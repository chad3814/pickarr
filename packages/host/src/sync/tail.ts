import type { DatabaseSync } from 'node:sqlite';
import { readCurrentState, readLogEntries } from './entries.ts';
import type { SyncRegistry } from './registry.ts';

/**
 * One invalidation, as a client receives it.
 *
 * **Three op kinds, and each cursor emits its own.** The backwards walk over
 * the log (`sync/backfill.ts`) emits `create` for every row it sends.
 * `tailSince` below emits `upsert` for a row that still exists and `delete`
 * for one that does not. A `create` means "here is a row you may not have
 * yet"; an `upsert` means "here is what this row is *now*".
 *
 * **That split is the whole mechanism that makes the two cursors safe to
 * apply in either order, and it is structural rather than arithmetic.** A
 * backfill page's values are read at one instant and applied at another, and
 * a write in between makes the page stale with nothing in the payload to say
 * so. No stateless server can prevent that: the invalidating write can land
 * after the response was serialised. So the op kind carries the rule, and a
 * client owes it **two obligations**:
 *
 *  1. **A `create` never overwrites.** Applying a `create` for a row the
 *     client already holds -- including one it holds as a *tombstone* -- does
 *     nothing at all.
 *  2. **A `delete` writes a tombstone; it does not remove the row.** The
 *     tombstone is what makes obligation 1 see a deleted row as "already
 *     held".
 *
 * **What breaks if a client skips either.** Skip 1 and a stale page overwrites
 * the newer value the tail already delivered -- permanently, because that
 * row's log entry is already consumed and nothing re-sends it. Skip 2 and a
 * stale page resurrects a row the tail deleted: obligation 1 finds the row
 * absent, so the `create` applies, and the row is back for as long as that
 * install exists. Both are measured, as tests, in
 * `test/sync/backfill.test.ts`. An earlier draft instead dated every page
 * with an `asOf` and asked the client to compare it against its own tail
 * cursor; the op kind does the same work without a number a client can
 * compare the wrong way round, so the stamp is gone rather than kept beside
 * it.
 *
 * **`sync_log.op` is a different vocabulary from this one.** The column holds
 * `'upsert'` or `'delete'`, written by the triggers (`sync/log.ts`), and
 * records only which trigger fired. Neither cursor turns it into an op kind:
 * `tailSince` never reads it at all, and `backfillBefore` reads it only in a
 * `WHERE` clause, to keep entries that can resolve to nothing out of its
 * pages. Current state is the authority on what an entry resolved to, and
 * nothing on the wire is a `create` except a backfill op.
 *
 * **`id` is on every op, whatever its kind, and never only inside `value`.**
 * It is the row's primary key in `table`, which is what a client stores the
 * row under -- so a `create`, the `upsert` that later refreshes the same row
 * and the `delete` that tombstones it all agree on one key. Putting the key
 * on the op rather than inside the payload is what makes that independent of
 * each read shape:
 * `readHostRows` (`sync/tables.ts`) happens to project `id` into `value` for
 * all seven host tables, and no plugin read shape carries it at all
 * (`packages/contract/src/sync.ts`), so a protocol that read the key out of
 * `value` worked for the host and silently failed for every plugin table --
 * an op a client could not key, group or later delete. The `id` inside a host
 * `value` is redundant and left alone; this one is the key.
 */
export interface SyncOp {
  op: 'create' | 'upsert' | 'delete';
  table: string;
  /** The row's primary key in `table`. Present on every op; see above. */
  id: number;
  /** Present on a create and an upsert: the row as the client receives it. Absent on a delete. */
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
 * the authority on what it changed to. `readCurrentState` (`sync/entries.ts`)
 * is where the absence comes from, and its doc has why that read cannot tear.
 *
 * **This cursor never emits a `create`.** Its ops say what a row is now and
 * are meant to overwrite whatever the client holds; only the backfill's
 * insert-if-absent `create` is allowed to lose to what is already there. See
 * `SyncOp` above for the two obligations that split rests on.
 *
 * The cursor returned is the last *entry's* id, not the last *served op's*
 * -- including an entry skipped because its table is unknown to `registry`.
 * A client only ever asks for ids above what it was handed, so returning
 * anything short of the last entry actually read would hand the same
 * skipped entry back on every following page, forever.
 *
 * **`backfillBefore` (`sync/backfill.ts`) is this function with the
 * comparison flipped and the order reversed**, and the two are deliberately
 * kept the same shape so a reader can see that. What differs is the
 * predicate, the cursor's exhausted value, and which op kind an entry becomes;
 * the half they share -- reading a page of entries and resolving it to current
 * state -- is `sync/entries.ts`, written once.
 */
export function tailSince(
  raw: DatabaseSync,
  registry: SyncRegistry,
  since: number,
  limit: number,
): { ops: readonly SyncOp[]; cursor: number } {
  const entries = readLogEntries(raw.prepare(
    'SELECT id, table_name, row_id FROM sync_log WHERE id > ? ORDER BY id LIMIT ?',
  ).all(since, limit));

  if (entries.length === 0) return { ops: [], cursor: since };

  const state = readCurrentState(raw, registry, entries);
  const ops: SyncOp[] = [];
  for (const entry of entries) {
    if (!state.knows(entry.table)) continue;
    const value = state.rowOf(entry.table, entry.rowId);
    ops.push(value === undefined
      ? { op: 'delete', table: entry.table, id: entry.rowId }
      : { op: 'upsert', table: entry.table, id: entry.rowId, value });
  }

  const last = entries[entries.length - 1];
  return { ops, cursor: last === undefined ? since : last.id };
}
