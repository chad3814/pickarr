import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { DownloadRow } from '../src/components/DownloadRow.tsx';
import { Downloads } from '../src/routes/Downloads.tsx';
import { fetchStub } from './fetchStub.ts';
// `groupAnchorHref` is deliberately *not* imported: both hrefs below are
// spelled out, because an expectation the code under test computes cannot
// detect that code changing.
import { api, type DownloadView, type DownloadsResponse } from '../src/api/client.ts';

/**
 * Unmount between tests rather than at the end of each one. `<Downloads />`
 * polls on an interval that only unmounting clears, so a test that failed
 * before its own `cleanup()` used to leave the timer running and the whole
 * file hung with no failure reported.
 */
afterEach(cleanup);

/**
 * A row's title is a router link now, and a `<Link>` outside a router throws.
 * Every render of a tracked row goes through here.
 */
function routed(node: ReactNode) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

/**
 * Never `assert.equal(screen.queryByText(x), null)` — one of two shapes of
 * `#40`, documented in full on `gone()` in `MediaCard.test.tsx`: node:assert
 * formats a live DOM element to explain a failed equality, which burns real
 * time and reports no test name. Compare the boolean instead, as here.
 */
function gone(text: string | RegExp): boolean {
  return screen.queryByText(text) === null;
}

/**
 * Lets every already-queued microtask run, and React commit what they produced.
 *
 * For tests that mock `setInterval` and so cannot use `waitFor` — see the poll
 * test below for why. `setTimeout(0)` rather than a bare `await`: the chain from
 * a settled `fetch` to a painted row crosses `response.json()` and React's own
 * scheduling, which is several turns deep rather than one.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function download(over: Partial<DownloadView> = {}): DownloadView {
  return {
    id: 1,
    groupId: 1,
    releaseId: 1,
    title: 'Alex Coal',
    kind: 'initial',
    status: 'downloading',
    error: null,
    attempts: 0,
    updatedAt: 1,
    absentSince: null,
    ...over,
  };
}

// Run unconditionally, unlike the per-test `cleanup()` calls this replaces:
// the new retry test below mounts `Downloads` with its 3-second poll timer
// mocked, and an assertion failure that skips cleanup would leave that timer
// running for real once the mock reverts at test end — the process would
// then hang on an interval nothing is left to clear. `afterEach` runs whether
// the test passed or threw, matching `Failed.test.tsx` and `Browse.test.tsx`.
afterEach(cleanup);

test('a tracked row shows status and offers retry only when failed', () => {
  const { rerender } = render(routed(<DownloadRow download={download()} onRetry={() => {}} />));
  assert.equal(screen.queryByRole('button', { name: /retry/i }), null);

  rerender(
    routed(
      <DownloadRow
        download={download({ status: 'failed', error: 'disk full', attempts: 1 })}
        onRetry={() => {}}
      />,
    ),
  );
  assert.ok(screen.getByRole('button', { name: /retry/i }));
  assert.ok(screen.getByText(/disk full/));
});

test('an absent row warns and offers retry, a healthy row offers neither', () => {
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
  const { rerender } = render(
    routed(<DownloadRow download={download({ absentSince: threeHoursAgo })} onRetry={() => {}} />),
  );
  assert.ok(screen.getByText(/missing from client for 3h/i));
  assert.ok(screen.getByRole('button', { name: /retry/i }));

  rerender(routed(<DownloadRow download={download()} onRetry={() => {}} />));
  assert.ok(gone(/missing from client/i));
  assert.equal(screen.queryByRole('button', { name: /retry/i }), null);
});

test('a failed row keeps its error and retry button, and no absence warning', () => {
  render(
    routed(
      <DownloadRow
        download={download({ status: 'failed', error: 'disk full', attempts: 1 })}
        onRetry={() => {}}
      />,
    ),
  );
  assert.ok(screen.getByText(/disk full/));
  assert.ok(screen.getByRole('button', { name: /retry/i }));
  assert.ok(gone(/missing from client/i));
});

test('retry is offered for exactly the statuses the API guard accepts', () => {
  // `POST /api/downloads/:id/retry` 409s unless `status === 'failed' ||
  // absentSince !== null` (packages/core/src/http/server.ts). The button must
  // offer retry on precisely that set — wider and it 409s on click, narrower
  // and an absent row keeps no escape hatch at all. This enumerates every
  // status the SPA can see a download in, crossed with absent/not, as the one
  // place both halves of that agreement are pinned together.
  const statuses = ['queued', 'downloading', 'completed', 'importing', 'imported', 'failed'] as const;
  for (const status of statuses) {
    for (const absentSince of [null, Date.now() - 60_000]) {
      const { unmount } = render(
        routed(<DownloadRow download={download({ status, absentSince })} onRetry={() => {}} />),
      );
      const expectRetry = status === 'failed' || absentSince !== null;
      assert.equal(
        screen.queryByRole('button', { name: /retry/i }) !== null,
        expectRetry,
        `status=${status} absentSince=${String(absentSince)}`,
      );
      unmount();
    }
  }
});

test('a failed download links to its group on the Picks tab', () => {
  // The failure named a title and stopped there: the group holding the
  // untried alternatives sat unreachable in a long list. The title is now the
  // way across.
  render(
    routed(
      <DownloadRow
        download={download({
          groupId: 42,
          status: 'failed',
          error: 'Repair failed, not enough repair blocks (92 short)',
        })}
        onRetry={() => {}}
      />,
    ),
  );
  // The literal, not `groupAnchorHref(42)`. An expectation computed by calling
  // the code under test cannot detect that code changing: made to return a
  // constant, `groupAnchor` passed this whole suite because both ends of the
  // link agreed on the wrong string. See the matching literal in
  // `MediaCard.test.tsx` — between them the two ids pin the mapping, not just
  // its consistency.
  assert.equal(
    screen.getByRole('link', { name: 'Alex Coal' }).getAttribute('href'),
    '/picks#group-42',
  );
});

test('a healthy download links too', () => {
  // The link is navigation, not an error affordance: "what is this a download
  // of?" is a fair question about a row that is downloading normally.
  render(routed(<DownloadRow download={download({ groupId: 7 })} onRetry={() => {}} />));
  // A second literal, a second group id: together with the one above, no
  // constant and no mapping other than the real one satisfies both.
  assert.equal(screen.getByRole('link', { name: 'Alex Coal' }).getAttribute('href'), '/picks#group-7');
});

test('a bodyless request carries no json content-type', async () => {
  // Retry sends no body. Declaring one anyway made Fastify reject it with a
  // 400 before the route ran, so the button never worked — and the click site
  // had no catch, so it failed in silence.
  const sent: RequestInit[] = [];
  globalThis.fetch = fetchStub(async (_input, init) => {
    sent.push(init ?? {});
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });

  await api.retry(7);
  assert.equal(sent[0]?.headers, undefined);

  await api.pick(1, 2);
  assert.deepEqual(sent[1]?.headers, { 'content-type': 'application/json' });
});

test('a refused retry surfaces instead of vanishing', async () => {
  globalThis.fetch = fetchStub(async (_input, init) =>
    init?.method === 'POST'
      ? new Response(JSON.stringify({ error: 'Only a failed download can be retried' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(
          JSON.stringify({
            tracked: [
              {
                id: 1,
                groupId: 1,
                releaseId: 1,
                title: 'Alex Coal',
                kind: 'initial',
                status: 'failed',
                error: 'ENOTDIR',
                attempts: 1,
                updatedAt: 1,
              },
            ],
            untracked: [],
            nextCursor: null,
          }),
          { headers: { 'content-type': 'application/json' } },
        ));

  render(routed(<Downloads />));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /retry/i })));
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));

  await waitFor(() => assert.ok(screen.getByText(/only a failed download can be retried/i)));
});

test('retry refreshes the row immediately, without waiting on the poll', async (t) => {
  // Enabling only `setInterval` freezes `Downloads`' 3-second poll on a mock
  // clock this test never ticks, while leaving `setTimeout` — what `waitFor`
  // below polls with — running on the real one. So the only way the row can
  // reach `queued` here is `Downloads.retry` patching it from the retry's own
  // response; the 3-second poll physically cannot fire.
  //
  // This is what pins the regression that patch guards against. It used to be
  // `setData(await api.downloads())`, and dropping *that* still left every
  // assertion green when nothing froze the poll, because `waitFor`'s real
  // timeout is longer than three seconds — it just made the e2e spec 1.6s ->
  // 5.3s slower, waiting the poll interval out inside its own 5-second
  // assertion window. On a loaded CI runner that margin is what turns into an
  // unreproducible flake, and nothing else in the repo pins it.
  t.mock.timers.enable({ apis: ['setInterval'] });

  let downloadsRequests = 0;
  globalThis.fetch = fetchStub(async (_input, init) => {
    if (init?.method === 'POST') {
      // The row as the server left it. `/api/downloads/:id/retry` has always
      // answered with the updated `DownloadView`; the screen now uses it,
      // which is also what lets a retry reach a row that has scrolled off page
      // one — a refetch of page one no longer can.
      return new Response(
        JSON.stringify(download({ status: 'queued', error: null, attempts: 1 })),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    downloadsRequests += 1;
    return new Response(
      JSON.stringify({
        tracked: [download({ status: 'failed', error: 'disk full', attempts: 1 })],
        untracked: [],
        nextCursor: null,
      } satisfies DownloadsResponse),
      { headers: { 'content-type': 'application/json' } },
    );
  });

  // `routed`, like every other render here. This test arrived from `main`,
  // where `DownloadRow` had no `<Link>` and needed no Router; this branch gave
  // the title one. Git merged both files without a conflict and the result did
  // not render at all — an empty body, and a missing button rather than a
  // missing Router. CI found it; neither branch could have.
  render(routed(<Downloads />));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /retry/i })));
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));

  await waitFor(() => assert.equal(screen.getByText('queued').textContent, 'queued'));
  // The mount's page one, and nothing else: the mocked interval never ticked,
  // and the retry no longer refetches the list at all.
  assert.equal(downloadsRequests, 1);
});

test('untracked entries render inert and labelled', async () => {
  const body: DownloadsResponse = {
    tracked: [],
    untracked: [{ clientId: 'sab', ref: 'x', name: 'Someone Elses', state: 'downloading', percentage: 40 }],
    nextCursor: null,
  };
  globalThis.fetch = fetchStub(async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }));

  render(routed(<Downloads />));

  await waitFor(() => assert.ok(screen.getByText('Someone Elses')));
  assert.ok(screen.getByText(/not managed by pickarr/i));
  assert.equal(screen.queryByRole('button', { name: /retry/i }), null);
});

// The search box. It filters the rows the screen already holds rather than
// going to the server: `/api/downloads` is paginated now, so "already in hand"
// means the pages that have been loaded rather than the whole table, and the
// term reaches the rest as they load. Moving it to `?q=` is the remaining half
// of issue #31 and would start the list over on each keystroke, which is a
// different behaviour to judge on its own.

/** Answers `/api/downloads` with one fixed body, and nothing else. */
function serveDownloads(body: DownloadsResponse): void {
  globalThis.fetch = fetchStub(async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }));
}

test('typing a term leaves only the tracked rows that match it', async () => {
  serveDownloads({
    tracked: [download({ id: 1, title: 'Alex Coal' }), download({ id: 2, title: 'Riley Reid' })],
    untracked: [],
    nextCursor: null,
  });

  render(routed(<Downloads />));
  await waitFor(() => assert.ok(screen.getByText('Riley Reid')));

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search downloads' }), {
    target: { value: 'coal' },
  });

  assert.ok(screen.getByText('Alex Coal'));
  assert.ok(gone('Riley Reid'));
});

test('the term filters untracked entries too, and takes their heading with them', async () => {
  // The heading is the whole of what says these rows are not Pickarr's. Leaving
  // it standing over an empty list would read as "Pickarr has lost track of
  // something", when all that happened is the reader typed.
  serveDownloads({
    tracked: [download({ id: 1, title: 'Alex Coal' }), download({ id: 2, title: 'Riley Reid' })],
    untracked: [
      { clientId: 'sab', ref: 'a', name: 'Someone Elses', state: 'downloading', percentage: 40 },
      { clientId: 'sab', ref: 'b', name: 'Alex Coal Extras', state: 'completed', percentage: 100 },
    ],
    nextCursor: null,
  });

  render(routed(<Downloads />));
  await waitFor(() => assert.ok(screen.getByText('Someone Elses')));
  const box = screen.getByRole('searchbox', { name: 'Search downloads' });

  // A term both halves can satisfy filters each of them and keeps the heading
  // between: the two lists are filtered independently, not one and then the
  // other discarded.
  fireEvent.change(box, { target: { value: 'alex' } });
  assert.ok(screen.getByText('Alex Coal'));
  assert.ok(screen.getByText('Alex Coal Extras'));
  assert.ok(screen.getByText(/not managed by pickarr/i));
  assert.ok(gone('Riley Reid'));
  assert.ok(gone('Someone Elses'));

  // A term only a tracked row can satisfy takes the whole section, heading and
  // all, rather than leaving the label over nothing.
  fireEvent.change(box, { target: { value: 'riley' } });
  assert.ok(screen.getByText('Riley Reid'));
  assert.ok(gone('Alex Coal Extras'));
  assert.ok(gone('Someone Elses'));
  assert.ok(gone(/not managed by pickarr/i));
});

test('a poll landing does not clear the term or unfilter the list', async (t) => {
  // The term is the reader's, and `data` is the server's; the poll replaces the
  // second every three seconds. Deriving the visible rows from both on each
  // render is what keeps a tick from undoing a search mid-read — the failure
  // this pins is a box that still holds "coal" over a list that has silently
  // gone back to everything.
  //
  // Nothing here waits on `waitFor`, and that is not a style preference.
  // `waitFor` polls with `setInterval` (@testing-library/dom's `wait-for.js`),
  // which this test mocks in order to freeze the component's own poll — so its
  // polling never fires and it is left depending on its `MutationObserver`. That
  // delivered fast enough in isolation and lost to the 1s deadline inside a
  // loaded full-suite run, which is how this test was first seen failing. The
  // deferreds below remove the race instead of widening the window it has to win.
  t.mock.timers.enable({ apis: ['setInterval'] });

  // One deferred per expected poll, resolved as that poll's response is handed
  // back. Pre-created so the resolvers exist before the first call can need one.
  const resolvers: (() => void)[] = [];
  const handedBack = Array.from(
    { length: 2 },
    () => new Promise<void>((resolve) => resolvers.push(resolve)),
  );

  let polls = 0;
  globalThis.fetch = fetchStub(async () => {
    polls += 1;
    // The second poll brings a new row, which is the case that matters: a filter
    // re-derived from fresh data must apply to what just arrived, not only to
    // what was there when the term was typed.
    const tracked =
      polls === 1
        ? [download({ id: 1, title: 'Alex Coal' }), download({ id: 2, title: 'Riley Reid' })]
        : [
            download({ id: 1, title: 'Alex Coal' }),
            download({ id: 2, title: 'Riley Reid' }),
            download({ id: 3, title: 'Riley Reid Again' }),
          ];
    resolvers[polls - 1]?.();
    return new Response(
      JSON.stringify({ tracked, untracked: [], nextCursor: null } satisfies DownloadsResponse),
      { headers: { 'content-type': 'application/json' } },
    );
  });

  render(routed(<Downloads />));
  await handedBack[0];
  await flush();
  assert.ok(screen.getByText('Riley Reid'));

  const box = screen.getByRole('searchbox', { name: 'Search downloads' });
  fireEvent.change(box, { target: { value: 'coal' } });
  assert.ok(gone('Riley Reid'));

  t.mock.timers.tick(3000);
  assert.equal(polls, 2, 'the mocked interval fires the poll synchronously');
  await handedBack[1];
  await flush();

  // The term survived the landing, and the row that arrived under it is filtered
  // by it rather than appearing through the search.
  assert.equal((box as HTMLInputElement).value, 'coal', 'the term is still what was typed');
  assert.ok(screen.getByText('Alex Coal'));
  assert.ok(gone('Riley Reid'));
  assert.ok(gone('Riley Reid Again'), 'a row that arrived under a term must be filtered by it');

  // And it really did arrive — without this, every assertion above would also
  // hold if the second response had simply never reached state, which is the
  // vacuous pass this guards against.
  fireEvent.change(box, { target: { value: '' } });
  assert.ok(screen.getByText('Riley Reid Again'));
});

/**
 * One `/api/downloads` mock over two pages: no cursor answers page one, any
 * cursor answers page two and ends the list. Every response resolves the next
 * deferred, so a test can wait for the exact fetch it caused rather than
 * racing a timeout — see the poll test above for why `waitFor` is unavailable
 * once `setInterval` is mocked.
 */
function servePagedDownloads(expected: number): {
  handedBack: Promise<void>[];
  pageOneFetches: () => number;
} {
  const resolvers: (() => void)[] = [];
  const handedBack = Array.from(
    { length: expected },
    () => new Promise<void>((resolve) => resolvers.push(resolve)),
  );
  let calls = 0;
  let pageOne = 0;

  globalThis.fetch = fetchStub(async (input) => {
    const cursor = new URL(input, 'http://test.invalid').searchParams.get('cursor');
    let body: DownloadsResponse;
    if (cursor === null) {
      pageOne += 1;
      // The poll's page one differs from the mount's in one row's status,
      // which is the patch this has to land without disturbing page two.
      body = {
        tracked: [
          download({ id: 3, title: 'Newest', status: pageOne === 1 ? 'downloading' : 'imported' }),
          download({ id: 2, title: 'Middle' }),
        ],
        untracked: [],
        nextCursor: '2:2',
      };
    } else {
      body = {
        tracked: [download({ id: 1, title: 'Oldest' })],
        untracked: [],
        nextCursor: null,
      };
    }
    calls += 1;
    resolvers[calls - 1]?.();
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  });

  return { handedBack, pageOneFetches: () => pageOne };
}

test('a poll landing keeps page two on screen and patches page one in place', async (t) => {
  // The interaction issue #31 names as its second risk. The poll now fetches
  // page one only, four times a minute, and it has two ways to be wrong:
  // replacing the list discards every page the reader scrolled to, and
  // appending page one grows the list by a page each tick. Asserting the row
  // *count* rather than only what is present is what separates them — an
  // append leaves every assertion about presence green.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { handedBack, pageOneFetches } = servePagedDownloads(3);

  render(routed(<Downloads />));
  await handedBack[0];
  await flush();
  assert.ok(screen.getByText('Middle'));
  assert.ok(gone('Oldest'), 'page two is not loaded yet');

  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await handedBack[1];
  await flush();
  assert.ok(screen.getByText('Oldest'));

  t.mock.timers.tick(3000);
  assert.equal(pageOneFetches(), 2, 'the mocked interval fires the poll synchronously');
  await handedBack[2];
  await flush();

  // Page two survived the landing, page one's changed row took its new status,
  // and the list is still three rows rather than five.
  assert.ok(screen.getByText('Oldest'), 'a poll must not discard a page the reader scrolled to');
  assert.equal(screen.getAllByText('Newest').length, 1);
  assert.ok(screen.getByText('imported'));
  assert.equal(document.querySelectorAll('ul.downloads > li').length, 3);
});

test('the search term filters rows from every page loaded, not only the newest', async (t) => {
  // The term stays a client-side filter through the pagination, so what it
  // must not do is stop reaching a page the reader has already scrolled to.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { handedBack } = servePagedDownloads(2);

  render(routed(<Downloads />));
  await handedBack[0];
  await flush();
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await handedBack[1];
  await flush();

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search downloads' }), {
    target: { value: 'oldest' },
  });

  assert.ok(screen.getByText('Oldest'));
  assert.ok(gone('Newest'));
  assert.ok(gone('Middle'));
});

// Two clients can each be running a job the other knows nothing about, and
// `nzo_id` is unique only within one SABnzbd — so once #34 made a second client
// reachable, two untracked entries can arrive sharing a `ref`.
//
// The console is asserted on rather than the rows, because keying on `ref`
// alone does *not* visibly drop a row on first render: React renders both and
// complains that the behaviour "may cause children to be duplicated and/or
// omitted" and "could change in a future version". That warning is the whole
// observable defect on mount, and this screen re-renders this list every three
// seconds from a poll, which is exactly the update React is declining to
// promise anything about.
test('two untracked entries from different clients sharing a ref are keyed apart', async () => {
  serveDownloads({
    tracked: [],
    untracked: [
      { clientId: 'sab-a', ref: 'nzo_1', name: 'Stranger On A', state: 'downloading', percentage: 5 },
      { clientId: 'sab-b', ref: 'nzo_1', name: 'Stranger On B', state: 'completed', percentage: null },
    ],
    nextCursor: null,
  });

  const complaints: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => complaints.push(args.map(String).join(' '));
  try {
    render(routed(<Downloads />));
    await waitFor(() => assert.ok(screen.getByText('Stranger On A')));
    assert.ok(screen.getByText('Stranger On B'));
  } finally {
    console.error = realError;
  }
  assert.deepEqual(complaints, []);
});
