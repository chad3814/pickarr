import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { done, request } from '../../src/store/idb.ts';
import { openStore, SCHEMA_VERSION, type StoredRow } from '../../src/store/db.ts';
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

    // The keyPath alone says nothing about what actually lands in the
    // index -- that is the self-filtering property design spec §3.2 calls
    // load-bearing, and it has to be observed by inserting rows and reading
    // the index back, not asserted by inspecting its definition.
    const tx = db.transaction('rows', 'readwrite');
    const rows = tx.objectStore('rows');
    rows.put({ table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 5 } });
    // No `pluginId` -- this table projects `feedId` instead -- so this row
    // has no `value.pluginId` and IndexedDB omits it from the index.
    rows.put({ table: 'rss_item', id: 2, value: { feedId: 9, updatedAt: 5 } });
    // A tombstone: no `value` at all, so no `value.pluginId` either.
    rows.put({ table: 'media_item', id: 3 });
    await done(tx);

    const inIndex = await request<StoredRow[]>(
      db.transaction('rows').objectStore('rows').index('by_table_plugin_updated').getAll(),
    );
    assert.deepEqual(
      inIndex.map((row) => row.id).toSorted(),
      [1],
      'only the media_item row that actually carries a pluginId is in the index -- '
      + 'the rss_item row (no pluginId) and the tombstone (no value at all) are both excluded',
    );
  } finally {
    db.close();
  }
});

test('a v1 replica opening at v2 is rebuilt, not half-migrated', async () => {
  const name = freshDbName();
  // A replica as it existed before the bump: v1 had no `by_table_plugin_updated`.
  const old = await openStore(name, 1);
  // A row this replica held before the bump. Rebuilt and half-migrated agree
  // on every index name -- design spec §7 says what tells them apart is
  // this row's fate: gone after a rebuild (refilled later through bootstrap
  // and backfill), still there after an in-place migration.
  const seedTx = old.transaction('rows', 'readwrite');
  seedTx.objectStore('rows').put({ table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 5 } });
  await done(seedTx);
  old.close();
  const upgraded = await openStore(name);
  try {
    const names = new Set(upgraded.transaction('rows').objectStore('rows').indexNames);
    assert.ok(names.has('by_table_plugin_updated'), 'the new index is present after the bump');
    assert.ok(names.has('by_table_updated'), 'and the old ones were recreated, not dropped');
    assert.equal(upgraded.version, SCHEMA_VERSION);

    const row = await request(upgraded.transaction('rows').objectStore('rows').get(['media_item', 1]));
    assert.equal(row, undefined, 'the pre-bump row is gone -- a rebuild discards it rather than carrying it forward');
  } finally {
    upgraded.close();
  }
});

test('a tab still holding the old version open steps aside instead of blocking the bump', async () => {
  // The two-tab case across a deploy, which is this branch's own: the 1->2
  // bump is the first this codebase has ever made, and before `openStore`
  // listened for `versionchange` a second tab holding v1 open made the
  // upgrading tab's open fire `blocked` -- `OpenBlockedError`, which
  // `Shell` can only report, leaving that tab with no replica at all.
  // Nothing in this suite opened two connections to one name before, which
  // is why the gap survived.
  const name = freshDbName();
  const firstTab = await openStore(name, 1);
  try {
    const secondTab = await openStore(name, 2);
    assert.equal(secondTab.version, 2, 'the upgrade went through rather than blocking on the open connection');
    secondTab.close();
  } finally {
    // Idempotent by the standard, and the point of the test is that the
    // `versionchange` handler already did this.
    firstTab.close();
  }
});
