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
 * the rows logged between the two thresholds in both streams, which is the
 * overwrite this design exists to make impossible. And it makes the
 * `watermark` every page returns a constant rather than a rising number, so
 * a client that adopts page *n*'s watermark as its tail cursor adopts page
 * 1's and skips nothing.
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
 * **The watermark is read first**, before the page's rows are selected, so
 * that a row changed while this page is being built lands *above* it and
 * reaches the client through the tail (`tailSince`) rather than through
 * this walk -- §5.3's table of why running the two concurrently loses
 * nothing. Reading it after would risk the opposite: a row that changed
 * between the two reads would be neither above the watermark nor caught by
 * this page, and would reach the client only on a later coincidence. Every
 * page reads a mark that way, as its own `asOf`; only the *first* page's
 * becomes the walk's `watermark`, which every page after it carries forward
 * in `before.watermark` for the reason `BackfillCursor` gives.
 *
 * **The two streams are disjoint: every op below is skipped if that row has
 * a `sync_log` entry above `watermark`.** The tail is then the authority on
 * that row and will deliver it, so this walk says nothing about it, and a
 * client never holds two sources for one row at one time. A row with *no*
 * log entry at all -- one that predates migration 15 -- is never skipped,
 * because no tail will ever deliver it.
 *
 * **Disjointness alone does not make the two safe to apply in any order,
 * and `asOf` is why this function returns a second number.** §5.3's table
 * reasoned about what is *sent* and never about what order it is *applied*
 * in, and missed this: a page's values are read at one instant and applied
 * at another, and a write in between makes the page stale with nothing in
 * the payload to say so -- a client that applies it ends up holding the
 * older copy, with that row's log entry already consumed, so nothing ever
 * re-sends it. Permanent, silent, one row. The skip above cannot close that
 * case, measured: with the page for media item 3 already built, an `UPDATE`
 * on it takes log entry 7, above a watermark of 6, and the page in hand
 * still carries the old title. Nor does an insert-if-absent apply rule
 * close it, also measured: make the write a `DELETE` and the tail removes
 * the row, then the stale page finds it absent and puts it back.
 *
 * So the page is dated instead. `asOf` is the log's high-water mark read
 * *before* this page's rows, so every value below is current as of at least
 * `asOf`, and **a client may apply this page only while its own tail cursor
 * has not passed `asOf`.** Past it the page is stale and must be discarded
 * and refetched with the same `before`, which costs nothing: `before` is a
 * keyset the client still holds and the walk has not advanced. That is one
 * integer compared against a number the client already has -- no per-row
 * version, no `updated_at` (which `role` has not got, and which no plugin
 * read shape need carry), no tombstone. A stateless server cannot do
 * better than date its own answer, because the write that invalidates a
 * page can land after the response was serialised.
 *
 * **Each page is self-consistent, with one named exception.** Ops are
 * emitted in dependency order -- the group's own row, then its releases,
 * then what was submitted for them, then who is in it (people before roles,
 * since a role points at a person), then each plugin table's rows for these
 * items, in the order the plugin declared them. A client replaying a page
 * in order therefore never sees an op reference a row it has not already
 * received, in this page or an earlier one, *except* where the referenced
 * row was skipped above because the tail owns it -- an `rss_item` whose
 * `media_item` changed after the walk began. That reference is forward, not
 * dangling: the row is above the watermark, so the client's tail, which
 * starts at that same watermark, delivers it at its log position. It is
 * never a reference to a row the client will never receive. That exception
 * is the price of disjointness, and is named here rather than left for
 * slice 2 to discover.
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
): { ops: readonly SyncOp[]; cursor: BackfillCursor | null; watermark: number; asOf: number } {
  // One read, two jobs on the first page: `asOf` dates *this* page, and on
  // the first page it is also the walk's `watermark`, which every page after
  // it carries forward in its cursor rather than re-reading.
  const asOf = readWatermark(raw);
  const watermark = before === null ? asOf : before.watermark;

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

  if (items.length === 0) return { ops: [], cursor: null, watermark, asOf };

  const itemIds = items.map((item) => item.id);
  const itemHoles = itemIds.map(() => '?').join(', ');
  const ops: SyncOp[] = [];

  // The group's own row, first: nothing below may reference an item the
  // client has not already received, in this page or an earlier one -- or,
  // where this row is skipped because the tail owns it, will receive from
  // the tail. See this function's doc on that one exception.
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
  // declared them -- which is how a detail row ends up before the shared
  // parent it points at (§5.2, §3.3). `registry` has no schema knowledge of
  // its own for a plugin table, so this goes through `rowsFor`, not SQL.
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

  return { ops, cursor, watermark, asOf };
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
 * Appends one upsert per id that resolved to current state *and* that the
 * tail does not own, in `ids`' order, each keyed by its row id.
 *
 * The key goes on the op, not inside `value` -- see `SyncOp` in
 * `sync/tail.ts` for why that is the protocol's business and not each read
 * shape's.
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
    if (value !== undefined && !owned.has(id)) ops.push({ op: 'upsert', table, id, value });
  }
}
