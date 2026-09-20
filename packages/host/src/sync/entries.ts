import type { DatabaseSync } from 'node:sqlite';
import type { SyncRegistry } from './registry.ts';

/**
 * One `sync_log` row, as both cursors read it: a log position and the row it
 * names. Never the `op` column -- `tailSince` does not read it at all, and
 * `backfillBefore` uses it only in its `WHERE` clause, so neither needs it
 * back out. `sync/tail.ts`'s `SyncOp` has why the column's vocabulary is not
 * the wire's.
 */
export interface LogEntry {
  readonly id: number;
  readonly table: string;
  readonly rowId: number;
}

/**
 * `SELECT id, table_name, row_id FROM sync_log ...` rows, narrowed. The two
 * cursors' predicates and orderings differ; the three columns they read do
 * not, which is why this is here rather than written twice.
 */
export function readLogEntries(rows: readonly unknown[]): readonly LogEntry[] {
  return rows.map((row) => ({
    id: Number((row as { id: unknown }).id),
    table: String((row as { table_name: unknown }).table_name),
    rowId: Number((row as { row_id: unknown }).row_id),
  }));
}

/** Current state for the rows one page of log entries names. */
export interface CurrentState {
  /** Whether the registry owns this table at all -- see `readCurrentState`. */
  knows(table: string): boolean;
  /**
   * The row as a client receives it, or `undefined` for a row that no longer
   * exists. Absence is the answer, not an error: the log records that a row
   * changed, and current state is the authority on what it changed to.
   */
  rowOf(table: string, rowId: number): unknown;
}

/**
 * Current state for every row `entries` names: **one read per table, never
 * one per row.**
 *
 * That is the whole reason this is a step of its own rather than a lookup
 * inside each cursor's emission loop. A page of 200 entries over nine tables
 * is nine `readRows` calls; resolving each entry as it is emitted would be 200.
 *
 * It is also what makes a torn read impossible. There is one query for the
 * entries and one per table for the rows, so a row deleted between the two
 * simply reads as absent -- which each cursor then interprets in its own way:
 * `tailSince` turns it into a `delete`, because a client may be holding the
 * row; `backfillBefore` drops it, because a client walking below its pivot
 * cannot be.
 *
 * **A table nobody declares is `knows() === false`, which is not the same as
 * a table whose rows are all gone.** `sync_log` can hold entries for a table
 * a plugin since removed, and the cursors must advance past those rather than
 * serve them or refuse the page. Keeping the two questions apart is what lets
 * each cursor skip an unknown table's entry while still moving its cursor
 * over it.
 */
export function readCurrentState(
  raw: DatabaseSync,
  registry: SyncRegistry,
  entries: readonly LogEntry[],
): CurrentState {
  const byTable = new Map<string, number[]>();
  for (const entry of entries) {
    const ids = byTable.get(entry.table);
    if (ids === undefined) byTable.set(entry.table, [entry.rowId]);
    else ids.push(entry.rowId);
  }

  const rows = new Map<string, Record<number, unknown>>();
  for (const [table, ids] of byTable) rows.set(table, registry.readRows(raw, table, ids));

  const known = new Set(registry.tables());
  return {
    knows: (table) => known.has(table),
    rowOf: (table, rowId) => rows.get(table)?.[rowId],
  };
}
