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
