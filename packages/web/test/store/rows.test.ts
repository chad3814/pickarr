import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { getRow, getRows, byMediaItem, byRssItem, listByTable } from '../../src/store/rows.ts';

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

test('byMediaItem returns rows from several tables in one query', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'rss_item', id: 1, value: { mediaItemId: 7, filename: 'a' } },
    { op: 'upsert', table: 'role', id: 2, value: { mediaItemId: 7, name: 'Alice' } },
    { op: 'upsert', table: 'tv_release', id: 3, value: { mediaItemId: 7, kind: 'episode' } },
    { op: 'upsert', table: 'rss_item', id: 4, value: { mediaItemId: 8, filename: 'b' } },
  ]);

  const rows = await byMediaItem(db, 7);

  assert.deepEqual(
    rows.toSorted((a, b) => a.id - b.id).map((row) => [row.table, row.id]),
    [
      ['rss_item', 1],
      ['role', 2],
      ['tv_release', 3],
    ],
  );
  db.close();
});

test('byMediaItem excludes a tombstone belonging to the media item, measured rather than assumed', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'rss_item', id: 1, value: { mediaItemId: 7 } },
    { op: 'upsert', table: 'role', id: 2, value: { mediaItemId: 7 } },
  ]);
  await seed(db, [{ op: 'delete', table: 'role', id: 2 }]);

  const rows = await byMediaItem(db, 7);

  assert.deepEqual(rows.map((row) => [row.table, row.id]), [['rss_item', 1]]);
  db.close();
});

test('byRssItem returns downloads across tables for one release', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'torrent_download', id: 1, value: { rssItemId: 20, status: 'downloading' } },
    { op: 'upsert', table: 'nzb_download', id: 2, value: { rssItemId: 20, status: 'queued' } },
    { op: 'upsert', table: 'torrent_download', id: 3, value: { rssItemId: 21, status: 'downloading' } },
  ]);

  const rows = await byRssItem(db, 20);

  assert.deepEqual(
    rows.toSorted((a, b) => a.id - b.id).map((row) => [row.table, row.id]),
    [
      ['torrent_download', 1],
      ['nzb_download', 2],
    ],
  );
  db.close();
});

test('getRow answers undefined for a tombstone', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'here' } }]);
  await seed(db, [{ op: 'delete', table: 'person', id: 1 }]);

  assert.equal(await getRow(db, 'person', 1), undefined);
  db.close();
});

test('getRow answers undefined for a row never replicated -- the same answer as a tombstone, deliberately (spec §9)', async () => {
  const db = await freshDb();
  assert.equal(await getRow(db, 'person', 999), undefined);
  db.close();
});

test('getRow answers the value for a row actually held', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'here' } }]);

  assert.deepEqual(await getRow(db, 'person', 1), { name: 'here' });
  db.close();
});

test('getRows answers only the ids actually held, a tombstone and an absence both left out', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { name: 'one' } },
    { op: 'upsert', table: 'person', id: 2, value: { name: 'two' } },
  ]);
  await seed(db, [{ op: 'delete', table: 'person', id: 2 }]);

  const rows = await getRows(db, 'person', [1, 2, 3]);

  assert.deepEqual(rows, new Map([[1, { name: 'one' }]]));
  db.close();
});

test('listByTable refuses a table that projects no updatedAt', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => listByTable(db, 'role', { direction: 'next', limit: 10 }),
    /role.*updatedAt/,
  );
  db.close();
});

test('listByTable refuses a plugin table exactly as it refuses role', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => listByTable(db, 'tv_release', { direction: 'next', limit: 10 }),
    /tv_release.*updatedAt/,
  );
  db.close();
});

test('listByTable walks a permitted table in ascending order', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { name: 'a', updatedAt: 30 } },
    { op: 'upsert', table: 'person', id: 2, value: { name: 'b', updatedAt: 10 } },
    { op: 'upsert', table: 'person', id: 3, value: { name: 'c', updatedAt: 20 } },
  ]);

  const rows = await listByTable(db, 'person', { direction: 'next', limit: 10 });

  assert.deepEqual(rows.map((row) => row.id), [2, 3, 1]);
  db.close();
});

test('listByTable walks a permitted table in descending order', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { name: 'a', updatedAt: 30 } },
    { op: 'upsert', table: 'person', id: 2, value: { name: 'b', updatedAt: 10 } },
    { op: 'upsert', table: 'person', id: 3, value: { name: 'c', updatedAt: 20 } },
  ]);

  const rows = await listByTable(db, 'person', { direction: 'prev', limit: 10 });

  assert.deepEqual(rows.map((row) => row.id), [1, 3, 2]);
  db.close();
});

test('listByTable honours limit', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { updatedAt: 1 } },
    { op: 'upsert', table: 'person', id: 2, value: { updatedAt: 2 } },
    { op: 'upsert', table: 'person', id: 3, value: { updatedAt: 3 } },
  ]);

  const rows = await listByTable(db, 'person', { direction: 'next', limit: 2 });

  assert.deepEqual(rows.map((row) => row.id), [1, 2]);
  db.close();
});

test('listByTable resumes from fromUpdatedAt without repeating the boundary row', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { updatedAt: 10 } },
    { op: 'upsert', table: 'person', id: 2, value: { updatedAt: 20 } },
    { op: 'upsert', table: 'person', id: 3, value: { updatedAt: 30 } },
  ]);

  const rows = await listByTable(db, 'person', { direction: 'next', fromUpdatedAt: 20, limit: 10 });

  assert.deepEqual(rows.map((row) => row.id), [3]);
  db.close();
});

test('listByTable scoped to one table never returns another table\'s rows', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { updatedAt: 1 } },
    { op: 'upsert', table: 'media_item', id: 2, value: { updatedAt: 1 } },
  ]);

  const rows = await listByTable(db, 'person', { direction: 'next', limit: 10 });

  assert.deepEqual(rows.map((row) => [row.table, row.id]), [['person', 1]]);
  db.close();
});

test('listByTable excludes a tombstone from a permitted table, measured rather than assumed', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { updatedAt: 1 } },
    { op: 'upsert', table: 'person', id: 2, value: { updatedAt: 2 } },
  ]);
  await seed(db, [{ op: 'delete', table: 'person', id: 2 }]);

  const rows = await listByTable(db, 'person', { direction: 'next', limit: 10 });

  assert.deepEqual(rows.map((row) => row.id), [1]);
  db.close();
});
