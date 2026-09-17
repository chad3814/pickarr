import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Shell } from '../../src/shell/Shell.tsx';
import type { CreateStoreDeps } from '../../src/store/index.ts';
import { fetchStub, jsonResponse } from '../fetchStub.ts';
import {
  settle,
  manualScheduler,
  stubSyncFetch,
  grantedLease,
  freshDbName,
  type ManualScheduler,
  type StubFetch,
} from '../store/syncTestKit.ts';

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

/**
 * A short deadline, not the production 60 seconds (task 6's fix round,
 * review-found): every sync fetch bounds itself with a real
 * `AbortSignal.timeout`, and that timer outlives the request it bounds under
 * this suite's `happy-dom` environment, holding the process open until it
 * fires. Left at the default, this file alone took `test:web` from under a
 * second to about 60 seconds -- one `AbortSignal.timeout(60_000)` per test
 * that boots a store, none of them ever needing to fire. `sync.test.ts`
 * (an earlier task) already overrides `SyncDeps.fetchDeadlineMs` the same
 * way; this is `CreateStoreDeps`'s own version of that seam, added in this
 * fix round specifically so callers through `createStore` -- which is every
 * caller now that `Shell` exists -- have it too.
 */
const TEST_FETCH_DEADLINE_MS = 200;

function testDeps(): { deps: CreateStoreDeps; fetch: StubFetch; sched: ManualScheduler } {
  const fetch = stubSyncFetch({ '/api/sync/bootstrap': { since: 0, before: 0, generation: 'g' } });
  const sched = manualScheduler();
  return {
    fetch,
    sched,
    deps: {
      dbName: freshDbName('shell-test'),
      fetch: fetch.fetch,
      schedule: sched.schedule,
      now: (): number => 1000,
      locks: grantedLease(),
      fetchDeadlineMs: TEST_FETCH_DEADLINE_MS,
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

test('a store that fails to open is reported, not left as an unhandled rejection', async () => {
  // `Shell.tsx`'s own `createStore(wired).catch(...)` was added alongside
  // `useCounts.ts`'s `safeRefresh` catch and, per this fix round's review,
  // was equally untested: removing it produced zero test failures. Proven
  // here by forcing `openStore`'s own request to fail the way IndexedDB
  // actually fails it -- opening at a version *lower* than one already on
  // disk answers a `VersionError`, per the standard -- rather than by
  // injecting a fake rejection `Shell` never has to handle in production.
  const dbName = freshDbName('shell-open-fail');
  const preexisting = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 2);
    req.addEventListener('success', () => { resolve(req.result); }, { once: true });
    req.addEventListener('error', () => { reject(req.error ?? new Error('open failed')); }, { once: true });
  });
  preexisting.close();

  const escaped: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  const reported: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]): void => {
    reported.push(args);
  };

  try {
    const { deps } = testDeps();
    render(<Shell deps={{ ...deps, dbName }} onUnauthenticated={() => {}} />);
    await settle();

    assert.deepEqual(escaped, [], 'the failed open was caught, not left to escape as an unhandled rejection');
    assert.ok(
      reported.some((call) => call.some((value) => String(value).includes('failed to open the replica'))),
      'the failure was reported rather than swallowed silently',
    );
  } finally {
    console.error = originalConsoleError;
    process.off('unhandledRejection', onUnhandledRejection);
  }
});
