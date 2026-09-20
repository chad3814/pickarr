/**
 * The row-level read surface: seven functions. Five of them -- `getRow`,
 * `getRows`, `byMediaItem`, `byRssItem` and `listByTable` -- do not know
 * what a plugin is; `listByTablePlugin` and `countByPlugin` take a
 * `pluginId`, because the index they read (`by_table_plugin_updated`)
 * partitions on one. Even those two know nothing *about* a plugin: the id
 * is a key component they pass through, not a behaviour they switch on.
 * Design spec §7 says why the seam sits here -- joining across tables is
 * `store/gather.ts`'s job and a plugin's `compose.ts`'s, both built on top
 * of this rather than folded into it.
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
 * The seven tables `by_table_updated` is *read* for, and no others -- which
 * is no longer the same as the tables whose rows it holds; see the
 * `filepath_mapping` paragraph at the end. The original five
 * were measured rather than intended (design spec §3.2) -- this file's own
 * tests page `media_item` and `rss_item` through the index directly.
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
 * `person` does too, and so do `rss_feed` and `download_client`. `role`
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
 * **`filepath_mapping` is a ninth synced table and an eighth exclusion, and
 * it is the first one excluded for a reason other than not having the
 * column.** It joined `HOST_SYNCED_TABLES` in the path-mappings slice with
 * an `updatedAt` of its own (migration 19), so its rows are already in
 * `by_table_updated` and this set is the only thing between them and a
 * caller -- exactly where `download_client` stood one slice ago. It is
 * absent here because no caller lists it yet; the settings screen that
 * will is the task after the one that made it synced, and that task adds
 * the entry below.
 *
 * So the throw's message is, for this one table, not true of the table:
 * it says `projects no updatedAt` and this table does. That is deliberate
 * and it is bounded. **No caller can produce it** -- `listByTable`'s
 * production callers name `rss_feed`, `download_client` and `rss_item`
 * literally, and no call site anywhere passes a table computed at runtime,
 * so the only way to reach that string is to write the name in and the
 * same commit that would do so adds the entry. Rewording the message to
 * suit a case nobody can reach would cost the seven cases anyone *can*:
 * for `role` and the six plugin tables the sentence is exactly right and
 * says *why*, where a message about this set's membership would only
 * restate the guard.
 */
const TABLES_WITH_UPDATED_AT: ReadonlySet<string> = new Set([
  'media_item',
  'rss_item',
  'torrent_download',
  'nzb_download',
  'person',
  'rss_feed',
  'download_client',
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
 * set admits seven tables and only two of them, `media_item` and `rss_feed`,
 * project a `pluginId`; the two readers below originally reused it, so for
 * `rss_item`, `torrent_download`, `nzb_download` and `person` the guard
 * passed and the index answered nothing -- measured as
 * `listByTablePlugin('rss_item','tv') -> []` and
 * `countByPlugin('rss_item','tv') -> 0` against a store holding two real
 * `rss_item` rows. That is precisely the lie the other set's own doc exists
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
 * of the eight tables {@link TABLES_WITH_UPDATED_AT} excludes -- seven that
 * carry no `updatedAt` at all, and `filepath_mapping`, which carries one
 * and is excluded only because nothing lists it yet. See that constant's
 * doc for the measurement, for why an empty page would be worse, and for
 * why the message below is left saying `projects no updatedAt` even though
 * it is untrue of that eighth table and unreachable for it.
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
