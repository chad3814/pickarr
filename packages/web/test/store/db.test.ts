import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { done, request } from '../../src/store/idb.ts';
import { openStore } from '../../src/store/db.ts';
import { readCursors, writeCursors, readGeneration, writeGeneration } from '../../src/store/meta.ts';

test('the store is keyed by table and id together', async () => {
  const db = await freshDb();
  const names = [...db.objectStoreNames].toSorted();
  assert.deepEqual(names, ['meta', 'rows']);
  const rows = db.transaction('rows').objectStore('rows');
  assert.deepEqual(rows.keyPath, ['table', 'id']);
  assert.deepEqual([...rows.indexNames].toSorted(),
    ['by_media_item', 'by_rss_item', 'by_table', 'by_table_updated']);
  db.close();
});

test('a tombstone is findable by key and invisible to every value index', async () => {
  const db = await freshDb();
  const tx = db.transaction('rows', 'readwrite');
  const rows = tx.objectStore('rows');
  rows.put({ table: 'rss_item', id: 1, value: { mediaItemId: 7, updatedAt: 5 } });
  rows.put({ table: 'rss_item', id: 2 });
  await done(tx);

  const byItem = await request(db.transaction('rows').objectStore('rows')
    .index('by_media_item').getAll(7));
  assert.equal(byItem.length, 1, 'the tombstone is not in the index');

  const tomb = await request(db.transaction('rows').objectStore('rows').get(['rss_item', 2]));
  assert.ok(tomb !== undefined, 'the tombstone is still at its key');
  db.close();
});

test('cursors and generation survive a close and reopen; a fresh database answers undefined for both', async () => {
  const name = 'meta-roundtrip';
  const opened = await openStore(name);
  assert.equal(await readCursors(opened), undefined, 'a fresh database has no cursors');
  assert.equal(await readGeneration(opened), undefined, 'a fresh database has no generation');

  await writeCursors(opened, { since: 42, before: 100 });
  await writeGeneration(opened, 'gen-1');
  opened.close();

  const reopened = await openStore(name);
  assert.deepEqual(await readCursors(reopened), { since: 42, before: 100 });
  assert.equal(await readGeneration(reopened), 'gen-1');
  reopened.close();
});
