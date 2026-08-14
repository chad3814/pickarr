import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { failedReleaseIds, flagUpgrade, getGroup, pickedGroups } from '../../src/db/groups.ts';
import { failDownload } from '../../src/db/downloads.ts';

// A group holding a failed download is invisible everywhere else. Browse lists
// `state = 'new' OR upgrade_release_id IS NOT NULL`, and a picked group whose
// failure has just cost it its upgrade flag is neither — so the Picks page is
// the only screen that can point at it, and only if it sorts the group
// somewhere the user will look.
//
// It earns that place with a `list_rank_at` bump at the moment it fails, not
// with a sort key that puts failures ahead of everything. Ordering on `EXISTS (a
// release whose latest download failed)` was the first version of this and it
// pinned rather than surfaced: the predicate is per release and clears only when
// *that* release is downloaded again, so a group whose 2160p failed and whose
// 1080p then imported perfectly well sat above every healthy group forever. With
// several such groups the top of the list was permanently theirs, in an order
// that never changed and never reflected which had just happened. There is no
// time in a boolean.
//
// A bump says the same thing and then stops saying it. The group goes to the top
// the instant it fails, and every later event that lifts another group — an
// upgrade arriving, another failure — moves it down one, so the list stays
// ordered by what happened most recently. Nothing has to clear the mark, which
// is the same reason `latestDownloadFailed` reads the most recent attempt rather
// than storing a flag.
//
// The per-release marking is untouched: `failedReleaseIds` still names the rows
// the card marks `Failed`, and that answer is still "the latest download of this
// release failed". Only the group's *place in the list* stopped being derived
// from it.

interface GroupSpec {
  id: number;
  listRankAt: number;
}

/**
 * One picked group per spec, each holding two releases: the pick (id
 * `2 * groupId - 1`) and an untried alternative (id `2 * groupId`). Two, so a
 * test can hang a download off either one and say which release the failure
 * belongs to — the distinction the per-release marking turns on.
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
 * Appends a download to a release and returns its id. Ids are assigned by the
 * table, so calling this twice for one release makes the second call the more
 * recent attempt — which is the whole of what "most recent" means here. The id
 * comes back because the tests that matter here fail the download through
 * `failDownload`, the only writer of `status = 'failed'` and so the only place
 * the bump can live.
 */
function addDownload(
  db: DatabaseSync,
  groupId: number,
  releaseId: number,
  status: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
       VALUES (?, ?, 'sab', 'initial', ?, 1, 1)`,
    )
    .run(releaseId, groupId, status);
  return Number(result.lastInsertRowid);
}

/** Fails a release's freshly-added download at `now`, the way reconcile does. */
function failFor(db: DatabaseSync, groupId: number, releaseId: number, now: number): void {
  const id = addDownload(db, groupId, releaseId, 'downloading');
  failDownload(db, id, 'Repair failed, not enough repair blocks (92 short)', now);
}

function orderOf(db: DatabaseSync): number[] {
  return pickedGroups(db).map((group) => group.id);
}

test('a failure lifts its group to the top of the list', () => {
  const db = openTestDatabase();
  // Group 1 is the older of the two by list_rank_at, so before the failure it
  // sorts under group 2 — which is exactly what hid the reported group.
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 500 },
  ]);
  addDownload(db, 2, pickOf(2), 'imported');
  assert.deepEqual(orderOf(db), [2, 1]);

  failFor(db, 1, pickOf(1), 900);

  assert.deepEqual(orderOf(db), [1, 2]);
  // The bump is the mechanism, so it is worth pinning directly: the group's rank
  // is the moment it failed, not some rank-adjacent value that merely happens to
  // sort first today.
  assert.equal(getGroup(db, 1)?.listRankAt, 900);
  db.close();
});

test('a lifted group drifts back down as later events lift others', () => {
  const db = openTestDatabase();
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 200 },
    { id: 3, listRankAt: 300 },
  ]);
  failFor(db, 1, pickOf(1), 900);
  assert.deepEqual(orderOf(db), [1, 3, 2]);

  // An upgrade arriving on group 2 — the one event that bumped a group before
  // this change — outranks a failure that is now in the past.
  flagUpgrade(db, 2, 1000);
  assert.deepEqual(orderOf(db), [2, 1, 3]);

  // And so does a later failure. Two failed groups order newest-first rather
  // than sitting together in an order that says nothing.
  failFor(db, 3, pickOf(3), 1100);
  assert.deepEqual(orderOf(db), [3, 2, 1]);
  db.close();
});

test('a group whose other version succeeded is not pinned by the version that failed', () => {
  const db = openTestDatabase();
  // The reported bug, at its simplest. Group 1's 2160p failed long ago; its
  // 1080p then imported, so the user has the content. Nothing about that group
  // is urgent any more, but the failed release's latest download is still
  // `failed` — it is never retried, because there is no reason to retry it — so
  // a boolean sort key kept the group at the very top permanently.
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 500 },
  ]);
  failFor(db, 1, alternativeOf(1), 300);
  addDownload(db, 1, pickOf(1), 'imported');
  addDownload(db, 2, pickOf(2), 'imported');

  // Group 1 was lifted when it failed, at 300, and group 2 ranks above that.
  assert.deepEqual(orderOf(db), [2, 1]);
  // The release is still marked, which is the part a screen reads. Only the
  // group's place in the list stopped being derived from it.
  assert.deepEqual([...failedReleaseIds(db, 1)], [alternativeOf(1)]);
  db.close();
});

test('groups keep the list_rank_at DESC, id ASC order, failed or not', () => {
  const db = openTestDatabase();
  // Groups 1 and 2 share a list_rank_at — one ingest batch — and ascending id
  // inside that tie is newest-first, because ingest walks an RSS batch
  // newest-first and the newest item takes the lowest id. Group 3 ranks above
  // both. A failure anywhere in here must not disturb any of that.
  seedPicked(db, [
    { id: 1, listRankAt: 500 },
    { id: 2, listRankAt: 500 },
    { id: 3, listRankAt: 900 },
  ]);
  addDownload(db, 2, pickOf(2), 'failed');

  assert.deepEqual(orderOf(db), [3, 1, 2]);
  db.close();
});

test('failedReleaseIds still names exactly the releases whose latest attempt failed', () => {
  const db = openTestDatabase();
  seedPicked(db, [
    { id: 1, listRankAt: 100 },
    { id: 2, listRankAt: 500 },
  ]);
  addDownload(db, 1, pickOf(1), 'failed');
  // Retried, and this time it is running: no longer failed, so no longer marked.
  addDownload(db, 1, alternativeOf(1), 'failed');
  addDownload(db, 1, alternativeOf(1), 'queued');
  addDownload(db, 2, pickOf(2), 'imported');

  // Spelled as the literal release id rather than `pickOf(1)`: an expectation
  // computed by the same helper that seeded the row would survive that helper
  // changing under it.
  assert.deepEqual([...failedReleaseIds(db, 1)], [1]);
  assert.deepEqual([...failedReleaseIds(db, 2)], []);
  db.close();
});

test('a picked group with no downloads at all keeps its place', () => {
  const db = openTestDatabase();
  // Group 1 ranks above group 2 and has never been downloaded; group 2 has a
  // download that succeeded. Neither is a failure, so neither moves.
  seedPicked(db, [
    { id: 1, listRankAt: 500 },
    { id: 2, listRankAt: 300 },
  ]);
  addDownload(db, 2, pickOf(2), 'imported');

  assert.deepEqual(orderOf(db), [1, 2]);
  db.close();
});
