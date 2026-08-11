import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { DownloadRow } from '../src/components/DownloadRow.tsx';
import { Downloads } from '../src/routes/Downloads.tsx';
import { api, type DownloadsResponse } from '../src/api/client.ts';

// Run unconditionally, unlike the per-test `cleanup()` calls this replaces:
// the new retry test below mounts `Downloads` with its 3-second poll timer
// mocked, and an assertion failure that skips cleanup would leave that timer
// running for real once the mock reverts at test end — the process would
// then hang on an interval nothing is left to clear. `afterEach` runs whether
// the test passed or threw, matching `Failed.test.tsx` and `Browse.test.tsx`.
afterEach(cleanup);

test('a tracked row shows status and offers retry only when failed', () => {
  const { rerender } = render(
    <DownloadRow
      download={{
        id: 1,
        groupId: 1,
        releaseId: 1,
        title: 'Alex Coal',
        kind: 'initial',
        status: 'downloading',
        error: null,
        attempts: 0,
        updatedAt: 1,
      }}
      onRetry={() => {}}
    />,
  );
  assert.equal(screen.queryByRole('button', { name: /retry/i }), null);

  rerender(
    <DownloadRow
      download={{
        id: 1,
        groupId: 1,
        releaseId: 1,
        title: 'Alex Coal',
        kind: 'initial',
        status: 'failed',
        error: 'disk full',
        attempts: 1,
        updatedAt: 1,
      }}
      onRetry={() => {}}
    />,
  );
  assert.ok(screen.getByRole('button', { name: /retry/i }));
  assert.ok(screen.getByText(/disk full/));
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

  render(<Downloads />);
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

  render(<Downloads />);
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

  render(<Downloads />);

  await waitFor(() => assert.ok(screen.getByText('Someone Elses')));
  assert.ok(screen.getByText(/not managed by pickarr/i));
  assert.equal(screen.queryByRole('button', { name: /retry/i }), null);
});
