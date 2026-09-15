/**
 * The row-level read surface: five functions, none of which knows what a
 * plugin is. Design spec §7 says why the seam sits here -- joining across
 * tables is `store/gather.ts`'s job and a plugin's `compose.ts`'s, both
 * built on top of this rather than folded into it.
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
 * 'value.updatedAt']` -- also a `value.*` path, so the same exclusion
 * applies -- but its own tests measure that rather than lean on the claim,
 * per this task's brief.
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
  const { from, direction, limit } = opts;
  const range = rangeFor(table, from, direction);
  const index = rowsStore(db).index('by_table_updated');
  return drain(index.openCursor(range, direction), limit);
}
