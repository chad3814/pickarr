import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { getFeedItem } from '../../src/db/feed-items.ts';
import { getGroup } from '../../src/db/groups.ts';
import { getGroupMetadata, recordMetadataAnswer } from '../../src/db/metadata.ts';
import { getRelease, releasesForGroup } from '../../src/db/releases.ts';
import { maybeNum, type SqlRow } from '../../src/db/row.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';
import {
  dismissFeedItem,
  editGroup,
  editRelease,
  resolveFeedItem,
  type ManualDeps,
  type ManualResult,
} from '../../src/manual/operations.ts';

const NOW = 5000;

/**
 * A plugin whose identity is whatever `key` says and whose quality is a
 * resolution — no parsing, no site list, no field validation beyond the one
 * rule the 400 cases need. These tests are about core's rules for a manual
 * edit, not about any real plugin's idea of a release name.
 *
 * `key: '!'` is the one back door: it returns a `ParsedRelease` that
 * `validateParsed` must reject, which is the only way to reach that branch
 * from outside without a plugin that lies about its own contract.
 */
const PLUGIN: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse: () => null,
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
  manualFields: () => [
    { name: 'key', label: 'Key', type: 'text', scope: 'identity', required: true },
    { name: 'title', label: 'Title', type: 'text', scope: 'identity' },
    { name: 'res', label: 'Resolution', type: 'text', scope: 'quality' },
  ],
  fromManualValues(values): { media: ParsedRelease } | { error: string } {
    const key = values['key'] ?? '';
    if (key === '') return { error: 'key is required' };
    if (key === 'THROW') throw new Error('boom');
    return {
      media: {
        identityKey: key === '!' ? '' : key,
        display: { title: values['title'] ?? key, fields: [] },
        quality: { resolution: Number(values['res'] ?? '0') },
      },
    };
  },
  toManualValues: (media) => ({
    key: media.identityKey,
    title: media.display.title,
    res: String(media.quality.resolution ?? ''),
  }),
};

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

function registryFor(plugin: MediaTypePlugin): PluginRegistry {
  return {
    byPackage: () => plugin,
    byId: (id) => (id === plugin.id ? plugin : undefined),
    libraryRoot: () => '/library',
    libraryRootById: () => '/library',
    all: () => [plugin],
  };
}

/** Feed `f` is configured; every other feed id has been removed from config. */
function makeDeps(db: DatabaseSync, plugin: MediaTypePlugin = PLUGIN): ManualDeps {
  return {
    db,
    registry: registryFor(plugin),
    pluginForFeed: (feedId) => (feedId === 'f' ? plugin : null),
    now: () => NOW,
  };
}

function ok<T>(result: ManualResult<T>): T {
  assert.ok('ok' in result, `expected success, got ${JSON.stringify(result)}`);
  return result.ok;
}

function failure<T>(result: ManualResult<T>): { error: string; status: number } {
  assert.ok(!('ok' in result), `expected failure, got ${JSON.stringify(result)}`);
  return result;
}

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

test('editing only the display keeps the key and rewrites the search text with it', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = ok(editGroup(makeDeps(db), 2, { title: 'Renamed' }));

  assert.deepEqual(result, { groupId: 2, mergedInto: null });
  const group = getGroup(db, 2)!;
  assert.equal(group.identityKey, 'k2');
  assert.equal(group.display, '{"title":"Renamed","fields":[]}');
  assert.equal(group.searchText, 'renamed');
  assert.equal(group.editedAt, NOW);
  assert.equal(group.listRankAt, 600);
  db.close();
});

test('editing the key to an unused one rewrites the group in place', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = ok(editGroup(makeDeps(db), 2, { key: 'k9' }));

  assert.deepEqual(result, { groupId: 2, mergedInto: null });
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

test('editing the key to another group merges into it and deletes the source', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = ok(editGroup(makeDeps(db), 2, { key: 'k1', title: 'Renamed' }));

  assert.deepEqual(result, { groupId: 1, mergedInto: 1 });
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

test('a merge bumps list_rank_at when an incoming release beats the target pick', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  ok(editGroup(makeDeps(db), 2, { key: 'k1' }));

  const target = getGroup(db, 1)!;
  // The 2160 moving in beats the picked 720, so it is an *arrival* at group 1:
  // the same event ingest bumps for, reached by a slower route through a
  // human, exactly as a resolve is. The same scene fixed from the Failed tab
  // bumps, and these two routes must not order it differently.
  assert.equal(target.listRankAt, NOW);
  assert.equal(target.upgradeReleaseId, 2);
  db.close();
});

test('a merge that brings in nothing better than the pick does not bump', () => {
  const db = openTestDatabase();
  seedWorseSource(db);

  ok(editGroup(makeDeps(db), 2, { key: 'k1' }));

  const target = getGroup(db, 1)!;
  // Moving two also-ran encodes into a group is not an arrival: there is
  // nothing here the user would want the list to lift the group up for.
  assert.equal(target.listRankAt, 500);
  assert.equal(target.upgradeReleaseId, null);
  assert.equal(releasesForGroup(db, 1).length, 3);
  db.close();
});

test('a merge that ties an already-flagged upgrade does not bump', () => {
  const db = openTestDatabase();
  seedFlaggedTarget(db);

  ok(editGroup(makeDeps(db), 2, { key: 'k1' }));

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

test('a merge leaves the target group its own display and search text', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  ok(editGroup(makeDeps(db), 2, { key: 'k1', title: 'Renamed' }));

  // The submitted values were the user's way of naming which existing scene
  // this is; the target already describes it. Taking the display too would let
  // a hasty edit rewrite a record the user was only pointing at.
  const target = getGroup(db, 1)!;
  assert.equal(target.display, '{"title":"G1","fields":[]}');
  assert.equal(target.searchText, 'g1');
  db.close();
});

test('a merge that fails at the delete leaves nothing behind', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  // The delete is the one statement in a merge that can fail — a foreign key
  // this code did not anticipate, a disk error. RAISE(ABORT) fails that
  // statement and leaves the surrounding transaction to the caller, which is
  // exactly how a real constraint failure arrives.
  db.exec(`
    CREATE TRIGGER refuse_group_delete BEFORE DELETE ON media_groups
    BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END
  `);

  assert.throws(() => editGroup(makeDeps(db), 2, { key: 'k1' }), /simulated delete failure/);

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

test('merging a group that has been browsed does not 500, and leaves the target metadata untouched', () => {
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

  // The source has been browsed too, and picked up all four rows a browse can
  // leave behind: an answer, a rejected candidate recorded alongside it, a
  // link to its cast, and — inserted directly, since `recordMetadataAnswer`
  // would not leave one — a queue row, so the fix is proved against every
  // table `media_groups` is referenced from, not just whichever one a real
  // sequence happens to hit.
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

  const result = ok(editGroup(makeDeps(db), 2, { key: 'k1' }));
  assert.deepEqual(result, { groupId: 1, mergedInto: 1 });

  // The source's own rows describe an identity the merge just concluded was
  // wrong, and must not survive it, in any of the four tables.
  assert.equal(getGroupMetadata(db, 2), undefined);
  assert.equal(db.prepare('SELECT 1 FROM metadata_queue WHERE group_id = ?').get(2), undefined);
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

test('an identity edit forgets metadata confirmed against the identity it replaced', () => {
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

  // `k9` collides with nothing, so this takes the plain-edit path rather than
  // the merge one. The merge path already clears metadata — but only as a
  // foreign-key precondition for deleting the source row, which is why this
  // path was never given the same treatment.
  ok(editGroup(makeDeps(db), 2, { key: 'k9' }));

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

  db.close();
});

test('a save that changes nothing keeps the metadata it already had', () => {
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
  ok(editGroup(makeDeps(db), 2, { key: 'k2', title: 'G2' }));

  // Nothing the lookup asks about changed, so forgetting the answer would cost
  // a request and blank the card's panel until the worker replied — as the
  // price of a save that did nothing. #39 records the same lesson about a
  // no-op save having effects.
  const kept = getGroupMetadata(db, 2);
  assert.equal(kept?.state, 'confirmed');
  assert.equal(kept?.title, 'Still Correct');

  db.close();
});

test('a merge is refused when the source group has a download', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  insertDownload(db, 2, 2);

  const result = failure(editGroup(makeDeps(db), 2, { key: 'k1' }));

  assert.equal(result.status, 409);
  // The message names which of the two obstructions it is, and says the
  // refusal is permanent: nothing deletes a download row, so a user told only
  // "has a download" would wait for something that never comes.
  assert.match(result.error, /has a download recorded against it/);
  assert.match(result.error, /will not clear by waiting/);
  assert.notEqual(getGroup(db, 2), null);
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
  assert.deepEqual(
    releasesForGroup(db, 2).map((release) => release.id),
    [2],
  );
  db.close();
});

test('a merge is refused when the source group has an imported file', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  // The download hangs off the target, so only the imported file holds the
  // source — the second half of the history check on its own.
  insertDownload(db, 1, 1);
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (1, 1, 2, '/a', '/b', 10, 1)`,
  ).run();

  const result = failure(editGroup(makeDeps(db), 2, { key: 'k1' }));

  assert.equal(result.status, 409);
  assert.match(result.error, /already has files in the library/);
  assert.match(result.error, /Trashing them does not clear this either/);
  assert.notEqual(getGroup(db, 2), null);
  assert.deepEqual(
    releasesForGroup(db, 1).map((release) => release.id),
    [1],
  );
  db.close();
});

test('editGroup 404s on an unknown group', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  assert.equal(failure(editGroup(makeDeps(db), 99, { key: 'k9' })).status, 404);
  db.close();
});

test("editGroup reports the plugin's own message when it rejects the values", () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = failure(editGroup(makeDeps(db), 2, { key: '' }));

  assert.equal(result.status, 400);
  assert.equal(result.error, 'key is required');
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
  db.close();
});

test('editGroup 400s when the identity the plugin built fails validation', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = failure(editGroup(makeDeps(db), 2, { key: '!' }));

  // The scoreless validator still applies the identity checks: dropping the
  // score must not drop the rest with it.
  assert.equal(result.status, 400);
  assert.match(result.error, /identityKey/);
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
  db.close();
});

test('a group can be edited under a plugin whose score throws', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = ok(editGroup(makeDeps(db, THROWS_ON_SCORE), 2, { key: 'k9' }));

  // A group has no quality to score, so asking for one would refuse this edit
  // with a 400 the user has no way to satisfy — hence the scoreless validator.
  assert.deepEqual(result, { groupId: 2, mergedInto: null });
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

test('a plugin that throws while prefilling the form is a 400, not a 500', () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const result = failure(editGroup(makeDeps(db, THROWS_ON_PREFILL), 2, { key: 'k9' }));

  assert.equal(result.status, 400);
  assert.match(result.error, /plugin threw: boom/);
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
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

test('a plugin with no manual hooks refuses all three edits and still dismisses', () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedGroup(db);
  const deps = makeDeps(db, BARE);

  const resolved = failure(resolveFeedItem(deps, 1, { key: 'k9' }));
  const grouped = failure(editGroup(deps, 1, { key: 'k9' }));
  const released = failure(editRelease(deps, 1, { res: '2160' }));

  assert.equal(resolved.status, 409);
  assert.equal(grouped.status, 409);
  assert.equal(released.status, 409);
  // Dismissing is core's own bookkeeping and needs no plugin knowledge.
  assert.equal(ok(dismissFeedItem(deps, 1)).dismissedAt, NOW);
  db.close();
});
