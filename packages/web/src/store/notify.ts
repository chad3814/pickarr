/**
 * The subscription registry, and the first consumer of `applyBatch`'s
 * `Changed` return value (design spec §8).
 *
 * Six registries, because the six subscription kinds key on different
 * things: `subscribe` on one row (`table:id`), `subscribeInserts`,
 * `subscribeTable` and `subscribeTouched` on a whole table (a row that did
 * not exist when the caller subscribed has no `id` to key on yet),
 * `subscribeReset` and `subscribeActivity` on nothing at all. The three table-wide kinds differ in
 * *which* changes reach them, and with what -- inserts only, against every
 * change with no ids, against every change with ids -- and
 * {@link subscribeTable}'s own doc has the defect that made the second
 * necessary; {@link subscribeTouched}'s doc has the one that made the third
 * necessary.
 *
 * `subscribeActivity` is the sixth: it keys on nothing because the
 * Activities page refetches `GET /api/activity` rather than reading a row,
 * so there is no table or id for a change to name.
 *
 * `emit` and `emitReset` are the write side, and each has two callers rather
 * than one. `store/apply.ts` emits after its own commit, for the tab that did
 * the writing; `store/sync.ts` emits again on a *follower* tab when a
 * broadcast arrives, which is the only thing that ever wakes a non-leader's
 * subscribers. `emitReset` fires from `sync.ts` both when this tab detects a
 * generation change and when it hears one -- again, the second is the only
 * path a follower has.
 *
 * Nothing else may call either, and a test may only call them to prove this
 * module's own contract.
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
const tableSubscribers = new Map<string, Set<RowListener>>();
const touchedSubscribers = new Map<string, Set<InsertListener>>();
const resetSubscribers = new Set<RowListener>();
const activitySubscribers = new Set<RowListener>();

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
  let removed = false;
  return () => {
    // **Idempotent, and it looks the set up again rather than trusting the one
    // it captured.** Either guard alone closes the hole -- measured, removing
    // one at a time leaves every test green and only removing both
    // reintroduces the defect -- so this is deliberately belt and braces on a
    // public surface, not two halves of one fix. The hole was real: the
    // closure captured the `Set` that existed at
    // subscribe time, so once that set was emptied and dropped from the
    // registry, a second call re-ran `registry.delete(key)` against whatever
    // set had been created there *since* -- silently detaching other
    // components' live subscribers. Reproduced: subscribe, unsubscribe,
    // subscribe twice more, unsubscribe the first one again, and a change to
    // that row woke nobody at all.
    //
    // This is the same defect `leader.ts`'s `onMessage` had, in the file whose
    // own commit message said the lesson generalises. It did not, until here.
    if (removed) return;
    removed = true;
    const current = registry.get(key);
    if (current === undefined) return;
    current.delete(cb);
    if (current.size === 0) registry.delete(key);
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

/**
 * Fires once per batch that changed anything in `table`, whatever the
 * change was: an insert, an update, or a delete.
 *
 * **The gap the other two leave between them, and it was a live defect.**
 * `subscribe` needs an id, so it cannot watch a row that arrives later;
 * `subscribeInserts` only fires for rows that *became visible*, so an
 * update and a delete wake nobody. A whole-table reader built on
 * `subscribeInserts` therefore grows and never shrinks: `useFeeds` removed
 * a feed, the host deleted the row, the tombstone reached the replica --
 * and the settings list went on showing it until a reload. Found by the
 * Playwright spec that removes a feed and waits for it to leave the
 * screen; every unit test passed, because each drove the hook's read
 * directly rather than through a delete.
 *
 * Handed no ids on purpose. A deleted row's id says nothing a re-read does
 * not, and a listener that took ids would invite callers to patch state
 * from the notification instead of re-reading the replica, which is the
 * one thing this store's readers must not do.
 */
export function subscribeTable(table: string, cb: RowListener): () => void {
  return add(tableSubscribers, table, cb);
}

/**
 * Fires once per batch with every id the batch wrote to `table` -- inserts,
 * updates and deletes alike (`Changed.touched`). The channel `usePluginRows`
 * needed and #105 asked for: a reader that knows which ids it holds can
 * tell an update or a delete of its own rows from a stranger's, which
 * `subscribeInserts` cannot say and `subscribeTable` says without ids.
 */
export function subscribeTouched(table: string, cb: InsertListener): () => void {
  return add(touchedSubscribers, table, cb);
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
    // Once per table, not once per row: a table subscriber re-reads the
    // whole table, so firing it per id would re-read a 40-row batch forty
    // times over. `changed.touched` only carries a table when that table
    // changed, so an empty `ids` cannot reach here.
    fireRow(tableSubscribers.get(table));
    fireInsert(touchedSubscribers.get(table), ids);
  }
  for (const [table, ids] of changed.inserted) {
    fireInsert(insertSubscribers.get(table), ids);
  }
}

/** Called after a reset's rebuild commits (spec §6). Every tab subscribes, the leader included, so there is one code path rather than a leader's and a follower's. */
export function emitReset(): void {
  fireRow(resetSubscribers);
}

/** Fires when the host says its jobs or fetch queue changed (the `activity` event, relayed from the leader tab). */
export function subscribeActivity(cb: RowListener): () => void {
  activitySubscribers.add(cb);
  return () => {
    activitySubscribers.delete(cb);
  };
}

/** Called from `store/sync.ts` only: on the leader when the stream delivers `activity`, on a follower when the leader relays it. */
export function emitActivity(): void {
  fireRow(activitySubscribers);
}
