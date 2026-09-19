import type { DatabaseSync } from 'node:sqlite';
import { readCurrentState, readLogEntries } from './entries.ts';
import type { SyncOp } from './tail.ts';
import type { SyncRegistry } from './registry.ts';

/**
 * Ops *below* `before`, resolved to current state: `tailSince` with the
 * comparison flipped and the order reversed.
 *
 * **The log is read as an index of which rows exist, never as a history.**
 * It holds exactly one entry per live row -- the triggers collapse it on
 * write (design spec §3.5) and `seedSyncLog` (`sync/log.ts`) establishes the
 * invariant on a database that predates it -- so walking it backwards visits
 * every row exactly once, and each row's values still come from current
 * state. That is what makes this a walk over current state despite reading
 * the log to drive it, and why it needs no index of its own: measured,
 * `WHERE id < ? AND op != 'delete' ORDER BY id DESC` plans as
 * `SEARCH sync_log USING INTEGER PRIMARY KEY (rowid<?)`.
 *
 * **`op != 'delete'` is a page-density filter, not the thing that keeps
 * tombstones off this cursor.** A `delete` entry *below* a client's pivot
 * names a row that client can never have held: had it held the row, the
 * deletion would have re-logged the entry at a fresh, higher id, putting it
 * above the pivot and into the tail's half. So the entry carries nothing this
 * cursor could say -- and the collapse means a deleted row's single entry
 * *is* the delete. Filtering it in the predicate is what keeps `limit` meaning
 * rows *served* rather than rows looked at; a library with a long deletion
 * history would otherwise hand back progressively emptier pages. The emission
 * loop below drops an unresolved row as well, which covers the case the
 * predicate cannot see: an entry that said `upsert` when it was read and whose
 * row was deleted before the hydration ran.
 *
 * **Disjointness against the tail is arithmetic.** The tail takes `id >
 * since` and this takes `id < before`; a bootstrapping client is handed
 * `since = W - 1` and `before = W` (`sync/bootstrap.ts`), which meet at `W`
 * and overlap nowhere. There is no per-page, per-table `sync_log` query
 * deciding who owns a row, and no watermark threaded through the cursor --
 * both of which the current-state walk needed and neither of which survives
 * the flip.
 *
 * **Every op this walk emits is a `create`, and that is what makes a page
 * safe to apply however late it lands.** A page's values are read at one
 * instant and applied at another, and a write in between makes the page stale
 * with nothing in the payload to say so; no stateless server can prevent
 * that, since the invalidating write can land after the response was
 * serialised. So the op kind carries the rule. A client applying a `create`
 * for a row it already holds does nothing, and a `delete` tombstones the row
 * rather than removing it, so "already holds" covers a row the tail deleted
 * too: a stale page can neither overwrite the newer value the tail delivered
 * nor resurrect what the tail removed. Both obligations, and what breaks if a
 * client skips either, are in `sync/tail.ts`'s `SyncOp`.
 *
 * **Two properties the group-hydrated walk had and this one does not.
 * Accepted, and recorded here rather than left to be discovered.**
 *
 * 1. **Emission is in log order, not group order**, so an op may reference a
 *    synced row the client has not received yet -- production writes an
 *    `rss_item` before the `media_item` it is later relinked to, so the
 *    release is emitted first and its `media_item_id` points forward. The row
 *    arrives elsewhere in the same walk. A client already has to tolerate a
 *    reference it cannot resolve at all:
 *    `torrent_download`/`nzb_download`'s `download_client_id` names a table
 *    that is never synced (`sync/tables.ts`), by design and permanently.
 *    `rss_item.feed_id` used to be named alongside it here; it no longer is,
 *    because `rss_feed` joined the synced set and a `feedId` now resolves,
 *    eventually, the same way a forward `media_item_id` reference does. What
 *    is lost is the *ordering* guarantee inside the synced set, not eventual
 *    resolution of anything.
 * 2. **A page is `limit` rows, not `limit` hydrated groups.** Strictly better
 *    for bounding a response -- the old walk emitted every dependent row of
 *    each of `limit` media items, so a response weighed whatever those groups
 *    happened to weigh -- and it means `limit` now means what it says.
 *
 * A null cursor means the log below `before` is exhausted and the caller
 * retires this walk; from then on only the tail runs. **A short page is a
 * permanent exhaustion, not a momentary one**: every entry the log gains takes
 * a higher id, and a re-logged row's old entry is deleted, so nothing ever
 * appears below a point this walk has already passed.
 *
 * `before` of `null` is "from the newest entry", the route's own first-page
 * case. The predicate goes rather than being satisfied with a sentinel above
 * every id: measured, that form plans as `SCAN sync_log` with **no**
 * `USE TEMP B-TREE FOR ORDER BY`, which is the rowid index walked in reverse
 * with `LIMIT` stopping it -- not a read of the table.
 */
export function backfillBefore(
  raw: DatabaseSync,
  registry: SyncRegistry,
  before: number | null,
  limit: number,
): { ops: readonly SyncOp[]; cursor: number | null } {
  const entries = readLogEntries(before === null
    ? raw.prepare(
        "SELECT id, table_name, row_id FROM sync_log WHERE op != 'delete' ORDER BY id DESC LIMIT ?",
      ).all(limit)
    : raw.prepare(
        "SELECT id, table_name, row_id FROM sync_log WHERE id < ? AND op != 'delete' ORDER BY id DESC LIMIT ?",
      ).all(before, limit));

  if (entries.length === 0) return { ops: [], cursor: null };

  const state = readCurrentState(raw, registry, entries);
  const ops: SyncOp[] = [];
  for (const entry of entries) {
    if (!state.knows(entry.table)) continue;
    const value = state.rowOf(entry.table, entry.rowId);
    if (value !== undefined) ops.push({ op: 'create', table: entry.table, id: entry.rowId, value });
  }

  // The last *entry* read, not the last op served -- including an entry
  // skipped because its table is unknown to `registry`, or because its row
  // was gone by the time the page was hydrated. A client only ever asks for
  // ids below what it was handed, so returning the lowest served op's id
  // would hand a skipped entry back on every following page, and a page made
  // entirely of skipped entries would stall the walk outright. Exactly
  // `tailSince`'s reasoning, in the other direction.
  const last = entries[entries.length - 1];
  return { ops, cursor: entries.length < limit || last === undefined ? null : last.id };
}
