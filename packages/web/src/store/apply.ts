/**
 * Applies a batch of sync ops to the replica in one `readwrite` transaction,
 * and wakes the subscribers the batch affects once that transaction has
 * committed.
 *
 * The firing is part of this function's contract rather than a caller's
 * follow-up step, because *when* it happens is load-bearing: a subscriber that
 * reads must see the whole batch, which is only true after the commit. See
 * `emit` in `notify.ts`, and spec §4's last paragraph.
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
 * write, rather than a sequential `await` per op. The reason is narrower than
 * it looks and the body of this function states it in full: the sequential
 * form trips `no-await-in-loop`, and `noUncheckedIndexedAccess` makes the
 * parallel-array alternative awkward. It is **not** that the batch keeps
 * requests in flight -- that claim stood here for two commits and is false,
 * measured: nothing is in flight once `Promise.all` settles, the sequential
 * form commits identically, and what ends a transaction is a macrotask gap.
 */
import { request, done } from './idb.ts';
import type { StoredRow } from './db.ts';
import { writeCursors, type Cursors } from './meta.ts';
import type { SyncOp } from './wire.ts';
import { emit } from './notify.ts';

/**
 * A batch carried two ops for one key, which this function cannot apply.
 *
 * The read pass reads every key once, before any write, so two ops for the
 * same key both see the *pre-batch* state -- and then the outcome depends on
 * order in ways none of the three rules intend: `delete` then `create`
 * resurrects the row, two `create`s let the second overwrite, and `create`
 * then `delete` reports an insert for a row that ends up a tombstone.
 *
 * The server cannot produce one: `sync_log` holds a single entry per changed
 * row (collapse-on-write), so a page has one op per key by construction.
 * That invariant lives on the other side of the wire, which is exactly why
 * it is checked here rather than trusted -- a batch a client assembled
 * itself, or a future endpoint that pages differently, would break it
 * silently and the damage would look like a replication bug.
 */
export class DuplicateOpError extends Error {
  constructor(op: { table: string; id: number }) {
    super(`batch carries more than one op for ["${op.table}", ${String(op.id)}]`);
    this.name = 'DuplicateOpError';
  }
}

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
 *
 * **The check is on the value, not on the key.** `'value' in op` was the
 * first spelling and it was wrong: `{ op: 'upsert', value: undefined }` has
 * the key and fails the test, so exactly the record this exists to refuse
 * went straight through. `null` is refused for the same reason -- measured,
 * it is index-invisible too, and no read shape is a bare `null`.
 */
export class MalformedOpError extends Error {
  constructor(op: { table: string; id: number }) {
    super(`sync op for ["${op.table}", ${String(op.id)}] carries no usable value`);
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
  // Before the transaction opens, so a refused batch costs no abort: see
  // `DuplicateOpError` for why the server cannot send one and why that is a
  // reason to check rather than to trust.
  const keys = new Set<string>();
  for (const op of ops) {
    const key = `${op.table}:${String(op.id)}`;
    if (keys.has(key)) throw new DuplicateOpError(op);
    keys.add(key);
  }

  const tx = db.transaction(['rows', 'meta'], 'readwrite');
  const store = tx.objectStore('rows');

  // Read every key the batch touches before writing any of them.
  //
  // Two honest reasons and one that was wrong. The honest ones: a sequential
  // `await` per op trips `no-await-in-loop` (confirmed -- rewriting this as a
  // loop makes oxlint warn), and `noUncheckedIndexedAccess` makes the
  // parallel-array alternative awkward where this pairing does not.
  //
  // The wrong one, recorded so nobody restores it: an earlier comment here
  // claimed the batch "keeps requests continuously in flight, which is what
  // keeps the transaction alive". Both halves are false. Nothing is in flight
  // after `Promise.all` settles, the sequential form commits identically
  // (measured), and what ends a transaction is a macrotask gap rather than an
  // idle moment between requests.
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
        // Written even when the client never held the row, and that is the
        // point rather than an oversight: the tombstone's job is to block a
        // later stale `create` for this key (spec §4), and a client that
        // missed the row's arrival is exactly the one a stale backfill page
        // could otherwise resurrect it on. Reported in `touched` too -- a
        // subscriber re-reads and sees `undefined` either way, so a spurious
        // wake is cheaper than a missed one.
        store.put({ table: op.table, id: op.id }); // tombstone: no `value` key at all
      } else {
        if (op.value === undefined || op.value === null) throw new MalformedOpError(op);
        if (op.op === 'create' && existing !== undefined) continue; // including a tombstone
        store.put({ table: op.table, id: op.id, value: op.value });
        // "Inserted" means *became visible to a reader*, not "had no record".
        // A tombstone is a record and is invisible to every read (spec §2.5),
        // so an upsert reviving one is new data appearing at that key -- which
        // is what `subscribeInserts` exists to announce. Keying this on
        // `existing === undefined` alone omitted exactly that case while this
        // module's own `Changed` docblock promised to include it.
        if (existing === undefined || existing.value === undefined) {
          bucket(inserted, op.table).push(op.id);
        }
      }
      bucket(touched, op.table).push(op.id);
    }
    await writeCursors(tx, cursors);
  } catch (err) {
    // `abort()` is what makes a refused batch leave nothing behind: a
    // synchronous throw does not abort a transaction, so `put`s issued
    // earlier in this loop would commit anyway (measured).
    //
    // The guard around it is insurance rather than a pinned path, and the
    // distinction is stated because an earlier version of this comment
    // claimed otherwise. `abort()` on an already-aborted transaction throws
    // `InvalidStateError` (measured), which would replace the error the
    // caller actually needs -- but the loop above is synchronous, so no error
    // event can land in the middle of it, and no test here can construct a
    // transaction that is already aborted on arrival. So this is cheap
    // protection for a path the suite cannot reach, not a covered one.
    try {
      tx.abort();
    } catch {
      // Already aborted, which is the outcome this call wanted anyway.
    }
    throw err;
  }

  await done(tx);

  // After the commit, never inside it (spec §4's last paragraph): a
  // subscriber that reads would otherwise re-enter this transaction and see
  // its own batch half-applied.
  const changed: Changed = { touched, inserted };
  emit(changed);

  return changed;
}
