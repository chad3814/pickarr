import type { DatabaseSync } from 'node:sqlite';
import type { SyncOp } from './tail.ts';
import type { SyncRegistry } from './registry.ts';
import { HOST_SYNCED_TABLES } from './tables.ts';

/**
 * A backfill page's resume point, plus the watermark the whole walk is
 * measured against.
 *
 * `createdAt`/`id` are the last media item the walk sent, both columns
 * immutable (design spec §3.4).
 *
 * `watermark` is the log's high-water mark captured by the walk's *first*
 * page -- the same value the client adopted as its tail cursor -- carried
 * through every page rather than re-read per page. Two things depend on
 * that. It is the threshold this walk skips rows against (see
 * `backfillBefore`), and skipping against a *later* watermark would leave
 * the rows logged between the two thresholds out of both streams. And it
 * makes the `watermark` every page returns a constant rather than a rising
 * number, so a client that adopts page *n*'s watermark as its tail cursor
 * adopts page 1's and skips nothing.
 */
export interface BackfillCursor {
  readonly createdAt: number;
  readonly id: number;
  readonly watermark: number;
}

/**
 * One page of current state, newest media item first, hydrated by group
 * (design spec §5.2).
 *
 * **Ordering.** `(created_at DESC, id DESC)`, both immutable -- `updated_at`
 * would let a row touched mid-walk move in the ordering and be skipped
 * entirely (§3.4). Paging is a row-value keyset, `WHERE (created_at, id) <
 * (?, ?)`, never the equivalent `created_at < ? OR (created_at = ? AND id <
 * ?)`: slice E measured that two distinct placeholders let SQLite seek the
 * `(created_at, id)` index, where the `OR` form scans it (project global
 * constraints).
 *
 * **On the first page the watermark is read before the page's rows**, so
 * that a row changed while this page is being built lands *above* it and
 * reaches the client through the tail (`tailSince`) rather than through
 * this walk -- §5.3's account of why running the two concurrently loses
 * nothing. Reading it after would risk the opposite: a row that changed
 * between the two reads would be neither above the watermark nor caught by
 * this page, and would reach the client only on a later coincidence. Only
 * the first page reads a mark at all; every page after it carries the same
 * one forward in `before.watermark`, for the reason `BackfillCursor` gives.
 *
 * **The two streams are disjoint: every op below is skipped if that row has
 * a `sync_log` entry above `watermark`.** The tail is then the authority on
 * that row and will deliver it, so this walk says nothing about it, and a
 * client never holds two sources for one row at one time. A row with *no*
 * log entry at all -- one that predates migration 15 -- is never skipped,
 * because no tail will ever deliver it.
 *
 * **Every op this walk emits is a `create`, and that -- not disjointness --
 * is what makes a page safe to apply however late it lands.** A page's
 * values are read at one instant and applied at another, and a write in
 * between makes the page stale with nothing in the payload to say so. The
 * skip above cannot close that case, measured: with the page for media item
 * 3 already built, an `UPDATE` on it takes log entry 7, above a watermark of
 * 6, and the page in hand still carries the old title -- a read-time skip
 * cannot see a write that has not happened yet. Nor can any stateless
 * server, whose response was serialised before the write existed.
 *
 * So the op kind carries the rule. A client applying a `create` for a row it
 * already holds does nothing, and a `delete` tombstones the row rather than
 * removing it, so "already holds" covers a row the tail deleted too: a stale
 * page can neither overwrite the newer value the tail delivered nor
 * resurrect what the tail removed. Both obligations, and what breaks if a
 * client skips either, are in `sync/tail.ts`'s `SyncOp`. An earlier draft
 * dated every page with an `asOf` the client compared against its own tail
 * cursor; the op kind does that work structurally, so the stamp is gone
 * rather than kept beside it.
 *
 * **Each page is self-consistent *within the synced set*, with one named
 * exception.** Ops are emitted so that no row precedes a *synced* row it
 * names: the group's own row, then its releases, then what was submitted for
 * them, then who is in it (people before roles, since a role points at a
 * person), then each plugin table's rows for these items, in the order the
 * plugin declared them -- an order each plugin chooses so that a shared
 * parent precedes the rows naming it (`plugin-tv/src/sync.ts`).
 *
 * **"Within the synced set" is the honest scope, not a hedge.** Two columns
 * these projections do send name rows that will never be synced:
 * `rss_item.feed_id` names an `rss_feed`, and `torrent_download`'s and
 * `nzb_download`'s `download_client_id` name a `download_client` -- which
 * holds a service's address and so may not reach a replica at all
 * (`sync/tables.ts`). A page therefore does contain references a client
 * cannot resolve, by design and permanently. Earlier wordings of this
 * paragraph claimed no op references a row the client has not received;
 * that was false of these two columns from the first commit.
 *
 * The one exception *inside* the synced set is a row skipped above because
 * the tail owns it -- an `rss_item` whose `media_item` changed after the
 * walk began. That reference is forward, not dangling: the row is above the
 * watermark, so the client's tail, which starts at that same watermark,
 * delivers it at its log position. That exception is the price of
 * disjointness, and is named here rather than left for slice 2 to discover.
 *
 * **Skipping is per row, not per group, and the alternative is unsound
 * rather than merely worse.** Dropping a whole group whose `media_item` sits
 * above the watermark would lose that group's *unchanged* rows for good: the
 * keyset cursor advances past the group either way and never returns to it,
 * while the tail carries only the rows that actually changed, so a release
 * logged below the watermark would be reachable from neither stream.
 * Truncating the page before the group instead of dropping it does not help
 * -- the entry never falls back below the watermark, so the walk would stall
 * on that group forever. Per row costs a forward reference the tail closes;
 * per group costs rows nothing closes.
 *
 * A null cursor means current state is exhausted and the caller retires
 * this walk; from then on only the tail runs (§5.2).
 */
export function backfillBefore(
  raw: DatabaseSync,
  registry: SyncRegistry,
  before: BackfillCursor | null,
  limit: number,
): { ops: readonly SyncOp[]; cursor: BackfillCursor | null; watermark: number } {
  // Read only on the first page, and before that page's rows; every page
  // after it carries the same mark forward in its cursor rather than
  // re-reading one. See this function's doc for both halves of why.
  const watermark = before === null ? readWatermark(raw) : before.watermark;

  const itemRows = before === null
    ? raw.prepare(
        'SELECT id, created_at AS createdAt FROM media_item ORDER BY created_at DESC, id DESC LIMIT ?',
      ).all(limit)
    : raw.prepare(
        'SELECT id, created_at AS createdAt FROM media_item WHERE (created_at, id) < (?, ?) ' +
        'ORDER BY created_at DESC, id DESC LIMIT ?',
      ).all(before.createdAt, before.id, limit);

  const items = itemRows.map((row) => ({
    id: Number((row as { id: unknown }).id),
    createdAt: Number((row as { createdAt: unknown }).createdAt),
  }));

  if (items.length === 0) return { ops: [], cursor: null, watermark };

  const itemIds = items.map((item) => item.id);
  const itemHoles = itemIds.map(() => '?').join(', ');
  const ops: SyncOp[] = [];

  // The group's own row, first: nothing below may name an item the client
  // has not already received, in this page or an earlier one -- or, where
  // this row is skipped because the tail owns it, will receive from the
  // tail. See `backfillBefore`'s doc on that one exception.
  pushRows(raw, ops, 'media_item', registry.readRows(raw, 'media_item', itemIds), itemIds, watermark);

  // Its releases.
  const releaseIds = idsOf(
    raw.prepare(`SELECT id FROM rss_item WHERE media_item_id IN (${itemHoles})`).all(...itemIds),
  );
  pushRows(raw, ops, 'rss_item', registry.readRows(raw, 'rss_item', releaseIds), releaseIds, watermark);

  // What was submitted for them.
  if (releaseIds.length > 0) {
    const releaseHoles = releaseIds.map(() => '?').join(', ');
    const torrentIds = idsOf(
      raw.prepare(`SELECT id FROM torrent_download WHERE rss_item_id IN (${releaseHoles})`).all(...releaseIds),
    );
    pushRows(raw, ops, 'torrent_download',
      registry.readRows(raw, 'torrent_download', torrentIds), torrentIds, watermark);

    const nzbIds = idsOf(
      raw.prepare(`SELECT id FROM nzb_download WHERE rss_item_id IN (${releaseHoles})`).all(...releaseIds),
    );
    pushRows(raw, ops, 'nzb_download', registry.readRows(raw, 'nzb_download', nzbIds), nzbIds, watermark);
  }

  // Who is in them: people before roles, since a role points at a person.
  const personIds = [...new Set(idsOf(
    raw.prepare(`SELECT person_id AS id FROM role WHERE media_item_id IN (${itemHoles})`).all(...itemIds),
  ))];
  pushRows(raw, ops, 'person', registry.readRows(raw, 'person', personIds), personIds, watermark);

  const roleIds = idsOf(
    raw.prepare(`SELECT id FROM role WHERE media_item_id IN (${itemHoles})`).all(...itemIds),
  );
  pushRows(raw, ops, 'role', registry.readRows(raw, 'role', roleIds), roleIds, watermark);

  // Each plugin table's rows for these items, in the order the plugin
  // declared them -- which each plugin chooses so that a row naming another
  // of its synced rows comes after it: `tv_series` before the `tv_season`
  // rows that carry a `seriesId` (§5.2, §3.3). `registry` has no schema
  // knowledge of its own for a plugin table, so this goes through `rowsFor`,
  // not SQL.
  for (const table of registry.tables()) {
    if (HOST_SYNCED_TABLES.includes(table)) continue;
    const ids = registry.rowsFor(raw, table, itemIds);
    if (ids.length === 0) continue;
    pushRows(raw, ops, table, registry.readRows(raw, table, ids), ids, watermark);
  }

  const lastItem = items[items.length - 1];
  const cursor = items.length < limit || lastItem === undefined
    ? null
    : { createdAt: lastItem.createdAt, id: lastItem.id, watermark };

  return { ops, cursor, watermark };
}

/** The log's high-water mark, or 0 for an empty log. */
function readWatermark(raw: DatabaseSync): number {
  const row = raw.prepare('SELECT coalesce(max(id), 0) AS watermark FROM sync_log').get() as
    { watermark: unknown } | undefined;
  return Number(row?.watermark ?? 0);
}

/** The `id` column of a row set, as plain numbers. */
function idsOf(rows: readonly unknown[]): readonly number[] {
  return rows.map((row) => Number((row as { id: unknown }).id));
}

/**
 * Which of `ids` in `table` the tail owns: those with a `sync_log` entry
 * above `watermark`.
 *
 * One indexed lookup per table per page -- `sync_log_row` is unique on
 * `(table_name, row_id)` (migration 15). `table` reaches the SQL as a bound
 * parameter, never as text; only the placeholder run is interpolated, and
 * every caller below passes a name from `HOST_SYNCED_TABLES` or from
 * `registry.tables()`.
 */
function tailOwns(
  raw: DatabaseSync,
  table: string,
  ids: readonly number[],
  watermark: number,
): ReadonlySet<number> {
  if (ids.length === 0) return new Set();
  const rows = raw.prepare(
    `SELECT row_id FROM sync_log WHERE table_name = ? AND id > ? AND row_id IN (${ids.map(() => '?').join(', ')})`,
  ).all(table, watermark, ...ids);
  return new Set(rows.map((row) => Number((row as { row_id: unknown }).row_id)));
}

/**
 * Appends one `create` per id that resolved to current state *and* that the
 * tail does not own, in `ids`' order, each keyed by its row id.
 *
 * `create`, never `upsert`: a client applies one of these only if it does
 * not already hold the row, which is what stops a page that was read before
 * a write and applied after it from undoing the write. `SyncOp` in
 * `sync/tail.ts` has the two client obligations that rest on this and what
 * breaks without them.
 *
 * The key goes on the op, not inside `value` -- see `SyncOp` again for why
 * that is the protocol's business and not each read shape's.
 */
function pushRows(
  raw: DatabaseSync,
  ops: SyncOp[],
  table: string,
  rows: Record<number, unknown>,
  ids: readonly number[],
  watermark: number,
): void {
  const owned = tailOwns(raw, table, ids, watermark);
  for (const id of ids) {
    const value = rows[id];
    if (value !== undefined && !owned.has(id)) ops.push({ op: 'create', table, id, value });
  }
}
