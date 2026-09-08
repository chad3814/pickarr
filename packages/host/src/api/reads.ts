/**
 * Every read the API answers, as SQL against the shared tables. Imports
 * `./cursor.ts` and nothing else from the project -- in particular nothing
 * from `host.ts`, so no route added on top of this can pull `src/api` into a
 * cycle back through the registry.
 *
 * **The keyset predicate is what this module is for.** Each paged read walks
 * `(updated_at, id)` forward with SQLite's *row-value* comparison
 *
 *     WHERE (updated_at, id) > (?, ?)
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
 * **The row-value form, not the `OR` form it is equivalent to.** The obvious
 * spelling of the same predicate is
 *
 *     WHERE (updated_at > ?) OR (updated_at = ? AND id > ?)
 *
 * which returns exactly the same rows and which SQLite **cannot seek** on: it
 * plans as `SCAN rss_item USING INDEX rss_item_updated`, walking the index
 * from entry one and discarding everything behind the cursor. That *names the
 * index while reading all of it*, which is how it hid -- a plan assertion
 * looking only for the index's name passes against both forms. The row-value
 * form plans as `SEARCH rss_item USING INDEX rss_item_updated (updated_at>?)`,
 * a range seek straight to the page, which is why the plan test asserts
 * `SEARCH`.
 *
 * The mechanism, because it decides how *not* to fix it: the two `?` in the
 * `OR` form are distinct parameters, so nothing tells SQLite they hold the
 * same value, and it cannot derive the `updated_at >= ?` range constraint the
 * disjunction implies. Spelling them as one numbered parameter
 * (`updated_at > ?1 OR (updated_at = ?1 AND id > ?2)`) *does* seek, measured
 * on this tree -- so the `OR` form is not inherently unseekable, only
 * unseekable as written. The row-value form is preferred over that repair
 * because it says the same thing in one comparison rather than relying on the
 * planner noticing a repeated parameter.
 *
 * Measured at 200,000 rows in each table, per page at cursor depths
 * 1,000 / 100,000 / 199,000 -- the `OR` form's cost grows with how far a
 * client has paged and the row-value form's does not:
 *
 *     rssItemsSince    OR 0.21 / 4.00 / 7.82    row-value 0.21 / 0.17 / 0.20
 *     mediaItemsSince  OR 0.20 / 4.99 / 9.84    row-value 0.17 / 0.18 / 0.14
 *     deletionsSince   OR 0.10 / 4.05 / 7.72    row-value 0.06 / 0.06 / 0.06
 *
 * `node:sqlite` is synchronous, so that growth is blocked event loop.
 *
 * `mediaItemsSince` is worth singling out, because it is why the plan test
 * names the seek's *columns* rather than just looking for `SEARCH`: with the
 * `OR` form its plan is `SEARCH media_item USING INDEX media_item_sync
 * (plugin_id=?)`. That genuinely is a seek -- of the plugin -- followed by a
 * walk of every row that plugin owns. Only `(plugin_id=? AND updated_at>?)`
 * says the cursor is in the seek too.
 *
 * That holds for every read here that reads one table. `downloadsSince` pages
 * a **union** of two tables whose ids are separate rowid spaces, so
 * `(updated_at, id)` is not a key there at all; it walks
 * `(updated_at, transport, id)` with a `UnionCursor` instead. See
 * `DOWNLOADS_SINCE` for why that triple is a total order and the pair is not.
 *
 * Synchronous, because `node:sqlite` is. Wrapping these in `async` would
 * promise a yield that never happens and buy nothing.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Cursor, UnionCursor } from './cursor.ts';
import { PAGE_SIZE, encodeCursor, encodeUnionCursor } from './cursor.ts';

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
 * `cursor` is the last item's own key, encoded -- `(updatedAt, id)` for a
 * single-table read, `(updatedAt, transport, id)` for the download union. On
 * an **empty** page it is the caller's own cursor handed straight back -- not
 * `null`.
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
 * Exact rather than approximate, and that matters: `(updated_at, id) > (0, 0)`
 * admits every row, because these tables key on `INTEGER PRIMARY KEY` and
 * SQLite never hands out a rowid below 1. So a row stamped `updated_at = 0`
 * still compares greater on its `id`, and every later row compares greater on
 * its time. The one shape it would miss is a negative `updated_at`, which
 * nothing can write: every value in these columns comes from a `now()`
 * reading in milliseconds.
 */
const BEGINNING: Cursor = { updatedAt: 0, id: 0 };

/**
 * The same, for the download union, and exact for the same reasons plus one
 * more: `'nzb'` is the *lower* of the two transports under SQLite's default
 * BINARY collation (`'nzb' < 'torrent'`), so `(0, 'nzb', 0)` sits below every
 * row either table can hold. Naming `'torrent'` here instead would hide every
 * `nzb_download` row stamped `updated_at = 0` from a caller who sent no
 * cursor.
 */
const UNION_BEGINNING: UnionCursor = { updatedAt: 0, transport: 'nzb', id: 0 };

/**
 * The keyset predicate, for a table's own `(time, id)` column pair. Written
 * once so that the three places it appears in the SQL below are all the same
 * predicate rather than three chances to get it wrong -- and so a change that
 * breaks it breaks every read at once instead of leaving two correct and one
 * silently wrong. The download union has its own, `unionKeyset`, because its
 * key has three components rather than two.
 *
 * A row-value comparison, for the reason the module doc gives: it is the only
 * spelling of this predicate SQLite can turn into an index seek. Strictly
 * `>`, never `>=` -- the cursor row itself has already been served.
 *
 * Both arguments are module-private literals from the constants below, never
 * anything a caller supplies, so nothing a caller holds reaches this text.
 * The two placeholders bind, in order: the cursor's time and the cursor's id.
 */
function keyset(timeColumn: string, idColumn: string): string {
  return `(${timeColumn}, ${idColumn}) > (?, ?)`;
}

const UPDATED_KEYSET = keyset('updated_at', 'id');

/**
 * The same predicate for one branch of the download union, over
 * `(updated_at, transport, id)`.
 *
 * The branch's own transport is interpolated as a literal rather than bound,
 * because it *is* a literal: each branch of the union selects
 * `'torrent' AS transport` or `'nzb' AS transport`, and the alias is not
 * visible to that branch's own `WHERE`. The value comes from `Transport`, a
 * module-private union of two words, never from anything a caller supplies.
 *
 * The same row-value form as `keyset`, one component wider. The three
 * placeholders bind, in order: the cursor's time, its transport and its id.
 * Reading it aloud: a row is ahead of the cursor when its time is later, or
 * when the time matches and the cursor's transport sorts before this
 * branch's, or when both match and the id is greater.
 *
 * Neither download table carries an index on `(updated_at, id)`, so this
 * branch scans whichever way it is written -- the row-value form is used here
 * for one predicate across the module rather than for a seek it cannot yet
 * get. An index that would make it seekable is a migration, and not this
 * change's.
 */
function unionKeyset(transport: Transport): string {
  return `(updated_at, '${transport}', id) > (?, ?, ?)`;
}

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

/**
 * Keyed on `media_item.provider`/`provider_ref` -- the pair
 * `media_item_provider_ref` dedups on, and the pair `MediaWriter` writes.
 *
 * **The `external_reference` table is deliberately not consulted.** It exists
 * (migration 1, declared in `schema.ts`, unique on
 * `(media_item_id, provider)`) and **has no writer at all**: nothing in this
 * tree inserts a row into it, and slice A's spec records it as unreachable
 * through the contract. Joining it here would read a table that is always
 * empty -- dead code that looks like coverage, and a second answer to one
 * question the moment something does start writing it. When it acquires a
 * writer, that is the change that should decide what a second lookup means.
 */
const MEDIA_ITEM_BY_PROVIDER_REF = `
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
 * Served by `rss_item_media_item`, migration 10's index on exactly
 * `media_item_id`. Before it existed this query was a bare `SCAN rss_item`,
 * reading the whole table for one item's handful of rows -- and
 * `MediaReader.rssItemsFor` calls it once per media item, so a plugin walking
 * its library scanned `rss_item` once per item in it.
 *
 * `ORDER BY id` needs no sort on top of that index: an index entry carries the
 * rowid as its tail, so the matches for one `media_item_id` come back in
 * rowid order already. The index test asserts both -- `SEARCH`, and no temp
 * B-tree.
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
 * **`transport` is the second `ORDER BY` term, not the last, and that is the
 * whole point.** `(updated_at, id)` is not a key across this union: `id` is a
 * per-table rowid, so a `torrent_download` row and an `nzb_download` row can
 * carry the same pair exactly. Ordering `(updated_at, id, transport)` and
 * paging on `(updated_at, id)` therefore *skips* a row whenever a page
 * boundary falls between two such rows -- the cursor names the pair, and the
 * next page's `id > ?` drops the one that was not served. Measured: 400 rows
 * across the two tables, 399 ever served, `torrent#101` never.
 *
 * `(updated_at, transport, id)` is a genuine total order, because `transport`
 * is constant within each branch and the two values are disjoint, so no two
 * rows in the union can share the triple. `UnionCursor` carries all three.
 */
const DOWNLOADS_SINCE = `
  SELECT ${DOWNLOAD_COLUMNS} FROM (
${TORRENT_DOWNLOAD_SELECT}
     WHERE ${unionKeyset('torrent')}
    UNION ALL
${NZB_DOWNLOAD_SELECT}
     WHERE ${unionKeyset('nzb')}
  )
  ORDER BY updated_at, transport, id
  LIMIT ?
`;

/**
 * Same order as `DOWNLOADS_SINCE`, so the two reads agree about what "oldest
 * change first" means for one rss item's downloads. Not paged, so no cursor
 * and no keyset -- an rss item's downloads are one per client at most.
 */
const DOWNLOADS_FOR_RSS_ITEM = `
  SELECT ${DOWNLOAD_COLUMNS} FROM (
${TORRENT_DOWNLOAD_SELECT}
     WHERE rss_item_id = ?
    UNION ALL
${NZB_DOWNLOAD_SELECT}
     WHERE rss_item_id = ?
  )
  ORDER BY updated_at, transport, id
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
  mediaItemByProviderRef: MEDIA_ITEM_BY_PROVIDER_REF,
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
 * `rss_item.download_type` is TEXT with no CHECK, so nothing in the *schema*
 * stops a third value reaching this point. This function is therefore what
 * makes `RssItemRead.downloadType`'s `'torrent' | 'nzb'` true rather than
 * hopeful -- the guarantee is enforced here, at the read boundary, not by the
 * column.
 *
 * The value history actually produced was `'usenet'`, the old spelling of
 * `'nzb'`. Migration 5 renamed it on `rss_feed` **and only there**, while
 * `feeds/reader.ts` copies a feed's value onto every item it writes, so every
 * rss item written before migration 5 ran still held it. **Migration 10
 * renames it on `rss_item` too**, which closes that source -- so on a
 * migrated database no row reaches here with a value outside the union.
 *
 * That is not the same as the column being safe. It is still unconstrained,
 * and `PluginContext.db` hands a plugin the raw connection, so a row written
 * *after* migration 10 can carry any string at all. The check stays for that
 * reason, and it is load-bearing rather than defensive padding.
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
 * An item together with the key it is ordered by. The two are carried
 * separately because `RssItemRead` and `DownloadRead` do not expose
 * `updatedAt` -- the page still has to know it to build the cursor.
 *
 * `K` is `Cursor` for a single-table read and `UnionCursor` for the download
 * union, so a reader that produces one kind of key cannot be paged with the
 * other kind of cursor by mistake.
 */
interface Keyed<T, K> {
  readonly item: T;
  readonly key: K;
}

function toMediaItemRead(row: unknown): Keyed<MediaItemRead, Cursor> {
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

function toRssItemRead(row: unknown): Keyed<RssItemRead, Cursor> {
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

function toDownloadRead(row: unknown): Keyed<DownloadRead, UnionCursor> {
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
    // The transport is part of the key, not only of the item: it is what
    // separates two rows that share an `(updatedAt, id)` pair.
    key: { updatedAt, transport, id },
  };
}

/** A tombstone's item is the id alone; its cursor walks `deleted_at`. */
function toDeletion(row: unknown): Keyed<number, Cursor> {
  const id = asNumber((row as { media_item_id: unknown }).media_item_id);
  return {
    item: id,
    key: { updatedAt: asNumber((row as { deleted_at: unknown }).deleted_at), id },
  };
}

/**
 * See `Page.cursor` for why an empty page echoes rather than nulling.
 *
 * `encode` is passed in rather than chosen here, because the key type decides
 * it: a `Cursor` encodes as two parts and a `UnionCursor` as three, and the
 * two forms are deliberately not interchangeable.
 */
function cursorFor<T, K>(
  keyed: readonly Keyed<T, K>[],
  after: K | null,
  encode: (key: K) => string,
): string | null {
  const last = keyed.at(-1);
  if (last !== undefined) {
    return encode(last.key);
  }
  return after === null ? null : encode(after);
}

function pageOf<T, K>(
  keyed: readonly Keyed<T, K>[],
  after: K | null,
  encode: (key: K) => string,
): Page<T> {
  return {
    items: keyed.map((entry) => entry.item),
    cursor: cursorFor(keyed, after, encode),
    done: keyed.length < PAGE_SIZE,
  };
}

export function mediaItemsSince(
  raw: DatabaseSync,
  pluginId: string,
  after: Cursor | null,
): Page<MediaItemRead> {
  const from = after ?? BEGINNING;
  const rows = raw.prepare(MEDIA_ITEMS_SINCE).all(pluginId, from.updatedAt, from.id, PAGE_SIZE);
  return pageOf(rows.map(toMediaItemRead), after, encodeCursor);
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
  const rows = raw.prepare(RSS_ITEMS_SINCE).all(from.updatedAt, from.id, PAGE_SIZE);
  return pageOf(rows.map(toRssItemRead), after, encodeCursor);
}

/**
 * One page across both download tables, ordered by
 * `(updated_at, transport, id)` over the union.
 *
 * A `UnionCursor`, not a `Cursor`, and the extra field is load-bearing rather
 * than decorative: `id` is a per-table rowid, so a `torrent_download` row and
 * an `nzb_download` row can share an `(updated_at, id)` pair exactly, and a
 * two-field cursor naming that pair cannot say which of them was already
 * served. See `DOWNLOADS_SINCE` for the order this walks and the row that was
 * measured going missing without it.
 *
 * Each branch takes the cursor's three fields, in the order `unionKeyset`
 * documents; the last binding is the page limit.
 */
export function downloadsSince(raw: DatabaseSync, after: UnionCursor | null): Page<DownloadRead> {
  const from = after ?? UNION_BEGINNING;
  const rows = raw.prepare(DOWNLOADS_SINCE).all(
    from.updatedAt, from.transport, from.id,
    from.updatedAt, from.transport, from.id,
    PAGE_SIZE,
  );
  return pageOf(rows.map(toDownloadRead), after, encodeUnionCursor);
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
  const rows = raw.prepare(DELETIONS_SINCE).all(pluginId, from.updatedAt, from.id, PAGE_SIZE);
  return pageOf(rows.map(toDeletion), after, encodeCursor);
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

/**
 * The media item this plugin holds under `(provider, providerRef)`.
 *
 * Named for the columns it reads, not for the `external_reference` table it
 * does not -- see `MEDIA_ITEM_BY_PROVIDER_REF` for why that table is left
 * alone. The spec's `MediaReader` first called this
 * `mediaItemByExternalReference`, which pointed at the wrong table; the name
 * now says which fact is being looked up.
 *
 * See `mediaItemById` for why a foreign item is `null` rather than a throw.
 */
export function mediaItemByProviderRef(
  raw: DatabaseSync,
  pluginId: string,
  provider: string,
  ref: string,
): MediaItemRead | null {
  const row = raw.prepare(MEDIA_ITEM_BY_PROVIDER_REF).get(pluginId, provider, ref);
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
