import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { useGroupMetadata } from '../src/api/useGroupMetadata.ts';
import type { MetadataView } from '../src/api/client.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of it.
afterEach(cleanup);

/** Renders what the hook currently knows, one line per id, so a test can
 * assert on rendered text instead of reaching into the hook directly. */
function Consumer({ ids }: { ids: readonly number[] }) {
  const metadata = useGroupMetadata(ids);
  return (
    <ul>
      {ids.map((id) => (
        <li key={id}>{`${id}:${metadata.get(id)?.state ?? 'unknown'}`}</li>
      ))}
    </ul>
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

test('a page of ids is requested once, not once per card', async () => {
  const requestBodies: number[][] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      const body = JSON.parse(String(init?.body)) as { groupIds: number[] };
      requestBodies.push(body.groupIds);
      return jsonResponse({ queued: body.groupIds.length, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    if (url.pathname === '/api/metadata') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((part) => part.length > 0);
      const response: Record<number, MetadataView> = {};
      for (const id of ids) response[Number(id)] = { state: 'none' };
      return jsonResponse(response);
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  }) as unknown as typeof fetch;

  render(<Consumer ids={[1, 2, 3]} />);
  await waitFor(() => assert.ok(screen.getByText('1:none')));

  // One POST, carrying every id the page rendered — not three POSTs, one per
  // card. This is the invariant "break on purpose" below breaks and un-breaks.
  assert.equal(requestBodies.length, 1);
  assert.deepEqual(requestBodies[0], [1, 2, 3]);
});

test('a re-render with the same ids costs no request', async () => {
  // The caller (Browse) rebuilds the ids array on every render, so its
  // identity changes on renders that changed nothing about which groups are
  // on screen. Keyed on that identity, the hook would re-ask on every one of
  // them — the same failure mode `useIdentityPreview`'s equivalent test
  // guards against.
  let requestCalls = 0;
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      requestCalls += 1;
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    return jsonResponse({ 9: { state: 'none' } });
  }) as unknown as typeof fetch;

  const { rerender } = render(<Consumer ids={[9]} />);
  await waitFor(() => assert.ok(screen.getByText('9:none')));
  assert.equal(requestCalls, 1);

  rerender(<Consumer ids={[9]} />);
  rerender(<Consumer ids={[9]} />);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(requestCalls, 1);
});

test('polling stops once nothing is pending', async () => {
  let getCalls = 0;
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    getCalls += 1;
    // Pending on the first answer (the worker has not run yet), confirmed on
    // every one after — a group's answer settles and stays settled.
    const view: MetadataView =
      getCalls === 1
        ? { state: 'pending' }
        : {
            state: 'confirmed',
            title: 'A title',
            performers: [],
            releaseDate: null,
            durationSeconds: null,
            synopsis: null,
            hasPoster: false,
          };
    return jsonResponse({ 5: view });
  }) as unknown as typeof fetch;

  render(<Consumer ids={[5]} />);
  await waitFor(() => assert.ok(screen.getByText('5:pending')));
  await waitFor(() => assert.ok(screen.getByText('5:confirmed')), { timeout: 3_000 });

  const callsOnceConfirmed = getCalls;
  // Comfortably longer than the hook's own backoff would wait before polling
  // again, so a poller that failed to stop would have already made another
  // call by the time this checks.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(getCalls, callsOnceConfirmed);
});

test('unmounting cancels in-flight work rather than letting it land late', async () => {
  let released: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    released = resolve;
  });
  let aborted = false;

  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://test.invalid');
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
    });
    if (url.pathname === '/api/metadata/request') {
      await held;
      if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError');
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    return jsonResponse({ 3: { state: 'none' } });
  }) as unknown as typeof fetch;

  const { unmount } = render(<Consumer ids={[3]} />);
  unmount();
  released?.();
  // Nothing to assert on the DOM — it is gone — but the fetch that was still
  // in flight must have been told to stop rather than resolving into a
  // component that no longer exists.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(aborted);
});
