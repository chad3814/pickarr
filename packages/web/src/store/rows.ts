/**
 * The row-level read surface: five functions, none of which knows what a
 * plugin is. Design spec §7 says why the seam sits here -- joining across
 * tables is `store/gather.ts`'s job and a plugin's `compose.ts`'s, both
 * built on top of this rather than folded into it.
 *
 * **`getRow` cannot tell "not yet replicated" from "does not exist", and
 * must not pretend to (spec §9).** Both a tombstone (a record with no
 * `value`) and an absent key resolve `row?.value` to `undefined` with no
 * special-casing required -- optional chaining over a missing property and
 * over a missing record land on the same answer, which is the point.
 * `byMediaItem` and `byRssItem` get the same exclusion for free, a different
 * way: a tombstone has no `value` key at all, so it drops out of
 * `by_media_item` and `by_rss_item` (both `value.*` index key paths) before
 * a query ever sees it (`store/db.ts`'s doc, measured in task 1's review).
 * `listByTable`'s index, `by_table_updated`, is keyed `['table',
 * 'value.updatedAt']` -- also a `value.*` path, so the same exclusion
 * applies -- but its own tests measure that rather than lean on the claim,
 * per this task's brief.
 */
import { request } from './idb.ts';
import type { StoredRow } from './db.ts';

/**
 * Options for {@link listByTable}. `fromUpdatedAt` is an `updatedAt` value,
 * not a row id -- named for what it is, because `from` alone reads as a
 * cursor of unstated kind (spec §7).
 */
export interface ListByTableOptions {
  /**
   * Strictly excluded from the page: `direction: 'next'` returns rows whose
   * `updatedAt` is greater than this, `'prev'` returns rows whose
   * `updatedAt` is less. Matches the host's own cursor convention
   * (`packages/host/src/api/reads.ts`: "never `>=` -- the cursor row itself
   * has already been served"), so a caller can hand the last row's
   * `updatedAt` straight back to page on without re-fetching it.
   *
   * `by_table_updated` carries no id to break a tie on, so two rows sharing
   * the exact `updatedAt` this cursor lands on cannot both be represented by
   * one boundary value -- whichever of them the page split between is not
   * re-offered. Unmeasured in practice: `updatedAt` is millisecond
   * resolution and this index has no secondary key to widen it.
   */
  fromUpdatedAt?: number;
  direction: 'next' | 'prev';
  limit: number;
}

/**
 * The five tables `by_table_updated` covers, and no others -- measured
 * rather than intended (design spec §3.2). `media_item`, `rss_item`,
 * `torrent_download` and `nzb_download` project `updatedAt` because the sync
 * protocol's read shapes for them do; `person` does too. `role` projects
 * only `createdAt`, and none of the six plugin read shapes (`tv_release`,
 * `tv_season`, `tv_series`, `movie_detail`, `xxx_scene`, `xxx_site`) carries
 * either. Asking `listByTable` for one of those seven is a programming
 * error and throws (see below) rather than returning an empty page, which
 * would read as "this table is empty" -- a lie a caller has no way to catch.
 */
const TABLES_WITH_UPDATED_AT: ReadonlySet<string> = new Set([
  'media_item',
  'rss_item',
  'torrent_download',
  'nzb_download',
  'person',
]);

function rowsStore(db: IDBDatabase): IDBObjectStore {
  return db.transaction('rows').objectStore('rows');
}

/** `undefined` for a tombstone and for a row never replicated -- spec §9 says the caller cannot tell those apart here, and must not be told it can. */
export async function getRow(db: IDBDatabase, table: string, id: number): Promise<unknown | undefined> {
  const row = await request<StoredRow | undefined>(rowsStore(db).get([table, id]));
  return row?.value;
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
    if (row?.value !== undefined) result.set(id, row.value);
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
 * The key range for one table's slice of `by_table_updated`: the whole
 * table when `fromUpdatedAt` is absent, otherwise the strict far side of it
 * in the direction requested. See {@link ListByTableOptions.fromUpdatedAt}.
 */
function rangeFor(table: string, fromUpdatedAt: number | undefined, direction: 'next' | 'prev'): IDBKeyRange {
  if (fromUpdatedAt === undefined) return IDBKeyRange.bound([table, -Infinity], [table, Infinity]);
  return direction === 'next'
    ? IDBKeyRange.bound([table, fromUpdatedAt], [table, Infinity], true, false)
    : IDBKeyRange.bound([table, -Infinity], [table, fromUpdatedAt], false, true);
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
 * of the seven tables {@link TABLES_WITH_UPDATED_AT} excludes -- see that
 * constant's doc for the measurement and the reasoning against returning an
 * empty page instead.
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
  const { fromUpdatedAt, direction, limit } = opts;
  const range = rangeFor(table, fromUpdatedAt, direction);
  const index = rowsStore(db).index('by_table_updated');
  return drain(index.openCursor(range, direction), limit);
}
