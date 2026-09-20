import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, DownloadedFile, JobHandler, MediaPlugin, PluginContext } from '@pickarr/contract';
import { createArtworkStore } from './artwork/store.ts';
import type { HostDb } from './db/open.ts';
import { migratePlugin } from './db/migrate.ts';
import { createMediaWriter } from './media/writer.ts';
import { createMediaReader } from './media/reader.ts';
import { createRunner } from './jobs/runner.ts';
import type { Runner } from './jobs/runner.ts';
import { createDispatcher } from './jobs/dispatcher.ts';
import type { Timers } from './jobs/dispatcher.ts';
import { createFeedReader } from './feeds/reader.ts';
import { addFeed as addFeedRule } from './feeds/add.ts';
import type { AddFeedInput, AddFeedRefusal } from './feeds/add.ts';
import { addDownloadClient as addDownloadClientRule } from './clients/add.ts';
import type { AddDownloadClientInput, AddDownloadClientRefusal } from './clients/add.ts';
import { requestPick as requestPickRule } from './clients/pick.ts';
import type { PickAccepted, PickRefusal } from './clients/pick.ts';
import {
  addMapping as addMappingRule,
  editMapping as editMappingRule,
  removeMapping as removeMappingRule,
} from './clients/mappings.ts';
import type { AddMappingInput, EditMappingInput, MappingRefusal } from './clients/mappings.ts';
import { installSyncTriggers, seedSyncLogOnce } from './sync/log.ts';
import { assertSyncable } from './sync/registry.ts';
import type { QueuedFetch } from './fetch/queue.ts';
import { pendingJobId, readPayloadNumber } from './jobs/pending.ts';
import { createReconcileHandler, scheduleReconcile as scheduleReconcileJob } from './clients/reconcile-job.ts';
import type { Secrets } from './secrets/instance.ts';
import { HOST_PLUGIN_ID } from './host-id.ts';
import { PluginNotRegisteredError, UnknownRssItemError } from './errors.ts';
import { ownerPluginId } from './db/owner.ts';

export { HOST_PLUGIN_ID };
export { PluginNotRegisteredError };
export { ownerPluginId };
export type { AddFeedInput, AddFeedRefusal };
export type { AddDownloadClientInput, AddDownloadClientRefusal };
export type { PickAccepted, PickRefusal };
export type { AddMappingInput, EditMappingInput, MappingRefusal };
export { MIN_POLL_INTERVAL_S, MAX_POLL_INTERVAL_S } from './feeds/add.ts';

/**
 * Real `Timers`, wiring `Host.start()`'s dispatcher to Node's own timer
 * functions. `setTimeout`/`setInterval` hand back whatever the runtime
 * returns; the two `clear*` methods only ever receive that same value back,
 * from this same pairing, so narrowing the opaque `unknown` handle here is
 * recovering a type this code already knows, not asserting one it doesn't.
 */
const nodeTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => { clearInterval(handle as NodeJS.Timeout); },
};

/**
 * A real sleep, for `run-job.ts`'s abort-grace wait. The only one in the
 * package: `main.ts` had a `defaultSleep` twin while the pump existed, and it
 * went with the pump, so there is nothing left to mirror or import.
 */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** How many times a job may fail before it dead-letters. */
export const DEFAULT_MAX_ATTEMPTS = 5;


/**
 * Narrows a `poll` job's `unknown` payload rather than casting it, so a
 * malformed row fails loudly instead of coercing silently. Built on
 * `jobs/pending.ts`'s `readPayloadNumber`, the non-throwing reader a scan
 * over rows that are not the one being run (`pendingJobId`, same module)
 * also uses -- throwing here is right precisely because this payload IS the
 * job under execution, and a bad one should fail loudly and dead-letter,
 * which would be wrong for a scan over every OTHER row.
 */
function readPollPayload(payload: unknown): { feedId: number } {
  const feedId = readPayloadNumber(payload, 'feedId');
  if (feedId === undefined) {
    throw new Error(`poll job payload is not shaped like { feedId: number }: ${JSON.stringify(payload)}`);
  }
  return { feedId };
}

/**
 * What came of dispatching a batch of new rss items.
 *
 * Returned, not thrown: an id with no registered owner and a plugin whose
 * handler rejected are both data the caller must act on, not exceptions —
 * every other id in the same batch may have been delivered successfully,
 * and a caller that retries on rejection would re-deliver ids the owned
 * plugins already handled, which no plugin here has proven idempotent.
 */
export interface NotifyOutcome {
  /** Ids whose feed has no registered plugin. Empty when every id was owned. */
  unowned: readonly number[];
  /** One entry per plugin whose `onNewRssItems` rejected, so a second plugin's failure can never hide behind a first. */
  failures: readonly { pluginId: string; error: unknown }[];
}


export interface Host {
  /** Applies the plugin's migrations and registers its handlers. */
  register(plugin: MediaPlugin): void;
  /** Dispatches to the plugin owning the feed those items came from. */
  notifyNewRssItems(ids: readonly number[]): Promise<NotifyOutcome>;
  /**
   * Hands an rss item to the plugin owning its feed, which submits it to a
   * download client.
   *
   * **Throws, where every other write path on this interface returns a
   * refusal as a value.** That is not an oversight being preserved: this
   * method predates any caller at all, and the errors it and everything
   * under it raise are how a job's `last_error` and the host log describe a
   * failed pick. `requestPick` below is the conversion, and
   * `clients/pick.ts` is where each throw becomes a code. A caller that
   * wants an answer rather than an exception should use that one.
   *
   * Rejects with `UnknownRssItemError` for an id naming no row and
   * `PluginNotRegisteredError` for a row whose feed's plugin is absent; the
   * plugin's own handler may reject with anything, and does reject with
   * `NoClientOfTypeError`, `ClientTypeMismatchError` or
   * `AlreadySubmittedError` when the submission cannot be placed.
   */
  requestDownload(rssItemId: number): Promise<void>;
  /**
   * Submits a pick for one release, answering `{ accepted: true }` or one
   * of `@pickarr/contract`'s `REQUEST_PICK_REFUSALS`.
   *
   * The value-returning face of `requestDownload` above, and the one
   * `POST /api/picks` is built on. The conversion itself lives in
   * `clients/pick.ts`, this method's own delegate -- the same split
   * `addFeed` and `addDownloadClient` use, and for the same reason:
   * `host.ts` is already long and that rule set is self-contained.
   *
   * **Returns every refusal as a value and throws none of them**, with
   * exactly the scope `addFeed`'s own doc states and no more. It can still
   * reject: anything `requestDownload` raises that is not one of the five
   * refusal classes is rethrown untouched -- a corrupt row, a closed
   * database, a plugin's own bug, a download client that could not be
   * reached. Those are infrastructure faults rather than answers about the
   * pick, they reach `api/server.ts`'s outermost handler, and they become a
   * 500, which is the right status for them.
   *
   * **`{ accepted: true }` does not mean a download row exists**, and the
   * route's own comment has the measurement. What it means is that the
   * owning plugin's `onDownloadRequest` resolved.
   */
  requestPick(rssItemId: number): Promise<PickAccepted | PickRefusal>;
  /**
   * Validates and writes a new `rss_feed` row, then schedules its first poll
   * immediately -- the same call `main.ts` already makes at boot for every
   * feed on file, so a freshly added feed reaches the same state a restart
   * would have left it in, and items arriving is the first real confirmation
   * the url was right. The invariants themselves live in `feeds/add.ts`,
   * this method's own delegate, not here: `host.ts` is already long, and
   * that rule set is self-contained.
   *
   * **Returns every refusal as a value and throws none of them**: a thrown
   * error is indistinguishable from a bug at the call site, and the route in
   * front of this (a later task) needs to map each refusal to its own status
   * code.
   *
   * That is the guarantee, and it is narrower than "never throws", which is
   * what this line used to say. This method can still reject -- a SQLite
   * error that is not the unique-constraint one is rethrown by `feeds/add.ts`,
   * and the `schedulePoll` after a successful insert is outside any `try`.
   * Both are infrastructure faults or bugs rather than answers about the
   * input, both reach `api/server.ts`'s outermost handler, and both become a
   * 500, which is the right status for them. Callers must not read "never
   * throws" as licence to skip an error boundary; what they may rely on is
   * that a *refusal* arrives in the return value or not at all.
   */
  addFeed(input: AddFeedInput): Promise<{ id: number } | AddFeedRefusal>;
  /**
   * Validates and writes a new `download_client` row -- storing its
   * credential in the `secret` table under a generated name, never in a
   * column -- then schedules its first reconcile immediately, which is the
   * same call `main.ts` already makes at boot for every client on file. So
   * a freshly added client reaches the state a restart would have left it
   * in, and the reconcile is also the first real confirmation the url and
   * the credential were right (design spec §8.8: no synchronous probe
   * inside the POST, because that puts a third-party service's latency
   * inside a user-facing request).
   *
   * The invariants themselves live in `clients/add.ts`, this method's own
   * delegate, not here -- `host.ts` is already long and that rule set is
   * self-contained, the same split `addFeed` uses.
   *
   * Returns every refusal as a value and throws none of them, for the
   * reason `addFeed` gives above -- and, as there, that is not the same as
   * never throwing. The two rejection paths here are `clients/add.ts`'s
   * rethrow of any SQLite error that is not the `download_client_name`
   * unique-constraint violation, and the awaited `scheduleReconcile` after
   * a successful insert, which sits outside every `try`. `saveSecret` is a
   * third: it runs before the insert (design spec §8.6) and a failure there
   * rejects with no row written. All three become a 500 at the route.
   *
   * **No refusal, and nothing this method returns or logs, carries the
   * submitted credential**: the value reaches `Secrets.saveSecret` and stops
   * there. That holds on the throwing paths too, and structurally rather
   * than by inspecting SQLite's wording: the only error `add.ts` rethrows
   * comes from the `INSERT INTO download_client` statement, and neither
   * credential is among that statement's bound values -- the row takes the
   * generated *secret names*, never the secrets. There is no value for an
   * error message to quote even if SQLite quoted its bindings.
   */
  addDownloadClient(input: AddDownloadClientInput): Promise<{ id: number } | AddDownloadClientRefusal>;
  /**
   * Validates and writes a new `filepath_mapping` row -- one translation
   * from a path download client `downloadClientId` reports into one this
   * host can open. The rules live in `clients/mappings.ts`, this method's
   * own delegate, not here: the same split `addFeed` and
   * `addDownloadClient` use, and for the same reason.
   *
   * **Nothing is scheduled afterwards, where the two write paths above each
   * schedule a job.** That is not an omission: `clients/deliver.ts` re-reads
   * this table through `mapClientPath` on **every** delivery tick and
   * deliberately never stores a mapped path, "because a stored mapped path
   * goes stale the moment a `filepath_mapping` row changes" (its own
   * docblock, and design spec §4). So a new mapping is in force at the next
   * tick with nothing to invalidate and nothing to enqueue, and a delivery
   * stuck against a missing mapping recovers by itself -- which
   * `deliver.ts` already cites as its reason for not failing such rows.
   *
   * Returns every refusal as a value and throws none of them, for the
   * reason `addFeed` gives above -- and, as there, that is not the same as
   * never throwing: a SQLite error that is neither the foreign-key nor the
   * unique-index violation is rethrown by `clients/mappings.ts` and becomes
   * a 500 at the route.
   */
  addMapping(input: AddMappingInput): Promise<{ id: number } | MappingRefusal>;
  /**
   * Replaces mapping `id`'s `from_path` and `to_path`, answering `{ id }`
   * or one of `@pickarr/contract`'s `MAPPING_REFUSALS`.
   *
   * **Edit rather than delete-plus-add, and the reason predates this
   * slice** (design spec §4): the row keeps its identity and its
   * `created_at`, and an in-flight delivery is unharmed because the mapping
   * is applied on demand rather than stored. `updated_at` moves; nothing
   * else about the row does, and the client it belongs to cannot be changed
   * at all -- see `EditMappingInput`.
   *
   * Returns every refusal as a value and throws none of them, with the same
   * scope `addMapping` above states.
   */
  editMapping(id: number, input: EditMappingInput): Promise<{ id: number } | MappingRefusal>;
  /**
   * Deletes mapping `id`, answering `{ id }` or `unknown-mapping`.
   *
   * An id naming no row is the refusal rather than a quiet success, so a
   * browser working from a stale list is told so. The removal reaches the
   * replica through the `AFTER DELETE` trigger `installSyncTriggers`
   * already emits for every synced table, which needs nothing from this
   * method (design spec §5).
   */
  removeMapping(id: number): Promise<{ id: number } | MappingRefusal>;
  /**
   * Delivers `file` to the plugin `pluginId` names, calling its
   * `onDownloadedFile`. The shape `deliverCompleted`
   * (`clients/deliver.ts`) expects for its own `deliver` dependency --
   * built here, rather than by whoever wires `deliverCompleted` up,
   * because only this closure holds the registered `plugins` map and
   * `ctxFor`. Throws `PluginNotRegisteredError` for a `pluginId` naming no
   * registered plugin, rather than silently doing nothing, so a caller can
   * tell that failure apart from the plugin's own handler rejecting.
   */
  deliverToPlugin(pluginId: string, file: DownloadedFile): Promise<void>;
  /** Enqueues the first `poll` job for a feed. Idempotent per feed. */
  schedulePoll(feedId: number, runAt?: number): number;
  /**
   * Enqueues the first `reconcile` job for a download client. Idempotent
   * per client, the same shape as `schedulePoll` -- a client that already
   * has a `reconcile` job `ready` or `running` gets no second one.
   *
   * A `Promise`, unlike `schedulePoll`: this delegates to
   * `clients/reconcile-job.ts`'s own exported `scheduleReconcile`, whose
   * `jobs` parameter is the contract's `JobQueue` -- `PluginContext.jobs`,
   * the same shape a plugin's own `ctx.jobs.enqueue` is -- and that
   * interface's `enqueue` is async, so there is no synchronous id to hand
   * back the moment this needs to actually create a row.
   */
  scheduleReconcile(clientId: number, runAt?: number): Promise<number>;
  /**
   * Sweeps every row a crash left `running`, then arms the dispatcher's
   * timer and safety interval so registered handlers run as their jobs
   * come due. Idempotent: a second call clears whatever the first armed
   * rather than leaking a second timer or interval alongside it. Returns
   * how many rows the sweep touched, ready or dead.
   */
  start(): number;
  /**
   * Clears the timer and the safety interval and returns — it does not
   * drain. A handler already in flight is abandoned deliberately: its row
   * stays `running`, and the next `start()` sweeps it.
   */
  stop(): void;
  /**
   * Resolves once nothing dispatched by `start()` is still running or waiting
   * for a slot.
   *
   * **A test affordance, and it must not be used for shutdown.** Waiting on
   * in-flight work is precisely the coupling this slice removes: `stop()`
   * abandons a handler and lets the next `start()` sweep its row. Production
   * has no caller (`main.ts` calls `stop()`, never this), and
   * `main.test.ts`'s shutdown test asserts that stays true.
   */
  idle(): Promise<void>;
}


/**
 * The host's own log channel -- a corrupt row, a feed lookup failure, an
 * unlink that failed for a reason other than the file already being gone,
 * and the host's own job-scanning code all surface through the same channel
 * a plugin's `ctx.log` would use.
 *
 * Module scope: it captures nothing from `createHost`, so declaring it
 * inside would rebuild the same closure on every call for no reason.
 */
function hostLog(message: string, detail?: Readonly<Record<string, unknown>>): void {
  console.log(`[${HOST_PLUGIN_ID}] ${message}`, detail ?? {});
}

export function createHost(deps: {
  raw: DatabaseSync;
  db: HostDb;
  // `QueuedFetch`, not the narrower `HostFetch` every plugin sees through
  // `PluginContext.fetch`: the feed reader built below needs `text`, and
  // wiring it to anything but this same queued instance's `text` method
  // would let a feed's fetches skip the per-hostname budget every other
  // call to that hostname is paced by.
  fetch: QueuedFetch;
  /**
   * Builds the download subsystem from **this host's** `secrets`, rather
   * than arriving already built beside it.
   *
   * A factory and not a `DownloadClients`, for a reason that is not style.
   * `createDownloadClients` closes over a `Secrets` of its own, and
   * `createReconcileHandler` below is handed one too. Taking both as
   * separate parameters would let a caller pass two different instances
   * with nothing here saying they must agree -- and two instances are two
   * memoization caches, so a `saveSecret` through one would leave the other
   * serving the old credential for the life of the process. That is exactly
   * the staleness design spec §3.5 exists to prevent, and it would show up
   * as an authentication failure against a service whose password had just
   * been fixed, with no failing test anywhere.
   *
   * Supplying the instance instead of accepting a built object closes that
   * by construction: there is one `Secrets` inside this host, this factory
   * receives it, and nothing inside this host has two to disagree about.
   *
   * **What is left, stated so the invariant is not read as stronger than it
   * is.** The boundary is not sealed: a caller can write `() => …` and
   * return a `DownloadClients` built over a second `createSecrets`. That is
   * a different failure from the one this shape removed, though -- it takes
   * a *visibly* zero-argument factory, because ignoring a named parameter
   * is `no-unused-vars`, which oxlint puts in `correctness` and the lint
   * gate therefore treats as an error. So the mistake has to be written on
   * purpose and is legible at the call site, where the old shape let two
   * parameters silently fail to agree. Five test files take that route
   * deliberately, each returning a double that resolves no credential.
   *
   * **The `Secrets` is deliberately not reachable through
   * `DownloadClients`.** That type is `PluginContext.downloads` -- the
   * object handed verbatim to every registered plugin by `ctxFor` below --
   * so a `secrets` member on it would give every plugin `get` over the
   * whole secret keyspace. Detecting a mismatch that way would cost more
   * than the mismatch does.
   */
  downloads: (secrets: Secrets) => DownloadClients;
  /**
   * The secrets subsystem: the one instance this host resolves every
   * credential through, handed to `createReconcileHandler` below and to
   * `downloads` above.
   *
   * Explicit rather than built here from `raw`: `createSecrets` needs the
   * secrets directory, which comes from the config file, and deciding it
   * here would put the chain's configuration in a second place. Required
   * rather than optional for the same reason a default `artworkDir` was
   * refused below -- a default would hide the wiring.
   */
  secrets: Secrets;
  now: () => number;
  /**
   * Where `MediaWriter` caches artwork bytes it measures on the way in.
   * Threaded explicitly rather than defaulted here: a default would hide
   * the wiring and could write artwork somewhere the caller never chose --
   * mirrors 1.x's `resolveArtworkDir`, whose default is `artwork/` next to
   * the database file, but that resolution belongs to whatever composes
   * `createHost` with a real database path, not to the host itself.
   */
  artworkDir: string;
  /**
   * Overrides the dispatcher's own timers. Absent means real ones — a test
   * that needs to advance the dispatcher deterministically (rather than
   * wait on real wall time) supplies the same kind of fake `Timers`
   * `dispatcher.test.ts` already builds for `createDispatcher` directly.
   */
  timers?: Timers;
  /**
   * Overrides the dispatcher's max jobs executing at once. Absent means
   * `DEFAULT_CONCURRENCY`. A test that steps a chain of jobs one at a time
   * — each enqueuing the next — sets this to `1` rather than relying on
   * the dispatcher being serial by nature, which it is not.
   */
  concurrency?: number;
}): Host {
  // Built once, from the one `Secrets` this host has, and shared by every
  // plugin context below. See `deps.downloads` for why it arrives as a
  // factory rather than already built.
  const downloads = deps.downloads(deps.secrets);

  // Plugins are wired explicitly via `register`, never discovered, so this
  // map is the host's whole notion of "who exists" — an id absent here is an
  // id nobody has registered, whether or not some `rss_feed` row names it.
  const plugins = new Map<string, MediaPlugin>();

  // Keyed by pluginId, then by kind, rather than by a composite string: two
  // plugins that both register kind "sync" get two independent inner maps,
  // so neither can overwrite the other's handler no matter what either one
  // is called.
  const handlers = new Map<string, Map<string, JobHandler>>();

  const runner: Runner = createRunner(deps.raw, {
    now: deps.now,
    defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
  });

  // The real dispatcher behind `start()`/`stop()`/`idle()`, meant to live
  // for as long as the host runs, driving every registered handler as its
  // jobs come due.
  // Built as two shapes, not one object literal with `concurrency` always
  // present: `exactOptionalPropertyTypes` is on, so an explicit
  // `concurrency: undefined` is not the same thing as the property being
  // absent, and `DispatcherOptions.concurrency` means the latter when it
  // wants `createDispatcher`'s own default.
  const dispatcherOpts = {
    now: deps.now,
    timers: deps.timers ?? nodeTimers,
    log: hostLog,
    sleep: realSleep,
    abortSignal: (ms: number) => AbortSignal.timeout(ms),
  };
  const dispatcher = deps.concurrency === undefined
    ? createDispatcher(deps.raw, dispatcherOpts)
    : createDispatcher(deps.raw, { ...dispatcherOpts, concurrency: deps.concurrency });

  // Whether `start()` has been called and not yet `stop()`ped. Gates
  // `dispatcher.rearm()` on every enqueue below: rearming is meaningless —
  // and, with real timers, actively harmful in a test that never calls
  // `start()` — before the dispatcher has anything armed to begin with.
  let started = false;

  // One instance shared by every plugin, because `MediaWriter` is
  // plugin-agnostic: ten of its eleven methods take no plugin id at all, and
  // the eleventh — `createMediaItem`, through `MediaItemInit.pluginId` —
  // stores the id it is handed without checking it against the plugin doing
  // the writing. So there is nothing per-plugin here to close over, and equally
  // nothing that stops `ctx.media.setResolution(anyRssItemId, …)` or
  // `ctx.media.dropMediaItem(anyId)` from reaching another plugin's rows.
  // What this writer holds is the shared-row invariants, in one place; what
  // keeps a plugin on its own side of them is convention and explicit
  // wiring, not enforcement.
  const artwork = createArtworkStore(deps.artworkDir, hostLog);
  const media = createMediaWriter(deps.db, deps.now, artwork);

  function ctxFor(pluginId: string): PluginContext {
    return {
      db: deps.raw,
      media,
      // A reader per plugin, unlike the one shared `media` above, and for the
      // opposite reason: every read it answers about a media item is filtered
      // by the plugin id it closes over, so a plugin never gets to name one.
      // Built here rather than hoisted out of `ctxFor` because the id is the
      // whole point -- one shared reader could only be scoped to nobody.
      read: createMediaReader(deps.raw, pluginId),
      // `Runner.enqueue` is sync and takes a `pluginId`; `JobQueue.enqueue` is
      // async and takes none. This adapter is the seam: it closes over the
      // plugin this context was built for, so that plugin can never name
      // another plugin's id when it enqueues its own work.
      jobs: {
        enqueue: async (job) => {
          const id = runner.enqueue(pluginId, job);
          // Only while the dispatcher is actually running: rearming is
          // what lets a job a plugin enqueues mid-flight be noticed before
          // the next safety-interval tick, but there is nothing to notice
          // it before `start()`, and nothing should — with real timers —
          // before a test ever calls it either.
          if (started) dispatcher.rearm();
          return id;
        },
      },
      fetch: deps.fetch,
      downloads,
      log: (message, detail) => {
        console.log(`[${pluginId}] ${message}`, detail ?? {});
      },
    };
  }

  // A named function, not only an inline method on the returned object:
  // `reconcileHandler` below (built by `createReconcileHandler`) needs this
  // exact dispatch for its own `deliver` dependency, and closing over a
  // second copy of it would let the two drift apart from a single edit
  // landing in only one -- the same reasoning `notifyNewRssItems`, just
  // below, is already hoisted for.
  async function deliverToPlugin(pluginId: string, file: DownloadedFile): Promise<void> {
    const plugin = plugins.get(pluginId);
    if (!plugin) {
      throw new PluginNotRegisteredError(pluginId);
    }
    await plugin.onDownloadedFile(file, ctxFor(plugin.id));
  }

  // A named function, not an inline method on the returned object: the feed
  // reader built below needs the very same dispatch this host promises
  // through `Host.notifyNewRssItems`, and closing over a second copy of it
  // would let the two drift apart from a single edit landing in only one.
  async function notifyNewRssItems(ids: readonly number[]): Promise<NotifyOutcome> {
    const grouped = new Map<string, { plugin: MediaPlugin; ids: number[] }>();
    // Ids whose feed names no plugin at all, or names one this host never
    // registered. Collected rather than dropped: a batch that silently lost
    // an item would look identical to one that never had it.
    const unowned: number[] = [];

    for (const id of ids) {
      const pluginId = ownerPluginId(deps.raw, id);
      const plugin = pluginId !== undefined ? plugins.get(pluginId) : undefined;
      if (pluginId === undefined || !plugin) {
        unowned.push(id);
        continue;
      }
      const entry = grouped.get(pluginId);
      if (entry) {
        entry.ids.push(id);
      } else {
        grouped.set(pluginId, { plugin, ids: [id] });
      }
    }

    // Each plugin sees its own whole batch in one call, not one call per
    // item: an item's position in the caller's array is not something a
    // plugin should have to reassemble from repeated single-item calls.
    // `allSettled`, not `all`: a rejecting plugin must not stop the others
    // from running, and must not stop this function from ever reading
    // their outcomes — `all` would reject on the first failure and drop
    // every later plugin's result on the floor.
    const groups = Array.from(grouped.values());
    const settled = await Promise.allSettled(
      groups.map(({ plugin, ids: ownIds }) => plugin.onNewRssItems(ownIds, ctxFor(plugin.id))),
    );

    const failures: { pluginId: string; error: unknown }[] = [];
    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i];
      const group = groups[i];
      if (outcome === undefined || group === undefined) continue;
      if (outcome.status === 'rejected') {
        failures.push({ pluginId: group.plugin.id, error: outcome.reason });
      }
    }

    // `unowned` and `failures` are reported together, in the same
    // returned value, rather than one hiding behind the other: a plugin
    // erroring on its own items must not suppress the unrelated report
    // that some other id had no owner at all, and vice versa.
    return { unowned, failures };
  }

  // The host's own feed reader. `fetchText` is this same `deps.fetch`
  // instance's `text` method, never a bare function wired around it — that
  // is what keeps a feed's fetch inside the per-hostname queue every
  // `json`/`bytes` call to that host already shares.
  const reader = createFeedReader({
    raw: deps.raw,
    fetchText: (url) => deps.fetch.text(url),
    notify: notifyNewRssItems,
    now: deps.now,
    log: hostLog,
  });

  // The handler runs last: rescheduling only after `pollFeed` has resolved,
  // so a poll that throws is retried through the runner's own backoff
  // instead of silently skipping to the next cycle. The feed row is read
  // BEFORE polling, not after: `pollFeed` throws on an unknown feed id, so
  // reading afterward would let a deleted feed's poll throw first, never
  // reach the "stop rescheduling" check, and retry to exhaustion instead of
  // ending the cycle cleanly.
  //
  // The reschedule goes through `enqueuePollUnlessPending`, the same guarded
  // path `schedulePoll` uses, rather than calling `runner.enqueue` directly.
  // A bare enqueue is not idempotent, and this handler can legitimately run
  // twice: the enqueue and the runner's `state = 'done'` write are separate
  // autocommit statements, so a process death between them leaves this job
  // `running`, the next `start()`'s crash sweep readies it, and the re-run
  // would enqueue a SECOND self-perpetuating cycle -- doubling that feed's
  // poll rate permanently.
  // `job.id` is excluded from the guard's scan because this job is itself
  // `running` while its own handler executes; without that exclusion the
  // guard would find it, decline to schedule anything, and silence the feed.
  const pollHandler: JobHandler = async (job) => {
    const { feedId } = readPollPayload(job.payload);
    const row = deps.raw.prepare('SELECT poll_interval_s FROM rss_feed WHERE id = ?').get(feedId);
    if (row === undefined) return; // the feed was deleted; end its poll cycle rather than dead-letter on a row that is gone
    await reader.pollFeed(feedId);
    const seconds = Number((row as { poll_interval_s: unknown }).poll_interval_s);
    enqueuePollUnlessPending(feedId, deps.now() + seconds * 1000, job.id);
  };

  // `reconcile-job.ts`'s own factory, built once here and registered the
  // same way `pollHandler` is: one job kind, one handler, under this host's
  // own reserved plugin id. `deliverToPlugin` above is exactly the
  // `deliver` dependency `createReconcileHandler` asks for -- the same
  // function `Host.deliverToPlugin` exposes to a caller outside this
  // module, reused rather than re-implemented so a plugin lookup edit here
  // reaches both.
  const reconcileHandler: JobHandler = createReconcileHandler({
    raw: deps.raw,
    fetch: deps.fetch,
    secrets: deps.secrets,
    now: deps.now,
    log: hostLog,
    deliver: deliverToPlugin,
  });

  handlers.set(HOST_PLUGIN_ID, new Map([['poll', pollHandler], ['reconcile', reconcileHandler]]));

  /**
   * The single place a `poll` job is created: returns the pending job's id if
   * this feed already has one, and otherwise enqueues. Both callers --
   * `schedulePoll` on the way in and `pollHandler`'s own reschedule -- go
   * through here, so neither can create a duplicate cycle the other would
   * then honour forever.
   *
   * The pending check itself is `jobs/pending.ts`'s `pendingJobId`, shared
   * with `reconcile-job.ts`'s own reconcile cycle -- see that module's doc
   * comment for why the scan is single-sourced rather than copied.
   */
  function enqueuePollUnlessPending(feedId: number, runAt: number | undefined, exceptJobId: number | undefined): number {
    const existing = pendingJobId(deps.raw, HOST_PLUGIN_ID, 'poll', 'feedId', feedId, exceptJobId, hostLog);
    if (existing !== undefined) return existing;
    // Built as two shapes, not one object literal with `runAt` always
    // present: `runAt` is `number | undefined` here, but `JobEnqueue.runAt`
    // is an optional `number` with `exactOptionalPropertyTypes` on, so an
    // explicit `undefined` is not the same thing as the property being
    // absent.
    const id = runAt === undefined
      ? runner.enqueue(HOST_PLUGIN_ID, { kind: 'poll', payload: { feedId } })
      : runner.enqueue(HOST_PLUGIN_ID, { kind: 'poll', payload: { feedId }, runAt });
    // Same reasoning as `ctxFor`'s own `jobs.enqueue`: only worth doing,
    // and only safe to do with real timers, once `start()` has actually run.
    if (started) dispatcher.rearm();
    return id;
  }

  // A named `const`, not a bare `return { ... }`, for exactly one reason:
  // `addFeed` below needs to call this same object's own `schedulePoll` --
  // the identical call `main.ts` makes at boot for a feed already on file --
  // and a method can only reach the object it is a property of by naming a
  // variable bound to it. Every method here still closes over `deps` and the
  // functions above the same way it would inside a bare object literal;
  // `host` is referenced nowhere until after this literal has finished
  // evaluating, since nothing calls a `Host` method during its own
  // construction.
  const host: Host = {
    register(plugin) {
      // Otherwise a plugin silently captures the host's own handlers: both
      // would sit under the same `plugin_id` in `handlers`, and whichever
      // registered second would win.
      if (plugin.id === HOST_PLUGIN_ID) {
        throw new Error(`plugin id "${HOST_PLUGIN_ID}" is reserved for the host`);
      }
      if (plugins.has(plugin.id)) {
        throw new Error(`plugin "${plugin.id}" is already registered`);
      }
      migratePlugin(deps.raw, plugin.id, plugin.migrations);
      // After the migration, not before: the tables it just created are what
      // these triggers attach to.
      //
      // **Validated here, immediately before installation, rather than only
      // by whatever later builds a `SyncRegistry`.** `register` is callable
      // -- and is called, by every real boot -- with no registry ever built
      // at all, so a check that lived only in `createSyncRegistry` would let
      // an unprefixed or wrongly-keyed table's triggers install here
      // regardless: `syncTriggerSql` (`sync/log.ts`) interpolates the table
      // name into DDL it says plainly it trusts the caller for, and SQLite
      // does not validate a trigger body's column references at `CREATE`
      // time, so a table keyed by anything but a lone `id` would install
      // cleanly and only throw the first time a row actually changes.
      // `assertSyncable` (`sync/registry.ts`) is the one place both this and
      // `createSyncRegistry` run that check, so the two callers cannot drift
      // apart on what "syncable" means.
      for (const table of plugin.synced) assertSyncable(deps.raw, plugin.id, table.table);
      // Idempotent (`DROP TRIGGER IF EXISTS` -- `sync/log.ts`), so a plugin
      // registered on every boot reinstalls its triggers rather than failing
      // the second time.
      const syncedTables = plugin.synced.map((table) => table.table);
      installSyncTriggers(deps.raw, syncedTables);
      // And, once, one log entry per row those tables already hold. The
      // triggers just installed only log a row that changes *after* they
      // exist, so every row `migratePlugin` above wrote -- a migration that
      // creates a table and fills it from an older one does exactly that --
      // would be indexed nowhere, and a client cursor that walks the log as
      // an index of which rows exist would never serve it. `migration15`
      // (`db/migrate.ts`) does the same for the host's own six tables, where
      // the migration runner's version record is the guard; a plugin's
      // declared table list has no version space, so the guard is a recorded
      // marker per table. **Not unguarded**: this runs on every boot, and a
      // reseed re-logs every row at a fresh id, which every client reads as
      // "all of this changed". `seedSyncLogOnce` has both halves of why.
      seedSyncLogOnce(deps.raw, syncedTables, deps.now());
      plugins.set(plugin.id, plugin);
      handlers.set(plugin.id, new Map(Object.entries(plugin.jobs)));
    },

    notifyNewRssItems,

    schedulePoll(feedId, runAt) {
      // No `exceptJobId`: an outside caller is not a poll job, so every
      // pending row it finds is a real reason not to schedule a second.
      return enqueuePollUnlessPending(feedId, runAt, undefined);
    },

    scheduleReconcile(clientId, runAt) {
      // `ctxFor(HOST_PLUGIN_ID).jobs` is exactly the `JobQueue`
      // `scheduleReconcile` asks for: the same `enqueue` a plugin's own
      // `ctx.jobs.enqueue` is, scoped to this host's own reserved id, and
      // already wired to rearm the dispatcher on every enqueue. No
      // `exceptJobId`, for the same reason `schedulePoll` passes none: an
      // outside caller is not itself a reconcile job.
      return scheduleReconcileJob(deps.raw, ctxFor(HOST_PLUGIN_ID).jobs, clientId, runAt, undefined, hostLog);
    },

    async requestDownload(rssItemId) {
      const pluginId = ownerPluginId(deps.raw, rssItemId);
      if (pluginId === undefined) {
        // Two conditions used to share one thrown sentence here ("belongs
        // to a feed whose plugin is not registered"), because nothing
        // downstream had to tell them apart. `requestPick` does: an id
        // naming no row is `unknown-release` and a row whose plugin is
        // absent is `plugin-not-registered`, and those are two different
        // things to put in front of an operator. `ownerPluginId` joins
        // `rss_item` to `rss_feed`, so `undefined` means one of the two
        // rows is missing -- and `rss_item.feed_id` is a foreign key under
        // `PRAGMA foreign_keys = ON` (`db/open.ts`), so the feed cannot be
        // the missing one and this is the item.
        throw new UnknownRssItemError(rssItemId);
      }
      const plugin = plugins.get(pluginId);
      if (!plugin) {
        throw new PluginNotRegisteredError(pluginId);
      }
      await plugin.onDownloadRequest(rssItemId, ctxFor(plugin.id));
    },

    async requestPick(rssItemId) {
      // Through `host.requestDownload`, the public method, and not through
      // the closure above it -- the same routing `addFeed` uses for
      // `schedulePoll`, and for the same reason: a pick must take the exact
      // path every other caller of `requestDownload` takes, rather than a
      // second, parallel one that could drift from it.
      return requestPickRule({ requestDownload: (id) => host.requestDownload(id) }, rssItemId);
    },

    deliverToPlugin,

    async addFeed(input) {
      const result = addFeedRule(
        { raw: deps.raw, now: deps.now, isRegistered: (pluginId) => plugins.has(pluginId) },
        input,
      );
      if ('refusal' in result) return result;
      // Through the public method, not `enqueuePollUnlessPending` directly:
      // this is the exact call `main.ts` makes at boot for every feed
      // already on file, so a freshly added feed is polled the same way a
      // restart would have polled it, rather than by a second, parallel path
      // that could drift from that one.
      host.schedulePoll(result.id);
      return result;
    },

    async addDownloadClient(input) {
      const result = addDownloadClientRule(
        {
          raw: deps.raw,
          now: deps.now,
          // The one method of `Secrets` the rule may have: handing it the
          // whole instance would give it `get` as well, and a writer that
          // cannot resolve a credential is a writer that cannot leak one.
          saveSecret: (name, value) => { deps.secrets.saveSecret(name, value); },
        },
        input,
      );
      if ('refusal' in result) return result;
      // Through the public method, not `scheduleReconcileJob` directly, for
      // the reason `addFeed` gives about `schedulePoll`: this is the exact
      // call `main.ts` makes at boot for every client already on file, so a
      // freshly added client is reconciled the same way a restart would
      // have reconciled it rather than by a second, parallel path.
      await host.scheduleReconcile(result.id);
      return result;
    },

    // The three mapping writes, each a straight delegation with nothing
    // scheduled afterwards -- see `Host.addMapping`'s own doc for why there
    // is no `schedulePoll`/`scheduleReconcile` twin here.
    //
    // `async` with no `await` inside, like `addFeed` above: `node:sqlite` is
    // synchronous, so the rules are, and the `Promise` is the interface's
    // rather than the implementation's.
    async addMapping(input) {
      return addMappingRule({ raw: deps.raw, now: deps.now }, input);
    },

    async editMapping(id, input) {
      return editMappingRule({ raw: deps.raw, now: deps.now }, id, input);
    },

    async removeMapping(id) {
      // No `now`, because a delete writes no column. See `removeMapping`.
      return removeMappingRule({ raw: deps.raw }, id);
    },

    start() {
      started = true;
      return dispatcher.start(
        (pluginId, kind) => handlers.get(pluginId)?.get(kind),
        (pluginId) => ctxFor(pluginId),
      );
    },

    stop() {
      started = false;
      dispatcher.stop();
    },

    idle() {
      return dispatcher.idle();
    },
  };

  return host;
}
