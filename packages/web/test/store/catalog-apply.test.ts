import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { freshDb } from './harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { request } from '../../src/store/idb.ts';
import { readCursors } from '../../src/store/meta.ts';
import { buildHaystack, type CatalogRecord } from '../../src/store/catalog.ts';

// Measured on fake-indexeddb with the 500-op batch below, in isolation:
// three runs gave 75, 76 and 74 ms (median 75) before `by_table_status_updated`
// existed, and 78, 82 and 80 ms with it. The budget is 10x that median, not
// 3x: `npm run check` runs test files concurrently, and a 3x budget tripped
// at 313 ms under that load with no change to the path it measures. Ten
// times still catches the regression this exists for -- a recompute that
// goes quadratic -- while a loaded machine does not.
const CATALOG_BATCH_BUDGET_MS = 750;

const CURSORS = { since: 1, before: null } as const;
async function record(db: IDBDatabase, id: number): Promise<CatalogRecord | undefined> {
  return request<CatalogRecord | undefined>(db.transaction('catalog', 'readonly').objectStore('catalog').get(id));
}
// Builders: fill every field of the contract shape; only the named ones matter here.
const item = (id: number, title: string, releaseDate: string | null, updatedAt = 100, pluginId = 'tv'): SyncOp =>
  ({ op: 'create', table: 'media_item', id, value: { id, pluginId, title, releaseDate, description: null, provider: null, providerRef: null, createdAt: 1, updatedAt } });
const release = (id: number, mediaItemId: number | null, filename: string): SyncOp =>
  ({ op: 'create', table: 'rss_item', id, value: { id, feedId: 1, filename, createdAt: 1, updatedAt: 1, downloadType: 'torrent', mediaItemId, rankingScore: null, lookupState: 'resolved', lookupStateDetail: null, videoResolution: null, lookupJson: '{"secret":"never-in-haystack"}', deliveredAt: null } });
const torrent = (id: number, rssItemId: number, status = 'failed'): SyncOp =>
  ({ op: 'create', table: 'torrent_download', id, value: { id, rssItemId, downloadClientId: 1, infohash: null, clientRef: null, status, attempts: 1, createdAt: 1, updatedAt: 1, percentage: null, absentSince: null, deliveredAt: null, reclaimedAt: null } });
const nzb = (id: number, rssItemId: number): SyncOp =>
  ({ op: 'create', table: 'nzb_download', id, value: { id, rssItemId, downloadClientId: 1, clientRef: null, status: 'failed', attempts: 1, createdAt: 1, updatedAt: 1, percentage: null, absentSince: null, deliveredAt: null, reclaimedAt: null } });
const role = (id: number, mediaItemId: number, personId: number): SyncOp =>
  ({ op: 'create', table: 'role', id, value: { id, mediaItemId, personId, role: 'actor', name: null, billingOrder: null, createdAt: 1 } });
const person = (id: number, name: string): SyncOp =>
  ({ op: 'create', table: 'person', id, value: { id, name, providerRef: `p${String(id)}`, createdAt: 1, updatedAt: 1 } });
const del = (table: string, id: number): SyncOp => ({ op: 'delete', table, id });

test('one scrambled batch yields one record with pluginId, updatedAt, picked and the full haystack', async () => {
  const db = await freshDb();
  const changed = await applyBatch(db, [
    person(2, 'Zendaya'), torrent(1, 11), role(1, 1, 1), release(12, 1, 'Dune.Part.Two.2024.2160p.mkv'),
    item(1, 'Dune:  Part Two', '2024-03-01', 500), release(11, 1, 'Dune.Part.Two.2024.1080p.mkv'), role(2, 1, 2), person(1, 'Timothée Chalamet'),
  ], CURSORS);
  assert.deepEqual(changed.catalog, [1]);
  const rec = await record(db, 1);
  assert.deepEqual(rec, {
    id: 1, pluginId: 'tv', updatedAt: 500, picked: 1,
    haystack: 'dune: part two\n2024\ndune.part.two.2024.1080p.mkv\ndune.part.two.2024.2160p.mkv\ntimothée chalamet\nzendaya',
  });
  assert.ok(!rec?.haystack.includes('never-in-haystack'));
});

test('a later download flips picked; a tombstoned download flips it back', async () => {
  // Review Focus 5.
  const db = await freshDb();
  await applyBatch(db, [item(1, 'Arrival', null), release(11, 1, 'Arrival.mkv')], CURSORS);
  assert.equal((await record(db, 1))?.picked, 0);
  assert.equal((await record(db, 1))?.haystack, 'arrival\narrival.mkv', 'no year when releaseDate is null');
  await applyBatch(db, [torrent(1, 11)], { since: 2, before: null });
  assert.equal((await record(db, 1))?.picked, 1);
  await applyBatch(db, [del('torrent_download', 1)], { since: 3, before: null });
  assert.equal((await record(db, 1))?.picked, 0);
});

test('an nzb download flips picked the same way; its tombstone flips it back', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'Arrival', null), release(11, 1, 'Arrival.nzb')], CURSORS);
  assert.equal((await record(db, 1))?.picked, 0);
  await applyBatch(db, [nzb(1, 11)], { since: 2, before: null });
  assert.equal((await record(db, 1))?.picked, 1);
  await applyBatch(db, [del('nzb_download', 1)], { since: 3, before: null });
  assert.equal((await record(db, 1))?.picked, 0);
});

test('a download id shared by two download tables does not let a tombstone of one clear picked', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'Arrival', null), release(11, 1, 'Arrival.mkv'), torrent(1, 11), nzb(1, 11)], CURSORS);
  assert.equal((await record(db, 1))?.picked, 1);
  await applyBatch(db, [del('torrent_download', 1)], { since: 2, before: null });
  assert.equal((await record(db, 1))?.picked, 1, 'the nzb download still picks it');
});

test('a release arriving before its media item is picked up when the item arrives', async () => {
  // Review Focus 1.
  const db = await freshDb();
  const first = await applyBatch(db, [release(11, 1, 'Early.mkv')], CURSORS);
  assert.deepEqual(first.catalog, [], 'nothing to recompute yet');
  assert.equal(await record(db, 1), undefined);
  await applyBatch(db, [item(1, 'Early', '1999-01-01')], { since: 2, before: null });
  assert.equal((await record(db, 1))?.haystack, 'early\n1999\nearly.mkv');
});

test('a release rematched from one item to another rewrites both records', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'A', null), item(2, 'B', null), release(11, 1, 'X.mkv')], CURSORS);
  const changed = await applyBatch(db, [{ ...release(11, 2, 'X.mkv'), op: 'upsert' }], { since: 2, before: null });
  assert.deepEqual(changed.catalog, [1, 2]);
  assert.equal((await record(db, 1))?.haystack, 'a');
  assert.equal((await record(db, 2))?.haystack, 'b\nx.mkv');
});

test('a person rename reaches every item they appear in; a role tombstone drops the name', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'A', null), item(2, 'B', null), person(7, 'Old Name'), role(1, 1, 7), role(2, 2, 7)], CURSORS);
  const changed = await applyBatch(db, [{ ...person(7, 'New Name'), op: 'upsert' }], { since: 2, before: null });
  assert.deepEqual(changed.catalog, [1, 2]);
  assert.equal((await record(db, 1))?.haystack, 'a\nnew name');
  await applyBatch(db, [del('role', 2)], { since: 3, before: null });
  assert.equal((await record(db, 2))?.haystack, 'b');
});

test('a media item tombstone deletes its record', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'A', null)], CURSORS);
  const changed = await applyBatch(db, [del('media_item', 1)], { since: 2, before: null });
  assert.deepEqual(changed.catalog, [1]);
  assert.equal(await record(db, 1), undefined);
});

test('plugin-owned rows that carry mediaItemId are ignored by the haystack', async () => {
  // Review Focus 2.
  const db = await freshDb();
  await applyBatch(db, [
    item(1, 'A', null),
    { op: 'create', table: 'tv_release', id: 50, value: { id: 50, mediaItemId: 1, filename: 'NOT-A-RELEASE.mkv', updatedAt: 1 } },
  ], CURSORS);
  assert.equal((await record(db, 1))?.haystack, 'a');
});

test('a refused batch leaves the catalog untouched', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'A', null)], CURSORS);
  await assert.rejects(applyBatch(db, [{ ...item(1, 'B', null), op: 'upsert' }, { op: 'upsert', table: 'media_item', id: 2, value: null }], { since: 2, before: null }));
  assert.equal((await record(db, 1))?.haystack, 'a');
});

test('a transaction that aborts after the catalog phase wrote rejects with that failure and leaves nothing behind', async () => {
  // The catalog phase awaits requests, so IndexedDB can fail the transaction
  // mid-phase: here the first `catalog.put` aborts its own transaction right
  // after issuing the write. The catch in `applyBatch` then runs against an
  // already-aborted transaction, where `abort()` throws `InvalidStateError`;
  // the guard around it is what lets the original failure reach the caller.
  const db = await freshDb();
  await applyBatch(db, [item(1, 'Before', null)], CURSORS);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function put(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const req = original.apply(this, args);
    if (this.name === 'catalog') this.transaction.abort();
    return req;
  };
  let failure: unknown;
  try {
    await applyBatch(db, [item(2, 'After', null), { ...item(1, 'Renamed', null), op: 'upsert' }], { since: 2, before: null });
  } catch (err) {
    failure = err;
  } finally {
    IDBObjectStore.prototype.put = original;
  }
  assert.ok(failure instanceof Error, 'applyBatch rejected');
  assert.notEqual(failure.name, 'InvalidStateError', 'the abort guard swallowed its own InvalidStateError');
  assert.equal(await record(db, 2), undefined, 'no catalog record for the batch');
  assert.equal((await record(db, 1))?.haystack, 'before', 'the existing record is unchanged');
  const rows = db.transaction('rows', 'readonly').objectStore('rows');
  assert.equal(await request(rows.get(['media_item', 2])), undefined, 'no row for the batch');
  assert.deepEqual(await readCursors(db), { since: 1, before: null }, 'the cursor did not move');
});

test('buildHaystack lowercases, collapses whitespace per part and joins with newlines', () => {
  assert.equal(buildHaystack(['Dune:  Part\tTwo', '2024', 'A.mkv']), 'dune: part two\n2024\na.mkv');
});

test('a 500-op batch over 100 items applies within the budget', async () => {
  // A regression tripwire on fake-indexeddb, not a benchmark: the budget is
  // at least three times the median measured when this test was written
  // (record the measurement in CATALOG_BATCH_BUDGET_MS's comment).
  const db = await freshDb();
  const ops: SyncOp[] = [];
  for (let i = 1; i <= 100; i += 1) {
    ops.push(item(i, `Title ${String(i)}`, '2020-01-01'), release(i * 10, i, `f${String(i)}.mkv`), release(i * 10 + 1, i, `g${String(i)}.mkv`), role(i, i, i), person(i, `Person ${String(i)}`));
  }
  const started = performance.now();
  await applyBatch(db, ops, CURSORS);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < CATALOG_BATCH_BUDGET_MS, `${String(Math.round(elapsed))} ms`);
});
