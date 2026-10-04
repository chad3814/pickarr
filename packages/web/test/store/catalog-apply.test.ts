import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { freshDb } from './harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { request } from '../../src/store/idb.ts';
import { readCursors } from '../../src/store/meta.ts';
import { buildHaystack, type CatalogRecord } from '../../src/store/catalog.ts';

/**
 * Runs `body` while counting `getAllKeys` calls on the `by_rss_item` index
 * -- the read `picked` costs, one per release checked -- and restores the
 * prototype whatever `body` does.
 *
 * This replaced a wall-clock budget (#108). That budget measured a 500-op
 * batch over 100 items at 75-82 ms in isolation and was set to ten times
 * that; it still tripped at 313 ms and then 966 ms under `npm run check`'s
 * concurrent files with no change to the path it measured. The property it
 * existed to catch -- a recompute whose reads grow with the releases an
 * item already has -- is a count, and fake-indexeddb answers a count
 * exactly on any machine.
 */
async function countingReleaseReads<T>(body: () => Promise<T>): Promise<{ result: T; reads: number }> {
  const original = IDBIndex.prototype.getAllKeys;
  let reads = 0;
  IDBIndex.prototype.getAllKeys = function getAllKeys(this: IDBIndex, query?: IDBValidKey | IDBKeyRange | null, count?: number) {
    if (this.name === 'by_rss_item') reads += 1;
    return original.call(this, query, count);
  };
  try {
    return { result: await body(), reads };
  } finally {
    IDBIndex.prototype.getAllKeys = original;
  }
}

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
    poster: null, background: null,
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

test('bootstrap: releases arriving over four pages cost one check each, not one per release so far (#108)', async () => {
  // A long-running show whose 200 releases arrive 50 to a sync page. The
  // from-scratch recompute read every release the item already had on each
  // page: 50 + 100 + 150 + 200 = 500 reads. Each page now checks only the
  // releases it linked: 200 in all.
  const db = await freshDb();
  const pageOf = (page: number): SyncOp[] =>
    Array.from({ length: 50 }, (_, i) => release(1000 + page * 50 + i, 1, `s01e${String(page * 50 + i)}.mkv`));
  const counts: number[] = [];
  const first = await countingReleaseReads(() => applyBatch(db, [item(1, 'Long Show', '2001-01-01'), ...pageOf(0)], CURSORS));
  counts.push(first.reads);
  for (let page = 1; page < 4; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- pages arrive in order; that is the thing being measured
    const { reads } = await countingReleaseReads(() => applyBatch(db, pageOf(page), { since: page + 1, before: null }));
    counts.push(reads);
  }
  assert.deepEqual(counts, [50, 50, 50, 50], `by_rss_item reads per page were ${counts.join(', ')}; the from-scratch recompute gives 50, 100, 150, 200`);
  const rec = await record(db, 1);
  assert.equal(rec?.picked, 0);
  assert.equal(rec?.haystack.split('\n').length, 2 + 200, 'every release is still in the haystack');
});

test('a batch that touches an item without touching its downloads reads no release (#108)', async () => {
  const db = await freshDb();
  const releases = Array.from({ length: 20 }, (_, i) => release(100 + i, 1, `r${String(i)}.mkv`));
  await applyBatch(db, [item(1, 'Show', null), ...releases, role(1, 1, 1), person(1, 'Someone'), torrent(500, 100)], CURSORS);
  assert.equal((await record(db, 1))?.picked, 1);

  const renamed = await countingReleaseReads(() =>
    applyBatch(db, [{ ...person(1, 'Someone Else'), op: 'upsert' }], { since: 2, before: null }));
  assert.equal(renamed.reads, 0, 'a person rename cannot change picked, so no release is read');
  assert.equal((await record(db, 1))?.picked, 1, 'and the carried bit is the right one');
  assert.ok((await record(db, 1))?.haystack.endsWith('someone else'));

  const retitled = await countingReleaseReads(() =>
    applyBatch(db, [{ ...release(100, 1, 'renamed.mkv'), op: 'upsert' }], { since: 3, before: null }));
  assert.equal(retitled.reads, 0, 'a release that stays on its item changed only the haystack');
  assert.ok((await record(db, 1))?.haystack.includes('renamed.mkv'));
});

test('a download arriving flips picked with no release read; its tombstone re-reads every release and flips it back (#108)', async () => {
  const db = await freshDb();
  const releases = Array.from({ length: 20 }, (_, i) => release(100 + i, 1, `r${String(i)}.mkv`));
  await applyBatch(db, [item(1, 'Show', null), ...releases], CURSORS);

  const added = await countingReleaseReads(() => applyBatch(db, [nzb(700, 105)], { since: 2, before: null }));
  assert.equal(added.reads, 0, 'a download written this batch is proof enough');
  assert.equal((await record(db, 1))?.picked, 1);

  const removed = await countingReleaseReads(() => applyBatch(db, [del('nzb_download', 700)], { since: 3, before: null }));
  assert.equal(removed.reads, 20, 'only the whole scan can prove no other download remains');
  assert.equal((await record(db, 1))?.picked, 0);
});

test('a release that arrives after its downloads is checked alone, and a release rematched away re-reads the item it left (#108)', async () => {
  const db = await freshDb();
  const releases = Array.from({ length: 10 }, (_, i) => release(100 + i, 1, `r${String(i)}.mkv`));
  await applyBatch(db, [item(1, 'Show', null), item(2, 'Other', null), ...releases, torrent(900, 555)], CURSORS);
  assert.equal((await record(db, 1))?.picked, 0, 'the download belongs to a release nobody has linked yet');

  const linked = await countingReleaseReads(() => applyBatch(db, [release(555, 1, 'late.mkv')], { since: 2, before: null }));
  assert.equal(linked.reads, 1, 'only the release that joined can have brought downloads');
  assert.equal((await record(db, 1))?.picked, 1);

  const moved = await countingReleaseReads(() =>
    applyBatch(db, [{ ...release(555, 2, 'late.mkv'), op: 'upsert' }], { since: 3, before: null }));
  assert.equal(moved.reads, 10 + 1, 'the item it left scans its ten remaining releases; the item it joined checks it alone');
  assert.equal((await record(db, 1))?.picked, 0);
  assert.equal((await record(db, 2))?.picked, 1);
});

/** A `poster`, `background` or `logo` row as the host replicates it: no `url`, no `path`. */
const artwork = (table: 'poster' | 'background' | 'logo', id: number, mediaItemId: number, rank: number): SyncOp =>
  ({ op: 'create', table, id, value: { id, mediaItemId, width: 10, height: 15, language: null, rank, createdAt: 1 } });

test('the record carries the rank-0 poster and background by rank then id, whatever order the batch came in', async () => {
  const db = await freshDb();
  await applyBatch(db, [
    artwork('poster', 22, 1, 0),
    artwork('background', 31, 1, 1),
    item(1, 'Show', null),
    artwork('poster', 20, 1, 1),
    artwork('poster', 21, 1, 0),
    artwork('background', 30, 1, 0),
    // Another item's rank-0 poster must not leak in.
    artwork('poster', 40, 2, 0),
    item(2, 'Other', null),
  ], CURSORS);
  const rec = await record(db, 1);
  assert.equal(rec?.poster, 21, 'rank 0, and the lower id of the two rank-0 posters');
  assert.equal(rec?.background, 30);
  assert.equal((await record(db, 2))?.poster, 40);
});

test('a record with no images carries null for both, and logos and people pictures never fill them', async () => {
  const db = await freshDb();
  const personPicture: SyncOp =
    { op: 'create', table: 'person_image', id: 60, value: { id: 60, personId: 1, width: 10, height: 15, language: null, rank: 0, createdAt: 1 } };
  await applyBatch(db, [item(1, 'Show', null), artwork('logo', 50, 1, 0), person(1, 'Actor'), role(1, 1, 1), personPicture], CURSORS);
  const rec = await record(db, 1);
  assert.equal(rec?.poster, null);
  assert.equal(rec?.background, null);
});

test('a better-ranked poster arriving later rewrites the record, and a tombstoned rank-0 background falls back to the survivor', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'Show', null), artwork('poster', 20, 1, 1), artwork('background', 30, 1, 0), artwork('background', 31, 1, 1)], CURSORS);
  assert.equal((await record(db, 1))?.poster, 20);

  const later = await applyBatch(db, [artwork('poster', 21, 1, 0)], { since: 2, before: null });
  assert.deepEqual(later.catalog, [1], 'a poster op affects its item');
  assert.equal((await record(db, 1))?.poster, 21);

  await applyBatch(db, [del('background', 30)], { since: 3, before: null });
  assert.equal((await record(db, 1))?.background, 31, 'the rank-1 background is now the best there is');
});

test('an artwork-only batch recomputes the item without reading a single release (#108 holds)', async () => {
  const db = await freshDb();
  const releases = Array.from({ length: 20 }, (_, i) => release(100 + i, 1, `r${String(i)}.mkv`));
  await applyBatch(db, [item(1, 'Show', null), ...releases, torrent(500, 100)], CURSORS);
  const { reads } = await countingReleaseReads(() => applyBatch(db, [artwork('poster', 20, 1, 0)], { since: 2, before: null }));
  assert.equal(reads, 0, 'a poster cannot change picked, so the previous bit is carried');
  const rec = await record(db, 1);
  assert.equal(rec?.picked, 1);
  assert.equal(rec?.poster, 20);
});
