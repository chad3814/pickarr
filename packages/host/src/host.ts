import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, JobHandler, MediaPlugin, PluginContext } from '@pickarr/contract';
import { createArtworkStore } from './artwork/store.ts';
import type { HostDb } from './db/open.ts';
import { migratePlugin } from './db/migrate.ts';
import { createMediaWriter } from './media/writer.ts';
import { createRunner } from './jobs/runner.ts';
import type { Runner } from './jobs/runner.ts';
import { createDispatcher } from './jobs/dispatcher.ts';
import { backoffMs } from './jobs/backoff.ts';
import type { Timers } from './jobs/dispatcher.ts';
import { createFeedReader } from './feeds/reader.ts';
import type { QueuedFetch } from './fetch/queue.ts';

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

/** A real sleep, for `run-job.ts`'s abort-grace wait, mirroring `main.ts`'s own `defaultSleep` -- duplicated rather than imported since `main.ts` sits above this module. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * `Runner.runOnce()`'s default `backoffMs`, the same exponential-capped
 * curve `dispatcher.ts`'s crash sweep and `run-job.ts`'s own retry use --
 * one curve, `packages/host/src/jobs/backoff.ts`, re-exported under this
 * name since it predates that extraction. Not an override knob: `backoffMs`
 * is a pure function of `attempts`, so a test controls retry timing through
 * the `now` this host is built with, not by tuning this curve.
 */
export const DEFAULT_BACKOFF_MS = backoffMs;

/** How many times a job may fail before it dead-letters. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * The host's own plugin id. `jobs.plugin_id` is `NOT NULL` and handlers are
 * keyed by `(pluginId, kind)`, so a job the host itself owns still needs a
 * plugin id to dispatch on — this is the one no plugin may claim. `register`
 * refuses it outright, so a plugin can never silently capture the host's own
 * handlers. It declares no tables, so `migratePlugin`'s `<pluginId>_` prefix
 * rule never applies to it — nothing ever calls `migratePlugin` with this id.
 */
export const HOST_PLUGIN_ID = 'host';

/** Narrows a `poll` job's `unknown` payload rather than casting it, so a malformed row fails loudly instead of coercing silently. */
function readPollPayload(payload: unknown): { feedId: number } {
  const feedId = tryReadPollFeedId(payload);
  if (feedId === undefined) {
    throw new Error(`poll job payload is not shaped like { feedId: number }: ${JSON.stringify(payload)}`);
  }
  return { feedId };
}

/**
 * The non-throwing twin of `readPollPayload`, for a scan over rows that are
 * not the one being run. `readPollPayload` throwing is right inside the
 * handler, where the payload IS the job under execution and a bad one
 * should fail loudly and dead-letter. It is wrong here: a scan that throws
 * on the first unparseable row it meets would let one corrupt job poison
 * every other feed's scheduling, including feeds with nothing wrong at all.
 * Returns `undefined` for anything not shaped like `{ feedId: number }`,
 * rather than coercing it into one.
 */
function tryReadPollFeedId(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const feedId = (payload as { feedId: unknown }).feedId;
  return typeof feedId === 'number' ? feedId : undefined;
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
   * TEST ADAPTER, deleted in the task that removes the last caller. Claims
   * and runs at most one due job — see `Runner.runOnce`'s own doc for why
   * this is not simply `Host.start()` called once — so the 64 existing
   * call sites keep working while they are migrated file by file.
   * Production must call `start()`; a pump loop calling this would rebuild
   * the coupling the dispatcher exists to remove.
   */
  runOnce(): Promise<boolean>;
  recover(): number;
  /** Enqueues the first `poll` job for a feed. Idempotent per feed. */
  schedulePoll(feedId: number, runAt?: number): number;
  /**
   * Sweeps every row a crash left `running`, then arms the dispatcher's
   * timer and safety interval so registered handlers run as their jobs
   * come due. Idempotent: a second call clears whatever the first armed
   * rather than leaking a second timer or interval alongside it. Returns
   * how many rows the sweep touched, ready or dead — the same count
   * `recover()` returns today.
   */
  start(): number;
  /**
   * Clears the timer and the safety interval and returns — it does not
   * drain. A handler already in flight is abandoned deliberately: its row
   * stays `running`, and the next `start()` sweeps it.
   */
  stop(): void;
  /** Resolves once nothing dispatched by `start()` is still running or waiting for a slot. */
  idle(): Promise<void>;
}

/** The `rss_feed` row an rss item belongs to names its owning plugin directly. */
function ownerPluginId(raw: DatabaseSync, rssItemId: number): string | undefined {
  const row = raw.prepare(`
    SELECT rss_feed.plugin_id AS plugin_id
      FROM rss_item JOIN rss_feed ON rss_feed.id = rss_item.feed_id
     WHERE rss_item.id = ?
  `).get(rssItemId);
  if (!row) return undefined;
  return String((row as { plugin_id: unknown }).plugin_id);
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
  downloads: DownloadClients;
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
    backoffMs: DEFAULT_BACKOFF_MS,
    defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
  });

  // Shared by the feed reader, the host's own job-scanning code below, and
  // the artwork store created next -- a corrupt row, a feed lookup failure
  // and an unlink that failed for a reason other than the file already
  // being gone all surface through the same channel a plugin's own
  // `ctx.log` would use.
  function hostLog(message: string, detail?: Readonly<Record<string, unknown>>): void {
    console.log(`[${HOST_PLUGIN_ID}] ${message}`, detail ?? {});
  }

  // The real dispatcher behind `start()`/`stop()`/`idle()` — a separate
  // instance from the one `runner`'s own `runOnce()` builds fresh per call
  // (see `runner.ts`): that one is scoped to claiming a single job and is
  // discarded immediately after, while this one is meant to live for as
  // long as the host runs, driving every registered handler as its jobs
  // come due.
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
      downloads: deps.downloads,
      log: (message, detail) => {
        console.log(`[${pluginId}] ${message}`, detail ?? {});
      },
    };
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
  // `running`, `recover` readies it, and the re-run would enqueue a SECOND
  // self-perpetuating cycle -- doubling that feed's poll rate permanently.
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
  handlers.set(HOST_PLUGIN_ID, new Map([['poll', pollHandler]]));

  /**
   * The id of a `poll` job already `ready` or `running` for this feed, so no
   * caller ever starts a second concurrent cycle. Uses `tryReadPollFeedId`,
   * not `readPollPayload`: this scans every OTHER pending poll job looking
   * for a match, and one unrelated row with a payload nothing understands is
   * not a reason to fail the whole scan -- it is simply not the feed being
   * looked for. Still logged, though: a payload nothing here can read means
   * something wrote a row this host never would have.
   *
   * `exceptJobId` is for the one caller that is itself a running poll job for
   * this feed and must not count as its own reason not to reschedule.
   */
  function pendingPollJobId(feedId: number, exceptJobId?: number): number | undefined {
    const rows = deps.raw.prepare(`
      SELECT id, payload_json FROM jobs WHERE plugin_id = ? AND kind = 'poll' AND state IN ('ready', 'running')
    `).all(HOST_PLUGIN_ID);
    for (const row of rows) {
      const id = Number((row as { id: unknown }).id);
      if (id === exceptJobId) continue;
      const payloadJson = String((row as { payload_json: unknown }).payload_json);
      const payload: unknown = JSON.parse(payloadJson);
      const otherFeedId = tryReadPollFeedId(payload);
      if (otherFeedId === undefined) {
        hostLog('poll job payload is not shaped like { feedId: number }, skipping it', { jobId: id, payload: payloadJson });
        continue;
      }
      if (otherFeedId === feedId) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * The single place a `poll` job is created: returns the pending job's id if
   * this feed already has one, and otherwise enqueues. Both callers --
   * `schedulePoll` on the way in and `pollHandler`'s own reschedule -- go
   * through here, so neither can create a duplicate cycle the other would
   * then honour forever.
   */
  function enqueuePollUnlessPending(feedId: number, runAt: number | undefined, exceptJobId: number | undefined): number {
    const existing = pendingPollJobId(feedId, exceptJobId);
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

    async requestDownload(rssItemId) {
      const pluginId = ownerPluginId(deps.raw, rssItemId);
      const plugin = pluginId !== undefined ? plugins.get(pluginId) : undefined;
      if (pluginId === undefined || !plugin) {
        throw new Error(`rss item id ${rssItemId} belongs to a feed whose plugin is not registered`);
      }
      await plugin.onDownloadRequest(rssItemId, ctxFor(plugin.id));
    },

    runOnce() {
      return runner.runOnce(
        (pluginId, kind) => handlers.get(pluginId)?.get(kind),
        (pluginId) => ctxFor(pluginId),
      );
    },

    recover() {
      return runner.recover();
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
}
