import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  deferPerformerSearch,
  duePerformerQueue,
  groupHasCast,
  insertPerformerSearch,
  removePerformerSearch,
} from '../../src/db/performer-queue.ts';
import { clearGroupMetadata } from '../../src/db/metadata.ts';

/** One picked group holding one release, and nothing else. */
function seedGroup(db: DatabaseSync, id: number): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(id, `g${id}`, `T${id}`, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (?, 'test', ?, ?, ?, 'picked', 1, 1)`,
  ).run(id, `k${id}`, `{"title":"G${id}","fields":[]}`, `g${id}`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, ?, ?, '{}', 100, 1)`,
  ).run(id, id, id);
}

/** Gives the group a cast, the way a confirmed scene answer does. */
function giveCast(db: DatabaseSync, groupId: number): void {
  db.prepare(
    `INSERT INTO performers (id, source, source_uuid, slug, name, kind, fetched_at)
     VALUES (?, 'theporndb', ?, 'someone', 'Someone', 'performer', 1)`,
  ).run(groupId, `uuid-${groupId}`);
  db.prepare(
    'INSERT INTO group_performers (group_id, performer_id, position) VALUES (?, ?, 0)',
  ).run(groupId, groupId);
}

test('a queued group comes back due once its next_at has passed', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);

  assert.equal(insertPerformerSearch(db, 1, 500), true);
  assert.deepEqual(duePerformerQueue(db, 499, 10), []);
  assert.deepEqual(
    duePerformerQueue(db, 500, 10).map((row) => row.groupId),
    [1],
  );
  db.close();
});

test('inserting twice keeps the first request rather than jumping the line', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  seedGroup(db, 2);
  insertPerformerSearch(db, 1, 100);
  insertPerformerSearch(db, 2, 200);

  // The second call must not move group 1's requested_at forward: the queue is
  // drained in (requested_at, group_id) order, so a re-request that reset the
  // stamp would let a repeatedly-settled group starve everything behind it.
  assert.equal(insertPerformerSearch(db, 1, 900), false);
  assert.deepEqual(
    duePerformerQueue(db, 1000, 10).map((row) => row.groupId),
    [1, 2],
  );
  assert.equal(duePerformerQueue(db, 1000, 10)[0]?.requestedAt, 100);
  db.close();
});

test('a group that already has a cast is not queued', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  giveCast(db, 1);

  assert.equal(groupHasCast(db, 1), true);
  assert.equal(insertPerformerSearch(db, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 1000, 10), []);
  db.close();
});

test('deferring bumps attempts and pushes next_at out', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  insertPerformerSearch(db, 1, 100);

  deferPerformerSearch(db, 1, 'provider returned HTTP 503', 5000);

  assert.deepEqual(duePerformerQueue(db, 4999, 10), []);
  const row = duePerformerQueue(db, 5000, 10)[0];
  assert.equal(row?.attempts, 1);
  assert.equal(row?.lastError, 'provider returned HTTP 503');
  db.close();
});

test('removing takes the row out for good', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  insertPerformerSearch(db, 1, 100);

  removePerformerSearch(db, 1);

  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('the limit is honoured, and it is the oldest request that survives it', () => {
  const db = openTestDatabase();
  for (const id of [1, 2, 3]) seedGroup(db, id);
  insertPerformerSearch(db, 3, 100);
  insertPerformerSearch(db, 1, 200);
  insertPerformerSearch(db, 2, 300);

  assert.deepEqual(
    duePerformerQueue(db, 1000, 2).map((row) => row.groupId),
    [3, 1],
  );
  db.close();
});

test('clearGroupMetadata removes the queue row, so deleting the group cannot fail the foreign key', () => {
  // This exact defect has shipped twice: the group tables reference
  // media_groups with no cascade, so a merge's deleteGroup
  // returned a 500 for any group holding an invisible queue row. A new table
  // referencing media_groups re-creates it unless the clear hook knows.
  const db = openTestDatabase();
  seedGroup(db, 1);
  insertPerformerSearch(db, 1, 100);

  clearGroupMetadata(db, 1);

  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  // The delete is the point: this throws a FOREIGN KEY error if the row is
  // still there. `openTestDatabase` sets `PRAGMA foreign_keys = ON`.
  db.prepare('DELETE FROM releases WHERE group_id = ?').run(1);
  db.prepare('DELETE FROM media_groups WHERE id = ?').run(1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n'], 0);
  db.close();
});
