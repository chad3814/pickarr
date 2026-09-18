import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import {
  getRow, getRows, byMediaItem, byRssItem, listByTable, listByTablePlugin, countByPlugin,
} from '../../src/store/rows.ts';
import { done } from '../../src/store/idb.ts';
import type { StoredRow } from '../../src/store/db.ts';

/** The resume cursor for the page just served: its last row's full index key. */
function cursorOf(rows: readonly StoredRow[]): { updatedAt: number; id: number } {
  const last = rows[rows.length - 1];
  if (last === undefined) throw new Error('no page to resume from');
  return { updatedAt: (last.value as { updatedAt: number }).updatedAt, id: last.id };
}

/**
 * `updatedAt` off a `StoredRow`'s `value`, narrowed with `typeof`/`in`
 * checks rather than a cast (Global Constraint: no cast to silence a type
 * error) -- the same technique any guard over an `unknown` value uses, such
 * as `useCounts.ts`'s own `isStoreClosed`.
 */
function updatedAtOf(row: StoredRow): number {
  const { value } = row;
  if (typeof value !== 'object' || value === null) throw new Error('row has no value to read updatedAt from');
  if (!('updatedAt' in value)) throw new Error('row value carries no updatedAt');
  const { updatedAt } = value;
  if (typeof updatedAt !== 'number') throw new Error('row value\'s updatedAt is not a number');
  return updatedAt;
}

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

test('listByTable resumes from a cursor without repeating the boundary row', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { updatedAt: 10 } },
    { op: 'upsert', table: 'person', id: 2, value: { updatedAt: 20 } },
    { op: 'upsert', table: 'person', id: 3, value: { updatedAt: 30 } },
  ]);

  const rows = await listByTable(db, 'person', {
    direction: 'next', from: { updatedAt: 20, id: 2 }, limit: 10,
  });

  assert.deepEqual(rows.map((row) => row.id), [3]);
  db.close();
});

test('a walk over rows tied on updatedAt serves every row exactly once', async () => {
  // The defect this cursor's second half exists for. Measured on the version
  // that resumed from `updatedAt` alone: paging these five backwards two at a
  // time served ids [1,4,5] and never served 2 or 3 from any page.
  //
  // Three explicit pages rather than a loop: `await` in a loop trips
  // `no-await-in-loop`, and spelling each page out shows *where* the old
  // version lost rows rather than only that a set came back short.
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'person', id: 1, value: { updatedAt: 300 } },
    { op: 'upsert', table: 'person', id: 2, value: { updatedAt: 200 } },
    { op: 'upsert', table: 'person', id: 3, value: { updatedAt: 200 } },
    { op: 'upsert', table: 'person', id: 4, value: { updatedAt: 200 } },
    { op: 'upsert', table: 'person', id: 5, value: { updatedAt: 100 } },
  ]);
  const one = await listByTable(db, 'person', { direction: 'prev', limit: 2 });
  const two = await listByTable(db, 'person', { direction: 'prev', limit: 2, from: cursorOf(one) });
  const three = await listByTable(db, 'person', { direction: 'prev', limit: 2, from: cursorOf(two) });

  const seen = [...one, ...two, ...three].map((row) => row.id);
  assert.deepEqual(seen.toSorted((a, b) => a - b), [1, 2, 3, 4, 5], 'every row served');
  assert.equal(new Set(seen).size, seen.length, 'and none served twice');
  db.close();
});

test('a stored null value reads as absent, matching what every index does with it', async () => {
  // Task 2 refuses to write one now, so this is about a replica that already
  // holds one: `null` is index-invisible exactly as a tombstone is, and a read
  // that returned it would be the one place two reads of a row disagree.
  const db = await freshDb();
  const tx = db.transaction('rows', 'readwrite');
  tx.objectStore('rows').put({ table: 'person', id: 1, value: null });
  await done(tx);

  assert.ok(await getRow(db, 'person', 1) === undefined, 'getRow hides it');
  assert.equal((await getRows(db, 'person', [1])).size, 0, 'getRows omits it');
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

test('paging a category neither skips nor repeats a row tied on updatedAt', async () => {
  // Five media items, three sharing one `updatedAt`. The two-part version of
  // this key was measured serving [1,4,5] and never serving 2 or 3.
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 10 } },
    { op: 'upsert', table: 'media_item', id: 2, value: { pluginId: 'tv', updatedAt: 20 } },
    { op: 'upsert', table: 'media_item', id: 3, value: { pluginId: 'tv', updatedAt: 20 } },
    { op: 'upsert', table: 'media_item', id: 4, value: { pluginId: 'tv', updatedAt: 20 } },
    { op: 'upsert', table: 'media_item', id: 5, value: { pluginId: 'tv', updatedAt: 30 } },
  ]);

  const seen: number[] = [];
  let from: { updatedAt: number; id: number } | undefined;
  for (let page = 0; page < 5; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous page's last row, so the walk is inherently sequential
    const got = await listByTablePlugin(db, 'media_item', 'tv', {
      direction: 'prev', limit: 2, ...(from === undefined ? {} : { from }),
    });
    if (got.length === 0) break;
    for (const row of got) seen.push(row.id);
    const last = got.at(-1);
    from = last === undefined ? undefined : { updatedAt: updatedAtOf(last), id: last.id };
  }

  assert.deepEqual(seen.toSorted((a, b) => a - b), [1, 2, 3, 4, 5], 'every row exactly once');
  assert.equal(new Set(seen).size, seen.length, 'and none served twice');
  db.close();
});

test('a category sees only its own rows', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 1 } },
    { op: 'upsert', table: 'media_item', id: 2, value: { pluginId: 'movie', updatedAt: 1 } },
    { op: 'upsert', table: 'media_item', id: 3, value: { pluginId: 'xxx', updatedAt: 1 } },
  ]);

  const tv = await listByTablePlugin(db, 'media_item', 'tv', { direction: 'next', limit: 10 });

  assert.deepEqual(tv.map((r) => r.id), [1], 'movie and xxx are not in tv');
  db.close();
});

test('counting a category reads no rows and excludes tombstones', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 1 } },
    { op: 'upsert', table: 'media_item', id: 2, value: { pluginId: 'tv', updatedAt: 2 } },
    { op: 'upsert', table: 'media_item', id: 3, value: { pluginId: 'movie', updatedAt: 1 } },
  ]);
  await seed(db, [{ op: 'delete', table: 'media_item', id: 2 }]);

  assert.equal(await countByPlugin(db, 'media_item', 'tv'), 1, 'the tombstoned row is not counted');
  assert.equal(await countByPlugin(db, 'media_item', 'movie'), 1);
  assert.equal(await countByPlugin(db, 'media_item', 'xxx'), 0, 'zero is an answer');
  db.close();
});
