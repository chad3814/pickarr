import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Shell } from '../../src/shell/Shell.tsx';
import type { CreateStoreDeps } from '../../src/store/index.ts';
import { SCHEMA_VERSION } from '../../src/store/db.ts';
import type { SyncFetch } from '../../src/store/sync.ts';
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
  render(
    <MemoryRouter>
      <Shell deps={deps} onUnauthenticated={() => { unauthenticated += 1; }} />
    </MemoryRouter>,
  );

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

test('an offline sign-out does not escape as an unhandled promise rejection', async () => {
  // The identical defect shape task 5's review found in
  // `SignIn.handleSubmit` (`4283bb6` fixed it there with `REQUEST_FAILED`):
  // `session.ts`'s `signOut` is a bare `fetch`, which rejects on any
  // transport failure -- offline, DNS, a reset connection -- and `void`
  // does not contain a rejection. Proven here the way `session.test.ts`'s
  // own stubs model a rejection: the sign-out fetch throws, the way an
  // offline tab's real one would.
  globalThis.fetch = fetchStub(async () => {
    throw new Error('offline');
  });
  const { deps, sched } = testDeps();

  const escaped: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  const originalConsoleError = console.error;
  console.error = (): void => {};

  try {
    let unauthenticated = 0;
    render(
      <MemoryRouter>
        <Shell deps={deps} onUnauthenticated={() => { unauthenticated += 1; }} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await settle();

    assert.deepEqual(escaped, [], 'the failed sign-out network call was caught, not left to escape as an unhandled rejection');
    assert.equal(unauthenticated, 1, 'App is still told to show SignIn again even though the network call failed');
  } finally {
    console.error = originalConsoleError;
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('a 401 on the tail poll -- the ordinary way a client discovers a dead session (design spec §4) -- calls onUnauthenticated', async () => {
  // `withUnauthenticatedCheck` (`Shell.tsx`) is the mechanism spec §4 is
  // built on, and it had no unit test at all before this one: removing its
  // one `if` left every other test in `test:web` green, and only the e2e
  // suite caught the gap -- by failing all five specs at once, since with no
  // demote the app never reaches `SignIn` and nothing can claim the install.
  // That is the least diagnostic signal available ("everything is red"); this
  // test exists so the same defect fails one named test instead.
  const bootstrapAnswer = { since: 0, before: 0, generation: 'g' };
  const fetch: SyncFetch = async (url) => {
    if (url === '/api/sync/bootstrap') {
      return { ok: true, status: 200, json: () => Promise.resolve(bootstrapAnswer) };
    }
    // Every other sync url -- the tail's `/api/sync?since=...` included --
    // answers the guard's fixed 401, never a body this test has to read.
    return { ok: false, status: 401, json: () => Promise.resolve({}) };
  };
  const sched = manualScheduler();

  // `sync.ts`'s own loop still sees a 401 as a failed request once
  // `withUnauthenticatedCheck` has told `Shell` about it, and logs it on the
  // same path any other failed request takes -- expected, and captured
  // rather than left to print, on `sync.test.ts`'s own `captureErrors`
  // pattern, so this test's output stays pristine.
  const originalConsoleError = console.error;
  console.error = (): void => {};

  let unauthenticated = 0;
  try {
    render(
      <MemoryRouter>
        <Shell
          deps={{
            dbName: freshDbName('shell-401'),
            fetch,
            schedule: sched.schedule,
            now: (): number => 1000,
            locks: grantedLease(),
            fetchDeadlineMs: TEST_FETCH_DEADLINE_MS,
          }}
          onUnauthenticated={() => { unauthenticated += 1; }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
    });
    await sched.drive('tail');

    assert.equal(unauthenticated, 1, 'a 401 read anywhere in the sync loops -- not just sign-in or sign-out -- is enough to demote');
  } finally {
    console.error = originalConsoleError;
  }
});

/**
 * A replica name `openStore` cannot open, and the reason it cannot.
 *
 * Forces the failure the way IndexedDB actually produces one -- opening at a
 * version *lower* than one already on disk answers a `VersionError`, per the
 * standard -- rather than injecting a fake rejection `Shell` never has to
 * handle in production. One version ahead of `SCHEMA_VERSION`, not a
 * literal, so the next bump does not silently turn this back into an
 * equal-version open with no `VersionError` and no failing assertion to say
 * why.
 */
async function unopenableDbName(label: string): Promise<string> {
  const dbName = freshDbName(label);
  const preexisting = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, SCHEMA_VERSION + 1);
    req.addEventListener('success', () => { resolve(req.result); }, { once: true });
    req.addEventListener('error', () => { reject(req.error ?? new Error('open failed')); }, { once: true });
  });
  preexisting.close();
  return dbName;
}

test('a store that fails to open is reported, not left as an unhandled rejection', async () => {
  // `Shell.tsx`'s own `createStore(wired).catch(...)` was added alongside
  // `useCounts.ts`'s `safeRefresh` catch and, per this fix round's review,
  // was equally untested: removing it produced zero test failures.
  const dbName = await unopenableDbName('shell-open-fail');

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
    render(
      <MemoryRouter>
        <Shell deps={{ ...deps, dbName }} onUnauthenticated={() => {}} />
      </MemoryRouter>,
    );
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

test('a replica that cannot be opened says so on screen, rather than rendering a confident blank', async () => {
  // The test above proves the *handler ran*. It says nothing about whether
  // anyone is told, and the answer was nobody (whole-branch review §3):
  // `/tv`'s section had an innerHTML of `""`, the three counts read 0/0/0,
  // and no alert of any kind appeared -- total failure rendering exactly
  // like "still loading", and exactly like the correct empty replica that
  // this branch's "zero is an answer" constraint makes a normal state.
  //
  // Asserted on a real visible heading, not on a `role`/`aria-label` pair
  // (`CLAUDE.md`'s longest hazard entry: a query that would still pass with
  // every stylesheet deleted is not evidence anyone can read the thing), and
  // the section takes its accessible name from that same heading through
  // `aria-labelledby`, so the announced string and the visible one cannot
  // drift apart.
  const dbName = await unopenableDbName('shell-open-fail-visible');

  const originalConsoleError = console.error;
  console.error = (): void => {};
  try {
    const { deps } = testDeps();
    render(
      <MemoryRouter initialEntries={['/tv']}>
        <Shell deps={{ ...deps, dbName }} onUnauthenticated={() => {}} />
      </MemoryRouter>,
    );
    await settle();

    const heading = screen.getByRole('heading', { name: /cannot open its local database/i });
    assert.ok(heading.textContent !== null && heading.textContent.length > 0, 'the failure is spelled out in visible text');
    assert.ok(
      screen.getByRole('region', { name: /cannot open its local database/i }),
      'and the region is named by that heading rather than by a duplicated aria-label',
    );
    assert.ok(
      screen.getByText(/close it, then reload/i),
      'and it says what to do about it, not merely that something went wrong',
    );
    assert.ok(!screen.queryByTestId('category-tv'), 'the blank category section is not shown alongside it');
  } finally {
    console.error = originalConsoleError;
  }
});

/**
 * Task 4's own tests: the nav is real `NavLink`s now, not plain text, and
 * `Shell` owns the four routes (`/tv`, `/movie`, `/xxx`, `/unmatched`, with
 * `/` redirecting to `/tv`). Each renders through `MemoryRouter` so a test
 * can choose the starting path directly, and each passes `deps` from
 * `testDeps()` -- the fixture every other test in this file uses -- rather
 * than defaulting `Shell` to the real browser adapters (`ShellProps.deps`'s
 * own doc on why a test must not do that).
 *
 * Each also waits for the tail loop to be scheduled before its assertions
 * run out: `createStore`'s own initial bootstrap read is in flight the
 * moment `render` returns, and ending the test (`afterEach(cleanup)`
 * unmounts, which closes the store) before it settles races that read
 * against the close -- the same race this file's other tests wait out, and
 * the reason for `sched` in `testDeps()`'s own return type.
 */
test('the nav links to each category, and marks the current one', async () => {
  const { deps, sched } = testDeps();
  render(
    <MemoryRouter initialEntries={['/movie']}>
      <Shell deps={deps} onUnauthenticated={() => {}} />
    </MemoryRouter>,
  );

  const link = screen.getByRole<HTMLAnchorElement>('link', { name: /Movies/ });
  assert.equal(link.getAttribute('href'), '/movie');
  assert.equal(link.getAttribute('aria-current'), 'page', 'the current category is announced, not only coloured');

  const other = screen.getByRole<HTMLAnchorElement>('link', { name: /TV/ });
  assert.ok(!other.hasAttribute('aria-current'), 'a category that is not current is not announced as the page');

  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });
});

/**
 * Pins the `<Route>` table's path-to-element mapping itself. The nav's own
 * hrefs and `aria-current` (asserted above) are derived from `CATEGORIES`
 * independently of the `<Route>` tree, so they cannot see this: swapping
 * which screen renders at `/tv` against `/movie` passed every test in this
 * file before these three existed (review-found, task 4's fix round).
 *
 * Asserts on each screen's `data-testid={`category-${category}`}` marker,
 * not its prose (round 2 of task 4's fix round, review-found: the first
 * version of these three asserted the exact placeholder text, which pinned
 * the mapping at the time but would have broken all three the moment tasks
 * 5-7 replaced a placeholder's wording with a real screen -- three later
 * tasks each stopping to repair a test this round added, rather than this
 * round choosing a marker that survives that swap). `data-testid` is the
 * house pattern for exactly this, already used by `Shell.tsx`'s own
 * `count-${category}`. The marker survived the swap it was chosen for:
 * `Category.tsx` carries it now, and its docblock says why.
 *
 * One test per category rather than a loop over `CATEGORIES`: a `for`-loop
 * body awaiting the tail-scheduled check on every iteration is exactly the
 * shape `no-await-in-loop` exists to flag, and three named tests are no less
 * clear for it.
 */
test('the /tv route renders the tv category, not another one', async () => {
  const { deps, sched } = testDeps();
  render(
    <MemoryRouter initialEntries={['/tv']}>
      <Shell deps={deps} onUnauthenticated={() => {}} />
    </MemoryRouter>,
  );

  assert.ok(screen.getByTestId('category-tv'), '/tv renders the tv placeholder');
  assert.ok(!screen.queryByTestId('category-movie'), 'not the movie placeholder');
  assert.ok(!screen.queryByTestId('category-xxx'), 'not the xxx placeholder');

  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });
});

test('the /movie route renders the movie category, not another one', async () => {
  const { deps, sched } = testDeps();
  render(
    <MemoryRouter initialEntries={['/movie']}>
      <Shell deps={deps} onUnauthenticated={() => {}} />
    </MemoryRouter>,
  );

  assert.ok(screen.getByTestId('category-movie'), '/movie renders the movie placeholder');
  assert.ok(!screen.queryByTestId('category-tv'), 'not the tv placeholder');
  assert.ok(!screen.queryByTestId('category-xxx'), 'not the xxx placeholder');

  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });
});

test('the /xxx route renders the xxx category, not another one', async () => {
  const { deps, sched } = testDeps();
  render(
    <MemoryRouter initialEntries={['/xxx']}>
      <Shell deps={deps} onUnauthenticated={() => {}} />
    </MemoryRouter>,
  );

  assert.ok(screen.getByTestId('category-xxx'), '/xxx renders the xxx placeholder');
  assert.ok(!screen.queryByTestId('category-tv'), 'not the tv placeholder');
  assert.ok(!screen.queryByTestId('category-movie'), 'not the movie placeholder');

  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });
});

/**
 * `/unmatched`'s own mapping test, alongside the three category ones above.
 * Task 7's own report found nothing pinning this route before this test --
 * unlike the three category placeholders, the one that stood at
 * `/unmatched` carried no `data-testid`, so swapping what this route
 * rendered could have gone unnoticed the way the three category ones no
 * longer can. `Unmatched`'s root now carries `data-testid="unmatched"` for
 * exactly this.
 *
 * `waitFor`, not a synchronous assertion like the three tests above: unlike
 * `Category`, whose `data-testid` sits on an outer element that renders
 * regardless of `store` (`Category.tsx`'s own doc), `Shell.tsx`'s
 * `/unmatched` route is `store === undefined ? null : <Unmatched .../>`, so
 * the marker is not there until `createStore` resolves.
 */
test('the /unmatched route renders Unmatched, not a category', async () => {
  const { deps, sched } = testDeps();
  render(
    <MemoryRouter initialEntries={['/unmatched']}>
      <Shell deps={deps} onUnauthenticated={() => {}} />
    </MemoryRouter>,
  );

  await waitFor(() => {
    assert.ok(screen.getByTestId('unmatched'), '/unmatched renders Unmatched');
  });
  assert.ok(!screen.queryByTestId('category-tv'), 'not the tv category');
  assert.ok(!screen.queryByTestId('category-movie'), 'not the movie category');
  assert.ok(!screen.queryByTestId('category-xxx'), 'not the xxx category');

  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });
});

test('/ redirects to /tv rather than rendering an empty shell', async () => {
  const { deps, sched } = testDeps();
  render(
    <MemoryRouter initialEntries={['/']}>
      <Shell deps={deps} onUnauthenticated={() => {}} />
    </MemoryRouter>,
  );

  const tv = await screen.findByRole<HTMLAnchorElement>('link', { name: /TV/ });
  assert.equal(tv.getAttribute('aria-current'), 'page', '/ lands on the tv category');

  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });
});

test('an unknown path inside the shell still renders the shell, not a blank page', async () => {
  // The host answers index.html for any non-api path, so this is a path the
  // router sees rather than a 404. The shell's own chrome must survive it --
  // the e2e deep-link spec asserts the same property against a real server.
  const { deps, sched } = testDeps();
  render(
    <MemoryRouter initialEntries={['/library/some/deep/link']}>
      <Shell deps={deps} onUnauthenticated={() => {}} />
    </MemoryRouter>,
  );

  assert.ok(screen.getByRole('heading', { name: 'Pickarr' }), 'the shell renders');
  assert.ok(screen.getByRole('navigation'), 'including its nav');

  // Pins the catch-all's own behaviour, not just that *something* rendered:
  // review-found (task 4's fix round), replacing `element={null}` with a
  // silent redirect to `/tv` passed every test above and in this file --
  // the exact failure mode this route exists to avoid, a typo'd url quietly
  // landing on the default category as though it had worked. A `Navigate`
  // to `/tv` would make the `TV` link `aria-current="page"` exactly as a
  // real `/tv` visit does, so asserting that none of the nav's links carry
  // it is what tells the two apart.
  const links = screen.getAllByRole<HTMLAnchorElement>('link');
  assert.ok(
    links.every((link) => !link.hasAttribute('aria-current')),
    'no category is announced as current when the path matches none of them',
  );

  await waitFor(() => {
    assert.ok(sched.hasPending('tail'), 'the tail loop has been scheduled');
  });
});
