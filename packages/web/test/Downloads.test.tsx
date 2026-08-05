import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { DownloadRow } from '../src/components/DownloadRow.tsx';
import { Downloads } from '../src/routes/Downloads.tsx';
import type { DownloadsResponse } from '../src/api/client.ts';

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
