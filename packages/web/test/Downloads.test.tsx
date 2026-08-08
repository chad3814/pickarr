import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { DownloadRow } from '../src/components/DownloadRow.tsx';
import { Downloads } from '../src/routes/Downloads.tsx';
import { api, type DownloadsResponse } from '../src/api/client.ts';

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
  cleanup();
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
  cleanup();
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
  cleanup();
});
