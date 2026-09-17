/**
 * Test doubles for driving `createStore` by hand -- the scheduler, the
 * lease, and a routed `fetch` stub -- shared by every test that boots a real
 * store through `Shell`/`App` rather than exercising `sync.ts` directly.
 *
 * Started as three private copies (`store/store.test.ts`'s own, and two more
 * added by task 6's fix round for `Shell.test.tsx` and `App.test.tsx`) before
 * being pulled out here: the second copy was tolerable, the third was the
 * signal that this had stopped being one test file's private fixture.
 * `store/store.test.ts` kept its own copy for a while longer, on the grounds
 * that it predated this file and did not need `hasPending`; fixing issue #81
 * is what made it need `hasPending`, so it now imports this module like
 * everything else and there is one copy again.
 */
import assert from 'node:assert/strict';
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

/**
 * Retries `assertion` until it stops throwing, and fails with what it last
 * said if it never does. For every assertion about something a driven tick
 * did, because `drive()` returns before the tick it started has finished.
 *
 * **Why this exists, and why `settle()` is not enough.** `drive()`
 * hands the loop's tick to the scheduler and then sleeps for a fixed 15ms,
 * because `Schedule` takes a synchronous `run` on purpose (see `drive`) and so
 * there is no promise for the harness to await. So everything a tick does --
 * reading `meta`, fetching, applying, and only then notifying -- lands some
 * unknown number of event-loop turns after `drive` has already returned.
 * Measured on an idle machine, the tail's page needs about nine of those
 * turns; 15ms covers them with roughly 6ms to spare, and does not cover them
 * when `node --test` is running eleven other files beside this one. That is
 * issue #81: an assertion on a subscriber that had not fired yet, reading as a
 * replica that applied nothing, about one full-suite run in six.
 *
 * Notifications are the worst case, because one fires only when the apply
 * transaction **completes**. A read is usually safer -- IndexedDB runs
 * transactions with overlapping scope in creation order -- but it is not safe
 * either, and assuming it was cost a round here: a tick whose own `readMeta`
 * has to complete before it can open the write transaction has not opened one
 * yet, so a read can beat it and legitimately see nothing.
 *
 * So: assert against a condition, never against a sleep. And make the
 * condition a *positive* one -- that what was expected is now there. Waiting
 * for an absence is issue #80: `!hasPending(loop)` is true both after a loop
 * retires and before it has been rescheduled, so it settles on the wrong state
 * and the assertion after it runs too early.
 */
export async function eventually(
  assertion: () => void | Promise<void>,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() - startedAt >= timeoutMs) {
        // Both halves, in a *new* error rather than by appending to the old
        // one's `message`. `node --test` renders a failure from `err.stack`,
        // which is a string built when the error was constructed, so mutating
        // `message` afterwards changes nothing that is ever printed -- the
        // description would have been silently dropped. An `AssertionError`'s
        // `message` already carries its own diff, so quoting it here keeps
        // what the assertion said, and `cause` keeps the assertion itself.
        throw new Error(
          `timed out after ${String(timeoutMs)}ms waiting for ${description}\n`
          + `  last failure: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      // Short, because what is being waited for is a handful of event-loop
      // turns rather than anything with real latency: a 10ms poll would more
      // than double the wait it is measuring.
      await delay(2);
    }
  }
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
      const returned: unknown = task.run();
      // Both copies this module was extracted from carry this assertion
      // (`store.test.ts`, `sync.test.ts`); dropping it here was Finding 10.
      // `sync.ts` hands `deps.schedule` a synchronous wrapper specifically so
      // an `async` function's rejection can never be handed straight to a
      // scheduler and escape every `catch` (`Schedule`'s own doc) -- this is
      // what pins that the wrapper this kit drives is still that shape.
      assert.equal(returned, undefined, 'the loop hands the scheduler a synchronous wrapper, not an async function whose rejection would escape');
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

/**
 * Granted the moment it is asked for. `hold` now must return a release
 * function (`Lease`'s own doc); this fixture's is a no-op, so the promise
 * `onGranted` receives stays pending exactly as it always did here -- no
 * caller in the files that use this fixture ever exercises release, that
 * being `sync.test.ts`'s own `manualLease` and the `leader.ts`-level tests'
 * business.
 */
export function grantedLease(): Lease {
  return {
    hold(onGranted): () => void {
      onGranted(
        new Promise<void>(() => {
          // Never settles in this fixture: nothing here ever releases.
        }),
      );
      return () => {
        // Nothing to release: see this function's own doc.
      };
    },
  };
}

let dbCounter = 0;
/** A database name no other caller in this process shares. */
export function freshDbName(prefix: string): string {
  dbCounter += 1;
  return `${prefix}-${String(dbCounter)}`;
}
