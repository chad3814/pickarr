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

  async function reconcileNow(): Promise<void> {
    await reconcileMutex.run(async () => {
      for (const clientId of deps.clientIds) {
        try {
          const result = await deps.reconcile(clientId);
          untracked.set(clientId, result.untracked);
        } catch (error) {
          deps.log(`reconcile ${clientId} failed: ${(error as Error).message}`);
        }
      }
    });
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

      const reconcileTimer = setInterval(() => {
        void reconcileNow();
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
