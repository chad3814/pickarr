/**
 * The subscription registry, and the only consumer of `applyBatch`'s
 * `Changed` return value (design spec §8).
 *
 * Three registries, because the three subscription kinds key on different
 * things: `subscribe` on one row (`table:id`), `subscribeInserts` on a whole
 * table (a row that did not exist when the caller subscribed has no `id` to
 * key on yet), `subscribeReset` on nothing at all.
 *
 * `emit` and `emitReset` are the write side, called by `store/apply.ts`
 * (task 2) and the reset path (task 6) respectively -- never by a test
 * pretending to be either, except to prove this module's own contract.
 *
 * **Fired after the transaction commits, never inside it** (spec §4's last
 * paragraph). `applyBatch` awaits `done(tx)` before calling `emit`; a
 * handler that reads here sees the whole batch, because the transaction that
 * applied it is already closed. Firing before that await would let a
 * handler's read re-enter the live transaction and see its own batch
 * half-applied.
 */
import type { Changed } from './apply.ts';

type RowListener = () => void;
type InsertListener = (ids: readonly number[]) => void;

const rowSubscribers = new Map<string, Set<RowListener>>();
const insertSubscribers = new Map<string, Set<InsertListener>>();
const resetSubscribers = new Set<RowListener>();

function rowKey(table: string, id: number): string {
  return `${table}:${String(id)}`;
}

/**
 * Adds `cb` to the `Set` at `key` in `registry`, creating it if absent, and
 * returns the unsubscribe closure every subscribe function here hands back.
 * The empty `Set` is deleted on the way out rather than left behind, so a
 * registry with nobody watching `table:id` costs nothing to carry.
 */
function add<K, L>(registry: Map<K, Set<L>>, key: K, cb: L): () => void {
  let set = registry.get(key);
  if (set === undefined) {
    set = new Set();
    registry.set(key, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) registry.delete(key);
  };
}

/**
 * A handler that throws must not stop the others -- one component's bug is
 * not a reason the rest of the app stops updating. Caught and reported
 * rather than swallowed silently, so the bug is still visible somewhere.
 *
 * Never handed the row that triggered it (Global Constraints: no row
 * contents in a log): only the error the handler itself threw, which is the
 * caller's own words about its own failure.
 */
function reportSubscriberError(err: unknown): void {
  console.error('pickarr: a store subscriber threw', err);
}

/**
 * Runs one handler so that neither a throw nor a rejection escapes.
 *
 * The `try` covers a synchronous throw. The promise check covers the case the
 * types invite and do not prevent: a listener is `() => void`, and TypeScript
 * accepts an `async` function there because `Promise<void>` is assignable to
 * `void` -- so a rejecting async handler slips past the `catch` entirely and
 * becomes an unhandled rejection. Measured under `node --test`, where one
 * does not merely warn: it was attributed to whichever test happened to be
 * running, corrupting an unrelated result.
 *
 * `instanceof Promise` rather than a duck-typed `.then`, because an `async`
 * function always returns a native promise and a bare thenable cannot satisfy
 * the declared `void` return without a cast the caller would have had to
 * write deliberately.
 */
function invoke(run: () => unknown): void {
  try {
    const result = run();
    if (result instanceof Promise) void result.catch(reportSubscriberError);
  } catch (err) {
    reportSubscriberError(err);
  }
}

function fireRow(cbs: Set<RowListener> | undefined): void {
  if (cbs === undefined) return;
  for (const cb of cbs) invoke(() => cb());
}

function fireInsert(cbs: Set<InsertListener> | undefined, ids: readonly number[]): void {
  if (cbs === undefined) return;
  for (const cb of cbs) invoke(() => cb(ids));
}

/** Fires on every change to `['table', id]`: an insert, an update, or a delete (spec §8). */
export function subscribe(table: string, id: number, cb: RowListener): () => void {
  return add(rowSubscribers, rowKey(table, id), cb);
}

/**
 * Fires with the ids a batch inserted into `table` -- the gap a per-row
 * subscription cannot close, because it cannot name a row that did not
 * exist when it was registered (spec §8).
 */
export function subscribeInserts(table: string, cb: InsertListener): () => void {
  return add(insertSubscribers, table, cb);
}

/** Fires after a generation-mismatch reset commits (spec §6, §8). */
export function subscribeReset(cb: RowListener): () => void {
  resetSubscribers.add(cb);
  return () => {
    resetSubscribers.delete(cb);
  };
}

/**
 * Called by `applyBatch` once its transaction has committed. Costs one
 * registry lookup per changed row rather than a scan of every subscriber
 * (spec §8), because `touched` and `inserted` are already exactly the rows
 * this batch changed.
 */
export function emit(changed: Changed): void {
  for (const [table, ids] of changed.touched) {
    for (const id of ids) {
      fireRow(rowSubscribers.get(rowKey(table, id)));
    }
  }
  for (const [table, ids] of changed.inserted) {
    fireInsert(insertSubscribers.get(table), ids);
  }
}

/** Called after a reset's rebuild commits (spec §6). Every tab subscribes, the leader included, so there is one code path rather than a leader's and a follower's. */
export function emitReset(): void {
  fireRow(resetSubscribers);
}
