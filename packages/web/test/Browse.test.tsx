import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { Browse } from '../src/routes/Browse.tsx';
import type { BrowseResponse, GroupView, PickResponse } from '../src/api/client.ts';

function group(id: number, title: string): GroupView {
  return {
    id,
    plugin: 'scenes',
    display: { title, fields: [] },
    state: 'new',
    pickedReleaseId: null,
    upgradeReleaseId: null,
    listRankAt: 1000 - id,
    releases: [
      { id: id * 10, score: 1080, quality: { resolution: 1080 }, releaseName: 'R', publishedAt: null },
    ],
  };
}

/**
 * Two pages of one group each, then a pick. `pick` decides what the server
 * says about the picked group's standing afterwards.
 */
function serve(pick: PickResponse['group']): () => string[] {
  const calls: string[] = [];
  const pages = new Map<string, BrowseResponse>([
    ['', { groups: [group(1, 'Alpha')], nextCursor: '999:1' }],
    ['999:1', { groups: [group(2, 'Beta')], nextCursor: null }],
  ]);

  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://test.invalid');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);

    const body =
      url.pathname === '/api/browse'
        ? pages.get(url.searchParams.get('cursor') ?? '')
        : ({
            download: {
              id: 1,
              groupId: 1,
              releaseId: 10,
              title: 'Alpha',
              kind: 'initial',
              status: 'queued',
              error: null,
              attempts: 0,
              updatedAt: 1,
            },
            group: pick,
          } satisfies PickResponse);

    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return () => calls;
}

/**
 * Absence, as a boolean.
 *
 * `assert.equal(screen.queryByText(x), null)` is the obvious spelling and it
 * kills the test run: inside `waitFor` the first check normally fails (the
 * card is still there), and building that AssertionError's message means
 * node:assert deep-inspecting a live DOM element. Retry it a few hundred times
 * and the process is OOM-killed with no output naming a test — a
 * SIGKILL where a one-second timeout was expected.
 */
function gone(text: string): boolean {
  return screen.queryByText(text) === null;
}

async function loadBothPages(): Promise<void> {
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => assert.ok(screen.getByText('Beta')));
}

test('picking after "load more" keeps the pages already loaded', async () => {
  // The regression: picking refetched the first page and replaced the list
  // with it, so the second page vanished and the list snapped back to its
  // original length.
  serve(null);
  await loadBothPages();

  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);

  await waitFor(() => assert.ok(gone('Alpha')));
  assert.ok(screen.getByText('Beta'));
  cleanup();
});

test('a group the server still lists is updated in place, not dropped', async () => {
  // Picking a lesser release leaves the group listed with the better one still
  // on offer. It keeps its position; it does not disappear and it does not
  // move to the end.
  const picked: GroupView = {
    ...group(1, 'Alpha'),
    state: 'picked',
    pickedReleaseId: 10,
    upgradeReleaseId: 11,
  };
  serve(picked);
  await loadBothPages();

  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);

  await waitFor(() => assert.ok(screen.getByText(/upgrade available/i)));
  const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  assert.deepEqual(titles, ['Alpha', 'Beta']);
  cleanup();
});

test('picking costs one request, not a refetch', async () => {
  const calls = serve(null);
  await loadBothPages();
  const beforePick = calls().length;

  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);
  await waitFor(() => assert.ok(gone('Alpha')));

  assert.deepEqual(calls().slice(beforePick), ['POST /api/groups/1/pick']);
  cleanup();
});
