import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { recoverInterruptedWork } from '../../src/pipeline/recover.ts';
import { getDownload } from '../../src/db/downloads.ts';

function seed(db: DatabaseSync, rows: [number, string, string | null][]): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'T', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{}', 't', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 1, 1)`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status, created_at, updated_at)
     VALUES (?, 1, 1, 'sab', ?, 'initial', ?, 1, 1)`,
  );
  for (const [id, status, clientRef] of rows) insert.run(id, clientRef, status);
}

test('importing resets to completed so the next tick redoes the import', () => {
  const db = openTestDatabase();
  seed(db, [[1, 'importing', 'nzo_1']]);
  const result = recoverInterruptedWork(db, 500);
  assert.equal(getDownload(db, 1)?.status, 'completed');
  assert.equal(result.importsReset, 1);
  db.close();
});

test('queued with no client ref is left queued for retry and counted', () => {
  const db = openTestDatabase();
  seed(db, [[1, 'queued', null]]);
  const result = recoverInterruptedWork(db, 500);
  assert.equal(getDownload(db, 1)?.status, 'queued');
  assert.equal(result.pendingAddUrl, 1);
  db.close();
});

test('terminal and in-flight rows are untouched', () => {
  const db = openTestDatabase();
  seed(db, [
    [1, 'imported', 'nzo_1'],
    [2, 'failed', 'nzo_2'],
    [3, 'downloading', 'nzo_3'],
  ]);
  recoverInterruptedWork(db, 500);
  assert.equal(getDownload(db, 1)?.status, 'imported');
  assert.equal(getDownload(db, 2)?.status, 'failed');
  assert.equal(getDownload(db, 3)?.status, 'downloading');
  db.close();
});
