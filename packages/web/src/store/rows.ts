/**
 * The row-level read surface: eight functions. Six of them -- `getRow`,
 * `getRows`, `byMediaItem`, `byRssItem`, `listByTable` and
 * `pluginRowsByMediaItems` -- do not know what a plugin is; `listByTablePlugin`
 * and `countByPlugin` take a `pluginId`, because the index they read
 * (`by_table_plugin_updated`) partitions on one. Even those two know nothing
 * *about* a plugin: the id is a key component they pass through, not a
 * behaviour they switch on. `pluginRowsByMediaItems` takes a list of table
 * names instead, the same as `tables` on `store/gather.ts`'s
 * `gatherMediaItem` used to and now does not -- see that function's own
 * doc for where the partition moved and why. Design spec §7 says why the
 * seam sits here -- joining across tables is `store/gather.ts`'s job and a
 * plugin's `compose.ts`'s, both built on top of this rather than folded
 * into it.
 *
 * **`getRow` cannot tell "not yet replicated" from "does not exist", and
 * must not pretend to (spec §9).** Both a tombstone (a record with no
 * `value`) and an absent key both resolve to `undefined` with no
 * special-casing required -- optional chaining over a missing property and
 * over a missing record land on the same answer, which is the point.
 * `byMediaItem` and `byRssItem` get the same exclusion for free, a different
 * way: a tombstone has no `value` key at all, so it drops out of
 * `by_media_item` and `by_rss_item` (both `value.*` index key paths) before
 * a query ever sees it (`store/db.ts`'s doc, measured in task 1's review).
 * A stored `value` of `null` reads as absent too. Task 2 refuses to write one,
 * so it cannot arrive from the wire any more -- but it is index-invisible
 * exactly as a tombstone is (measured), and a read surface that returned it
 * while every index hid it would be the one place in this module where two
 * reads of the same row disagree.
 *
 * `listByTable`'s index, `by_table_updated`, is keyed `['table',
 * 'value.updatedAt', 'id']` -- its middle component is a `value.*` path, so
 * the same exclusion applies -- but its own tests measure that rather than
 * lean on the claim. The third component is not decoration; see
 * {@link ListByTableOptions.from} for the rows a two-part key lost.
 */
import { request } from './idb.ts';
import type { StoredRow } from './db.ts';
import type { PluginRows } from '@pickarr/plugin-ui';
import { DOWNLOAD_STATUSES, type DownloadStatus } from '@pickarr/contract';

/**
 * Options for {@link listByTable}. `from` is the full key
 * `by_table_updated` is ordered by, not a bare timestamp -- see the property
 * itself for what a bare one cost (spec §3.2, §7).
 */
export interface ListByTableOptions {
  /**
   * Where to resume, as the full key the index is ordered by.
   *
   * Both halves, not just `updatedAt`: that column is not unique, so a page
   * boundary falling inside a tie cannot be resumed from the timestamp alone.
   * Measured on the two-part version -- five people paged backwards two at a
   * time with three sharing one `updatedAt` served [1,4,5] and never served 2
   * or 3 from any page. The row named here is excluded from the next page,
   * which is what makes a walk neither skip nor repeat.
   */
  from?: { updatedAt: number; id: number };
  direction: 'next' | 'prev';
  limit: number;
}

/**
 * The eight tables `by_table_updated` is *read* for, and no others -- which
 * is once again the same as the tables whose rows it holds, now that the
 * `filepath_mapping` paragraph at the end has a caller in it. The original
 * five were measured rather than intended (design spec §3.2) -- this
 * file's own tests page `media_item` and `rss_item` through the index
 * directly.
 *
 * **`rss_feed`'s membership is measured too, and this paragraph used to say
 * it was not.** It said "nothing in this repo pages an `rss_feed` row
 * through `by_table_updated` today, so it rests on declared shape alone",
 * which was true when it was written and stopped being true later in the
 * same branch, when `settings/useFeeds.ts` landed and read the whole table
 * through `listByTable`. Measured, by deleting `'rss_feed'` from the set
 * below: **12 web tests red** -- five in `test/settings/useFeeds.test.tsx`,
 * six in `test/settings/Feeds.test.tsx`, one in `test/shell/Shell.test.tsx`
 * -- each of them seeding real rows through `applyBatch` into a real
 * `fake-indexeddb` store and reading them back through this function. The
 * declared shape holds as well (`RssFeedSyncRead` carries `updatedAt`, same
 * as the other five, and the index's key path in `store/db.ts` admits any
 * row with one), but it is no longer the only thing holding this entry up.
 *
 * `media_item`, `rss_item`, `torrent_download` and `nzb_download`
 * project `updatedAt` because the sync protocol's read shapes for them do;
 * `person` does too, and so do `rss_feed`, `download_client` and
 * `filepath_mapping`. `role`
 * projects only `createdAt`, and none of the six plugin read shapes
 * (`tv_release`, `tv_season`, `tv_series`, `movie_detail`, `xxx_scene`,
 * `xxx_site`) carries either. Asking `listByTable` for one of those seven
 * is a programming error and throws (see below) rather than returning an
 * empty page, which would read as "this table is empty" -- a lie a caller
 * has no way to catch.
 *
 * **`download_client` was the eighth exclusion and is now a member, and it
 * is measured exactly the way `rss_feed` above is.** It joined
 * `HOST_SYNCED_TABLES` in the download clients slice and
 * `DownloadClientSyncRead` carries `updatedAt`, so its rows were already in
 * `by_table_updated` while this set was the last thing standing between
 * them and a caller; the entry below is the one line that admits them, and
 * `settings/useDownloadClients.ts` is the caller that made it an error to
 * fix rather than a table nobody asks for. Measured by deleting
 * `'download_client'` from the set: **19 web tests red** -- eleven in
 * `test/settings/DownloadClients.test.tsx`, six in
 * `test/settings/useDownloadClients.test.tsx`, one in
 * `test/settings/Settings.test.tsx` and one in `test/shell/Shell.test.tsx`
 * -- each of them seeding real rows through `applyBatch` into a real
 * `fake-indexeddb` store and reading them back through this function.
 *
 * **`filepath_mapping` was a ninth synced table and an eighth exclusion,
 * and it is now a member.** It joined `HOST_SYNCED_TABLES` in the
 * path-mappings slice with an `updatedAt` of its own (migration 19), so
 * its rows were already in `by_table_updated` while this set was the last
 * thing standing between them and a caller -- exactly where
 * `download_client` stood one slice earlier. The task that made it synced
 * deliberately left this entry to the task that needed it, and
 * `settings/useClientMappings.ts` is that caller: the path mappings inside
 * each download client's row on `/settings`.
 *
 * Measured the way the two entries above are, by deleting
 * `'filepath_mapping'` from the set below: **34 web tests red** of 215 --
 * fifteen in `test/settings/ClientMappings.test.tsx`, ten in
 * `test/settings/useClientMappings.test.tsx`, seven in
 * `test/settings/DownloadClients.test.tsx` and two in
 * `test/settings/Settings.test.tsx` -- each of them seeding real rows
 * through `applyBatch` into a real `fake-indexeddb` store and reading them
 * back through this function.
 *
 * This figure said 33 of 214 for the length of one fix wave, and was
 * wrong by the time it was written: the commit adding the order test to
 * `useClientMappings.test.tsx` landed two commits *earlier in that same
 * wave*, and that test fails under this mutation too. Nothing was
 * mismeasured -- the count was correct when taken and stale when
 * committed. A measured number is only true of the tree it was measured
 * against, which is worth knowing before writing the next one.
 *
 * The last nine of those are worth naming, because they are collateral
 * rather than aim: **eight of the nine mention no mapping at all.** The
 * ninth does -- `DownloadClients.test.tsx`'s `each listed client offers
 * its own path mappings, named from its own heading`, which this slice
 * added -- and the sentence here used to say all nine, which a review
 * re-ran the mutation and corrected. The eight are the other six in
 * `DownloadClients.test.tsx` and both in `Settings.test.tsx`.
 * `DownloadClients` mounts a `ClientMappings` per listed client, so a throw here becomes a
 * rejection out of that hook's refresh on any settings render at all --
 * which is the other half of why an empty page would be worse than a
 * throw. A silent `[]` would have left all nine green and the mappings
 * lists permanently, invisibly empty.
 *
 * So the throw's message is true of every table it can name again: the
 * seven this set excludes are `role`, which projects only `createdAt`, and
 * the six plugin read shapes, which carry neither. The paragraph this
 * replaces recorded a deliberate, bounded inaccuracy in that sentence for
 * the one table that carried the column and was excluded anyway; nothing
 * here needs it now.
 *
 * **`plugin_destination` is the ninth**, on exactly the reasoning
 * `filepath_mapping` joined by one slice earlier: the importer slice made
 * it synced (`sync/tables.ts`), it projects `updatedAt`, and
 * `settings/useDestinations.ts` is the caller it was admitted for -- the
 * library-destinations section of `/settings`.
 *
 * Measured the way the entries above are, by deleting `'plugin_destination'`
 * from the set below: **24 web tests red** of 258 -- all seventeen of
 * `test/settings/Destinations.test.tsx` and seven of the eight in
 * `test/settings/useDestinations.test.tsx`, each of them seeding real rows
 * through `applyBatch` into a real `fake-indexeddb` store and reading them
 * back through this function.
 *
 * Two things about that figure are worth saying rather than leaving to be
 * re-derived. **None of the 24 is collateral**, where nine of
 * `filepath_mapping`'s 34 were: no other screen reads this table, so the
 * blast radius is exactly the two files that do. And the **one survivor**
 * is `a store-closed rejection during refresh is caught` -- it hands the
 * hook a `listByTable` of its own that rejects before this function is
 * reached, so it is the only test in either file that never calls it. A
 * silent `[]` in place of the throw would have left the whole destinations
 * section rendering three permanently, invisibly blank rows.
 */
const TABLES_WITH_UPDATED_AT: ReadonlySet<string> = new Set([
  'media_item',
  'rss_item',
  'torrent_download',
  'nzb_download',
  'person',
  'rss_feed',
  'download_client',
  'filepath_mapping',
  'plugin_destination',
]);

/**
 * The tables the two per-category readers below (`listByTablePlugin`,
 * `countByPlugin`) will query `by_table_plugin_updated` for -- a guard on
 * the *readers*, not a description of what the index holds. Exactly one
 * member today: `media_item` is the table those two readers exist for.
 *
 * **This is no longer "the tables carrying `pluginId`", now that `rss_feed`
 * does too.** `by_table_plugin_updated` is a generic IndexedDB index keyed
 * `['table', 'value.pluginId', 'value.updatedAt', 'id']`
 * (`store/db.ts`), so it indexes *any* row with both components, `rss_feed`
 * rows included since `RssFeedSyncRead` carries `pluginId` -- with nothing
 * in this file asking for that. `rss_item` still carries `feedId` instead of
 * `pluginId`, which is why *its* rows stay out of the index on their own;
 * `rss_feed` is the opposite case, present in the index and excluded here
 * only because this set says so. No caller needs a feed listed by plugin
 * yet, so it stays out; admitting it is a one-line change here whenever one
 * does, not a schema change.
 *
 * **Separate from `TABLES_WITH_UPDATED_AT`, because they disagree.** That
 * set admits eight tables and only two of them, `media_item` and `rss_feed`,
 * project a `pluginId`; the two readers below originally reused it, so for
 * `rss_item`, `torrent_download`, `nzb_download` and `person` the guard
 * passed and the index answered nothing -- measured, with a registered
 * plugin's own id as the second argument, as
 * `listByTablePlugin('rss_item', pluginId) -> []` and
 * `countByPlugin('rss_item', pluginId) -> 0` against a store holding two
 * real `rss_item` rows. (The id is written as a name rather than spelled
 * out because `test/plugins/registry.test.ts` refuses a plugin id anywhere
 * in `src/` outside the registry, comments included; the measurement is
 * the one originally recorded here and is unchanged.) That is precisely the lie the other set's own doc exists
 * to refuse: an empty answer reading as "this table is empty", which a
 * caller has no way to catch.
 */
const TABLES_WITH_PLUGIN_ID: ReadonlySet<string> = new Set(['media_item']);

function rowsStore(db: IDBDatabase): IDBObjectStore {
  return db.transaction('rows').objectStore('rows');
}

/** `undefined` for a tombstone and for a row never replicated -- spec §9 says the caller cannot tell those apart here, and must not be told it can. */
export async function getRow(db: IDBDatabase, table: string, id: number): Promise<unknown | undefined> {
  const row = await request<StoredRow | undefined>(rowsStore(db).get([table, id]));
  // `?? undefined` rather than `row?.value`: a stored `null` is index-
  // invisible like a tombstone, so returning it would make this the one read
  // that disagrees with every index. See the module docblock.
  return row?.value ?? undefined;
}

/**
 * Every id in `ids` that resolves to an actual value, keyed by id. An id
 * that is a tombstone or was never replicated is simply absent from the
 * map -- `map.get(id)` already answers `undefined` for both, matching
 * {@link getRow}.
 */
export async function getRows(
  db: IDBDatabase,
  table: string,
  ids: readonly number[],
): Promise<Map<number, unknown>> {
  const store = rowsStore(db);
  const held = await Promise.all(
    ids.map(async (id) => ({ id, row: await request<StoredRow | undefined>(store.get([table, id])) })),
  );
  const result = new Map<number, unknown>();
  for (const { id, row } of held) {
    if (row?.value !== undefined && row.value !== null) result.set(id, row.value);
  }
  return result;
}

/** Every row of every table belonging to one media item, in one round trip -- not compound on `table` (spec §3.2), because that one query is the composition layer's most common. */
export async function byMediaItem(db: IDBDatabase, mediaItemId: number): Promise<readonly StoredRow[]> {
  return request<StoredRow[]>(rowsStore(db).index('by_media_item').getAll(mediaItemId));
}

/** A release's downloads, across `torrent_download` and `nzb_download` alike. */
export async function byRssItem(db: IDBDatabase, rssItemId: number): Promise<readonly StoredRow[]> {
  return request<StoredRow[]>(rowsStore(db).index('by_rss_item').getAll(rssItemId));
}

/**
 * {@link pluginRowsByMediaItems}' answer: the rows themselves, and the ids
 * behind them.
 *
 * `heldIds` exists for `usePluginRows` (#105): the sync protocol puts a
 * row's key on the op rather than in the value, and `PluginRows` carries
 * values without their keys on purpose (see that type's own doc) -- so a
 * caller that wants to know *which* rows a page holds, to tell its own
 * update or delete from a stranger's, cannot get that from `rows` alone.
 * This carries the key the one step further, beside the values rather than
 * inside them.
 */
export interface PluginRowsPage {
  readonly rows: ReadonlyMap<number, PluginRows>;
  /** Every row id the page holds, per table -- what `usePluginRows` matches a touched id against. */
  readonly heldIds: ReadonlyMap<string, ReadonlySet<number>>;
}

/**
 * Every row `tables` names, for every id in `mediaItemIds`, grouped first
 * by media item and then by table -- one transaction regardless of how
 * many ids or tables, the way {@link getRows} already batches N keyed
 * reads for one table onto one transaction rather than opening one per id.
 *
 * **One transaction, measured rather than assumed.** `rowsStore` opens a
 * fresh transaction on every call, so calling {@link byMediaItem} once per
 * id -- the shape a per-card fetch would have taken -- opens one
 * transaction per id. This function opens exactly one `IDBObjectStore` and
 * issues every id's `getAll` against it before any of them resolves
 * (`Promise.all` over synchronous `IDBRequest` creation, the same
 * structure `getRows` already uses), which is what keeps the transaction
 * open across all of them rather than auto-committing between calls.
 * `test/store/rows.test.ts` counts this directly, for a page of 50, rather
 * than trusting the shape of the code.
 *
 * **Every table `tables` names is a key for every id, always, even when
 * that id has no rows in it.** An absent key would read as "not fetched",
 * and a caller cannot tell that from "fetched, and empty" unless this
 * function keeps the two apart itself -- `@pickarr/plugin-ui`'s
 * `PluginRows` own doc says the same, and this is the function that now
 * has to honour it: `store/gather.ts` no longer does (see that module's
 * doc for why the partition moved here).
 *
 * An id in `mediaItemIds` that the replica holds nothing for still gets an
 * entry in the returned map -- every declared table, each an empty array
 * -- rather than being left out of the map entirely. A caller that wants
 * to distinguish "this item does not exist" from "this item has no rows in
 * these tables" already has that answer from wherever it got
 * `mediaItemIds`; this function does not re-derive it.
 */
export async function pluginRowsByMediaItems(
  db: IDBDatabase,
  mediaItemIds: readonly number[],
  tables: readonly string[],
): Promise<PluginRowsPage> {
  const index = rowsStore(db).index('by_media_item');
  const held = await Promise.all(
    mediaItemIds.map(async (mediaItemId) => ({
      mediaItemId,
      rows: await request<StoredRow[]>(index.getAll(mediaItemId)),
    })),
  );
  const result = new Map<number, PluginRows>();
  const heldIds = new Map<string, Set<number>>();
  for (const table of tables) heldIds.set(table, new Set());
  for (const { mediaItemId, rows } of held) {
    const pluginRows: Record<string, unknown[]> = {};
    for (const table of tables) pluginRows[table] = [];
    for (const row of rows) {
      pluginRows[row.table]?.push(row.value);
      heldIds.get(row.table)?.add(row.id);
    }
    result.set(mediaItemId, pluginRows);
  }
  return { rows: result, heldIds };
}

/**
 * The key range for one table's slice of `by_table_updated`: the whole table
 * when `from` is absent, otherwise the strict far side of that *key* in the
 * direction requested. See {@link ListByTableOptions.from}.
 *
 * `-Infinity`/`Infinity` pad both unused components so the bound is the same
 * arity as the index. A short array compares less than any longer one sharing
 * its prefix, so a two-element low bound would still work -- but a two-element
 * *upper* bound would exclude every row in the table, which is the kind of
 * asymmetry that reads as a missing-data bug rather than a bounds bug.
 */
function rangeFor(
  table: string,
  from: { updatedAt: number; id: number } | undefined,
  direction: 'next' | 'prev',
): IDBKeyRange {
  const low = [table, -Infinity, -Infinity];
  const high = [table, Infinity, Infinity];
  if (from === undefined) return IDBKeyRange.bound(low, high);
  const at = [table, from.updatedAt, from.id];
  // Exclusive on the named row in whichever direction the walk is going, so
  // the row that ended the last page is not repeated and its tied siblings
  // are not skipped.
  return direction === 'next'
    ? IDBKeyRange.bound(at, high, true, false)
    : IDBKeyRange.bound(low, at, false, true);
}

/**
 * Drains an open cursor request up to `limit` rows. Not built on `request`
 * from `store/idb.ts`: that helper resolves a request's *one* `success`
 * event, and a cursor fires `success` again on every `continue()` -- a
 * second wrapper here, rather than teaching the shared one two shapes, per
 * that module's own docblock on why it stays at two functions.
 */
function drain(cursorRequest: IDBRequest<IDBCursorWithValue | null>, limit: number): Promise<StoredRow[]> {
  return new Promise((resolve, reject) => {
    const results: StoredRow[] = [];
    cursorRequest.addEventListener('success', () => {
      const cursor = cursorRequest.result;
      if (cursor === null || results.length >= limit) {
        resolve(results);
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    });
    cursorRequest.addEventListener(
      'error',
      () => reject(cursorRequest.error ?? new Error('indexeddb cursor failed')),
      { once: true },
    );
  });
}

/**
 * `table` in modification order, walking `by_table_updated`. Throws for any
 * of the seven tables {@link TABLES_WITH_UPDATED_AT} excludes, every one of
 * which carries no `updatedAt` at all. See that constant's doc for the
 * per-table measurements and for why an empty page would be worse than a
 * throw.
 */
export async function listByTable(
  db: IDBDatabase,
  table: string,
  opts: ListByTableOptions,
): Promise<readonly StoredRow[]> {
  if (!TABLES_WITH_UPDATED_AT.has(table)) {
    throw new Error(
      `"${table}" projects no updatedAt, so listByTable cannot list it in modification order (design spec §3.2)`,
    );
  }
  const { from, direction, limit } = opts;
  const range = rangeFor(table, from, direction);
  const index = rowsStore(db).index('by_table_updated');
  return drain(index.openCursor(range, direction), limit);
}

/**
 * `rangeFor`'s four-part sibling. Same exclusivity rule and same reason: the
 * row that ended the last page is excluded in whichever direction the walk is
 * going, so a page boundary landing inside an `updatedAt` tie neither repeats
 * that row nor skips its siblings.
 */
function pluginRangeFor(
  table: string,
  pluginId: string,
  from: { updatedAt: number; id: number } | undefined,
  direction: 'next' | 'prev',
): IDBKeyRange {
  const low = [table, pluginId, -Infinity, -Infinity];
  const high = [table, pluginId, Infinity, Infinity];
  if (from === undefined) return IDBKeyRange.bound(low, high);
  const at = [table, pluginId, from.updatedAt, from.id];
  return direction === 'next'
    ? IDBKeyRange.bound(at, high, true, false)
    : IDBKeyRange.bound(low, at, false, true);
}

/**
 * One category's rows in modification order. A sibling of {@link listByTable}
 * rather than a flag on it, so which index a call uses is visible where the
 * call is written.
 *
 * Throws for any table {@link TABLES_WITH_PLUGIN_ID} excludes -- see that
 * constant for why it is not `TABLES_WITH_UPDATED_AT`.
 */
export async function listByTablePlugin(
  db: IDBDatabase,
  table: string,
  pluginId: string,
  opts: ListByTableOptions,
): Promise<readonly StoredRow[]> {
  if (!TABLES_WITH_PLUGIN_ID.has(table)) {
    throw new Error(
      `"${table}" projects no pluginId, so listByTablePlugin cannot list one of its categories (design spec §3.2)`,
    );
  }
  const { from, direction, limit } = opts;
  const index = rowsStore(db).index('by_table_plugin_updated');
  return drain(index.openCursor(pluginRangeFor(table, pluginId, from, direction), direction), limit);
}

/**
 * How many rows one category has, counted by the index rather than read.
 *
 * This replaces reading every `media_item` row to produce three numbers.
 * Tombstones are absent from the index (`db.ts`'s own note on why), so a
 * deleted row leaves the count without this having to filter for it.
 *
 * Throws for a table projecting no `pluginId`, exactly as
 * {@link listByTablePlugin} does and for the same reason: a count of zero
 * over a table full of rows is a lie a caller cannot catch. This one had no
 * guard at all until the whole-branch review measured it answering `0` for
 * `rss_item`. `async` despite awaiting nothing, so that refusal arrives as
 * a rejection rather than as a synchronous throw out of a function whose
 * signature promises a promise -- the same shape its sibling already has.
 */
export async function countByPlugin(db: IDBDatabase, table: string, pluginId: string): Promise<number> {
  if (!TABLES_WITH_PLUGIN_ID.has(table)) {
    throw new Error(
      `"${table}" projects no pluginId, so countByPlugin cannot count one of its categories (design spec §3.2)`,
    );
  }
  const index = rowsStore(db).index('by_table_plugin_updated');
  const req = index.count(pluginRangeFor(table, pluginId, undefined, 'next'));
  return new Promise((resolve, reject) => {
    req.addEventListener('success', () => resolve(req.result), { once: true });
    req.addEventListener('error', () => reject(req.error ?? new Error('indexeddb count failed')), { once: true });
  });
}

/**
 * One download that has not finished, joined to what the Activities page
 * shows beside it. Built from the replica alone: the host does no work for it.
 */
export interface ActiveDownload {
  readonly table: 'torrent_download' | 'nzb_download';
  readonly id: number;
  readonly status: string;
  readonly percentage: number | null;
  /** `'unknown release'` when the `rss_item` has not replicated yet. */
  readonly filename: string;
  /** `null` when the release is unmatched, or its `media_item` has not replicated. */
  readonly title: string | null;
  /** `'unknown client'` when the `download_client` row is absent. */
  readonly clientName: string;
  readonly updatedAt: number;
}

/**
 * The statuses a download can hold while it is still someone's concern:
 * the host's vocabulary (`@pickarr/contract`'s `DOWNLOAD_STATUSES`) minus
 * its two terminal members. Derived rather than listed so a seventh status
 * is live here the day the host adds it, which matches what the old
 * `!== 'delivered' && !== 'failed'` filter did without being a list that
 * drifts. `rows.test.ts` pins both the four members and the two left out.
 */
export const ACTIVE_DOWNLOAD_STATUSES: readonly DownloadStatus[] =
  DOWNLOAD_STATUSES.filter((status) => status !== 'delivered' && status !== 'failed');

const DOWNLOAD_TABLES = ['torrent_download', 'nzb_download'] as const;

/** Every row of `table` whose `value.status` is `status`, newest first, off `by_table_status_updated`. */
function listByTableStatus(db: IDBDatabase, table: string, status: string): Promise<StoredRow[]> {
  const index = rowsStore(db).index('by_table_status_updated');
  const range = IDBKeyRange.bound([table, status, -Infinity, -Infinity], [table, status, Infinity, Infinity]);
  return drain(index.openCursor(range, 'prev'), Number.POSITIVE_INFINITY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface RawDownload {
  readonly id: number;
  readonly status: string;
  readonly percentage: number | null;
  readonly rssItemId: number | null;
  readonly downloadClientId: number | null;
  readonly updatedAt: number;
}

function toRawDownload(value: unknown): RawDownload | undefined {
  if (!isRecord(value)) return undefined;
  const { id, status, percentage, rssItemId, downloadClientId, updatedAt } = value;
  if (typeof id !== 'number' || typeof status !== 'string' || typeof updatedAt !== 'number') return undefined;
  return {
    id,
    status,
    percentage: typeof percentage === 'number' ? percentage : null,
    rssItemId: typeof rssItemId === 'number' ? rssItemId : null,
    downloadClientId: typeof downloadClientId === 'number' ? downloadClientId : null,
    updatedAt,
  };
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/**
 * Every torrent and NZB download whose status is not terminal (see
 * {@link ACTIVE_DOWNLOAD_STATUSES}), newest `updatedAt` first, each joined
 * to its release filename, its media item's title and its client's name. A
 * join whose row has not replicated (log order is not row order) falls back
 * rather than dropping the download: the page would otherwise hide work that
 * is really running.
 *
 * Reads one index range per `[table, status]` -- eight in all -- and merges
 * them, so the cost is proportional to what is live, not to every download
 * ever recorded (the host never deletes a download row, so the table only
 * grows). The earlier version walked each whole table newest first; on an
 * old install that was every row, on every change to either table.
 */
export async function activeDownloads(db: IDBDatabase): Promise<readonly ActiveDownload[]> {
  const pages = await Promise.all(
    DOWNLOAD_TABLES.flatMap((table) =>
      ACTIVE_DOWNLOAD_STATUSES.map(async (status) => ({ table, rows: await listByTableStatus(db, table, status) }))),
  );
  const live: { table: ActiveDownload['table']; raw: RawDownload }[] = [];
  for (const { table, rows } of pages) {
    for (const row of rows) {
      const raw = toRawDownload(row.value);
      if (raw !== undefined) live.push({ table, raw });
    }
  }
  // Newest first across all eight ranges; ties by table name then id, so the
  // order is total and a re-render under equal timestamps does not shuffle.
  live.sort((a, b) => b.raw.updatedAt - a.raw.updatedAt || a.table.localeCompare(b.table) || b.raw.id - a.raw.id);

  const rssIds = [...new Set(live.flatMap(({ raw }) => (raw.rssItemId === null ? [] : [raw.rssItemId])))];
  const clientIds = [...new Set(live.flatMap(({ raw }) => (raw.downloadClientId === null ? [] : [raw.downloadClientId])))];
  const [rssItems, clients] = await Promise.all([
    getRows(db, 'rss_item', rssIds),
    getRows(db, 'download_client', clientIds),
  ]);
  const mediaIds = new Set<number>();
  for (const item of rssItems.values()) {
    if (isRecord(item) && typeof item.mediaItemId === 'number') mediaIds.add(item.mediaItemId);
  }
  const media = await getRows(db, 'media_item', [...mediaIds]);

  const result = live.map(({ table, raw }): ActiveDownload => {
    const rss = raw.rssItemId === null ? undefined : rssItems.get(raw.rssItemId);
    const mediaItemId = isRecord(rss) && typeof rss.mediaItemId === 'number' ? rss.mediaItemId : undefined;
    const client = raw.downloadClientId === null ? undefined : clients.get(raw.downloadClientId);
    return {
      table,
      id: raw.id,
      status: raw.status,
      percentage: raw.percentage,
      filename: stringField(rss, 'filename') ?? 'unknown release',
      title: mediaItemId === undefined ? null : (stringField(media.get(mediaItemId), 'title') ?? null),
      clientName: stringField(client, 'name') ?? 'unknown client',
      updatedAt: raw.updatedAt,
    };
  });
  return result.toSorted((a, b) => b.updatedAt - a.updatedAt);
}
