import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { liveFilesForOtherReleases } from '../../src/db/imported-files.ts';

/**
 * Group 1 holds releases 1 and 2. Release 1 imported twice — downloads 1 and 3,
 * a retry — which is the whole point of this fixture: a release-scoped question
 * must keep *both* of release 1's files, and a download-scoped one cannot.
 */
function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"T","fields":[]}', 't', 'picked', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://i.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://i.invalid/2.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":1080}', 1080, 100),
            (2, 1, 2, '{"resolution":2160}', 2160, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 100, 100),
            (2, 2, 1, 'sab', 'upgrade', 'imported', 100, 100),
            (3, 1, 1, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, trashed_at, created_at)
     VALUES (1, 1, 1, '/dl/a.mp4', '/library/a.mp4', 10, NULL, 100),
            (2, 2, 1, '/dl/b.mp4', '/library/b.mp4', 20, NULL, 100),
            (3, 3, 1, '/dl/c.mp4', '/library/c.mp4', 30, NULL, 100),
            (4, 1, 1, '/dl/d.mp4', '/library/d.mp4', 40, 500,  100)`,
  ).run();
}

test('liveFilesForOtherReleases returns the files of every release but the kept one', () => {
  const db = openTestDatabase();
  seed(db);

  const rows = liveFilesForOtherReleases(db, 1, 2);

  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 3],
  );
});

test('liveFilesForOtherReleases skips files already trashed', () => {
  const db = openTestDatabase();
  seed(db);

  const rows = liveFilesForOtherReleases(db, 1, 2);

  assert.ok(!rows.some((row) => row.id === 4), 'row 4 is trashed and must not be returned');
});

test('liveFilesForOtherReleases with no kept release returns every live file', () => {
  const db = openTestDatabase();
  seed(db);

  const rows = liveFilesForOtherReleases(db, 1, null);

  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 2, 3],
  );
});

/**
 * The bug that ruled out reusing `liveFilesForGroup(db, groupId, downloadId)`.
 * Release 1 imported across downloads 1 and 3; excluding one download would
 * offer up the other's file for trashing, and that file belongs to the release
 * being kept.
 */
test('a release that imported twice keeps both of its files when it is the kept one', () => {
  const db = openTestDatabase();
  seed(db);

  const rows = liveFilesForOtherReleases(db, 1, 1);

  assert.deepEqual(
    rows.map((row) => row.id),
    [2],
    'only release 2s file is trashable; both of release 1s must survive',
  );
});
