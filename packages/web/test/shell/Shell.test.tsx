import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Shell } from '../../src/shell/Shell.tsx';
import type { CreateStoreDeps } from '../../src/store/index.ts';
import type { Lease, Schedule, SyncFetch, SyncLoop, SyncResponse } from '../../src/store/sync.ts';
import { fetchStub, jsonResponse } from '../fetchStub.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`).
 *
 * `Shell` owns a store with a running sync loop -- this file's single largest
 * hazard: a test that renders it and throws before its own teardown would
 * leave that store's scheduled tasks alive, hanging the file for however long
 * they keep firing, with no failing test named. Every store this file creates
 * is stopped through `Shell`'s own "Sign out" path or through `cleanup`
 * unmounting it (which runs `Shell`'s effect cleanup, which calls
 * `store.stop()`) -- never left to the next test.
 *
 * `globalThis.fetch` is restored unconditionally too: `session.ts`'s
 * `signOut` calls the real global `fetch` with a relative url, which has no
 * document to resolve against here and would otherwise throw.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A real timer, not fake ones -- fake timers hang this suite (`CLAUDE.md`). */
function settle(): Promise<void> {
  return delay(15);
}

interface ScheduledTask {
  loop: SyncLoop;
  run: () => void;
  ran: boolean;
  cancelled: boolean;
}

interface ManualScheduler {
  schedule: Schedule;
  drive(loop: SyncLoop): Promise<void>;
  /** Whether `loop` currently has a task that was scheduled and neither driven nor cancelled -- a test's way to wait for one to exist before it acts, and to check it stopped existing afterwards, without running it. */
  hasPending(loop: SyncLoop): boolean;
}

/** The scheduler seam `sync.ts` was built to take, driven by hand -- the same technique `store/store.test.ts` uses for the same reason. */
function manualScheduler(): ManualScheduler {
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

interface StubFetch {
  fetch: SyncFetch;
  urls: string[];
}

/** Routes by exact url, and fails loudly on anything unrouted. */
function stubSyncFetch(table: Readonly<Record<string, unknown>>): StubFetch {
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
function grantedLease(): Lease {
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
/** A database name no other test in this process shares. */
function freshDbName(): string {
  dbCounter += 1;
  return `shell-test-${String(dbCounter)}`;
}

function testDeps(): { deps: CreateStoreDeps; fetch: StubFetch; sched: ManualScheduler } {
  const fetch = stubSyncFetch({ '/api/sync/bootstrap': { since: 0, before: 0, generation: 'g' } });
  const sched = manualScheduler();
  return {
    fetch,
    sched,
    deps: {
      dbName: freshDbName(),
      fetch: fetch.fetch,
      schedule: sched.schedule,
      now: (): number => 1000,
      locks: grantedLease(),
    },
  };
}

test('sign-out stops the store', async () => {
  // A store left running against a dead session retries a 401 on the backoff
  // ladder, which the previous slice just finished bounding -- this is the
  // property that makes "stops" mean something rather than "asked to".
  globalThis.fetch = fetchStub(async () => jsonResponse({}, 200));
  const { deps, sched } = testDeps();

  let unauthenticated = 0;
  render(<Shell deps={deps} onUnauthenticated={() => { unauthenticated += 1; }} />);

  // Waits for two independent things to have actually happened before acting,
  // rather than a fixed delay standing in for both: `useCounts`'s own first
  // read landing (clicking "Sign out" before it does would close the database
  // out from under that still-in-flight read -- a real race `useCounts.ts`
  // now catches rather than crashing on, but a passing test should not depend
  // on winning it), and the tail loop having been scheduled at least once (so
  // that cancelling it below is observed actually happening, not merely
  // "never got the chance to").
  await waitFor(() => {
    assert.equal(screen.getByTestId('count-tv').textContent, '0');
  });
  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });

  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await settle();

  assert.equal(unauthenticated, 1, 'App is told to show SignIn again');
  assert.equal(sched.hasPending('tail'), false, 'store.stop() cancelled the tail task that was pending');
});
