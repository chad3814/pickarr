import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  clearParseError,
  dismissedFeedItems,
  getFeedItem,
  setDismissedAt,
} from '../../src/db/feed-items.ts';
import {
  deleteGroup,
  getGroup,
  groupHistory,
  markGroupEdited,
  moveReleasesToGroup,
  refreshUpgradeFlag,
  updateGroupIdentity,
} from '../../src/db/groups.ts';
import {
  getRelease,
  markReleaseEdited,
  releasesForGroup,
  updateReleaseQuality,
} from '../../src/db/releases.ts';
import { maybeNum, type SqlRow } from '../../src/db/row.ts';

// Browse's failed branch, the Dismissed tab, the group editor and the release
// editor all read and write rows the parser produced. These are the
// storage-level pieces they stand on: a listing of what was dismissed, the
// two `edited_at` stamps that record a human touched a row, and the merge
// primitives an identity edit needs.

/**
 * Six feed items covering every case the Dismissed list has to sort out: two
 * live (non-dismissed) failures sharing one `first_seen_at`, two dismissed
 * failures sharing a different `first_seen_at` (so the dismissed-only tie
 * ordering is observable on its own), a third dismissed failure standing
 * alone as the newest row overall, and an item that parsed cleanly.
 *
 * Ids ascend as `first_seen_at` descends, mirroring ingest: a batch is walked
 * newest-first, so within one batch the lowest id is the newest item.
 */
function seedFeedItems(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, published_at,
                             first_seen_at, parse_error, dismissed_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', NULL, 300, 'no site',  NULL),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', NULL, 300, 'no date',  NULL),
            (3, 'f', 'g3', 'T3', 'https://indexer.invalid/3.nzb', NULL, 200, 'no title', 900),
            (4, 'f', 'g4', 'T4', 'https://indexer.invalid/4.nzb', 1234, 100, NULL,       NULL),
            (5, 'f', 'g5', 'T5', 'https://indexer.invalid/5.nzb', NULL, 200, 'no scene', 950),
            (6, 'f', 'g6', 'T6', 'https://indexer.invalid/6.nzb', NULL, 350, 'no site',  1000)`,
  ).run();
}

/**
 * Two groups with two releases each. Group 1 is picked on its *worse* release,
 * so the upgrade flag has something to find; group 2 is unpicked and exists to
 * be merged away.
 */
function seedGroups(db: DatabaseSync): void {
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
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 'picked', 1,    100, 500),
            (2, 'test', 'k2', '{"title":"G2","fields":[]}', 'g2', 'new',    NULL, 100, 600)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":720}',  720,  1),
            (2, 1, 2, '{"resolution":1080}', 1080, 1),
            (3, 2, 3, '{"resolution":720}',  720,  1),
            (4, 2, 4, '{"resolution":1080}', 1080, 1)`,
  ).run();
}

/** `edited_at` is not on `ReleaseRow`, so tests read the column directly. */
function releaseEditedAt(db: DatabaseSync, id: number): number | null {
  const row = db.prepare('SELECT edited_at FROM releases WHERE id = ?').get(id);
  if (row === undefined) throw new Error(`no release ${id}`);
  return maybeNum(row as SqlRow, 'edited_at');
}

// --- Dismissed feed items -----------------------------------------------

test('dismissedFeedItems lists only dismissed items, newest first, lowest id within a tie', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const page = dismissedFeedItems(db, { cursor: null, limit: 10 });

  // Items 1 and 2 are live failures, never dismissed; item 4 parsed. Item 6 is
  // the newest dismissal and stands alone; items 3 and 5 share a
  // first_seen_at, and ascending id inside that tie is newest-first for the
  // same reason browseGroups tiebreaks that way.
  assert.deepEqual(
    page.map((item) => item.id),
    [6, 3, 5],
  );
  db.close();
});

test('dismissedFeedItems excludes a live failure and a cleanly parsed item', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const ids = dismissedFeedItems(db, { cursor: null, limit: 10 }).map((item) => item.id);

  assert.equal(ids.includes(1), false, 'item 1 is a live failure, never dismissed');
  assert.equal(ids.includes(4), false, 'item 4 parsed cleanly and was never a failure at all');
  db.close();
});

test('dismissedFeedItems pages over a first_seen_at tie exactly once per row', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const seen: number[] = [];
  let cursor: { firstSeenAt: number; id: number } | null = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = dismissedFeedItems(db, { cursor, limit: 1 });
    if (page.length === 0) break;
    for (const item of page) seen.push(item.id);
    const last = page.at(-1);
    cursor = last === undefined ? null : { firstSeenAt: last.firstSeenAt, id: last.id };
  }

  // The tie between 3 and 5 is where a cursor that tiebroke in the other
  // direction from the ORDER BY would either skip a row or repeat one.
  assert.deepEqual(seen, [6, 3, 5]);
  db.close();
});

test('getFeedItem maps every column the Dismissed list needs', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  const dismissed = getFeedItem(db, 3);
  const parsed = getFeedItem(db, 4);

  assert.equal(dismissed?.feedId, 'f');
  assert.equal(dismissed?.guid, 'g3');
  assert.equal(dismissed?.rawTitle, 'T3');
  assert.equal(dismissed?.link, 'https://indexer.invalid/3.nzb');
  assert.equal(dismissed?.publishedAt, null);
  assert.equal(dismissed?.firstSeenAt, 200);
  assert.equal(dismissed?.parseError, 'no title');
  assert.equal(dismissed?.dismissedAt, 900);
  assert.equal(parsed?.publishedAt, 1234);
  assert.equal(parsed?.parseError, null);
  assert.equal(getFeedItem(db, 99), null);
  db.close();
});

test('clearParseError also clears dismissed_at, because a resolve overrides a dismissal', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  clearParseError(db, 3);

  const item = getFeedItem(db, 3);
  assert.equal(item?.parseError, null);
  // Leaving dismissed_at set would keep a now-resolved item filtered out of
  // Browse's own list while it holds a perfectly good release.
  assert.equal(item?.dismissedAt, null);
  assert.deepEqual(
    dismissedFeedItems(db, { cursor: null, limit: 10 }).map((row) => row.id),
    [6, 5],
  );
  db.close();
});

test('setDismissedAt stamps the item and it joins the Dismissed list', () => {
  const db = openTestDatabase();
  seedFeedItems(db);

  setDismissedAt(db, 1, 5000);

  assert.equal(getFeedItem(db, 1)?.dismissedAt, 5000);
  assert.deepEqual(
    dismissedFeedItems(db, { cursor: null, limit: 10 }).map((item) => item.id),
    [6, 1, 3, 5],
  );
  db.close();
});

// --- Upgrade flag ------------------------------------------------------

test('refreshUpgradeFlag flags the better release without moving list_rank_at', () => {
  const db = openTestDatabase();
  seedGroups(db);
  const before = getGroup(db, 1)!;

  refreshUpgradeFlag(db, 1);

  const after = getGroup(db, 1)!;
  assert.equal(after.upgradeReleaseId, 2);
  // The whole reason this helper exists instead of reusing `flagUpgrade`:
  // correcting a release's quality is not a release arriving, so the group
  // must not jump to the top of the browse list.
  assert.equal(after.listRankAt, before.listRankAt);
  db.close();
});

test('refreshUpgradeFlag clears a stale flag when nothing beats the pick', () => {
  const db = openTestDatabase();
  seedGroups(db);
  // Picked on the best release, but still carrying a flag from before the
  // pick — exactly the state a quality correction can leave behind.
  db.prepare('UPDATE media_groups SET picked_release_id = 2, upgrade_release_id = 1 WHERE id = 1')
    .run();
  const before = getGroup(db, 1)!;

  refreshUpgradeFlag(db, 1);

  const after = getGroup(db, 1)!;
  assert.equal(after.upgradeReleaseId, null);
  assert.equal(after.listRankAt, before.listRankAt);
  db.close();
});

test('refreshUpgradeFlag on a missing group is silent and disturbs no other group', () => {
  const db = openTestDatabase();
  seedGroups(db);
  // Both groups carry a flag, so a write that escaped its WHERE clause — or a
  // derivation run against the wrong row — would show up in the comparison.
  db.prepare('UPDATE media_groups SET upgrade_release_id = 2 WHERE id = 1').run();
  db.prepare('UPDATE media_groups SET upgrade_release_id = 4 WHERE id = 2').run();
  const before = [getGroup(db, 1), getGroup(db, 2)];

  refreshUpgradeFlag(db, 99);

  assert.deepEqual([getGroup(db, 1), getGroup(db, 2)], before);
  db.close();
});

// --- Edit stamps -------------------------------------------------------

test('markGroupEdited writes edited_at and nothing else', () => {
  const db = openTestDatabase();
  seedGroups(db);
  const before = getGroup(db, 1)!;
  assert.equal(before.editedAt, null);

  markGroupEdited(db, 1, 4242);

  assert.deepEqual(getGroup(db, 1), { ...before, editedAt: 4242 });
  db.close();
});

test('markReleaseEdited writes edited_at and nothing else', () => {
  const db = openTestDatabase();
  seedGroups(db);
  const before = getRelease(db, 1)!;
  assert.equal(releaseEditedAt(db, 1), null);

  markReleaseEdited(db, 1, 4242);

  assert.deepEqual(getRelease(db, 1), before);
  assert.equal(releaseEditedAt(db, 1), 4242);
  db.close();
});

// --- Identity and quality edits ---------------------------------------

test('updateGroupIdentity rewrites the three identity columns only', () => {
  const db = openTestDatabase();
  seedGroups(db);
  const before = getGroup(db, 1)!;

  updateGroupIdentity(db, {
    id: 1,
    identityKey: 'k1-fixed',
    display: '{"title":"Fixed","fields":[]}',
    searchText: 'fixed',
  });

  assert.deepEqual(getGroup(db, 1), {
    ...before,
    identityKey: 'k1-fixed',
    display: '{"title":"Fixed","fields":[]}',
    searchText: 'fixed',
  });
  db.close();
});

test('updateReleaseQuality rewrites quality and score and nothing else', () => {
  const db = openTestDatabase();
  seedGroups(db);
  const before = getRelease(db, 1)!;
  markReleaseEdited(db, 1, 111);

  updateReleaseQuality(db, { id: 1, quality: '{"resolution":2160}', score: 2160 });

  assert.deepEqual(getRelease(db, 1), {
    ...before,
    quality: '{"resolution":2160}',
    score: 2160,
  });
  // A quality correction is not itself the stamp — the operation layer decides
  // when to write edited_at, so this helper must leave an existing one alone.
  assert.equal(releaseEditedAt(db, 1), 111);
  db.close();
});

test('a quality correction that overtakes the flagged release clears the flag', () => {
  const db = openTestDatabase();
  seedGroups(db);
  // Group 1 is picked on release 1 (720) with release 2 (1080) flagged above
  // it — the state a real group is in before anyone edits anything.
  db.prepare('UPDATE media_groups SET upgrade_release_id = 2 WHERE id = 1').run();

  updateReleaseQuality(db, { id: 1, quality: '{"resolution":2160}', score: 2160 });
  refreshUpgradeFlag(db, 1);

  // The pick is now the best release in the group, so the flag has to go from
  // 2 to nothing. Seeding it as 2 first is what makes this a transition rather
  // than a restatement of the seed.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, null);
  db.close();
});

// --- Merge -------------------------------------------------------------

test('groupHistory is null until a download or an imported file references the group', () => {
  const db = openTestDatabase();
  seedGroups(db);
  assert.equal(groupHistory(db, 2), null);

  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (1, 3, 2, 'sab', 'initial', 'queued', 1, 1)`,
  ).run();

  assert.equal(groupHistory(db, 2), 'downloads');
  db.close();
});

test('groupHistory names an imported file even with no download of its own', () => {
  const db = openTestDatabase();
  seedGroups(db);
  // The download belongs to group 1; only the imported file points at group 2.
  // Artificial, but it is the one arrangement that exercises the second check
  // on its own — imported_files.download_id is NOT NULL, so group 2 cannot
  // have an imported file without some download existing somewhere.
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (1, 1, 2, '/a', '/b', 10, 1)`,
  ).run();

  assert.equal(groupHistory(db, 2), 'imported-files');
  db.close();
});

test('groupHistory counts a trashed imported file, because the file was still placed', () => {
  const db = openTestDatabase();
  seedGroups(db);
  // Again the download hangs off group 1, so the trashed file is the only
  // thing group 2 has — otherwise the download would answer for it.
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path, size_bytes, trashed_at, created_at)
     VALUES (1, 1, 2, '/a', '/b', 10, 500, 1)`,
  ).run();

  assert.equal(groupHistory(db, 2), 'imported-files');
  db.close();
});

test('groupHistory reports the imported file when a group has both', () => {
  const db = openTestDatabase();
  seedGroups(db);
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (1, 3, 2, 'sab', 'initial', 'imported', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (1, 1, 2, '/a', '/b', 10, 1)`,
  ).run();

  // The ordering only decides anything here, and here the download has already
  // landed: there are files in the library under this group's name. That is
  // the heavier fact, and the one the user has to go and look at.
  assert.equal(groupHistory(db, 2), 'imported-files');
  db.close();
});

// `deleteGroup`'s contract is that anything still referencing the row stops
// the delete rather than being orphaned by it, and that contract is the whole
// safety net under Task 5's merge. Three tables reference media_groups(id);
// each gets its own case, and each matches on the constraint rather than on
// "something threw" — an assert.throws with no matcher passes for a typo'd
// table name just as happily as for the constraint it meant to prove.
const FOREIGN_KEY_ERROR = /FOREIGN KEY/;

test('moveReleasesToGroup must run before deleteGroup, which the foreign key enforces', () => {
  const db = openTestDatabase();
  seedGroups(db);

  assert.throws(() => {
    deleteGroup(db, 2);
  }, FOREIGN_KEY_ERROR);

  moveReleasesToGroup(db, 2, 1);
  deleteGroup(db, 2);

  assert.equal(getGroup(db, 2), null);
  // releasesForGroup orders by score DESC, id DESC: the two 1080s, then the
  // two 720s.
  assert.deepEqual(
    releasesForGroup(db, 1).map((release) => release.id),
    [4, 2, 3, 1],
  );
  db.close();
});

test('deleteGroup refuses a group a download still references', () => {
  const db = openTestDatabase();
  seedGroups(db);
  moveReleasesToGroup(db, 2, 1);
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (1, 3, 2, 'sab', 'initial', 'queued', 1, 1)`,
  ).run();

  // Emptying the releases is not enough on its own — which is exactly why the
  // merge asks groupHasHistory before it starts, rather than relying on the
  // delete to tell it.
  assert.throws(() => {
    deleteGroup(db, 2);
  }, FOREIGN_KEY_ERROR);
  assert.notEqual(getGroup(db, 2), null);
  db.close();
});

test('deleteGroup refuses a group an imported file still references', () => {
  const db = openTestDatabase();
  seedGroups(db);
  moveReleasesToGroup(db, 2, 1);
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 1, 1)`,
  ).run();
  // The download hangs off group 1, so group 2 is held only by the imported
  // file — the second referencing table on its own.
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (1, 1, 2, '/a', '/b', 10, 1)`,
  ).run();

  assert.throws(() => {
    deleteGroup(db, 2);
  }, FOREIGN_KEY_ERROR);
  assert.notEqual(getGroup(db, 2), null);
  db.close();
});

test('moveReleasesToGroup empties the source without deleting it', () => {
  const db = openTestDatabase();
  seedGroups(db);

  moveReleasesToGroup(db, 2, 1);

  assert.equal(releasesForGroup(db, 2).length, 0);
  assert.equal(releasesForGroup(db, 1).length, 4);
  // The source row survives the move; deleting it is the caller's separate,
  // and separately fallible, second statement.
  assert.notEqual(getGroup(db, 2), null);
  db.close();
});
