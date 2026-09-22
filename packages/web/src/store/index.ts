/**
 * `createStore`: the public surface, and the only file in this package a
 * consumer outside `store/` should import from.
 *
 * A factory, not a module-level singleton. Every other module in this
 * directory was built to be driven by a test -- `sync.ts`'s injected
 * `fetch`/`schedule`/`now`/`locks`, `db.ts`'s `openStore(name)` taking the
 * name rather than assuming one -- and a singleton would throw that away at
 * the last step: a second `createStore` call in the same process (this
 * suite's own end-to-end test needs exactly that, since `node --test` runs a
 * whole file in one process) would either collide with the first tab's
 * database and lease, or silently reuse the first instance's state.
 *
 * This module wires the pieces together and adds nothing of its own: it
 * opens the replica, starts the sync loops over it, and closes over `db` so
 * every *read* a caller gets back needs no `db` argument of its own.
 *
 * **The subscriptions need none for a different reason, and the difference
 * matters.** They are not scoped to a replica at all: `notify.ts`'s
 * registries are module state, so two `Store`s in one process share them and
 * a subscriber on one will fire for the other's write to the same
 * `table:id`. Reads and the database stay correctly isolated; only the wake-up
 * crosses. Harmless under the one-replica-per-tab model this is built for,
 * and stated here rather than left for whoever first creates two stores in
 * one test file to find. An earlier version of this paragraph credited the
 * `db` closure for both, which was true of the reads and false of the
 * subscriptions. It invents no new adapter -- `fetch`, `schedule`, `now` and
 * `locks` are the same seams `sync.ts` already defined, handed through
 * unchanged, because the browser-facing choice of a real `fetch`, a real
 * `requestIdleCallback`-based scheduler and `webLocksLease` belongs to
 * whichever slice first has a route to run them from (design spec §1.2,
 * this task's brief).
 */
import { openStore } from './db.ts';
import type { StoredRow } from './db.ts';
import {
  getRow, getRows, byMediaItem, byRssItem, listByTable, listByTablePlugin, countByPlugin,
  pluginRowsByMediaItems,
  type ListByTableOptions,
} from './rows.ts';
import type { PluginRows } from '@pickarr/plugin-ui';
import { subscribe, subscribeInserts, subscribeReset } from './notify.ts';
import { gatherMediaItem, type GatheredItem } from './gather.ts';
import { startSync, type Lease, type Schedule, type SyncFetch } from './sync.ts';

/**
 * What `createStore` needs, and nothing it does not: the replica's name, and
 * the four seams `sync.ts` already requires of its caller. Nothing here
 * defaults, for the same reason `sync.ts` itself takes all four rather than
 * reaching for a global -- a caller that wants `globalThis.fetch`,
 * `webLocksLease()` or a `requestIdleCallback` scheduler supplies them
 * explicitly, and a test supplies its own stubs the same way `sync.test.ts`
 * already does.
 */
export interface CreateStoreDeps {
  /** The IndexedDB database name -- `openStore`'s own parameter, passed through so two stores in one process (this task's own test) do not share a replica. */
  dbName: string;
  fetch: SyncFetch;
  schedule: Schedule;
  /** Milliseconds, monotonic-ish. See `sync.ts`'s `SyncDeps.now`. */
  now: () => number;
  locks: Lease;
  /**
   * How long a single sync request may take before its signal aborts.
   * Forwarded to `startSync`'s `SyncDeps.fetchDeadlineMs` unchanged; see that
   * field for the default and why it exists. Absent here until a caller
   * through `createStore` needed it (task 6's fix round, review-found): every
   * `fetchJson` call creates a real `AbortSignal.timeout`, and that timer
   * outlives the request it bounds -- 60 real seconds per `node --test` file
   * that boots a store through the default, measured directly by shortening
   * it and watching a 60-second run become a one-second one. Production
   * leaves this unset, which is the existing 60-second default unchanged.
   */
  fetchDeadlineMs?: number;
}

/**
 * The seven reads (`store/rows.ts`), the three subscriptions
 * (`store/notify.ts`), the host-owned gatherer (`store/gather.ts`), and
 * `stop()` -- everything a consumer of the replica needs, with `db` already
 * bound so none of it takes one.
 *
 * The three subscriptions are `store/notify.ts`'s own module-level
 * registries, keyed by table and id rather than by store instance --
 * unchanged here, and deliberately: nothing in this slice's design keys a
 * subscription off which replica raised it (there is exactly one replica per
 * tab in production), and rebinding them per instance would be new behaviour
 * this task was not asked to add.
 */
export interface Store {
  getRow(table: string, id: number): Promise<unknown | undefined>;
  getRows(table: string, ids: readonly number[]): Promise<Map<number, unknown>>;
  byMediaItem(mediaItemId: number): Promise<readonly StoredRow[]>;
  byRssItem(rssItemId: number): Promise<readonly StoredRow[]>;
  /**
   * A page's plugin rows, one batched read regardless of how many ids or
   * tables -- `store/rows.ts`'s own doc on why this exists separately from
   * `gatherMediaItem` (a collapsed card needs its rows too, and this is the
   * only shape that can answer for a whole page of them at once).
   */
  pluginRowsByMediaItems(mediaItemIds: readonly number[], tables: readonly string[]): Promise<ReadonlyMap<number, PluginRows>>;
  listByTable(table: string, opts: ListByTableOptions): Promise<readonly StoredRow[]>;
  listByTablePlugin(table: string, pluginId: string, opts: ListByTableOptions): Promise<readonly StoredRow[]>;
  countByPlugin(table: string, pluginId: string): Promise<number>;
  subscribe(table: string, id: number, cb: () => void): () => void;
  subscribeInserts(table: string, cb: (ids: readonly number[]) => void): () => void;
  subscribeReset(cb: () => void): () => void;
  gatherMediaItem(mediaItemId: number): Promise<GatheredItem | undefined>;
  /**
   * Cancels both sync loops, releases this store's Web Lock lease if it
   * holds one, stops relaying other tabs' messages, and closes this store's
   * IndexedDB connection. Safe to call more than once -- `SyncHandle.stop()`
   * already is, and `IDBDatabase.close()` is idempotent by the standard.
   *
   * The lease release is what makes a second `Store` opened later in the
   * same tab able to lead: `Shell.tsx`'s sign-in and sign-out journeys both
   * open one after this one has stopped, and until `SyncHandle.stop()`
   * released the underlying Web Lock, that second `Store` queued behind this
   * one forever and never fetched anything (`leader.ts`'s module doc has the
   * full account).
   *
   * Closing `db` here, and not before, is what makes this store's `stop()`
   * actually stop things end to end: `sync.ts`'s own `SyncHandle.stop()`
   * only cancels the two scheduled tasks, releases the lease and the
   * `BroadcastChannel` relay, because it never opened the database and has
   * no business closing a handle a caller might still be reading from
   * mid-shutdown. This module did open it, so closing it here is what leaves
   * nothing of this store's for the process to hang on.
   */
  stop(): void;
}

/**
 * Opens the replica named `deps.dbName` and starts syncing it. Returns once
 * the database is open -- not once anything has been fetched, since fetching
 * waits on the lease exactly as `startSync` documents.
 */
export async function createStore(deps: CreateStoreDeps): Promise<Store> {
  const db = await openStore(deps.dbName);
  const handle = startSync({
    db,
    fetch: deps.fetch,
    schedule: deps.schedule,
    now: deps.now,
    locks: deps.locks,
    // Omitted entirely rather than set to `undefined` when absent:
    // `exactOptionalPropertyTypes` treats an explicit `undefined` differently
    // from an absent key, and `SyncDeps.fetchDeadlineMs` is typed `number`,
    // not `number | undefined`.
    ...(deps.fetchDeadlineMs === undefined ? {} : { fetchDeadlineMs: deps.fetchDeadlineMs }),
  });

  return {
    getRow: (table, id) => getRow(db, table, id),
    getRows: (table, ids) => getRows(db, table, ids),
    byMediaItem: (mediaItemId) => byMediaItem(db, mediaItemId),
    byRssItem: (rssItemId) => byRssItem(db, rssItemId),
    pluginRowsByMediaItems: (mediaItemIds, tables) => pluginRowsByMediaItems(db, mediaItemIds, tables),
    listByTable: (table, opts) => listByTable(db, table, opts),
    listByTablePlugin: (table, pluginId, opts) => listByTablePlugin(db, table, pluginId, opts),
    countByPlugin: (table, pluginId) => countByPlugin(db, table, pluginId),
    subscribe,
    subscribeInserts,
    subscribeReset,
    gatherMediaItem: (mediaItemId) => gatherMediaItem(db, mediaItemId),
    stop(): void {
      handle.stop();
      db.close();
    },
  };
}
