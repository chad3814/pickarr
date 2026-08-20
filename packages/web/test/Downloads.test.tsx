import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { DownloadRow } from '../src/components/DownloadRow.tsx';
import { Downloads } from '../src/routes/Downloads.tsx';
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
 * Never `assert.equal(screen.queryByText(x), null)` — a failed match there
 * formats the whole live DOM to explain itself, which burns real time and
 * reports no test name. Compare the boolean instead, as `Browse.test.tsx`
 * does.
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
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    sent.push(init ?? {});
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  await api.retry(7);
  assert.equal(sent[0]?.headers, undefined);

  await api.pick(1, 2);
  assert.deepEqual(sent[1]?.headers, { 'content-type': 'application/json' });
});

test('a refused retry surfaces instead of vanishing', async () => {
  globalThis.fetch = (async (_input: string, init?: RequestInit) =>
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
          }),
          { headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch;

  render(routed(<Downloads />));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /retry/i })));
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));

  await waitFor(() => assert.ok(screen.getByText(/only a failed download can be retried/i)));
});

test('retry refreshes the row immediately, without waiting on the poll', async (t) => {
  // Enabling only `setInterval` freezes `Downloads`' 3-second poll on a mock
  // clock this test never ticks, while leaving `setTimeout` — what `waitFor`
  // below polls with — running on the real one. So the only way the row can
  // reach `queued` here is the immediate `setData(await api.downloads())` in
  // `Downloads.retry`; the 3-second poll physically cannot fire.
  //
  // This is what pins the regression `setData` guards against: dropping that
  // line still left every assertion below green when nothing froze the poll,
  // because `waitFor`'s real timeout is longer than 3 seconds — it just made
  // the e2e spec 1.6s -> 5.3s slower, waiting the poll interval out inside its
  // own 5-second assertion window. On a loaded CI runner that margin is what
  // turns into an unreproducible flake, and nothing else in the repo pins it.
  t.mock.timers.enable({ apis: ['setInterval'] });

  let retried = false;
  let downloadsRequests = 0;
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      retried = true;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    downloadsRequests += 1;
    const download = {
      id: 1,
      groupId: 1,
      releaseId: 1,
      title: 'Alex Coal',
      kind: 'initial' as const,
      status: retried ? 'queued' : 'failed',
      error: retried ? null : 'disk full',
      attempts: 1,
      updatedAt: 1,
    };
    return new Response(JSON.stringify({ tracked: [download], untracked: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  // `routed`, like every other render here. This test arrived from `main`,
  // where `DownloadRow` had no `<Link>` and needed no Router; this branch gave
  // the title one. Git merged both files without a conflict and the result did
  // not render at all — an empty body, and a missing button rather than a
  // missing Router. CI found it; neither branch could have.
  render(routed(<Downloads />));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /retry/i })));
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));

  await waitFor(() => assert.equal(screen.getByText('queued').textContent, 'queued'));
  // The mount's poll plus the post-retry refresh — two, not three: the mocked
  // interval never ticked, so a third would only be possible if something
  // else re-fetched, and nothing should.
  assert.equal(downloadsRequests, 2);
});

test('untracked entries render inert and labelled', async () => {
  const body: DownloadsResponse = {
    tracked: [],
    untracked: [{ ref: 'x', name: 'Someone Elses', state: 'downloading', percentage: 40 }],
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  render(routed(<Downloads />));

  await waitFor(() => assert.ok(screen.getByText('Someone Elses')));
  assert.ok(screen.getByText(/not managed by pickarr/i));
  assert.equal(screen.queryByRole('button', { name: /retry/i }), null);
});

// The search box. `/api/downloads` returns every row unpaginated and this screen
// re-polls all of it every three seconds (issue #31), so the term filters what
// is already in hand — there is nothing for a server-side query to reach, and a
// term that had to survive a round trip would fight the poll.

/** Answers `/api/downloads` with one fixed body, and nothing else. */
function serveDownloads(body: DownloadsResponse): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

test('typing a term leaves only the tracked rows that match it', async () => {
  serveDownloads({
    tracked: [download({ id: 1, title: 'Alex Coal' }), download({ id: 2, title: 'Riley Reid' })],
    untracked: [],
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
      { ref: 'a', name: 'Someone Elses', state: 'downloading', percentage: 40 },
      { ref: 'b', name: 'Alex Coal Extras', state: 'completed', percentage: 100 },
    ],
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
  globalThis.fetch = (async () => {
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
    return new Response(JSON.stringify({ tracked, untracked: [] } satisfies DownloadsResponse), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

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
