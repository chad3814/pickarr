/**
 * Every read the API answers, as SQL against the shared tables. Imports
 * `./cursor.ts` and nothing else from the project -- in particular nothing
 * from `host.ts`, so no route added on top of this can pull `src/api` into a
 * cycle back through the registry.
 *
 * **The keyset predicate is what this module is for.** Each paged read walks
 * `(updated_at, id)` forward with
 *
 *     WHERE (updated_at > ?) OR (updated_at = ? AND id > ?)
 *
 * and nothing else will do. `updated_at >= ?` re-serves the cursor's whole
 * millisecond on every poll, forever, and a bare `updated_at > ?` silently
 * *drops* every row that shares the cursor's millisecond -- they are never
 * offered again. Neither shows up as an error anywhere; the first looks like
 * a client that will not settle and the second like rows that were never
 * written. The `id` tiebreak is what makes the page boundary exact when
 * several rows carry the same `updated_at`, which is the normal case for
 * anything written in one batch.
 *
 * That holds for every read here that reads one table. It does **not** hold
 * for `downloadsSince`, which pages a union of two tables whose ids are
 * separate rowid spaces; see its own doc for the limit that follows and why
 * this module cannot lift it.
 *
 * Synchronous, because `node:sqlite` is. Wrapping these in `async` would
 * promise a yield that never happens and buy nothing.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Cursor } from './cursor.ts';
import { PAGE_SIZE, encodeCursor } from './cursor.ts';

/**
 * Which of the two download tables a row came from, and which kind of thing
 * an rss item is fetched as. A union, not an enum: `erasableSyntaxOnly` is on
 * and these two values are the whole vocabulary a *client* is ever handed.
 * The columns behind them are TEXT and one of them can still hold a third
 * value -- see `downloadTypeOf` for which, and for what happens to it.
 */
export type Transport = 'torrent' | 'nzb';

/** A media item as a client sees it. The spec's §4 shape. */
export interface MediaItemRead {
  id: number;
  title: string;
  releaseDate: string | null;
  description: string | null;
  provider: string | null;
  providerRef: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * An rss item as a client sees it. No `updatedAt`: the column exists and is
 * what the page is ordered by, but it is the *cursor's* business rather than
 * a fact about the item, and the cursor already carries it.
 */
export interface RssItemRead {
  id: number;
  feedId: number;
  filename: string;
  link: string;
  mediaItemId: number | null;
  resolution: string;
  resolutionDetail: string | null;
  downloadType: Transport;
  deliveredAt: number | null;
}

/**
 * A download as a client sees it, from either table. `status` is `string`
 * rather than the host's own union: the vocabulary is the host's and will
 * grow, and a client pinned to today's values would break on the next one.
 *
 * `infohash` exists on `torrent_download` alone and reads `null` for an nzb
 * row -- one shape for both transports, rather than a field that is present
 * or absent depending on which table answered.
 */
export interface DownloadRead {
  id: number;
  rssItemId: number;
  downloadClientId: number;
  transport: Transport;
  status: string;
  clientRef: string | null;
  infohash: string | null;
  percentage: number | null;
  absentSince: number | null;
  deliveredAt: number | null;
  lastError: string | null;
}

/**
 * One page of a paged read.
 *
 * `done` is `items.length < PAGE_SIZE` and nothing cleverer. A page of
 * exactly `PAGE_SIZE` reports `done: false` even when nothing follows it,
 * because telling those two apart would need another query; one extra poll
 * is cheaper than stopping a row early.
 *
 * `cursor` is the last item's `(updatedAt, id)`, encoded. On an **empty**
 * page it is the caller's own cursor handed straight back -- not `null`.
 * `null` there would send a caught-up polling client back to the beginning
 * on every single poll, re-reading the whole table once a tick and never
 * noticing, since every row it re-read is a row it already had. `null` is
 * returned for exactly one case: an empty page with no cursor to echo, which
 * is a first poll against nothing, and where the beginning is already where
 * the caller is.
 */
export interface Page<T> {
  items: T[];
  cursor: string | null;
  done: boolean;
}

/**
 * The cursor a caller who sent none stands at.
 *
 * Exact rather than approximate, and that matters: `id > 0` admits every
 * row, because these tables key on `INTEGER PRIMARY KEY` and SQLite never
 * hands out a rowid below 1. So `updated_at = 0 AND id > 0` still catches a
 * row stamped 0, and `updated_at > 0` catches all the rest. The one shape it
 * would miss is a negative `updated_at`, which nothing can write: every
 * value in these columns comes from a `now()` reading in milliseconds.
 */
const BEGINNING: Cursor = { updatedAt: 0, id: 0 };

/**
 * The keyset predicate, for a table's own `(time, id)` column pair. Written
 * once so that the five places it appears in the SQL below are all the same
 * predicate rather than five chances to get it wrong -- and so a change that
 * breaks it breaks every read at once instead of leaving four correct and
 * one silently wrong.
 *
 * Both arguments are module-private literals from the constants below, never
 * anything a caller supplies, so nothing a caller holds reaches this text.
 * The three placeholders bind, in order: the cursor's time, the cursor's
 * time again, and the cursor's id.
 */
function keyset(timeColumn: string, idColumn: string): string {
  return `(${timeColumn} > ?) OR (${timeColumn} = ? AND ${idColumn} > ?)`;
}

const UPDATED_KEYSET = keyset('updated_at', 'id');

const MEDIA_ITEM_COLUMNS =
  'id, title, release_date, description, provider, provider_ref, created_at, updated_at';

const MEDIA_ITEMS_SINCE = `
  SELECT ${MEDIA_ITEM_COLUMNS}
    FROM media_item
   WHERE plugin_id = ? AND (${UPDATED_KEYSET})
   ORDER BY updated_at, id
   LIMIT ?
`;

const MEDIA_ITEM_BY_ID = `
  SELECT ${MEDIA_ITEM_COLUMNS} FROM media_item WHERE plugin_id = ? AND id = ?
`;

const MEDIA_ITEM_BY_REFERENCE = `
  SELECT ${MEDIA_ITEM_COLUMNS} FROM media_item
   WHERE plugin_id = ? AND provider = ? AND provider_ref = ?
`;

/**
 * `updated_at` is selected although `RssItemRead` has no such field: the
 * cursor is built from it, so the query has to return it even though the
 * caller never sees it.
 */
const RSS_ITEM_COLUMNS =
  'id, feed_id, filename, link, media_item_id, resolution, resolution_detail, download_type, delivered_at, updated_at';

const RSS_ITEMS_SINCE = `
  SELECT ${RSS_ITEM_COLUMNS}
    FROM rss_item
   WHERE ${UPDATED_KEYSET}
   ORDER BY updated_at, id
   LIMIT ?
`;

/**
 * Ordered by `id`, not by `updated_at`: this is every release found for one
 * media item, and id order is discovery order, which does not reshuffle
 * itself the moment one of the rows is touched.
 *
 * `rss_item` carries no index on `media_item_id`, so this one **scans** --
 * `EXPLAIN QUERY PLAN` says `SCAN rss_item` and the index test pins that as
 * the measured fact it is rather than as an approval. `ORDER BY id` is at
 * least rowid order, so the scan needs no sort on top of it. An index on
 * `media_item_id` is what would fix it, and adding one is a migration this
 * module cannot write.
 */
const RSS_ITEMS_FOR_MEDIA_ITEM = `
  SELECT ${RSS_ITEM_COLUMNS} FROM rss_item WHERE media_item_id = ? ORDER BY id
`;

const DOWNLOAD_COLUMNS =
  'id, rss_item_id, download_client_id, transport, status, client_ref, infohash, ' +
  'percentage, absent_since, delivered_at, last_error, updated_at';

/**
 * The two download tables are identical bar `infohash`, so each branch names
 * its own transport as a literal and the nzb branch supplies `NULL AS
 * infohash` to keep the two column lists union-compatible. Written out twice
 * rather than built from a table name, so no table name is ever interpolated
 * into SQL.
 */
const TORRENT_DOWNLOAD_SELECT = `
    SELECT id, rss_item_id, download_client_id, 'torrent' AS transport, status, client_ref,
           infohash, percentage, absent_since, delivered_at, last_error, updated_at
      FROM torrent_download`;

const NZB_DOWNLOAD_SELECT = `
    SELECT id, rss_item_id, download_client_id, 'nzb' AS transport, status, client_ref,
           NULL AS infohash, percentage, absent_since, delivered_at, last_error, updated_at
      FROM nzb_download`;

/**
 * Ordered across **both** tables, not within each. Reading one table to
 * exhaustion and then the other would interleave wrongly -- a client would
 * see every torrent before any nzb regardless of when either changed -- and
 * a cursor over that order skips rows the moment the second table's oldest
 * row is older than the first table's newest.
 *
 * `transport` is the last `ORDER BY` term so the order is fully determined
 * rather than left to whatever the sorter happens to do. It does **not**
 * make the cursor able to separate two rows that share an `(updated_at, id)`
 * pair -- `Cursor` has two fields, and `id` is a per-table rowid, so a
 * torrent row and an nzb row can hold the same pair. See this module's
 * `downloadsSince` for what that costs.
 */
const DOWNLOADS_SINCE = `
  SELECT ${DOWNLOAD_COLUMNS} FROM (
${TORRENT_DOWNLOAD_SELECT}
     WHERE ${UPDATED_KEYSET}
    UNION ALL
${NZB_DOWNLOAD_SELECT}
     WHERE ${UPDATED_KEYSET}
  )
  ORDER BY updated_at, id, transport
  LIMIT ?
`;

const DOWNLOADS_FOR_RSS_ITEM = `
  SELECT ${DOWNLOAD_COLUMNS} FROM (
${TORRENT_DOWNLOAD_SELECT}
     WHERE rss_item_id = ?
    UNION ALL
${NZB_DOWNLOAD_SELECT}
     WHERE rss_item_id = ?
  )
  ORDER BY updated_at, id, transport
`;

const DELETIONS_SINCE = `
  SELECT media_item_id, deleted_at
    FROM deleted_media_item
   WHERE plugin_id = ? AND (${keyset('deleted_at', 'media_item_id')})
   ORDER BY deleted_at, media_item_id
   LIMIT ?
`;

/**
 * The SQL each function below runs, keyed by that function's name.
 *
 * Exported so the index test can put `EXPLAIN QUERY PLAN` over the statement
 * this module *actually* prepares. A plan assertion against a string restated
 * in a test proves what SQLite does with the test's string, which is not the
 * question. Slice D shipped two status indexes that no query used and nothing
 * noticed until someone measured a 153 ms reconcile tick; a plan test over
 * the real query text is the only thing that would have caught it, and it
 * only works if the text is the same object.
 */
export const SYNC_QUERIES: Readonly<Record<string, string>> = Object.freeze({
  mediaItemsSince: MEDIA_ITEMS_SINCE,
  rssItemsSince: RSS_ITEMS_SINCE,
  downloadsSince: DOWNLOADS_SINCE,
  deletionsSince: DELETIONS_SINCE,
  mediaItemById: MEDIA_ITEM_BY_ID,
  mediaItemByReference: MEDIA_ITEM_BY_REFERENCE,
  rssItemsForMediaItem: RSS_ITEMS_FOR_MEDIA_ITEM,
  downloadsForRssItem: DOWNLOADS_FOR_RSS_ITEM,
});

/**
 * Every column below is pulled through its own `unknown`-typed accessor,
 * the idiom `clients/config.ts` uses, rather than the row being asserted
 * wholesale as some `SomeRow` shape it was never checked against. `null` and
 * `undefined` both mean "the column held no value": SQLite returns the
 * former, and a column absent from the select would give the latter, so
 * folding them together is what keeps a mistyped column name from arriving
 * as the string `'undefined'`.
 */
function asText(value: unknown): string {
  return String(value);
}

function asNumber(value: unknown): number {
  return Number(value);
}

function asTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * `rss_item.download_type` is TEXT, so nothing in the schema stops a third
 * value reaching this point -- and one is genuinely reachable. `'usenet'`
 * was the old spelling of `'nzb'`; migration 5 renamed it on `rss_feed`
 * **and only there**, while `feeds/reader.ts` copies a feed's value onto
 * every item it writes. Any `rss_item` row written before migration 5 ran
 * therefore still holds `'usenet'` today, because no migration has ever
 * touched this column.
 *
 * Refused rather than folded to `'torrent'`, because a coerced value hands
 * a client a fact the row does not hold and the client has no way to find
 * out. The cost is real and worth naming: one such row fails the whole
 * `rssItemsSince` page it lands in, and paging past it is not possible, so
 * a database with one would need the row corrected. That is the trade
 * against silently telling every client a usenet release is a torrent.
 *
 * The message names the row's id and the offending value, and nothing else
 * off the row: a discriminant, never the row itself.
 */
function downloadTypeOf(id: number, value: unknown): Transport {
  const text = asText(value);
  if (text !== 'torrent' && text !== 'nzb') {
    throw new Error(`rss item ${id} has unknown download type ${JSON.stringify(text)}`);
  }
  return text;
}

/**
 * An item together with the `(updatedAt, id)` pair it is ordered by. The two
 * are carried separately because `RssItemRead` and `DownloadRead` do not
 * expose `updatedAt` -- the page still has to know it to build the cursor.
 */
interface Keyed<T> {
  readonly item: T;
  readonly key: Cursor;
}

function toMediaItemRead(row: unknown): Keyed<MediaItemRead> {
  const id = asNumber((row as { id: unknown }).id);
  const updatedAt = asNumber((row as { updated_at: unknown }).updated_at);
  return {
    item: {
      id,
      title: asText((row as { title: unknown }).title),
      releaseDate: asTextOrNull((row as { release_date: unknown }).release_date),
      description: asTextOrNull((row as { description: unknown }).description),
      provider: asTextOrNull((row as { provider: unknown }).provider),
      providerRef: asTextOrNull((row as { provider_ref: unknown }).provider_ref),
      createdAt: asNumber((row as { created_at: unknown }).created_at),
      updatedAt,
    },
    key: { updatedAt, id },
  };
}

function toRssItemRead(row: unknown): Keyed<RssItemRead> {
  const id = asNumber((row as { id: unknown }).id);
  const updatedAt = asNumber((row as { updated_at: unknown }).updated_at);
  return {
    item: {
      id,
      feedId: asNumber((row as { feed_id: unknown }).feed_id),
      filename: asText((row as { filename: unknown }).filename),
      link: asText((row as { link: unknown }).link),
      mediaItemId: asNumberOrNull((row as { media_item_id: unknown }).media_item_id),
      resolution: asText((row as { resolution: unknown }).resolution),
      resolutionDetail: asTextOrNull((row as { resolution_detail: unknown }).resolution_detail),
      downloadType: downloadTypeOf(id, (row as { download_type: unknown }).download_type),
      deliveredAt: asNumberOrNull((row as { delivered_at: unknown }).delivered_at),
    },
    key: { updatedAt, id },
  };
}

function toDownloadRead(row: unknown): Keyed<DownloadRead> {
  const id = asNumber((row as { id: unknown }).id);
  const updatedAt = asNumber((row as { updated_at: unknown }).updated_at);
  // Decided by comparison against one literal rather than by a membership
  // check, because the only two values that can arrive here are the two
  // literals this module's own SQL writes into the `transport` column. There
  // is no third case to refuse.
  const transport: Transport =
    asText((row as { transport: unknown }).transport) === 'nzb' ? 'nzb' : 'torrent';
  return {
    item: {
      id,
      rssItemId: asNumber((row as { rss_item_id: unknown }).rss_item_id),
      downloadClientId: asNumber((row as { download_client_id: unknown }).download_client_id),
      transport,
      status: asText((row as { status: unknown }).status),
      clientRef: asTextOrNull((row as { client_ref: unknown }).client_ref),
      infohash: asTextOrNull((row as { infohash: unknown }).infohash),
      percentage: asNumberOrNull((row as { percentage: unknown }).percentage),
      absentSince: asNumberOrNull((row as { absent_since: unknown }).absent_since),
      deliveredAt: asNumberOrNull((row as { delivered_at: unknown }).delivered_at),
      lastError: asTextOrNull((row as { last_error: unknown }).last_error),
    },
    key: { updatedAt, id },
  };
}

/** A tombstone's item is the id alone; its cursor walks `deleted_at`. */
function toDeletion(row: unknown): Keyed<number> {
  const id = asNumber((row as { media_item_id: unknown }).media_item_id);
  return {
    item: id,
    key: { updatedAt: asNumber((row as { deleted_at: unknown }).deleted_at), id },
  };
}

/** See `Page.cursor` for why an empty page echoes rather than nulling. */
function cursorFor<T>(keyed: readonly Keyed<T>[], after: Cursor | null): string | null {
  const last = keyed.at(-1);
  if (last !== undefined) {
    return encodeCursor(last.key);
  }
  return after === null ? null : encodeCursor(after);
}

function pageOf<T>(keyed: readonly Keyed<T>[], after: Cursor | null): Page<T> {
  return {
    items: keyed.map((entry) => entry.item),
    cursor: cursorFor(keyed, after),
    done: keyed.length < PAGE_SIZE,
  };
}

export function mediaItemsSince(
  raw: DatabaseSync,
  pluginId: string,
  after: Cursor | null,
): Page<MediaItemRead> {
  const from = after ?? BEGINNING;
  const rows = raw.prepare(MEDIA_ITEMS_SINCE)
    .all(pluginId, from.updatedAt, from.updatedAt, from.id, PAGE_SIZE);
  return pageOf(rows.map(toMediaItemRead), after);
}

/**
 * Not plugin-scoped, and that is deliberate: an rss item belongs to a feed,
 * and a feed's `plugin_id` says who polls it, not who may read what it
 * found. Every client syncs the same stream of feed items.
 *
 * Served by `rss_item_updated`, which has existed since migration 1 and
 * covers exactly `(updated_at, id)`. Migration 9 adds no second index on
 * those columns for this query, because that one already is one.
 */
export function rssItemsSince(raw: DatabaseSync, after: Cursor | null): Page<RssItemRead> {
  const from = after ?? BEGINNING;
  const rows = raw.prepare(RSS_ITEMS_SINCE).all(from.updatedAt, from.updatedAt, from.id, PAGE_SIZE);
  return pageOf(rows.map(toRssItemRead), after);
}

/**
 * One page across both download tables, ordered by `(updated_at, id)` over
 * the union.
 *
 * **A known limit, recorded rather than hidden.** `id` is a per-table rowid,
 * so a `torrent_download` row and an `nzb_download` row can share an
 * `(updated_at, id)` pair exactly. When a page boundary falls between two
 * such rows, the cursor that names the pair cannot say which of them was
 * already served, and the next page's `id > ?` drops the other. `Cursor`
 * carries two fields, so there is nowhere to put the transport that would
 * separate them; fixing it needs a third cursor field or a union-wide key,
 * neither of which this module can introduce on its own.
 */
export function downloadsSince(raw: DatabaseSync, after: Cursor | null): Page<DownloadRead> {
  const from = after ?? BEGINNING;
  const rows = raw.prepare(DOWNLOADS_SINCE).all(
    from.updatedAt, from.updatedAt, from.id,
    from.updatedAt, from.updatedAt, from.id,
    PAGE_SIZE,
  );
  return pageOf(rows.map(toDownloadRead), after);
}

/**
 * The ids of media items this plugin has had deleted, paged over
 * `deleted_at`. Only its own: by the time anyone reads a tombstone there is
 * nothing left on `media_item` to join to, which is why `plugin_id` is
 * copied onto the tombstone in the first place.
 */
export function deletionsSince(
  raw: DatabaseSync,
  pluginId: string,
  after: Cursor | null,
): Page<number> {
  const from = after ?? BEGINNING;
  const rows = raw.prepare(DELETIONS_SINCE)
    .all(pluginId, from.updatedAt, from.updatedAt, from.id, PAGE_SIZE);
  return pageOf(rows.map(toDeletion), after);
}

/**
 * `null` for an item that does not exist *and* for one belonging to another
 * plugin. The two are one answer on purpose: distinguishing them would
 * report the existence of the other plugin's rows, which is the first half
 * of reading them.
 */
export function mediaItemById(raw: DatabaseSync, pluginId: string, id: number): MediaItemRead | null {
  const row = raw.prepare(MEDIA_ITEM_BY_ID).get(pluginId, id);
  return row === undefined ? null : toMediaItemRead(row).item;
}

/** See `mediaItemById` for why a foreign item is `null` rather than a throw. */
export function mediaItemByReference(
  raw: DatabaseSync,
  pluginId: string,
  provider: string,
  ref: string,
): MediaItemRead | null {
  const row = raw.prepare(MEDIA_ITEM_BY_REFERENCE).get(pluginId, provider, ref);
  return row === undefined ? null : toMediaItemRead(row).item;
}

/** Every rss item pointing at this media item, in discovery order. */
export function rssItemsForMediaItem(raw: DatabaseSync, mediaItemId: number): RssItemRead[] {
  return raw.prepare(RSS_ITEMS_FOR_MEDIA_ITEM).all(mediaItemId)
    .map((row) => toRssItemRead(row).item);
}

/** Every download for this rss item, from both tables, oldest change first. */
export function downloadsForRssItem(raw: DatabaseSync, rssItemId: number): DownloadRead[] {
  return raw.prepare(DOWNLOADS_FOR_RSS_ITEM).all(rssItemId, rssItemId)
    .map((row) => toDownloadRead(row).item);
}
