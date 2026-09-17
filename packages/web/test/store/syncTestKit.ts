/**
 * Test doubles for driving `createStore` by hand -- the scheduler, the
 * lease, and a routed `fetch` stub -- shared by every test that boots a real
 * store through `Shell`/`App` rather than exercising `sync.ts` directly.
 *
 * Started as three private copies (`store/store.test.ts`'s own, and two more
 * added by task 6's fix round for `Shell.test.tsx` and `App.test.tsx`) before
 * being pulled out here: the second copy was tolerable, the third was the
 * signal that this had stopped being one test file's private fixture.
 * `store/store.test.ts` keeps its own copy rather than importing this one --
 * it predates this file and its version does not need `hasPending` -- but
 * anything new that needs to drive a store by hand should reach for this
 * module first.
 */
import type { Lease, Schedule, SyncFetch, SyncLoop, SyncResponse } from '../../src/store/sync.ts';

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A real timer, not fake ones -- fake timers hang this suite (`CLAUDE.md`). */
export function settle(): Promise<void> {
  return delay(15);
}

interface ScheduledTask {
  loop: SyncLoop;
  run: () => void;
  ran: boolean;
  cancelled: boolean;
}

export interface ManualScheduler {
  schedule: Schedule;
  drive(loop: SyncLoop): Promise<void>;
  /** Whether `loop` currently has a task that was scheduled and neither driven nor cancelled -- a test's way to wait for one to exist before it acts, and to check it stopped existing afterwards, without running it. */
  hasPending(loop: SyncLoop): boolean;
}

/** The scheduler seam `sync.ts` was built to take, driven by hand. */
export function manualScheduler(): ManualScheduler {
  const tasks: ScheduledTask[] = [];
  const schedule: Schedule = (loop, _delayMs, run) => {
    const task: ScheduledTask = { loop, run, ran: false, cancelled: false };
    tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };
  function pendingTask(loop: SyncLoop): ScheduledTask | undefined {
    return tasks.find((t) => t.loop === loop && !t.ran && !t.cancelled);
  }
  return {
    schedule,
    async drive(loop: SyncLoop): Promise<void> {
      const task = pendingTask(loop);
      if (task === undefined) throw new Error(`no pending ${loop} task to drive`);
      task.ran = true;
      task.run();
      await settle();
    },
    hasPending(loop: SyncLoop): boolean {
      return pendingTask(loop) !== undefined;
    },
  };
}

function ok(body: unknown): SyncResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

export interface StubFetch {
  fetch: SyncFetch;
  urls: string[];
}

/** Routes by exact url, and fails loudly on anything unrouted rather than answering a default that would hide a wrong request. */
export function stubSyncFetch(table: Readonly<Record<string, unknown>>): StubFetch {
  const urls: string[] = [];
  return {
    urls,
    fetch: (url: string): Promise<SyncResponse> => {
      urls.push(url);
      if (!Object.hasOwn(table, url)) throw new Error(`unrouted sync request: ${url}`);
      return Promise.resolve(ok(table[url]));
    },
  };
}

/** Granted the moment it is asked for, whose release never settles -- `store/leader.ts`'s production behaviour. */
export function grantedLease(): Lease {
  return {
    hold(onGranted): void {
      onGranted(
        new Promise<void>(() => {
          // Never settles: a browser tears the lock down with the tab.
        }),
      );
    },
  };
}

let dbCounter = 0;
/** A database name no other caller in this process shares. */
export function freshDbName(prefix: string): string {
  dbCounter += 1;
  return `${prefix}-${String(dbCounter)}`;
}
