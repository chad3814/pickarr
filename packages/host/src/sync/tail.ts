import type { DatabaseSync } from 'node:sqlite';
import type { SyncRegistry } from './registry.ts';

/**
 * One invalidation, as a client receives it.
 *
 * **`id` is on every op, upsert and delete alike, and never only inside
 * `value`.** It is the row's primary key in `table`, which is what a client
 * stores the row under -- so an upsert and the delete that later names the
 * same row agree on one key, and a shared parent re-sent once per group
 * (`sync/backfill.ts`) deduplicates instead of accumulating a copy per
 * group. Putting the key on the op rather than inside the payload is what
 * makes that independent of each read shape: `readHostRows`
 * (`sync/tables.ts`) happens to project `id` into `value` for all six host
 * tables, and no plugin read shape carries it at all
 * (`packages/contract/src/sync.ts`), so a protocol that read the key out of
 * `value` worked for the host and silently failed for every plugin table --
 * an upsert a client could not key, group or later delete. The `id` inside a
 * host `value` is redundant and left alone; this one is the key.
 */
export interface SyncOp {
  op: 'upsert' | 'delete';
  table: string;
  /** The row's primary key in `table`. Present on every op; see above. */
  id: number;
  /** Present on an upsert: the row as the client receives it. Absent on a delete. */
  value?: unknown;
}

/**
 * Ops above `since`, resolved to current state.
 *
 * No `GROUP BY`: the log already holds one entry per changed row, because
 * every trigger deletes the previous entry before inserting (design spec
 * §3.5). This is a primary-key range scan.
 *
 * An entry whose row has since vanished becomes a `delete` even if the entry
 * says `upsert` -- the log records that a row changed, and current state is
 * the authority on what it changed to. That is also what makes a torn read
 * impossible: there is one query for the entries and one per table for the
 * rows, and a row deleted between them simply reads as absent.
 *
 * The cursor returned is the last *entry's* id, not the last *served op's*
 * -- including an entry skipped because its table is unknown to `registry`.
 * A client only ever asks for ids above what it was handed, so returning
 * anything short of the last entry actually read would hand the same
 * skipped entry back on every following page, forever.
 */
export function tailSince(
  raw: DatabaseSync,
  registry: SyncRegistry,
  since: number,
  limit: number,
): { ops: readonly SyncOp[]; cursor: number } {
  const entries = raw.prepare(
    'SELECT id, table_name, row_id FROM sync_log WHERE id > ? ORDER BY id LIMIT ?',
  ).all(since, limit).map((row) => ({
    id: Number((row as { id: unknown }).id),
    table: String((row as { table_name: unknown }).table_name),
    rowId: Number((row as { row_id: unknown }).row_id),
  }));

  if (entries.length === 0) return { ops: [], cursor: since };

  const byTable = new Map<string, number[]>();
  for (const entry of entries) {
    const ids = byTable.get(entry.table);
    if (ids === undefined) byTable.set(entry.table, [entry.rowId]);
    else ids.push(entry.rowId);
  }

  const rows = new Map<string, Record<number, unknown>>();
  for (const [table, ids] of byTable) rows.set(table, registry.readRows(raw, table, ids));

  const known = new Set(registry.tables());
  const ops: SyncOp[] = [];
  for (const entry of entries) {
    if (!known.has(entry.table)) continue;
    const value = rows.get(entry.table)?.[entry.rowId];
    ops.push(value === undefined
      ? { op: 'delete', table: entry.table, id: entry.rowId }
      : { op: 'upsert', table: entry.table, id: entry.rowId, value });
  }

  const last = entries[entries.length - 1];
  return { ops, cursor: last === undefined ? since : last.id };
}
