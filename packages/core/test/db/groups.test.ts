import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  browseGroups,
  completeUpgrade,
  flagUpgrade,
  getGroup,
  markPicked,
  pickedGroups,
  refreshUpgradeFlag,
} from '../../src/db/groups.ts';

// `upgrade_release_id` is an invariant, not an event log: it names the
// highest-scoring release in the group that is strictly better than
// `picked_release_id`, or NULL when there is none. Every write that can change
// either side of that comparison has to re-derive it — otherwise the flag
// records only whichever *arrival* happened to notice, and a pick or a
// completed upgrade silently leaves it describing a comparison that no longer
// holds. `list_rank_at` is deliberately not part of the invariant: only a
// newly arriving better release moves a group up the browse list, so
// re-deriving must never bump it.

/**
 * A picked group with four releases scoring 100/200/300/400 (ids 1..4), so
 * every test can point `picked_release_id` at any rung and state exactly what
 * the derived flag must be.
 */
function seedGroup(db: DatabaseSync, pickedReleaseId: number): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 1),
            (3, 'f', 'g3', 'T3', 'https://indexer.invalid/3.nzb', 1),
            (4, 'f', 'g4', 'T4', 'https://indexer.invalid/4.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{"title":"T","fields":[]}', 't', 'picked', ?, 100, 100)`,
  ).run(pickedReleaseId);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1), (2, 1, 2, '{}', 200, 1),
            (3, 1, 3, '{}', 300, 1), (4, 1, 4, '{}', 400, 1)`,
  ).run();
}

test('completeUpgrade keeps a better release flagged instead of clearing it', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  // Release 3 was flagged while the download of release 2 was in flight.
  db.prepare('UPDATE media_groups SET upgrade_release_id = 3 WHERE id = 1').run();

  completeUpgrade(db, 1, 2);

  const group = getGroup(db, 1)!;
  assert.equal(group.pickedReleaseId, 2);
  // Clearing here would lose release 4 as well as 3 — the flag is re-derived
  // from what the group actually holds, not from what this download replaced.
  assert.equal(group.upgradeReleaseId, 4);
  assert.equal(group.listRankAt, 100);
  db.close();
});

test('completeUpgrade onto the best release clears the flag', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  db.prepare('UPDATE media_groups SET upgrade_release_id = 4 WHERE id = 1').run();

  completeUpgrade(db, 1, 4);

  const group = getGroup(db, 1)!;
  assert.equal(group.pickedReleaseId, 4);
  assert.equal(group.upgradeReleaseId, null);
  assert.equal(group.listRankAt, 100);
  db.close();
});

test('picking the worse of two known releases flags the better one', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  db.prepare(
    "UPDATE media_groups SET state = 'new', picked_release_id = NULL WHERE id = 1",
  ).run();

  markPicked(db, 1, 2);

  const group = getGroup(db, 1)!;
  assert.equal(group.state, 'picked');
  assert.equal(group.pickedReleaseId, 2);
  // Without this the group leaves browse entirely and the better releases it
  // already holds become unreachable.
  assert.equal(group.upgradeReleaseId, 4);
  // Nothing new arrived, so the group must not jump to the top of the list.
  assert.equal(group.listRankAt, 100);
  db.close();
});

test('picking the best known release leaves nothing flagged', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  db.prepare(
    "UPDATE media_groups SET state = 'new', picked_release_id = NULL WHERE id = 1",
  ).run();

  markPicked(db, 1, 4);

  const group = getGroup(db, 1)!;
  assert.equal(group.upgradeReleaseId, null);
  db.close();
});

test('an equal-scoring release is not an upgrade', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  db.prepare('DELETE FROM releases WHERE id IN (3, 4)').run();
  db.prepare('UPDATE releases SET score = 100 WHERE id = 2').run();

  markPicked(db, 1, 1);

  assert.equal(getGroup(db, 1)?.upgradeReleaseId, null);
  db.close();
});

test('flagUpgrade re-derives the same invariant and is the only write that moves list_rank_at', () => {
  const db = openTestDatabase();
  seedGroup(db, 2);

  flagUpgrade(db, 1, 7000);

  const group = getGroup(db, 1)!;
  assert.equal(group.upgradeReleaseId, 4);
  assert.equal(group.listRankAt, 7000);
  db.close();
});

// --- A release that cannot be downloaded is not an upgrade -------------
//
// The flag is what puts a picked group back on Browse and what the card
// advertises. Flagging a release whose download just failed offers the user a
// button that fails again — the reported loop, in which the only escape from a
// failed 2160p was to pick the 1080p and be offered the 2160p straight back.
// The rule is the *most recent* download, so a retry that succeeds makes the
// release eligible again without anything having to clear a marker.

/**
 * Appends a download for a release. Ids are assigned by the table, so a second
 * call for the same release is the more recent attempt — which is the whole of
 * what "most recent" means here.
 */
function addDownload(db: DatabaseSync, releaseId: number, status: string): void {
  db.prepare(
    `INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (?, 1, 'sab', 'initial', ?, 1, 1)`,
  ).run(releaseId, status);
}

test('a better release nobody has tried is still flagged', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);

  markPicked(db, 1, 1);

  // "Never downloaded" and "downloaded fine" are the same answer — not failed.
  // A NULL leaking out of the failure test instead of a 0 would make an
  // untried release, which is every release in a fresh group, fail the
  // eligibility check and leave nothing ever flagged.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, 4);
  db.close();
});

test('a better release whose latest download failed is passed over for the next best', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  addDownload(db, 4, 'failed');

  markPicked(db, 1, 1);

  // Release 4 outscores 3, so it is what the old rule flagged. It cannot be
  // downloaded; release 3 is the best thing left that might be.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, 3);
  db.close();
});

test('when every better release has failed, nothing is flagged', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  for (const releaseId of [2, 3, 4]) addDownload(db, releaseId, 'failed');

  markPicked(db, 1, 1);

  // The group leaves Browse rather than advertising a loop. It is picked, so
  // it lives on the Picks tab, where a scene you own belongs.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, null);
  db.close();
});

test('a release retried successfully after a failure is flagged again', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  addDownload(db, 4, 'failed');
  addDownload(db, 4, 'imported');

  markPicked(db, 1, 1);

  // Only the most recent attempt counts, so recovery needs no separate write:
  // the release becomes eligible again the moment a later attempt is not a
  // failure.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, 4);
  db.close();
});

test("the pick's own failure does not suppress the alternatives it needs", () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  addDownload(db, 1, 'failed');

  refreshUpgradeFlag(db, 1);

  // The failure test is asked about each *candidate*, not about the pick. Ask
  // it about the pick — the shape the ordering rule uses — and a group whose
  // pick failed would have every alternative suppressed at once, which is the
  // opposite of what such a group needs.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, 4);
  db.close();
});

test('a failed download on a release worse than the pick changes nothing', () => {
  const db = openTestDatabase();
  seedGroup(db, 3);
  addDownload(db, 1, 'failed');
  addDownload(db, 2, 'failed');

  refreshUpgradeFlag(db, 1);

  assert.equal(getGroup(db, 1)?.upgradeReleaseId, 4);
  db.close();
});

test('flagUpgrade passes over a failed release too, and still moves list_rank_at', () => {
  const db = openTestDatabase();
  seedGroup(db, 2);
  addDownload(db, 4, 'failed');

  flagUpgrade(db, 1, 7000);

  // Every write that re-derives the flag goes through one expression, so an
  // arrival cannot re-advertise what a pick just ruled out.
  const group = getGroup(db, 1)!;
  assert.equal(group.upgradeReleaseId, 3);
  assert.equal(group.listRankAt, 7000);
  db.close();
});

// --- Browse ordering within a tie -------------------------------------
//
// Every group created in one ingest batch shares that batch's list_rank_at.
// RSS feeds serve newest-first, so ingest processes the newest item first
// and it gets the lowest id in the batch — ascending id order within a tie
// is therefore already newest-first. The previous ORDER BY tiebroke on id
// descending, which put the batch's oldest item on top of the list.

test('browseGroups puts the lowest id first within a list_rank_at tie (newest ingested first)', () => {
  const db = openTestDatabase();
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 1),
            (3, 'f', 'g3', 'T3', 'https://indexer.invalid/3.nzb', 1)`,
  ).run();
  // Ids 1..3 simulate ingest walking one RSS batch newest-first: id 1 is the
  // newest item (processed first, so it got the lowest id), id 3 the oldest.
  // All three land in the same batch, so they share one list_rank_at.
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 100, 500),
            (2, 'test', 'k2', '{"title":"G2","fields":[]}', 'g2', 100, 500),
            (3, 'test', 'k3', '{"title":"G3","fields":[]}', 'g3', 100, 500)`,
  ).run();

  const page = browseGroups(db, { cursor: null, limit: 10, search: null });

  assert.deepEqual(page.map((group) => group.id), [1, 2, 3]);
  db.close();
});

test('keyset pagination over a list_rank_at tie yields every row exactly once, in order, with no duplicates', () => {
  const db = openTestDatabase();
  const values: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    values.push(
      `(${i}, 'f', 'g${i}', 'T${i}', 'https://indexer.invalid/${i}.nzb', 1)`,
    );
  }
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at) VALUES ${values.join(', ')}`,
  ).run();
  const groupValues: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    groupValues.push(
      `(${i}, 'test', 'k${i}', '{"title":"G${i}","fields":[]}', 'g${i}', 100, 500)`,
    );
  }
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at) VALUES ${groupValues.join(', ')}`,
  ).run();

  const seen: number[] = [];
  let cursor: { listRankAt: number; id: number } | null = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = browseGroups(db, { cursor, limit: 2, search: null });
    if (page.length === 0) break;
    for (const group of page) seen.push(group.id);
    const last = page.at(-1);
    cursor = last === undefined ? null : { listRankAt: last.listRankAt, id: last.id };
  }

  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  db.close();
});

// pickedGroups backs the unpaginated Picks page and has no cursor to keep in
// step, but it orders on the same (list_rank_at, id) pair as browseGroups and
// must agree with it — a picked group with an upgrade flagged appears on
// both pages, and the same tie must not render in opposite order on one page
// versus the other.
test('browseGroups and pickedGroups agree on the order of the same tied, upgrade-flagged groups', () => {
  const db = openTestDatabase();
  const feedItemValues: string[] = [];
  const releaseValues: string[] = [];
  const groupValues: string[] = [];
  for (let g = 1; g <= 3; g += 1) {
    const pickedFeedItemId = g * 2 - 1;
    const upgradeFeedItemId = g * 2;
    feedItemValues.push(
      `(${pickedFeedItemId}, 'f', 'g${pickedFeedItemId}', 'T${pickedFeedItemId}', 'https://indexer.invalid/${pickedFeedItemId}.nzb', 1)`,
      `(${upgradeFeedItemId}, 'f', 'g${upgradeFeedItemId}', 'T${upgradeFeedItemId}', 'https://indexer.invalid/${upgradeFeedItemId}.nzb', 1)`,
    );
    releaseValues.push(
      `(${pickedFeedItemId}, ${g}, ${pickedFeedItemId}, '{}', 100, 1)`,
      `(${upgradeFeedItemId}, ${g}, ${upgradeFeedItemId}, '{}', 200, 1)`,
    );
    groupValues.push(
      `(${g}, 'test', 'k${g}', '{"title":"G${g}","fields":[]}', 'g${g}', 'picked', ${pickedFeedItemId}, ${upgradeFeedItemId}, 100, 500)`,
    );
  }
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at) VALUES ${feedItemValues.join(', ')}`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, upgrade_release_id, created_at, list_rank_at)
     VALUES ${groupValues.join(', ')}`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at) VALUES ${releaseValues.join(', ')}`,
  ).run();

  const browseIds = browseGroups(db, { cursor: null, limit: 10, search: null }).map(
    (group) => group.id,
  );
  const picksIds = pickedGroups(db).map((group) => group.id);

  assert.deepEqual(browseIds, [1, 2, 3]);
  assert.deepEqual(picksIds, [1, 2, 3]);
  assert.deepEqual(browseIds, picksIds);
  db.close();
});
