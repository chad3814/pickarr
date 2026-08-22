import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { getFeedItem } from '../../src/db/feed-items.ts';
import { getGroup } from '../../src/db/groups.ts';
import { filesForGroup } from '../../src/db/imported-files.ts';
import { getGroupMetadata, recordMetadataAnswer } from '../../src/db/metadata.ts';
import { getRelease, releasesForGroup } from '../../src/db/releases.ts';
import { maybeNum, num, type SqlRow } from '../../src/db/row.ts';
import { planIdentityChange } from '../../src/manual/identity-plan.ts';
import {
  dismissFeedItem,
  editGroup,
  editRelease,
  resolveFeedItem,
  type ManualDeps,
} from '../../src/manual/operations.ts';
import { lstatOrNull } from '../../src/pipeline/import.ts';
import { FILING, NOW, PLUGIN, makeDeps, ok, failure, seedWithFile } from './fixtures.ts';

/**
 * A plugin that cannot score. Nothing about a group needs a score — quality is
 * release-level — so this must not stand in the way of a group edit.
 */
const THROWS_ON_SCORE: MediaTypePlugin = {
  ...PLUGIN,
  score: () => {
    throw new Error('boom');
  },
};

/** A plugin whose *inverse* hook is broken, which no submitted value can avoid. */
const THROWS_ON_PREFILL: MediaTypePlugin = {
  ...PLUGIN,
  toManualValues: () => {
    throw new Error('boom');
  },
};

/** The same plugin with none of the manual hooks — the degradation case. */
const BARE: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse: () => null,
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
};

/** `edited_at` is on neither `ReleaseRow` nor the group row's public shape. */
function releaseEditedAt(db: DatabaseSync, id: number): number | null {
  const row = db.prepare('SELECT edited_at FROM releases WHERE id = ?').get(id);
  if (row === undefined) throw new Error(`no release ${id}`);
  return maybeNum(row as SqlRow, 'edited_at');
}

/**
 * Item 1 is a plain failure, item 2 a dismissed one, item 3 parsed cleanly,
 * item 4 failed on a feed that is no longer in configuration.
 */
function seedFeedItems(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at,
                             parse_error, dismissed_at)
     VALUES (1, 'f',    'g1', 'T1', 'https://indexer.invalid/1.nzb', 100, 'no site', NULL),
            (2, 'f',    'g2', 'T2', 'https://indexer.invalid/2.nzb', 100, 'no site', 900),
            (3, 'f',    'g3', 'T3', 'https://indexer.invalid/3.nzb', 100, NULL,      NULL),
            (4, 'gone', 'g4', 'T4', 'https://indexer.invalid/4.nzb', 100, 'no site', NULL)`,
  ).run();
}

/**
 * A group keyed `k1`, picked on its only release (720), so a resolve that
 * joins it has both a pick to beat and a `list_rank_at` to leave alone.
 */
function seedPickedGroup(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 'picked', 1, 100, 500)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 3, '{"resolution":720}', 720, 100)`,
  ).run();
}

/**
 * Two groups, one release each. Group 1 is picked on a 720 with nothing
 * flagged; group 2 holds a 2160, so merging 2 into 1 has to raise a flag that
 * was not there before rather than restate one the seed already set.
 */
function seedTwoGroups(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 'picked', 1,    100, 500),
            (2, 'test', 'k2', '{"title":"G2","fields":[]}', 'g2', 'new',    NULL, 100, 600)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":720}',  720,  100),
            (2, 2, 2, '{"resolution":2160}', 2160, 100)`,
  ).run();
}

/**
 * A merge that brings in nothing better: group 1 is picked on a 2160, group 2
 * holds a 1080 and a 720. Both `list_rank_at` values are distinct from `NOW`,
 * so a bump cannot pass for a coincidence.
 */
function seedWorseSource(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 100),
            (3, 'f', 'g3', 'T3', 'https://indexer.invalid/3.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 'picked', 1,    100, 500),
            (2, 'test', 'k2', '{"title":"G2","fields":[]}', 'g2', 'new',    NULL, 100, 600)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":2160}', 2160, 100),
            (2, 2, 2, '{"resolution":1080}', 1080, 100),
            (3, 2, 3, '{"resolution":720}',   720, 100)`,
  ).run();
}

/**
 * A target already offering an upgrade: group 1 is picked on a 720 with its
 * own 2160 flagged; group 2 holds a second 2160. The incoming release beats
 * the pick and ties the flag, which is the boundary the flagged-score
 * comparison is strict for.
 */
function seedFlaggedTarget(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 100),
            (3, 'f', 'g3', 'T3', 'https://indexer.invalid/3.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, upgrade_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 'picked', 1,    2,    100, 500),
            (2, 'test', 'k2', '{"title":"G2","fields":[]}', 'g2', 'new',    NULL, NULL, 100, 600)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":720}',   720, 100),
            (2, 1, 2, '{"resolution":2160}', 2160, 100),
            (3, 2, 3, '{"resolution":2160}', 2160, 100)`,
  ).run();
}

/** One group, picked on the better of its two releases. */
function seedEditableReleases(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 'picked', 1, 100, 500)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":720}', 720, 100),
            (2, 1, 2, '{"resolution":480}', 480, 100)`,
  ).run();
}

/**
 * Plans the change, then applies it against the digest that plan returned —
 * which is the only way to apply anything that moves releases or files.
 *
 * There is deliberately no test-only bypass of the digest. It is the whole
 * confirmation gate, and a flag that skipped it would be a hole in the gate
 * that the tests would then be proving nothing about.
 */
async function applyPlanned(deps: ManualDeps, groupId: number, values: Record<string, string>) {
  const plan = ok(await planIdentityChange(deps, groupId, values));
  return editGroup(deps, groupId, values, plan.digest);
}

function insertDownload(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (1, ?, ?, 'sab', 'initial', 'queued', 1, 1)`,
  ).run(releaseId, groupId);
}

// --- Resolve -----------------------------------------------------------

test('resolve creates a group, inserts the release and clears the parse error', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = ok(resolveFeedItem(makeDeps(db), 1, { key: 'k9', title: 'Nine', res: '1080' }));

  assert.equal(result.joinedExisting, false);
  const group = getGroup(db, result.groupId)!;
  assert.equal(group.identityKey, 'k9');
  assert.equal(group.display, '{"title":"Nine","fields":[]}');
  assert.equal(group.searchText, 'nine');
  assert.deepEqual(
    releasesForGroup(db, result.groupId).map((release) => release.feedItemId),
    [1],
  );
  assert.equal(getFeedItem(db, 1)?.parseError, null);
  db.close();
});

test('resolve joins an existing group with the same key', () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedGroup(db);

  const result = ok(resolveFeedItem(makeDeps(db), 1, { key: 'k1', title: 'Ignored', res: '480' }));

  assert.equal(result.groupId, 1);
  assert.equal(result.joinedExisting, true);
  assert.equal(releasesForGroup(db, 1).length, 2);
  // Joining must not restate the group's identity from the submitted values:
  // the group already describes this scene.
  assert.equal(getGroup(db, 1)?.display, '{"title":"G1","fields":[]}');
  db.close();
});

test('resolve stamps edited_at on the release it created', () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedGroup(db);

  ok(resolveFeedItem(makeDeps(db), 1, { key: 'k1', res: '480' }));

  const added = releasesForGroup(db, 1).find((release) => release.feedItemId === 1)!;
  assert.equal(releaseEditedAt(db, added.id), NOW);
  db.close();
});

test('resolve stamps edited_at on a group it created', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = ok(resolveFeedItem(makeDeps(db), 1, { key: 'k9', res: '1080' }));

  assert.equal(getGroup(db, result.groupId)?.editedAt, NOW);
  db.close();
});

test('resolve leaves edited_at null on a group it merely joined', () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedGroup(db);

  ok(resolveFeedItem(makeDeps(db), 1, { key: 'k1', res: '480' }));

  // Nothing about the existing group was edited — a release was added to it —
  // so a later re-parse pass has no reason to treat it as protected.
  assert.equal(getGroup(db, 1)?.editedAt, null);
  db.close();
});

test('resolve clears dismissed_at, because fixing a dismissed item overrides the dismissal', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  ok(resolveFeedItem(makeDeps(db), 2, { key: 'k9', res: '1080' }));

  const item = getFeedItem(db, 2)!;
  assert.equal(item.parseError, null);
  assert.equal(item.dismissedAt, null);
  db.close();
});

test('resolve bumps list_rank_at when the new release beats a picked one', () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedGroup(db);

  const result = ok(resolveFeedItem(makeDeps(db), 1, { key: 'k1', res: '2160' }));

  const group = getGroup(db, result.groupId)!;
  const added = releasesForGroup(db, 1).find((release) => release.feedItemId === 1)!;
  // A resolve is a release *arriving*; it just took a slower route through a
  // human. The two edits below are corrections and must not do this.
  assert.equal(group.listRankAt, NOW);
  assert.equal(group.upgradeReleaseId, added.id);
  db.close();
});

test('resolve leaves list_rank_at alone when the new release loses to the pick', () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedGroup(db);

  ok(resolveFeedItem(makeDeps(db), 1, { key: 'k1', res: '480' }));

  const group = getGroup(db, 1)!;
  assert.equal(group.listRankAt, 500);
  assert.equal(group.upgradeReleaseId, null);
  db.close();
});

test('resolve refuses an item that already parsed', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = failure(resolveFeedItem(makeDeps(db), 3, { key: 'k9', res: '1080' }));

  assert.equal(result.status, 409);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM releases').get()?.['n']), 0);
  db.close();
});

test('resolve 404s on an unknown feed item', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  assert.equal(failure(resolveFeedItem(makeDeps(db), 99, { key: 'k9' })).status, 404);
  db.close();
});

test('resolve refuses an item whose feed is no longer configured, naming the feed', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = failure(resolveFeedItem(makeDeps(db), 4, { key: 'k9', res: '1080' }));

  assert.equal(result.status, 409);
  // Guessing a plugin would file the item under the wrong media type, so the
  // message has to say which feed went missing.
  assert.match(result.error, /gone/);
  assert.equal(getFeedItem(db, 4)?.parseError, 'no site');
  db.close();
});

test("resolve reports the plugin's own message when it rejects the values", () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = failure(resolveFeedItem(makeDeps(db), 1, { key: '', res: '1080' }));

  assert.equal(result.status, 400);
  assert.equal(result.error, 'key is required');
  assert.equal(getFeedItem(db, 1)?.parseError, 'no site');
  db.close();
});

test('resolve 400s when the release the plugin built fails validation', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = failure(resolveFeedItem(makeDeps(db), 1, { key: '!', res: '1080' }));

  assert.equal(result.status, 400);
  assert.match(result.error, /identityKey/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 0);
  db.close();
});

test('a plugin that throws while building the release is a 400, not a 500', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = failure(resolveFeedItem(makeDeps(db), 1, { key: 'THROW' }));

  // Same reasoning as `validateParsed`'s own guard: this runs in a request
  // handler with no guard of its own, and an unguarded throw would leave a
  // rolled-back transaction and a 500 where the field values are at fault.
  assert.equal(result.status, 400);
  assert.match(result.error, /plugin threw: boom/);
  assert.equal(getFeedItem(db, 1)?.parseError, 'no site');
  db.close();
});

// --- Dismiss -----------------------------------------------------------

test('dismiss stamps dismissed_at', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = ok(dismissFeedItem(makeDeps(db), 1));

  assert.equal(result.dismissedAt, NOW);
  assert.equal(getFeedItem(db, 1)?.dismissedAt, NOW);
  db.close();
});

test('dismiss refuses an item that parsed', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const result = failure(dismissFeedItem(makeDeps(db), 3));

  assert.equal(result.status, 409);
  assert.equal(getFeedItem(db, 3)?.dismissedAt, null);
  db.close();
});

test('dismiss 404s on an unknown feed item', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  assert.equal(failure(dismissFeedItem(makeDeps(db), 99)).status, 404);
  db.close();
});

// --- Edit a group ------------------------------------------------------

test('editing only the display keeps the key and rewrites the search text with it', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = ok(await editGroup(makeDeps(db), 2, { title: 'Renamed' }));

  // No digest, and none required: this moves nothing. A typo fix stays a
  // one-click save.
  assert.deepEqual(result, { groupId: 2, mergedInto: null, renamed: 0, trashed: 0, failed: [] });
  const group = getGroup(db, 2)!;
  assert.equal(group.identityKey, 'k2');
  assert.equal(group.display, '{"title":"Renamed","fields":[]}');
  assert.equal(group.searchText, 'renamed');
  assert.equal(group.editedAt, NOW);
  assert.equal(group.listRankAt, 600);
  db.close();
});

test('editing the key to an unused one rewrites the group in place', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = ok(await editGroup(makeDeps(db), 2, { key: 'k9' }));

  // A rekey with no files under the old key moves nothing on disk either, so it
  // needs no digest.
  assert.deepEqual(result, { groupId: 2, mergedInto: null, renamed: 0, trashed: 0, failed: [] });
  const group = getGroup(db, 2)!;
  assert.equal(group.identityKey, 'k9');
  // The title came from `toManualValues` of the current record: an edit
  // submits only what changed.
  assert.equal(group.display, '{"title":"G2","fields":[]}');
  assert.equal(group.editedAt, NOW);
  assert.equal(group.listRankAt, 600);
  assert.equal(releasesForGroup(db, 2).length, 1);
  db.close();
});

test('editing the key to another group merges into it and deletes the source', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = ok(await applyPlanned(makeDeps(db), 2, { key: 'k1', title: 'Renamed' }));

  assert.deepEqual(result, { groupId: 1, mergedInto: 1, renamed: 0, trashed: 0, failed: [] });
  assert.equal(getGroup(db, 2), null);
  assert.deepEqual(
    releasesForGroup(db, 1).map((release) => release.id),
    [2, 1],
  );
  const target = getGroup(db, 1)!;
  // The arriving 2160 beats the picked 720, and the flag was null before.
  assert.equal(target.upgradeReleaseId, 2);
  // The stamp goes on the surviving group.
  assert.equal(target.editedAt, NOW);
  // And the 2160 arriving is worth a bump — see the three ordering tests below
  // for the rule and its two boundaries.
  assert.equal(target.listRankAt, NOW);
  db.close();
});

test('a merge bumps list_rank_at when an incoming release beats the target pick', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  ok(await applyPlanned(makeDeps(db), 2, { key: 'k1' }));

  const target = getGroup(db, 1)!;
  // The 2160 moving in beats the picked 720, so it is an *arrival* at group 1:
  // the same event ingest bumps for, reached by a slower route through a
  // human, exactly as a resolve is. The same scene fixed from the Failed tab
  // bumps, and these two routes must not order it differently.
  assert.equal(target.listRankAt, NOW);
  assert.equal(target.upgradeReleaseId, 2);
  db.close();
});

test('a merge that brings in nothing better than the pick does not bump', async () => {
  const db = openTestDatabase();
  seedWorseSource(db);

  ok(await applyPlanned(makeDeps(db), 2, { key: 'k1' }));

  const target = getGroup(db, 1)!;
  // Moving two also-ran encodes into a group is not an arrival: there is
  // nothing here the user would want the list to lift the group up for.
  assert.equal(target.listRankAt, 500);
  assert.equal(target.upgradeReleaseId, null);
  assert.equal(releasesForGroup(db, 1).length, 3);
  db.close();
});

test('a merge that ties an already-flagged upgrade does not bump', async () => {
  const db = openTestDatabase();
  seedFlaggedTarget(db);

  ok(await applyPlanned(makeDeps(db), 2, { key: 'k1' }));

  const target = getGroup(db, 1)!;
  // The incoming 2160 beats the picked 720 but only equals the 2160 already
  // flagged, and the group is already in the browse list on that flag's
  // account. Bumping would re-sort the list around an arrival that offers the
  // user nothing new — which is exactly why ingest's guard compares against
  // the flagged score too, and strictly.
  assert.equal(target.listRankAt, 500);
  // Something better than the pick is still on offer; which of the two tied
  // 2160s carries the flag is `deriveUpgradeReleaseId`'s business.
  assert.notEqual(target.upgradeReleaseId, null);
  db.close();
});

test('a merge leaves the target group its own display and search text', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  ok(await applyPlanned(makeDeps(db), 2, { key: 'k1', title: 'Renamed' }));

  // The submitted values were the user's way of naming which existing scene
  // this is; the target already describes it. Taking the display too would let
  // a hasty edit rewrite a record the user was only pointing at.
  const target = getGroup(db, 1)!;
  assert.equal(target.display, '{"title":"G1","fields":[]}');
  assert.equal(target.searchText, 'g1');
  db.close();
});

test('a merge that fails at the delete leaves nothing behind', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  const deps = makeDeps(db);
  // The delete is the one statement in a merge that can fail — a foreign key
  // this code did not anticipate, a disk error. RAISE(ABORT) fails that
  // statement and leaves the surrounding transaction to the caller, which is
  // exactly how a real constraint failure arrives.
  db.exec(`
    CREATE TRIGGER refuse_group_delete BEFORE DELETE ON media_groups
    BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END
  `);
  // Planning only reads, so the trigger does not change what it returns — and
  // the digest still has to be right, because the phase-1 transaction is only
  // reached through the same gate a real caller comes through.
  const plan = ok(await planIdentityChange(deps, 2, { key: 'k1' }));

  await assert.rejects(
    editGroup(deps, 2, { key: 'k1' }, plan.digest),
    /simulated delete failure/,
  );

  // Without the enclosing transaction all three earlier writes commit and
  // survive: the releases end up under the target while the source row lives
  // on, still claiming a picked release it no longer holds, and the target
  // carries a stamp and a flag from a merge that never happened. Every browse
  // and pick query would read that as truth.
  assert.deepEqual(
    releasesForGroup(db, 2).map((release) => release.id),
    [2],
  );
  assert.deepEqual(
    releasesForGroup(db, 1).map((release) => release.id),
    [1],
  );
  const target = getGroup(db, 1)!;
  assert.equal(target.editedAt, null);
  assert.equal(target.upgradeReleaseId, null);
  assert.notEqual(getGroup(db, 2), null);
  // The rollback also has to close the transaction it opened, or the next
  // operation on this connection begins inside a doomed one.
  assert.equal(db.isTransaction, false);
  db.close();
});

test('merging a group that has been browsed does not 500, and leaves the target metadata untouched', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  // The target has its own answer already; a merge must not disturb it — the
  // target's answer describes the target's identity, which the merge does not
  // question.
  recordMetadataAnswer(db, {
    groupId: 1,
    source: 'theporndb',
    confirmed: {
      sourceUuid: 'target-uuid', title: 'Target Scene', siteUuid: null, siteId: null,
      siteName: 'Site', date: '2020-01-01', performers: [], durationSeconds: null,
      synopsis: null, posterUrl: null, slug: null,
    },
    nearMisses: [],
    now: 1000,
  });

  // The source has been browsed too, and picked up all five rows a browse can
  // leave behind: an answer, a rejected candidate recorded alongside it, a
  // link to its cast, and — inserted directly, since `recordMetadataAnswer`
  // would not leave either — a metadata queue row and a performer-search queue
  // row, so the fix is proved against every table `media_groups` is referenced
  // from, not just whichever one a real sequence happens to hit.
  //
  // The cast has to be non-empty, and this test is the reason to say so out
  // loud: `group_performers` is the newest of those tables, and while this
  // answer was `confirmed: null` the row it would have written did not exist,
  // so the one table the performer work added was the one table a test named
  // for covering "every table" quietly stopped covering. An empty `performers`
  // array here passes against a `clearGroupMetadata` that has never heard of
  // `group_performers` — and a real merge, of a real group whose refetch has
  // landed, does not.
  recordMetadataAnswer(db, {
    groupId: 2,
    source: 'theporndb',
    confirmed: {
      sourceUuid: 'source-uuid', title: 'Source Scene', siteUuid: null, siteId: null,
      siteName: 'Site', date: '2020-01-01',
      performers: [
        {
          sourceUuid: 'performer-uuid', slug: 'source-performer', name: 'Source Performer',
          kind: 'performer', faceUrl: null, imageUrl: null,
        },
      ],
      durationSeconds: null, synopsis: null, posterUrl: null, slug: null,
    },
    nearMisses: [
      {
        candidate: {
          sourceUuid: 'rejected', title: 'Rejected Scene', siteUuid: null, siteId: null,
          siteName: 'Site', date: '2020-01-01', performers: [], durationSeconds: null,
          synopsis: null, posterUrl: null, slug: null,
        },
        reason: 'date outside window',
      },
    ],
    now: 1000,
  });
  // Spelled out before the merge rather than assumed: if this link were never
  // written, the assertion below that it is gone would pass for the wrong
  // reason and the table would be back to being uncovered.
  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS n FROM group_performers WHERE group_id = ?').get(2)?.['n']),
    1,
  );
  db.prepare(
    `INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
     VALUES (2, 2000, 0, 2000)`,
  ).run();
  // `performer_queue` is the fifth table, and it is the one whose row nothing
  // in the UI can show: a group whose scene lookup settled castless is queued
  // for a performer search with no visible trace. That is the shape of the
  // defect this test exists for — a normal merge meeting `FOREIGN KEY
  // constraint failed` over a row nobody knew the group held.
  db.prepare(
    `INSERT INTO performer_queue (group_id, requested_at, attempts, next_at)
     VALUES (2, 2000, 0, 2000)`,
  ).run();

  const result = ok(await applyPlanned(makeDeps(db), 2, { key: 'k1' }));
  assert.deepEqual(result, { groupId: 1, mergedInto: 1, renamed: 0, trashed: 0, failed: [] });

  // The source's own rows describe an identity the merge just concluded was
  // wrong, and must not survive it, in any of the five tables.
  assert.equal(getGroupMetadata(db, 2), undefined);
  assert.equal(db.prepare('SELECT 1 FROM metadata_queue WHERE group_id = ?').get(2), undefined);
  assert.equal(db.prepare('SELECT 1 FROM performer_queue WHERE group_id = ?').get(2), undefined);
  assert.equal(
    db.prepare('SELECT 1 FROM metadata_candidates WHERE group_id = ?').get(2),
    undefined,
  );
  assert.equal(
    db.prepare('SELECT 1 FROM group_performers WHERE group_id = ?').get(2),
    undefined,
  );
  // The performer itself outlives the merge. It is shared, keyed on the
  // provider's uuid, and its cached avatar is on disk under its id — deleting
  // it here would strip it from every other card that credits them.
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM performers').get()?.['n']), 1);

  // The target kept its own answer — a merge is not a reason to forget it or
  // to re-ask the question.
  const targetMetadata = getGroupMetadata(db, 1);
  assert.equal(targetMetadata?.state, 'confirmed');
  assert.equal(targetMetadata?.title, 'Target Scene');

  db.close();
});

test('an identity edit forgets metadata confirmed against the identity it replaced', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  // Answered while the group still claimed `k2`, so this row describes
  // whatever scene the *old* identity matched — which is the reading the human
  // is about to overrule.
  recordMetadataAnswer(db, {
    groupId: 2,
    source: 'theporndb',
    confirmed: {
      sourceUuid: 'stale-uuid',
      title: 'The Scene The Wrong Parse Matched',
      siteUuid: null,
      siteId: null,
      siteName: 'Site',
      date: '2020-01-01',
      performers: [{
        sourceUuid: 'somebody-else-uuid',
        slug: 'somebody-else-entirely',
        name: 'Somebody Else Entirely',
        kind: 'performer',
        faceUrl: null,
        imageUrl: null,
      }],
      durationSeconds: null,
      synopsis: null,
      posterUrl: null,
      slug: null,
    },
    nearMisses: [
      {
        candidate: {
          sourceUuid: 'rejected-uuid',
          title: 'A Rejected Candidate',
          siteUuid: null,
          siteId: null,
          siteName: 'Site',
          date: '2020-01-09',
          performers: [],
          durationSeconds: null,
          synopsis: null,
          posterUrl: null,
          slug: null,
        },
        reason: 'date outside window',
      },
    ],
    now: 1000,
  });

  // Queued for a performer search as well, which is what a castless settle
  // leaves behind. On this path the row is not a foreign-key hazard — nothing
  // is deleted — it is a *stale question*: the search it asks for is built from
  // the title the human is about to replace, so an answer arriving after the
  // edit would write a cast derived from the reading that was just overruled.
  db.prepare(
    `INSERT INTO performer_queue (group_id, requested_at, attempts, next_at)
     VALUES (2, 2000, 0, 2000)`,
  ).run();

  // `k9` collides with nothing, so this takes the plain-edit path rather than
  // the merge one. The merge path already clears metadata — but only as a
  // foreign-key precondition for deleting the source row, which is why this
  // path was never given the same treatment.
  ok(await editGroup(makeDeps(db), 2, { key: 'k9' }));

  // The row has to be gone rather than merely stale. `enqueueMetadata` counts
  // *any* `group_metadata` row as answered, so one that survives is never
  // re-asked: the card would keep showing the wrong scene's performers and
  // poster for as long as the group exists.
  assert.equal(getGroupMetadata(db, 2), undefined);

  // The rejected candidates were evidence about the old identity too, and are
  // no more true of the new one than the answer was.
  assert.equal(
    db.prepare('SELECT 1 FROM metadata_candidates WHERE group_id = ?').get(2),
    undefined,
  );

  // The cast linked against the old identity goes with it, and so does the
  // pending search that would have written another one.
  assert.equal(
    db.prepare('SELECT 1 FROM group_performers WHERE group_id = ?').get(2),
    undefined,
  );
  assert.equal(db.prepare('SELECT 1 FROM performer_queue WHERE group_id = ?').get(2), undefined);

  db.close();
});

test('a save that changes nothing keeps the metadata it already had', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  recordMetadataAnswer(db, {
    groupId: 2,
    source: 'theporndb',
    confirmed: {
      sourceUuid: 'good-uuid',
      title: 'Still Correct',
      siteUuid: null,
      siteId: null,
      siteName: 'Site',
      date: '2020-01-01',
      performers: [],
      durationSeconds: null,
      synopsis: null,
      posterUrl: null,
      slug: null,
    },
    nearMisses: [],
    now: 1000,
  });

  // The key and the title the group already holds, so both the identity and
  // the rendered display come back byte-identical.
  ok(await editGroup(makeDeps(db), 2, { key: 'k2', title: 'G2' }));

  // Nothing the lookup asks about changed, so forgetting the answer would cost
  // a request and blank the card's panel until the worker replied — as the
  // price of a save that did nothing. #39 records the same lesson about a
  // no-op save having effects.
  const kept = getGroupMetadata(db, 2);
  assert.equal(kept?.state, 'confirmed');
  assert.equal(kept?.title, 'Still Correct');

  db.close();
});

/**
 * Was a 409 until the identity-change design of 2026-08-16, and asserted the
 * message that said so ("has a download recorded against it", "will not clear
 * by waiting"). That refusal was permanent, because nothing in the system
 * deletes a `downloads` row — so a group ever picked from could never have its
 * identity corrected at all. It now merges, and the download moves with it.
 */
test('a source group with a download recorded against it now merges', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  insertDownload(db, 2, 2);

  const outcome = ok(await applyPlanned(makeDeps(db), 2, { key: 'k1' }));

  assert.equal(outcome.mergedInto, 1);
  assert.equal(getGroup(db, 2), null, 'the emptied source is deleted');
  assert.deepEqual(
    releasesForGroup(db, 1).map((release) => release.id),
    [2, 1],
  );
  // The row that used to make this permanent, now pointing at the survivor —
  // which is what `deleteGroup`'s foreign key demands and what makes the merge
  // possible at all.
  assert.equal(
    num(db.prepare('SELECT group_id FROM downloads WHERE id = 1').get() as SqlRow, 'group_id'),
    1,
  );
  db.close();
});

/**
 * The other half of the same reversal: a 409 that said the source "already has
 * files in the library under its own name, which keep the paths they were
 * given", and that trashing them would not clear it either. Both halves of that
 * message are now false — the row moves with the merge, and phase 3 is what
 * reconciles the path.
 *
 * `FILING` rather than the default `PLUGIN`: a plugin that files nothing
 * (`planImport: () => null`) cannot say where a live file belongs under the new
 * identity, and the planner refuses that as a blocker rather than stranding the
 * file. The file itself is deliberately absent from disk, which the planner
 * reports as a warning and skips — this test is about the *row* travelling, and
 * the file half has its own tests below.
 */
test('a source group with an imported file recorded against it now merges', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  // The download hangs off the target, so only the imported file holds the
  // source — the second half of the old history check on its own.
  insertDownload(db, 1, 1);
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (1, 1, 2, '/a', '/b', 10, 1)`,
  ).run();
  const deps = makeDeps(db, FILING);

  const plan = ok(await planIdentityChange(deps, 2, { key: 'k1' }));
  assert.match(String(plan.warnings[0]), /already gone from disk/);
  const outcome = ok(await editGroup(deps, 2, { key: 'k1' }, plan.digest));

  assert.equal(outcome.mergedInto, 1);
  assert.equal(getGroup(db, 2), null);
  assert.deepEqual(
    filesForGroup(db, 1).map((file) => file.id),
    [1],
    'the imported file row followed the source into the survivor',
  );
  db.close();
});

test('editGroup 404s on an unknown group', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  assert.equal(failure(await editGroup(makeDeps(db), 99, { key: 'k9' })).status, 404);
  db.close();
});

test("editGroup reports the plugin's own message when it rejects the values", async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = failure(await editGroup(makeDeps(db), 2, { key: '' }));

  assert.equal(result.status, 400);
  assert.equal(result.error, 'key is required');
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
  db.close();
});

test('editGroup 400s when the identity the plugin built fails validation', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = failure(await editGroup(makeDeps(db), 2, { key: '!' }));

  // The scoreless validator still applies the identity checks: dropping the
  // score must not drop the rest with it.
  assert.equal(result.status, 400);
  assert.match(result.error, /identityKey/);
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
  db.close();
});

test('a group can be edited under a plugin whose score throws', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = ok(await editGroup(makeDeps(db, THROWS_ON_SCORE), 2, { key: 'k9' }));

  // A group has no quality to score, so asking for one would refuse this edit
  // with a 400 the user has no way to satisfy — hence the scoreless validator.
  assert.deepEqual(result, { groupId: 2, mergedInto: null, renamed: 0, trashed: 0, failed: [] });
  assert.equal(getGroup(db, 2)?.identityKey, 'k9');
  db.close();
});

test('a release cannot be edited under a plugin whose score throws', () => {
  const db = openTestDatabase();
  seedEditableReleases(db);

  const result = failure(editRelease(makeDeps(db, THROWS_ON_SCORE), 2, { res: '2160' }));

  // The opposite of the case above, and the reason `validateParsed` keeps its
  // score check: a release row without a trustworthy score sorts by a quality
  // it does not claim.
  assert.equal(result.status, 400);
  assert.equal(getRelease(db, 2)?.score, 480);
  db.close();
});

test('a plugin that throws while prefilling the form is a 400, not a 500', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = failure(await editGroup(makeDeps(db, THROWS_ON_PREFILL), 2, { key: 'k9' }));

  assert.equal(result.status, 400);
  assert.match(result.error, /plugin threw: boom/);
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
  db.close();
});

// --- Apply an identity change to the library ---------------------------

test('the reported scenario: correcting a picked group merges it into the other one', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const deps = makeDeps(db, FILING, libraryRoot);

  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));
  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.mergedInto, 2);
  assert.equal(outcome.renamed, 1);
  assert.deepEqual(outcome.failed, []);

  const survivor = getGroup(db, 2);
  assert.equal(survivor?.state, 'picked');
  assert.equal(survivor?.pickedReleaseId, 1, 'the target adopts the source pick');
  // Derived *after* the adopted pick was written. Deriving first would ask the
  // question of a group whose `picked_release_id` was still NULL, which derives
  // to no upgrade at all — the user would lose the 2160 the merge just put
  // within reach.
  assert.equal(survivor?.upgradeReleaseId, 2, 'the 2160 release is now a flagged upgrade');
  assert.deepEqual(
    releasesForGroup(db, 2)
      .map((release) => release.id)
      .toSorted(),
    [1, 2],
  );

  assert.equal(await readFile(join(libraryRoot, 'k2', '1080.mp4'), 'utf8'), 'data');
  assert.equal(await lstatOrNull(join(libraryRoot, 'k1', '1080.mp4')), null);
  const files = filesForGroup(db, 2);
  assert.equal(files[0]?.destPath, join(libraryRoot, 'k2', '1080.mp4'), 'dest_path caught up');
  db.close();
});

test('a stale digest is refused and changes nothing', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const deps = makeDeps(db, FILING, libraryRoot);

  const result = await editGroup(deps, 1, { key: 'k2', title: 'A' }, 'not-the-digest');

  assert.equal(failure(result).status, 409);
  assert.notEqual(getGroup(db, 1), null, 'the source group is untouched');
  assert.notEqual(await lstatOrNull(join(libraryRoot, 'k1', '1080.mp4')), null);
  db.close();
});

test('a missing digest is refused when the plan moves anything', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);

  const result = await editGroup(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' });

  assert.equal(failure(result).status, 409);
  assert.match(failure(result).error, /must be confirmed first/);
  db.close();
});

test('a display-only edit still applies with no digest', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const outcome = ok(await editGroup(makeDeps(db), 1, { key: 'k1', title: 'Renamed' }));

  assert.equal(outcome.mergedInto, null);
  assert.equal(
    (JSON.parse(getGroup(db, 1)!.display) as { title: string }).title,
    'Renamed',
    'a typo fix must still save in one click',
  );
  db.close();
});

test('a blocked plan is refused', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  // Something the group did not put there sits at the path the rename wants.
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '1080.mp4'), 'someone else');
  const deps = makeDeps(db, FILING, libraryRoot);
  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));

  const result = await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest);

  // A confirmed digest is not permission to overwrite: the blockers are checked
  // on the freshly recomputed plan, ahead of the digest comparison.
  assert.equal(failure(result).status, 409);
  assert.notEqual(getGroup(db, 1), null);
  assert.equal(await readFile(join(libraryRoot, 'k2', '1080.mp4'), 'utf8'), 'someone else');
  db.close();
});

test('a failing rename leaves the merge standing and reports the file', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const deps: ManualDeps = {
    ...makeDeps(db, FILING, libraryRoot),
    // EPERM, not EXDEV: EXDEV has a copy fallback that would succeed.
    rename: () => Promise.reject(Object.assign(new Error('nope'), { code: 'EPERM' })),
  };
  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));

  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.mergedInto, 2, 'the merge committed before any file moved');
  assert.equal(outcome.renamed, 0);
  assert.equal(outcome.failed.length, 1);
  assert.equal(
    filesForGroup(db, 2)[0]?.destPath,
    join(libraryRoot, 'k1', '1080.mp4'),
    'dest_path still names where the file actually is',
  );
  db.close();
});

test('re-saving after a failed rename finishes the remaining work', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const failing: ManualDeps = {
    ...makeDeps(db, FILING, libraryRoot),
    rename: () => Promise.reject(Object.assign(new Error('nope'), { code: 'EPERM' })),
  };
  const firstPlan = ok(await planIdentityChange(failing, 1, { key: 'k2', title: 'A' }));
  await editGroup(failing, 1, { key: 'k2', title: 'A' }, firstPlan.digest);

  // Same values, working filesystem, and the group is now group 2.
  const deps = makeDeps(db, FILING, libraryRoot);
  const plan = ok(await planIdentityChange(deps, 2, { key: 'k2', title: 'B' }));
  assert.equal(plan.kind, 'none', 'the merge already happened');
  assert.equal(plan.renames.length, 1, 'but the file is still at its old path');

  const outcome = ok(await editGroup(deps, 2, { key: 'k2', title: 'B' }, plan.digest));

  // The file work is gated on the plan's renames rather than on `kind`, which is
  // what makes finishing an interrupted edit the same operation as the edit.
  assert.equal(outcome.renamed, 1);
  assert.equal(await readFile(join(libraryRoot, 'k2', '1080.mp4'), 'utf8'), 'data');
  assert.equal(filesForGroup(db, 2)[0]?.destPath, join(libraryRoot, 'k2', '1080.mp4'));
  db.close();
});

test('a superseded pick is trashed before the survivors are renamed', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  const trashDir = await mkdtemp(join(tmpdir(), 'pickarr-trash-'));
  await seedWithFile(db, libraryRoot);
  // The target is picked too, on a release scoring *below* the source's — so it
  // is the target's own file that is superseded, and the source's pick and file
  // are the ones that survive and move. Both a trash and a rename in one apply
  // is the only shape that can observe the order of the two phases.
  db.prepare('UPDATE releases SET score = 500 WHERE id = 2').run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '2160.mp4'), 'superseded');
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 2, 2, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 2, '/dl/b.mp4', ?, 5, 100)`,
  ).run(join(libraryRoot, 'k2', '2160.mp4'));

  // Asked from inside the rename, which is the only place the question "had the
  // trashing already happened?" can be answered honestly. In production the
  // superseded file frequently occupies the exact path the renamed one wants —
  // the collision `import.ts` trashes ahead of its own transfer loop to avoid —
  // and this is that ordering, observed rather than assumed.
  let supersededWasGoneFirst: boolean | null = null;
  const deps: ManualDeps = {
    ...makeDeps(db, FILING, libraryRoot),
    trashDir,
    rename: async (from, to) => {
      supersededWasGoneFirst =
        (await lstatOrNull(join(libraryRoot, 'k2', '2160.mp4'))) === null;
      await rename(from, to);
    },
  };

  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));
  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.trashed, 1);
  assert.equal(outcome.renamed, 1);
  assert.deepEqual(outcome.failed, []);
  assert.equal(supersededWasGoneFirst, true);
  assert.equal(getGroup(db, 2)?.pickedReleaseId, 1, 'the higher-scoring pick stands');
  const trashedRow = filesForGroup(db, 2).find((file) => file.id === 2);
  assert.notEqual(trashedRow?.trashedAt, null);
  assert.equal(await readFile(join(libraryRoot, 'k2', '1080.mp4'), 'utf8'), 'data');
  db.close();
});

/**
 * The production case, and the one the whole phase-2-before-phase-3 ordering is
 * for: the superseded file occupies the *exact* path the surviving file is being
 * renamed to. Nothing here would work in any other order — the rename has
 * nowhere to land until the trash has happened.
 *
 * The ordering test above proves phase 2 runs first by observation; this one
 * proves it matters.
 */
test('a rename into the path a superseded file occupies succeeds', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  const trashDir = await mkdtemp(join(tmpdir(), 'pickarr-trash-'));
  await seedWithFile(db, libraryRoot);
  // Same resolution on both picks, so both files are filed under `1080.mp4`, and
  // a lower score on the target's, so the source's pick and file survive.
  db.prepare(`UPDATE releases SET quality = '{"resolution":1080}', score = 500 WHERE id = 2`).run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '1080.mp4'), 'superseded');
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 2, 2, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 2, '/dl/b.mp4', ?, 10, 100)`,
  ).run(join(libraryRoot, 'k2', '1080.mp4'));
  const deps: ManualDeps = { ...makeDeps(db, FILING, libraryRoot), trashDir };

  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));
  assert.deepEqual(plan.blockers, [], 'a file this plan trashes is not a foreign occupant');
  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.trashed, 1);
  assert.equal(outcome.renamed, 1);
  assert.deepEqual(outcome.failed, []);
  // The contested path now holds the winner, and the loser is recoverable.
  assert.equal(await readFile(join(libraryRoot, 'k2', '1080.mp4'), 'utf8'), 'data');
  assert.equal(await lstatOrNull(join(libraryRoot, 'k1', '1080.mp4')), null);
  const survivingFile = filesForGroup(db, 2).find((file) => file.id === 1);
  assert.equal(survivingFile?.destPath, join(libraryRoot, 'k2', '1080.mp4'));
  const trashedFile = filesForGroup(db, 2).find((file) => file.id === 2);
  assert.notEqual(trashedFile?.trashedAt, null);
  assert.equal(await readFile(String(trashedFile?.trashPath), 'utf8'), 'superseded');
  assert.equal(getGroup(db, 2)?.pickedReleaseId, 1);
  db.close();
});

/**
 * The invariant the whole four-phase order exists to buy, pinned: **nothing on
 * disk moves until phase 1 has committed.** Hoisting phases 2-3 above phase 1 —
 * or interleaving them — would leave a group whose files had moved while the
 * database still described the arrangement they moved out of, which is exactly
 * the state no re-save could reason about.
 *
 * The delete trigger is the same technique the phase-1 rollback test above uses;
 * what is new here is that the group *has a file*, so a phase-1 failure has
 * something to prove about the filesystem.
 */
test('a phase 1 failure leaves every file exactly where it was', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const deps = makeDeps(db, FILING, libraryRoot);
  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));
  assert.equal(plan.renames.length, 1, 'there has to be file work for this to prove anything');
  db.exec(`
    CREATE TRIGGER refuse_group_delete BEFORE DELETE ON media_groups
    BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END
  `);

  await assert.rejects(
    editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest),
    /simulated delete failure/,
  );

  // The file is still where the database says it is, and the database still says
  // what it said before — the two never disagreed for an instant.
  assert.equal(await readFile(join(libraryRoot, 'k1', '1080.mp4'), 'utf8'), 'data');
  assert.equal(await lstatOrNull(join(libraryRoot, 'k2', '1080.mp4')), null);
  assert.equal(filesForGroup(db, 1)[0]?.destPath, join(libraryRoot, 'k1', '1080.mp4'));
  assert.notEqual(getGroup(db, 1), null);
  assert.equal(db.isTransaction, false);
  db.close();
});

/**
 * The failure mode the occupant check in phase 3 exists for. An unwritable
 * `trashDir` makes `trashFiles` throw at its first `mkdir`, before it has touched
 * anything, so every superseded file is still on disk — and the planner has
 * already lifted its occupied-destination blocker for exactly those paths on the
 * strength of phase 2 clearing them. Without the check, phase 3 would rename
 * straight over a file the design promises is recoverable from `trashDir`,
 * destroying it and leaving two live rows naming one path.
 */
test('a rename is refused when phase 2 failed to clear its destination', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  // The same collision as the test above: both picks are 1080p, so both files
  // are filed under `1080.mp4`, and the target's scores lower and loses.
  db.prepare(`UPDATE releases SET quality = '{"resolution":1080}', score = 500 WHERE id = 2`).run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '1080.mp4'), 'superseded');
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 2, 2, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 2, '/dl/b.mp4', ?, 10, 100)`,
  ).run(join(libraryRoot, 'k2', '1080.mp4'));
  // A regular file where the trash directory should be, so `trashFiles`' own
  // `mkdir` fails with ENOTDIR — a misconfigured or unwritable `trashDir` in
  // miniature, and one that fails before it has moved anything.
  const trashDir = join(await mkdtemp(join(tmpdir(), 'pickarr-trash-')), 'not-a-directory');
  await writeFile(trashDir, 'in the way');
  const deps: ManualDeps = { ...makeDeps(db, FILING, libraryRoot), trashDir };

  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));
  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.trashed, 0);
  assert.equal(outcome.renamed, 0, 'the rename must not proceed over an uncleared destination');
  assert.equal(outcome.failed.length, 2, 'both the trashing and the rename are reported');
  assert.match(String(outcome.failed[1]?.error), /still occupied/);
  // Neither file was touched, and both rows still name where their file is.
  assert.equal(await readFile(join(libraryRoot, 'k2', '1080.mp4'), 'utf8'), 'superseded');
  assert.equal(await readFile(join(libraryRoot, 'k1', '1080.mp4'), 'utf8'), 'data');
  const files = filesForGroup(db, 2);
  assert.equal(files.find((file) => file.id === 1)?.destPath, join(libraryRoot, 'k1', '1080.mp4'));
  assert.equal(files.find((file) => file.id === 2)?.destPath, join(libraryRoot, 'k2', '1080.mp4'));
  assert.equal(files.find((file) => file.id === 2)?.trashedAt, null);
  // And the merge itself stands, so re-saving after fixing the trash directory
  // finishes the file work.
  assert.equal(outcome.mergedInto, 2);
  db.close();
});

/**
 * `trashFiles` marks a row trashed with a *null* `trash_path` when its file has
 * already left the disk — deliberately, since it did not move the file and has
 * nowhere honest to point. Counting `rows.length` on a clean return therefore
 * reported a file as having reached `trashDir` when the trash directory held
 * nothing but the empty folder the attempt had just created.
 *
 * Reading `trashedAt` back does not tell the two apart: `markTrashed` stamps it
 * in the vanished-file case too. `trashPath` is the field that distinguishes a
 * file that moved from a row that was merely retired, which is why the
 * read-back below asserts on both.
 *
 * Not a failure either — §4.3 of the design rules a file already gone from disk
 * a warning, not a failure — so the row is neither counted nor named in
 * `failed`.
 */
test('a doomed row whose file is already gone is not counted as trashed', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  const trashDir = await mkdtemp(join(tmpdir(), 'pickarr-trash-'));
  await seedWithFile(db, libraryRoot);
  // The target's pick scores below the source's, so it is the target's row that
  // is doomed — and its file is never written, standing in for one an operator
  // deleted by hand or an interrupted upgrade already moved.
  db.prepare('UPDATE releases SET score = 500 WHERE id = 2').run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 2, 2, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 2, '/dl/b.mp4', ?, 5, 100)`,
  ).run(join(libraryRoot, 'k2', '2160.mp4'));
  const deps: ManualDeps = { ...makeDeps(db, FILING, libraryRoot), trashDir };

  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));
  assert.equal(plan.trashing.length, 1, 'the vanished file is still planned for trashing');
  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.trashed, 0, 'nothing reached trashDir, so nothing is counted');
  assert.deepEqual(outcome.failed, [], 'a file already gone is a warning, not a failure');
  assert.equal(outcome.renamed, 1, 'the rest of the edit went through');
  const retired = filesForGroup(db, 2).find((file) => file.id === 2);
  assert.notEqual(retired?.trashedAt, null, 'the row is still retired...');
  assert.equal(retired?.trashPath, null, '...but nothing moved, so it names no trash location');
  db.close();
});

// --- Edit a release ----------------------------------------------------

test('editing a release writes the quality, the recomputed score and the stamp', () => {
  const db = openTestDatabase();
  seedEditableReleases(db);

  const result = ok(editRelease(makeDeps(db), 2, { res: '2160' }));

  assert.deepEqual(result, { groupId: 1 });
  const release = getRelease(db, 2)!;
  assert.equal(release.quality, '{"resolution":2160}');
  assert.equal(release.score, 2160);
  assert.equal(releaseEditedAt(db, 2), NOW);
  db.close();
});

test('editing a release re-derives the upgrade flag without moving list_rank_at', () => {
  const db = openTestDatabase();
  seedEditableReleases(db);

  ok(editRelease(makeDeps(db), 2, { res: '2160' }));

  const group = getGroup(db, 1)!;
  // The corrected release now beats the pick, so the flag has to appear.
  assert.equal(group.upgradeReleaseId, 2);
  // Correcting a record is not an arrival.
  assert.equal(group.listRankAt, 500);
  assert.equal(group.editedAt, null);
  db.close();
});

test('editing a release keeps the identity values it did not submit', () => {
  const db = openTestDatabase();
  seedEditableReleases(db);

  ok(editRelease(makeDeps(db), 2, { res: '2160' }));

  // The merge with `toManualValues(current)` is what supplies `key`; without
  // it the plugin would have rejected the submission outright.
  const group = getGroup(db, 1)!;
  assert.equal(group.identityKey, 'k1');
  assert.equal(group.display, '{"title":"G1","fields":[]}');
  db.close();
});

test('editRelease 404s on an unknown release', () => {
  const db = openTestDatabase();
  seedEditableReleases(db);

  assert.equal(failure(editRelease(makeDeps(db), 99, { res: '2160' })).status, 404);
  db.close();
});

// --- Degradation -------------------------------------------------------

test('a plugin with no manual hooks refuses all three edits and still dismisses', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedGroup(db);
  const deps = makeDeps(db, BARE);

  const resolved = failure(resolveFeedItem(deps, 1, { key: 'k9' }));
  const grouped = failure(await editGroup(deps, 1, { key: 'k9' }));
  const released = failure(editRelease(deps, 1, { res: '2160' }));

  assert.equal(resolved.status, 409);
  assert.equal(grouped.status, 409);
  assert.equal(released.status, 409);
  // Dismissing is core's own bookkeeping and needs no plugin knowledge.
  assert.equal(ok(dismissFeedItem(deps, 1)).dismissedAt, NOW);
  db.close();
});
