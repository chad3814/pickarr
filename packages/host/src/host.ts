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
import type { QueuedFetch } from './fetch/queue.ts';
import { pendingJobId, readPayloadNumber } from './jobs/pending.ts';
import { createReconcileHandler, scheduleReconcile as scheduleReconcileJob } from './clients/reconcile-job.ts';
import type { Secrets } from './secrets/instance.ts';
import { HOST_PLUGIN_ID } from './host-id.ts';
import { PluginNotRegisteredError } from './errors.ts';
import { ownerPluginId } from './db/owner.ts';

export { HOST_PLUGIN_ID };
export { PluginNotRegisteredError };
export { ownerPluginId };

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
  requestDownload(rssItemId: number): Promise<void>;
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
   * receives it, and nothing here has two to disagree about.
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

  return {
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
      const plugin = pluginId !== undefined ? plugins.get(pluginId) : undefined;
      if (pluginId === undefined || !plugin) {
        throw new Error(`rss item id ${rssItemId} belongs to a feed whose plugin is not registered`);
      }
      await plugin.onDownloadRequest(rssItemId, ctxFor(plugin.id));
    },

    deliverToPlugin,

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
}
