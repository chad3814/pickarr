import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { failedReleaseIds, pickedGroups } from '../../src/db/groups.ts';

// A group holding a failed download is invisible everywhere else. Browse lists
// `state = 'new' OR upgrade_release_id IS NOT NULL`, and a picked group whose
// failure has just cost it its upgrade flag is neither — so the Picks page is
// the only screen that can point at it, and only if it sorts the group
// somewhere the user will look. Hence: failed groups first, and the existing
// (list_rank_at DESC, id ASC) order underneath, untouched.
//
// The rule is *per release, then any*: a group counts when **any** release it
// holds has a failed latest download. Both halves are load-bearing.
//
// "Any release" rather than "the pick", because the pick is often not what
// failed — an upgrade defers moving `picked_release_id` until the replacement
// imports, so a failed upgrade leaves the pointer on a release that imported
// perfectly well.
//
// "Latest download" per release rather than the group's last download overall,
// because re-picking a release whose earlier attempt failed inserts a second
// `downloads` row (`inFlightForRelease` excludes only 'failed', so nothing
// stops it) — a release that is downloading again has recovered, and a healthy
// download of some *other* release says nothing about the one that failed.

interface GroupSpec {
  id: number;
  listRankAt: number;
}

/**
 * One picked group per spec, each holding two releases: the pick (id
 * `2 * groupId - 1`) and an untried alternative (id `2 * groupId`). Two, so a
 * test can hang a download off either one and say which release the failure
 * belongs to — the distinction the ordering rule turns on.
 */
function seedPicked(db: DatabaseSync, specs: GroupSpec[]): void {
  const feedItems: string[] = [];
  const groups: string[] = [];
  const releases: string[] = [];
  for (const spec of specs) {
    const pick = pickOf(spec.id);
    const alternative = alternativeOf(spec.id);
    for (const id of [pick, alternative]) {
      feedItems.push(`(${id}, 'f', 'g${id}', 'T${id}', 'https://indexer.invalid/${id}.nzb', 1)`);
      releases.push(`(${id}, ${spec.id}, ${id}, '{}', ${id * 100}, 1)`);
    }
    groups.push(
      `(${spec.id}, 'test', 'k${spec.id}', '{"title":"G${spec.id}","fields":[]}', 'g${spec.id}',` +
        ` 'picked', ${pick}, 100, ${spec.listRankAt})`,
    );
  }
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES ${feedItems.join(', ')}`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES ${groups.join(', ')}`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES ${releases.join(', ')}`,
  ).run();
}

/** The release `seedPicked` pointed the group's `picked_release_id` at. */
function pickOf(groupId: number): number {
  return groupId * 2 - 1;
}

/** The other release the group holds — never picked, always available. */
function alternativeOf(groupId: number): number {
  return groupId * 2;
}

/**
 * Appends a download to a release. Ids are assigned by the table, so calling
 * this twice for one release makes the second call the more recent attempt —
 * which is the whole of what "most recent" means here.
 */
function addDownload(
  db: DatabaseSync,
  groupId: number,
  releaseId: number,
  status: string,
): void {
  db.prepare(
    `INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (?, ?, 'sab', 'initial', ?, 1, 1)`,
  ).run(releaseId, groupId, status);
}

function orderOf(db: DatabaseSync): number[] {
  return pickedGroups(db).map((group) => group.id);
}

test('a group whose pick failed sorts above a newer group whose pick imported', () => {
  const db = openTestDatabase();
  // Group 1 is the older of the two by list_rank_at, so ordering on that column
  // alone buries it under group 2 — exactly what hid the reported group.
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 500 },
  ]);
  addDownload(db, 1, pickOf(1), 'failed');
  addDownload(db, 2, pickOf(2), 'imported');

  assert.deepEqual(orderOf(db), [1, 2]);
  db.close();
});

test('failed groups keep the existing list_rank_at DESC, id ASC order among themselves', () => {
  const db = openTestDatabase();
  // Groups 1 and 2 share a list_rank_at — one ingest batch — and ascending id
  // inside that tie is newest-first, because ingest walks an RSS batch
  // newest-first and the newest item takes the lowest id. Group 3 ranks above
  // both. Sorting failures to the front must not disturb any of that.
  seedPicked(db, [
    { id: 1, listRankAt: 500 },
    { id: 2, listRankAt: 500 },
    { id: 3, listRankAt: 900 },
  ]);
  for (const id of [1, 2, 3]) addDownload(db, id, pickOf(id), 'failed');

  assert.deepEqual(orderOf(db), [3, 1, 2]);
  db.close();
});

test('a failed pick that is downloading again does not sort to the top', () => {
  const db = openTestDatabase();
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 500 },
  ]);
  // Picked, failed, picked again: two rows for one release. The group is being
  // dealt with, so it is not a group needing attention.
  addDownload(db, 1, pickOf(1), 'failed');
  addDownload(db, 1, pickOf(1), 'queued');
  addDownload(db, 2, pickOf(2), 'imported');

  assert.deepEqual(orderOf(db), [2, 1]);
  db.close();
});

test('a failed download on a release nobody picked still sorts to the top', () => {
  const db = openTestDatabase();
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 500 },
  ]);
  // The reported shape: the user owns the pick, which imported fine, and the
  // *upgrade* they asked for failed. `pickRelease` records that as an upgrade,
  // so `picked_release_id` never moved off the file they already had — asking
  // only whether the pick failed answers no, and the group goes unlisted while
  // Browse advertises the release that just failed.
  addDownload(db, 1, pickOf(1), 'imported');
  addDownload(db, 1, alternativeOf(1), 'failed');
  addDownload(db, 2, pickOf(2), 'imported');

  assert.deepEqual(orderOf(db), [1, 2]);
  db.close();
});

test('a group is judged by every release it holds, not by the last download it happened to start', () => {
  const db = openTestDatabase();
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 500 },
  ]);
  // Group 1's alternative failed and has not been retried; its pick then
  // downloaded fine. "The group's most recent download" is that healthy one, so
  // a rule reading the group's downloads as a single stream calls this group
  // well — but a release in it is still failed, unretried, and worth showing.
  // The rule is per release, then any.
  addDownload(db, 1, alternativeOf(1), 'failed');
  addDownload(db, 1, pickOf(1), 'imported');
  addDownload(db, 2, pickOf(2), 'imported');

  assert.deepEqual(orderOf(db), [1, 2]);
  db.close();
});

test('failedReleaseIds names exactly the releases the ordering counts', () => {
  const db = openTestDatabase();
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 500 },
  ]);
  addDownload(db, 1, pickOf(1), 'failed');
  // Retried, and this time it is running: no longer failed, so neither flagged
  // nor marked.
  addDownload(db, 1, alternativeOf(1), 'failed');
  addDownload(db, 1, alternativeOf(1), 'queued');
  addDownload(db, 2, pickOf(2), 'imported');

  // The set the card marks rows from and the flag the list sorts on are one
  // query; a group hoisted to the top with no row on it marked is the drift
  // this pins. Spelled as the literal release id rather than `pickOf(1)`: an
  // expectation computed by the same helper that seeded the row would survive
  // that helper changing under it.
  assert.deepEqual([...failedReleaseIds(db, 1)], [1]);
  assert.deepEqual([...failedReleaseIds(db, 2)], []);
  assert.deepEqual(orderOf(db), [1, 2]);
  db.close();
});

test('a picked group with no downloads at all keeps its place', () => {
  const db = openTestDatabase();
  // Group 1 ranks above group 2 and has never been downloaded; group 2 has a
  // download that succeeded. "No download" and "a download that did not fail"
  // are the same answer — not failed — and must not split into two sort keys,
  // which is what a NULL leaking out of the flag expression would do.
  seedPicked(db, [
    { id: 1, listRankAt: 500 },
    { id: 2, listRankAt: 300 },
  ]);
  addDownload(db, 2, pickOf(2), 'imported');

  assert.deepEqual(orderOf(db), [1, 2]);
  db.close();
});
