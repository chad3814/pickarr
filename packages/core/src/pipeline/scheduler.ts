import type { DatabaseSync } from 'node:sqlite';
import type { FeedConfig } from '../config/schema.ts';
import type { IngestResult } from '../ingest/ingest.ts';
import type { ReconcileResult, UntrackedEntry } from './reconcile.ts';
import { createMutex } from './mutex.ts';

export const RECONCILE_INTERVAL_MS = 10_000;

export interface SchedulerDeps {
  db: DatabaseSync;
  feeds: FeedConfig[];
  clientIds: string[];
  ingestFeed(feed: FeedConfig): Promise<IngestResult>;
  reconcile(clientId: string): Promise<ReconcileResult>;
  log(message: string): void;
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
  const untracked = new Map<string, UntrackedEntry[]>();
  const timers: NodeJS.Timeout[] = [];

  async function ingestOne(feed: FeedConfig): Promise<IngestResult> {
    return ingestMutex.run(() => deps.ingestFeed(feed));
  }

  async function ingestAllNow(): Promise<void> {
    for (const feed of deps.feeds) {
      try {
        const result = await ingestOne(feed);
        deps.log(
          `ingest ${feed.id}: ${result.inserted} new, ${result.groupsCreated} groups, ` +
            `${result.upgradesFlagged} upgrades, ${result.parseErrors} parse errors`,
        );
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
          void ingestOne(feed).catch((error: Error) =>
            deps.log(`ingest ${feed.id} failed: ${error.message}`),
          );
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
