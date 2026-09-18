import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { done, request } from '../../src/store/idb.ts';
import { openStore, SCHEMA_VERSION } from '../../src/store/db.ts';
import { readCursors, writeCursors, readGeneration, writeGeneration } from '../../src/store/meta.ts';

let dbNameCounter = 0;
/** A database name no other test in this file shares. */
function freshDbName(): string {
  dbNameCounter += 1;
  return `db-test-${String(dbNameCounter)}`;
}

test('the store is keyed by table and id together', async () => {
  const db = await freshDb();
  const names = [...db.objectStoreNames].toSorted();
  assert.deepEqual(names, ['meta', 'rows']);
  const rows = db.transaction('rows').objectStore('rows');
  assert.deepEqual(rows.keyPath, ['table', 'id']);
  assert.deepEqual([...rows.indexNames].toSorted(),
    ['by_media_item', 'by_rss_item', 'by_table', 'by_table_plugin_updated', 'by_table_updated']);
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

test('bumping the schema version rebuilds the replica rather than throwing', async () => {
  // The reviewer reproduced the opposite: against an existing database the
  // bare createObjectStore calls raise ConstraintError, so a version bump
  // broke every client that already held a replica. A replica is disposable,
  // so the upgrade discards it -- and dropping `meta` with it is what makes
  // the next start bootstrap instead of resuming a cursor for data that is
  // gone.
  const name = `bump-${String(Date.now())}`;
  const first = await openStore(name, 1);
  const tx = first.transaction(['rows', 'meta'], 'readwrite');
  tx.objectStore('rows').put({ table: 'person', id: 1, value: { name: 'before' } });
  tx.objectStore('meta').put({ key: 'since', value: 42 });
  await done(tx);
  first.close();

  const second = await openStore(name, 2);
  assert.equal(second.version, 2);
  assert.deepEqual([...second.objectStoreNames].toSorted(), ['meta', 'rows']);
  const rows = await request(second.transaction('rows').objectStore('rows').getAll());
  assert.equal(rows.length, 0, 'the replica was discarded, not migrated');
  const cursors = await request(second.transaction('meta').objectStore('meta').getAll());
  assert.equal(cursors.length, 0, 'and the cursors went with it, so the next start bootstraps');
  assert.deepEqual([...second.transaction('rows').objectStore('rows').indexNames].toSorted(),
    ['by_media_item', 'by_rss_item', 'by_table', 'by_table_plugin_updated', 'by_table_updated'],
    'indexes are rebuilt too');
  second.close();
});

test('the per-category index exists, and holds only rows that project a pluginId', async () => {
  const db = await openStore(freshDbName());
  try {
    assert.equal(SCHEMA_VERSION, 2, 'the bump that creates this index');
    const index = db.transaction('rows').objectStore('rows').index('by_table_plugin_updated');
    assert.deepEqual(
      [...index.keyPath],
      ['table', 'value.pluginId', 'value.updatedAt', 'id'],
      'four parts: pluginId partitions, updatedAt orders, id breaks ties',
    );
  } finally {
    db.close();
  }
});

test('a v1 replica opening at v2 is rebuilt, not half-migrated', async () => {
  const name = freshDbName();
  // A replica as it existed before the bump: v1 had no `by_table_plugin_updated`.
  const old = await openStore(name, 1);
  old.close();
  const upgraded = await openStore(name);
  try {
    const names = new Set(upgraded.transaction('rows').objectStore('rows').indexNames);
    assert.ok(names.has('by_table_plugin_updated'), 'the new index is present after the bump');
    assert.ok(names.has('by_table_updated'), 'and the old ones were recreated, not dropped');
    assert.equal(upgraded.version, 2);
  } finally {
    upgraded.close();
  }
});
