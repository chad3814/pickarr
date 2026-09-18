import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App.tsx';
import type { CreateStoreDeps } from '../src/store/index.ts';
import { fetchStub, jsonResponse } from './fetchStub.ts';
import { manualScheduler, stubSyncFetch, grantedLease, freshDbName, type ManualScheduler } from './store/syncTestKit.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): `App`
 * renders `Shell`, which owns a store with a running sync loop -- the same
 * hazard `Shell.test.tsx` documents at length. `cleanup()` unmounts whatever
 * `App` is currently showing, which runs `Shell`'s own effect cleanup and
 * stops its store, so nothing is left running into the next test.
 *
 * `globalThis.fetch` is restored unconditionally too: `session.ts`'s
 * `signOut` (reached through `Shell`'s "Sign out" button) calls the real
 * global `fetch` with a relative url, which has no document to resolve
 * against here.
 *
 * Every render is wrapped in `MemoryRouter` (task 4): `Shell`'s nav and
 * routes are real `react-router` components now, which throw without a
 * `Router` ancestor -- `main.tsx` supplies `BrowserRouter` in production,
 * and this file supplies `MemoryRouter` the same way `Shell.test.tsx` does.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function testShellDeps(): { deps: CreateStoreDeps; sched: ManualScheduler } {
  const fetch = stubSyncFetch({ '/api/sync/bootstrap': { since: 0, before: 0, generation: 'g' } });
  const sched = manualScheduler();
  return {
    sched,
    deps: {
      dbName: freshDbName('app-test'),
      fetch: fetch.fetch,
      schedule: sched.schedule,
      now: (): number => 1000,
      locks: grantedLease(),
      // Short, not the production default -- see `Shell.test.tsx`'s own
      // comment on `TEST_FETCH_DEADLINE_MS` for why this matters at all.
      fetchDeadlineMs: 200,
    },
  };
}

test('App renders Shell first, with no sign-in step in between', async () => {
  // Spec §4, §7 item 14: there is no probe for "am I already signed in", so
  // the only honest starting point is to try -- not to assume signed out.
  // This is deliberately *not* "does not render SignIn": that framing was
  // the bug (task 6's fix round). What matters is what a visitor actually
  // sees on the very first render, before any read has even had a chance to
  // answer.
  const { deps, sched } = testShellDeps();
  render(
    <MemoryRouter>
      <App shellDeps={deps} />
    </MemoryRouter>,
  );

  const signOutButton = screen.getByRole('button', { name: 'Sign out' });
  assert.ok(signOutButton, 'Shell is on screen immediately, not after a sign-in step');

  // Waited out before this test ends, not left to resolve during the next
  // one: `afterEach(cleanup)` unmounts immediately after this function
  // returns, and unmounting before `Shell`'s own store finished booting
  // races that boot's in-flight IndexedDB transaction against the close
  // `stop()` performs on it -- harmless (nothing here reads the result) but
  // noisy, logged by `sync.ts`'s own failure reporting. Waiting for the tail
  // loop to actually be scheduled is the same fix `Shell.test.tsx` and this
  // file's other test both use.
  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });
});

test('App falls back to SignIn once Shell calls onUnauthenticated, driven here via Sign out', async () => {
  // Named for what this drives, not for the mechanism spec §4 describes: a
  // click on "Sign out" reaches `onUnauthenticated` through `handleSignOut`,
  // never through the 401 demote (`withUnauthenticatedCheck`). This test's
  // old name claimed the latter and exercised only the former -- the whole-
  // branch review found that gap, and `Shell.test.tsx`'s own "a 401 on the
  // tail poll ... calls onUnauthenticated" is the test that actually covers
  // the 401 path this name used to claim.
  globalThis.fetch = fetchStub(async () => jsonResponse({}, 200));
  const { deps, sched } = testShellDeps();
  render(
    <MemoryRouter>
      <App shellDeps={deps} />
    </MemoryRouter>,
  );

  // Waits for `Shell`'s own boot sequence to actually finish before acting --
  // `Shell.test.tsx`'s "sign-out stops the store" documents why: clicking
  // before it does races the store's own in-flight bootstrap against the
  // close `store.stop()` performs, which `sync.ts` reports (correctly) as a
  // failure and retries, and a passing test should not depend on winning
  // that race either way.
  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });

  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

  await waitFor(() => {
    assert.ok(screen.getByRole('heading', { name: 'Sign in' }), 'SignIn is shown once Shell calls onUnauthenticated');
  });
});
