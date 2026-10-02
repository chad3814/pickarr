import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import {
  getRow, getRows, byMediaItem, byRssItem, listByTable, listByTablePlugin, countByPlugin,
  pluginRowsByMediaItems, activeDownloads,
  type PluginRowsPage,
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

test('pluginRowsByMediaItems partitions each item its own rows, from the tables named and no others', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'tv' } },
    { op: 'upsert', table: 'tv_release', id: 1, value: { mediaItemId: 7, kind: 'episode' } },
    { op: 'upsert', table: 'movie_detail', id: 2, value: { mediaItemId: 7, runtimeMinutes: 100 } },
    { op: 'upsert', table: 'media_item', id: 8, value: { pluginId: 'tv' } },
    { op: 'upsert', table: 'tv_release', id: 3, value: { mediaItemId: 8, kind: 'season' } },
  ]);

  const result = await pluginRowsByMediaItems(db, [7, 8], ['tv_release']);

  assert.equal(result.rows.get(7)?.tv_release?.length, 1, "item 7's named table is carried");
  assert.ok(!('movie_detail' in (result.rows.get(7) ?? {})), 'an unnamed table is not, even though it belongs to the same item');
  assert.equal(result.rows.get(8)?.tv_release?.length, 1, "item 8's rows are not mixed into item 7's entry");
  assert.deepEqual(result.heldIds.get('tv_release'), new Set([1, 3]), 'every row id held under the named table, across both items, and nothing else');
  db.close();
});

test('pluginRowsByMediaItems: a named table with no rows is an empty array, not an absent key', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'tv' } }]);

  const result = await pluginRowsByMediaItems(db, [7], ['tv_release']);

  assert.deepEqual(result.rows.get(7), { tv_release: [] }, 'the key exists and is empty');
  db.close();
});

test('pluginRowsByMediaItems answers every declared table for an id the replica holds nothing for', async () => {
  const db = await freshDb();

  const result = await pluginRowsByMediaItems(db, [999], ['tv_release']);

  assert.deepEqual(result.rows.get(999), { tv_release: [] }, 'an id with no media item at all still gets a full entry');
  db.close();
});

test('pluginRowsByMediaItems opens one transaction for a page of ids, not one per id -- measured, not assumed', async () => {
  // The property this function exists for: `byMediaItem` opens a fresh
  // transaction on every call (`rowsStore`'s own doc), so calling it once
  // per card -- the shape a per-card fetch took before this design replaced
  // it -- would open one transaction per card. This counts the real thing
  // rather than trusting the shape of the code, the same way
  // `getRows answers only the ids actually held` above does not just for
  // that function but this file's own `the count comes from the index, not
  // from a filtered scan` did for `countByPlugin`.
  const db = await freshDb();
  const ids = Array.from({ length: 50 }, (_, i) => i + 1);
  await seed(
    db,
    ids.flatMap((id) => [
      { op: 'upsert' as const, table: 'media_item', id, value: { pluginId: 'tv' } },
      { op: 'upsert' as const, table: 'tv_release', id: 1000 + id, value: { mediaItemId: id, kind: 'episode' } },
    ]),
  );

  const original = db.transaction.bind(db);
  let transactions = 0;
  db.transaction = (storeNames, mode, options) => {
    transactions += 1;
    return original(storeNames, mode, options);
  };

  let result: PluginRowsPage;
  try {
    result = await pluginRowsByMediaItems(db, ids, ['tv_release']);
  } finally {
    db.transaction = original;
  }

  assert.equal(transactions, 1, 'one transaction served all 50 ids');
  assert.equal(result.rows.size, 50, 'every id still got its own entry');
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

test('counting a category excludes tombstones', async () => {
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

test('listByTablePlugin refuses a table that projects no pluginId', async () => {
  // `TABLES_WITH_UPDATED_AT`'s own doc gives the reason this guard exists:
  // an empty page "would read as 'this table is empty' -- a lie a caller
  // has no way to catch". Both readers of `by_table_plugin_updated`
  // inherited the `updatedAt` guard, which admits five tables of which
  // only `media_item` projects a `pluginId` -- so for the other four they
  // told exactly that lie. Measured against a store holding two real
  // `rss_item` rows: `listByTablePlugin` answered `[]` and `countByPlugin`
  // answered `0`.
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'rss_item', id: 1, value: { feedId: 1, mediaItemId: null, updatedAt: 1 } },
    { op: 'upsert', table: 'rss_item', id: 2, value: { feedId: 1, mediaItemId: null, updatedAt: 2 } },
  ]);

  await assert.rejects(
    () => listByTablePlugin(db, 'rss_item', 'tv', { direction: 'prev', limit: 10 }),
    /projects no pluginId/,
    'a table with rows in it must not answer "empty"',
  );
  await assert.rejects(
    () => countByPlugin(db, 'rss_item', 'tv'),
    /projects no pluginId/,
    'and the count must refuse it the same way its sibling does',
  );
  db.close();
});

test('the count comes from the index, not from a filtered scan', async () => {
  // The claim the test above was named for and could not check: that a
  // count reads the index rather than every `media_item` row. Spying on
  // `rowsStore(db).index(...)` would couple this to a call shape, and a
  // timing assertion is flaky by construction -- but there is a third way,
  // which needs neither, because the two mechanisms genuinely disagree
  // about one row.
  //
  // `by_table_plugin_updated`'s key path is
  // ['table', 'value.pluginId', 'value.updatedAt', 'id'], and IndexedDB
  // omits any record whose key path does not fully resolve. So a row
  // carrying `pluginId` but no `updatedAt` is in `by_table` and *not* in
  // `by_table_plugin_updated`, while any scan filtering rows on "has a
  // value, and value.pluginId === 'tv'" counts it. That difference is
  // observable through `countByPlugin`'s public signature alone.
  //
  // Hand-built, because the wire cannot produce it -- `MediaItemSyncRead`
  // requires `updatedAt` -- which is exactly the case `CLAUDE.md` names:
  // "when behaviour changes and stored data does not, hand-build a fixture
  // in the old shape". It also documents, at the count layer, the
  // self-filtering property spec §3.2 calls load-bearing.
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 1 } }]);
  const tx = db.transaction('rows', 'readwrite');
  tx.objectStore('rows').put({ table: 'media_item', id: 2, value: { pluginId: 'tv' } });
  await done(tx);

  assert.equal(await countByPlugin(db, 'media_item', 'tv'), 1, 'the row the index omits is not counted');
  db.close();
});

test('activeDownloads lists every non-terminal download with its filename, title and client, and copes with missing joins', async () => {
  const db = await freshDb();
  await applyBatch(db, [
    { op: 'upsert', table: 'download_client', id: 1, value: { id: 1, name: 'Seedbox', type: 'torrent', implementation: 'qbittorrent', url: '', username: null, category: '', consecutiveFailures: 0, unreachableSince: null, createdAt: 1, updatedAt: 1 } },
    { op: 'upsert', table: 'media_item', id: 5, value: { id: 5, pluginId: 'tv', title: 'A Show', createdAt: 1, updatedAt: 1, provider: null, providerRef: null, releaseDate: null, description: null } },
    { op: 'upsert', table: 'rss_item', id: 7, value: { id: 7, feedId: 1, filename: 'a.mkv', createdAt: 1, updatedAt: 1, downloadType: 'torrent', mediaItemId: 5, rankingScore: null, lookupState: 'resolved', lookupStateDetail: null, lookupJson: null, videoResolution: null, deliveredAt: null } },
    { op: 'upsert', table: 'torrent_download', id: 11, value: { id: 11, rssItemId: 7, downloadClientId: 1, infohash: null, clientRef: 'r', status: 'downloading', attempts: 1, createdAt: 1, updatedAt: 9, percentage: 42, absentSince: null, deliveredAt: null, reclaimedAt: null } },
    { op: 'upsert', table: 'torrent_download', id: 12, value: { id: 12, rssItemId: 7, downloadClientId: 1, infohash: null, clientRef: 'd', status: 'delivered', attempts: 1, createdAt: 1, updatedAt: 9, percentage: 100, absentSince: null, deliveredAt: 9, reclaimedAt: null } },
    { op: 'upsert', table: 'torrent_download', id: 14, value: { id: 14, rssItemId: 7, downloadClientId: 1, infohash: null, clientRef: 'f', status: 'failed', attempts: 3, createdAt: 1, updatedAt: 9, percentage: null, absentSince: null, deliveredAt: null, reclaimedAt: null } },
    { op: 'upsert', table: 'nzb_download', id: 13, value: { id: 13, rssItemId: 99, downloadClientId: 2, clientRef: null, status: 'submitting', attempts: 0, createdAt: 1, updatedAt: 3, percentage: null, absentSince: null, deliveredAt: null, reclaimedAt: null } },
  ], { since: 1, before: null });
  const rows = await activeDownloads(db);
  assert.deepEqual(rows.map((r) => [r.table, r.id, r.status, r.filename, r.title, r.clientName, r.percentage]), [
    ['torrent_download', 11, 'downloading', 'a.mkv', 'A Show', 'Seedbox', 42],
    ['nzb_download', 13, 'submitting', 'unknown release', null, 'unknown client', null],
  ]);
  assert.deepEqual(rows.map((r) => r.updatedAt), [9, 3], 'newest first');
  db.close();
});

test('activeDownloads finds a quiet live download behind more terminal rows than one page', async () => {
  const db = await freshDb();
  const download = (id: number, status: string, updatedAt: number): SyncOp => ({
    op: 'upsert',
    table: 'torrent_download',
    id,
    value: { id, rssItemId: 1, downloadClientId: 1, infohash: null, clientRef: null, status, attempts: 1, createdAt: 1, updatedAt, percentage: null, absentSince: null, deliveredAt: null, reclaimedAt: null },
  });
  const ops: SyncOp[] = [download(1, 'submitting', 1)];
  for (let id = 2; id <= 12; id += 1) ops.push(download(id, id % 2 === 0 ? 'delivered' : 'failed', id * 10));
  await applyBatch(db, ops, { since: 1, before: null });
  const rows = await activeDownloads(db, 3);
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [[1, 'submitting']], 'the oldest row is live and 11 newer terminal rows span four pages of three');
  db.close();
});
