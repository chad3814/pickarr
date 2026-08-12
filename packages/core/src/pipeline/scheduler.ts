import type { DatabaseSync } from 'node:sqlite';
import type { FeedConfig } from '../config/schema.ts';
import type { IngestResult } from '../ingest/ingest.ts';
import type { ReconcileResult, UntrackedEntry } from './reconcile.ts';
import { createMutex } from './mutex.ts';

export const RECONCILE_INTERVAL_MS = 10_000;

/**
 * Used only when `runMetadata` is supplied without `metadataIntervalMs` —
 * matches `metadataSchema`'s own default in config/schema.ts, since main.ts
 * always derives one from config when metadata is actually enabled.
 */
export const DEFAULT_METADATA_INTERVAL_MS = 5_000;

export interface SchedulerDeps {
  db: DatabaseSync;
  feeds: FeedConfig[];
  clientIds: string[];
  ingestFeed(feed: FeedConfig): Promise<IngestResult>;
  reconcile(clientId: string): Promise<ReconcileResult>;
  log(message: string): void;
  /**
   * Runs one metadata pass. Absent when metadata is disabled or has no
   * client configured — main.ts decides that once at startup, not here, so
   * this scheduler only has to ask "is there a runner" rather than re-derive
   * why there might not be one.
   */
  runMetadata?: () => Promise<void>;
  metadataIntervalMs?: number;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  ingestAllNow(): Promise<void>;
  ingestNow(feedId: string): Promise<IngestResult>;
  reconcileNow(): Promise<void>;
  untrackedFor(clientId: string): UntrackedEntry[];
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const ingestMutex = createMutex();
  const reconcileMutex = createMutex();
  const metadataMutex = createMutex();
  const untracked = new Map<string, UntrackedEntry[]>();
  const timers: NodeJS.Timeout[] = [];

  async function ingestOne(feed: FeedConfig): Promise<IngestResult> {
    return ingestMutex.run(() => deps.ingestFeed(feed));
  }

  /**
   * The count alone (`parseErrors`) says a feed has names the parser cannot
   * handle; it never says which ones, so there was nothing to act on. Each
   * failure in `result.parseFailures` is logged on its own line — bounded by
   * `MAX_REPORTED_PARSE_FAILURES` inside `ingestEntries` itself, so a feed
   * that suddenly fails to parse at all cannot flood the log — with the
   * suppressed count logged too when the cap was hit, so a truncated report
   * still says how much was left out.
   */
  function logIngestResult(feed: FeedConfig, result: IngestResult): void {
    deps.log(
      `ingest ${feed.id}: ${result.inserted} new, ${result.groupsCreated} groups, ` +
        `${result.upgradesFlagged} upgrades, ${result.parseErrors} parse errors`,
    );
    for (const failure of result.parseFailures) {
      deps.log(`ingest ${feed.id}: parse_error (${failure.reason}): ${failure.title}`);
    }
    if (result.parseFailuresSuppressed > 0) {
      deps.log(
        `ingest ${feed.id}: ${result.parseFailuresSuppressed} additional parse failures ` +
          'suppressed this tick',
      );
    }
  }

  async function ingestAllNow(): Promise<void> {
    for (const feed of deps.feeds) {
      try {
        const result = await ingestOne(feed);
        logIngestResult(feed, result);
      } catch (error) {
        // One bad feed must never stop the others.
        deps.log(`ingest ${feed.id} failed: ${(error as Error).message}`);
      }
    }
  }

  async function reconcilePass(): Promise<void> {
    for (const clientId of deps.clientIds) {
      try {
        const result = await deps.reconcile(clientId);
        untracked.set(clientId, result.untracked);
      } catch (error) {
        deps.log(`reconcile ${clientId} failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * The explicit, caller-initiated pass — the one at boot, and anything else
   * that asks for a reconcile by name. `run`, not `tryRun`: a caller that
   * awaits this is entitled to have it actually happen, so it queues rather
   * than being dropped.
   */
  async function reconcileNow(): Promise<void> {
    await reconcileMutex.run(reconcilePass);
  }

  return {
    start() {
      for (const feed of deps.feeds) {
        const timer = setInterval(() => {
          void ingestOne(feed)
            .then((result) => logIngestResult(feed, result))
            .catch((error: Error) => deps.log(`ingest ${feed.id} failed: ${error.message}`));
        }, feed.intervalSeconds * 1000);
        timer.unref();
        timers.push(timer);
      }

      // `tryRun`, not `run`: a timer tick is a *sample*, not a work item. The
      // imports a tick performs run inside it and can take minutes, while this
      // timer keeps firing every ten seconds throughout — with a queueing
      // acquisition, a five-minute import leaves roughly thirty ticks stacked
      // up to run back-to-back the moment it finishes, each issuing its own
      // pair of requests to the download client, and every one of them
      // observing a state the first of them already handled. A tick that finds
      // the mutex busy has nothing to contribute that the next tick will not,
      // so it is dropped. `reconcileNow` above keeps `run` precisely because
      // the opposite is true of an explicit call.
      const reconcileTimer = setInterval(() => {
        void reconcileMutex.tryRun(reconcilePass);
      }, RECONCILE_INTERVAL_MS);
      reconcileTimer.unref();
      timers.push(reconcileTimer);

      // No `runMetadata` means metadata is disabled or has no client —
      // main.ts already decided that once at startup, so there is nothing
      // for a timer to do here; registering one anyway would just tick
      // forever calling nothing.
      const runMetadata = deps.runMetadata;
      if (runMetadata !== undefined) {
        // `tryRun`, for exactly the reason the reconcile timer above is:
        // a metadata tick is a sample, not a work item, and has nothing to
        // contribute over a busy pass that the next tick won't.
        //
        // `.catch()`, like the ingest timer above and unlike the reconcile
        // timer: `reconcilePass` already swallows every per-client failure
        // internally, so it never rejects, but `runMetadata` can — its own
        // per-row work is guarded by `deferOrGiveUp` inside `runMetadataPass`,
        // yet the query that finds the due rows in the first place is not.
        // An uncaught rejection here would be an unhandled rejection on the
        // process, which crashes it by default; a transient database fault
        // must cost one skipped tick, not the whole container.
        const metadataTimer = setInterval(() => {
          void metadataMutex
            .tryRun(runMetadata)
            .catch((error: Error) => deps.log(`metadata pass failed: ${error.message}`));
        }, deps.metadataIntervalMs ?? DEFAULT_METADATA_INTERVAL_MS);
        metadataTimer.unref();
        timers.push(metadataTimer);
      }
    },

    stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },

    ingestAllNow,
    ingestNow(feedId) {
      const feed = deps.feeds.find((candidate) => candidate.id === feedId);
      if (feed === undefined) throw new Error(`No such feed: ${feedId}`);
      return ingestOne(feed);
    },
    reconcileNow,
    untrackedFor: (clientId) => untracked.get(clientId) ?? [],
  };
}
