/**
 * Applies a batch of sync ops to the replica in one `readwrite` transaction.
 *
 * This is the one place that enforces the two rules the server cannot:
 * design spec §4's table, and `packages/host/src/sync/tail.ts`'s `SyncOp`
 * doc comment on `value`. Both rest on the same fact -- a client can be
 * handed a page it already applied, or a page that is stale by the time it
 * arrives -- and each rule closes one way that replaying it could go wrong:
 *
 * - `create` is a no-op over a row already held, **including a tombstone**.
 *   Drop this and a stale `create` for a key the client already upserted
 *   newer state for reverts that state to whatever the stale page carried.
 * - `delete` puts `{table, id}` with no `value` rather than removing the
 *   record. Drop this and a `create` replayed after a `delete` -- which sync
 *   can legitimately deliver, since a page is a snapshot of the log, not a
 *   guarantee of no earlier delivery -- resurrects a row nothing else is
 *   watching for, because nothing observes an object store's absence the
 *   way it observes a row's presence.
 *
 * The cursor advance is written into this same transaction, after the ops
 * and before `done(tx)`, so a crash between them is impossible: either both
 * commit or neither does. Two transactions would let a crash between them
 * either re-deliver a page (harmless -- both rules above are idempotent) or
 * skip one, which is silent permanent data loss (spec §4).
 *
 * Every key the batch touches is read in one `Promise.all` pass before any
 * write, rather than a sequential `await` per op: the latter trips
 * `no-await-in-loop`, and issuing the writes only after every read has
 * settled keeps requests continuously in flight, which is what keeps the
 * transaction alive until `done(tx)` -- an IndexedDB transaction commits as
 * soon as it has no pending request and control returns to the event loop.
 */
import { request, done } from './idb.ts';
import type { StoredRow } from './db.ts';
import { writeCursors, type Cursors } from './meta.ts';
import type { SyncOp } from './wire.ts';

/**
 * Thrown when a `create` or `upsert` carries no `value`. Names the op's
 * table and id, and never its value (Global Constraints: no row contents in
 * a message) -- there is none to name anyway, that being the defect.
 *
 * `value: undefined` is excluded from every `value.*` index exactly as an
 * absent `value` is, so a create or upsert with no value would write a
 * record indistinguishable from a tombstone: invisible to every index, and
 * blocking any later `create` for the same key. Refusing it here is cheaper
 * than debugging that later.
 */
export class MalformedOpError extends Error {
  constructor(op: { table: string; id: number }) {
    super(`sync op for ["${op.table}", ${String(op.id)}] carries no value`);
    this.name = 'MalformedOpError';
  }
}

/**
 * Which rows a batch touched, and which of those it inserted (found nothing
 * at their key beforehand -- including a tombstone, since a revive is still
 * new data appearing at that key). Keyed by table.
 *
 * The two are kept apart because task 4's subscription registry needs
 * different sets from each: every subscriber watching a touched table or
 * key, but only `subscribeInserts` cares whether the row is new. This
 * function is the only place that still knows which, once the write has
 * happened -- the store itself no longer distinguishes an inserted row from
 * one that was merely updated.
 */
export interface Changed {
  touched: ReadonlyMap<string, readonly number[]>;
  inserted: ReadonlyMap<string, readonly number[]>;
}

function bucket(map: Map<string, number[]>, table: string): number[] {
  const existing = map.get(table);
  if (existing !== undefined) return existing;
  const created: number[] = [];
  map.set(table, created);
  return created;
}

export async function applyBatch(
  db: IDBDatabase,
  ops: readonly SyncOp[],
  cursors: Cursors,
): Promise<Changed> {
  const tx = db.transaction(['rows', 'meta'], 'readwrite');
  const store = tx.objectStore('rows');

  // Read every key the batch touches before writing any of them -- see the
  // module docblock for why this is a batch, not a loop.
  const held = await Promise.all(
    ops.map(async (op) => ({
      op,
      existing: await request<StoredRow | undefined>(store.get([op.table, op.id])),
    })),
  );

  const touched = new Map<string, number[]>();
  const inserted = new Map<string, number[]>();

  // Everything from here to the cursor write is wrapped in one try/catch so
  // that any failure -- a refused op, or IndexedDB itself refusing a value
  // it cannot structured-clone -- explicitly aborts `tx` before rethrowing.
  // A synchronous throw alone does not: `store.put` requests already issued
  // earlier in this loop stay queued and go on to commit when the
  // transaction next falls idle, which would commit part of a batch whose
  // other half we just refused. Explicit `tx.abort()` is what makes this
  // failure mode match the one the atomicity test above already covers.
  try {
    for (const { op, existing } of held) {
      if (op.op === 'delete') {
        store.put({ table: op.table, id: op.id }); // tombstone: no `value` key at all
      } else {
        if (!('value' in op)) throw new MalformedOpError(op);
        if (op.op === 'create' && existing !== undefined) continue; // including a tombstone
        store.put({ table: op.table, id: op.id, value: op.value });
        if (existing === undefined) bucket(inserted, op.table).push(op.id);
      }
      bucket(touched, op.table).push(op.id);
    }
    await writeCursors(tx, cursors);
  } catch (err) {
    tx.abort();
    throw err;
  }

  await done(tx);

  return { touched, inserted };
}
