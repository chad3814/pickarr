import type { DatabaseSync } from 'node:sqlite';
import type { SyncOp } from './tail.ts';
import type { SyncRegistry } from './registry.ts';
import { HOST_SYNCED_TABLES } from './tables.ts';

/** A backfill page's resume point: the last item it sent, both columns immutable (design spec §3.4). */
export interface BackfillCursor {
  readonly createdAt: number;
  readonly id: number;
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
 * this page, and would reach the client only on a later coincidence.
 *
 * **Each page is self-consistent.** Ops are emitted in dependency order --
 * the group's own row, then its releases, then what was submitted for them,
 * then who is in it (people before roles, since a role points at a person),
 * then each plugin table's rows for these items, in the order the plugin
 * declared them. A client replaying a page in order therefore never sees an
 * op reference a row it has not already received, in this page or an
 * earlier one. A shared parent -- one `tv_series` across many episodes --
 * is re-sent once per group that points at it; harmless, because an op is
 * an invalidation carrying current state and a repeat create is a no-op
 * (§3.1, §3.3).
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
  const watermarkRow = raw.prepare('SELECT coalesce(max(id), 0) AS watermark FROM sync_log').get() as
    { watermark: unknown } | undefined;
  const watermark = Number(watermarkRow?.watermark ?? 0);

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

  // The group's own row, first: nothing below may reference an item the
  // client has not already received, in this page or an earlier one.
  pushRows(ops, 'media_item', registry.readRows(raw, 'media_item', itemIds), itemIds);

  // Its releases.
  const releaseIds = idsOf(
    raw.prepare(`SELECT id FROM rss_item WHERE media_item_id IN (${itemHoles})`).all(...itemIds),
  );
  pushRows(ops, 'rss_item', registry.readRows(raw, 'rss_item', releaseIds), releaseIds);

  // What was submitted for them.
  if (releaseIds.length > 0) {
    const releaseHoles = releaseIds.map(() => '?').join(', ');
    const torrentIds = idsOf(
      raw.prepare(`SELECT id FROM torrent_download WHERE rss_item_id IN (${releaseHoles})`).all(...releaseIds),
    );
    pushRows(ops, 'torrent_download', registry.readRows(raw, 'torrent_download', torrentIds), torrentIds);

    const nzbIds = idsOf(
      raw.prepare(`SELECT id FROM nzb_download WHERE rss_item_id IN (${releaseHoles})`).all(...releaseIds),
    );
    pushRows(ops, 'nzb_download', registry.readRows(raw, 'nzb_download', nzbIds), nzbIds);
  }

  // Who is in them: people before roles, since a role points at a person.
  const personIds = [...new Set(idsOf(
    raw.prepare(`SELECT person_id AS id FROM role WHERE media_item_id IN (${itemHoles})`).all(...itemIds),
  ))];
  pushRows(ops, 'person', registry.readRows(raw, 'person', personIds), personIds);

  const roleIds = idsOf(
    raw.prepare(`SELECT id FROM role WHERE media_item_id IN (${itemHoles})`).all(...itemIds),
  );
  pushRows(ops, 'role', registry.readRows(raw, 'role', roleIds), roleIds);

  // Each plugin table's rows for these items, in the order the plugin
  // declared them -- which is how a detail row ends up before the shared
  // parent it points at (§5.2, §3.3). `registry` has no schema knowledge of
  // its own for a plugin table, so this goes through `rowsFor`, not SQL.
  for (const table of registry.tables()) {
    if (HOST_SYNCED_TABLES.includes(table)) continue;
    const ids = registry.rowsFor(raw, table, itemIds);
    if (ids.length === 0) continue;
    pushRows(ops, table, registry.readRows(raw, table, ids), ids);
  }

  const lastItem = items[items.length - 1];
  const cursor = items.length < limit || lastItem === undefined
    ? null
    : { createdAt: lastItem.createdAt, id: lastItem.id };

  return { ops, cursor, watermark };
}

/** The `id` column of a row set, as plain numbers. */
function idsOf(rows: readonly unknown[]): readonly number[] {
  return rows.map((row) => Number((row as { id: unknown }).id));
}

/** Appends one upsert per id that actually resolved to current state, in `ids`' order. */
function pushRows(ops: SyncOp[], table: string, rows: Record<number, unknown>, ids: readonly number[]): void {
  for (const id of ids) {
    const value = rows[id];
    if (value !== undefined) ops.push({ op: 'upsert', table, value });
  }
}
