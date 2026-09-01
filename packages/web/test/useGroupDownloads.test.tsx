import { test, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, waitFor } from '@testing-library/react';
import { useGroupDownloads, POLL_MS, type GroupDownloadsHandle } from '../src/api/useGroupDownloads.ts';
import type { DownloadView, ReleaseDownloadView, ReleaseDownloadsResponse } from '../src/api/client.ts';
import { fetchStub, jsonResponse } from './fetchStub.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM (and this hook's `setInterval`) behind, and
// every later test would share it.
afterEach(cleanup);

/**
 * Runs `callback` inside a mounted component and hands back a box whose
 * `current` always holds the latest value it returned — updated on every
 * re-render, not just the first.
 *
 * There is no `@testing-library/react-hooks` (or equivalent) in this repo, so
 * this is the smallest thing that lets a test read a hook's return value
 * without going through rendered text: `render` runs `Harness` synchronously
 * before returning, so `box` is always set by the time this function hands it
 * back, and every later re-render (a poll landing, a `patch` call) mutates the
 * same object a test already holds a reference to.
 */
function renderHook<T>(callback: () => T): { current: T } {
  let box: { current: T } | undefined;
  function Harness() {
    const value = callback();
    if (box === undefined) box = { current: value };
    else box.current = value;
    return null;
  }
  render(<Harness />);
  if (box === undefined) throw new Error('renderHook: the harness never rendered');
  return box;
}

/**
 * Installs a `/api/downloads/for-groups` stub for the duration of one test,
 * and restores `fetch` after it (via `t.after`, so a failing test still
 * restores it rather than leaking the stub into whichever test runs next).
 *
 * A request to any other path is still rejected, so the hook's own poll
 * takes its error path exactly as it would against a real wrong URL — but
 * the path is also pushed onto the returned array first. `poll()`'s catch-all
 * has no channel to report a failure through (see its own doc), so a request
 * gone to the wrong place used to fail a test with a generic `waitFor`
 * timeout and never the stub's own message naming the path. Every test below
 * asserts this array is empty, which is what makes "no unexpected request was
 * made" a checked property rather than a hope — Tasks 6-8 wire this hook up
 * for the first time, and a wrong URL is exactly the mistake a first wiring
 * makes.
 */
function stubReleaseDownloads(
  t: TestContext,
  handler: (ids: number[]) => ReleaseDownloadsResponse,
): { unexpectedPaths: string[] } {
  const state: { unexpectedPaths: string[] } = { unexpectedPaths: [] };
  const original = globalThis.fetch;
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname !== '/api/downloads/for-groups') {
      state.unexpectedPaths.push(url.pathname);
      throw new Error(`unexpected request to ${url.pathname}`);
    }
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .filter((part) => part.length > 0)
      .map(Number);
    return jsonResponse(handler(ids));
  });
  t.after(() => {
    globalThis.fetch = original;
  });
  return state;
}

/** A `ReleaseDownloadView`, defaulted to a healthy in-progress download. */
function dl(over: Partial<ReleaseDownloadView> = {}): ReleaseDownloadView {
  return { downloadId: 1, status: 'downloading', error: null, absentSince: null, ...over };
}

/** A `DownloadView`, defaulted the same way `Downloads.test.tsx`'s own `download()` is. */
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

/** Waits out `ms` of real wall-clock time. See `useGroupMetadata.test.tsx` for why this suite runs its polls on the real clock rather than a mocked one. */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('an empty watch list issues no request at all', async (t) => {
  const calls: number[][] = [];
  const stub = stubReleaseDownloads(t, (ids) => {
    calls.push(ids);
    return {};
  });
  renderHook(() => useGroupDownloads([]));
  await tick(50);
  assert.deepEqual(calls, []);
  assert.deepEqual(stub.unexpectedPaths, []);
});

test('the first poll lands and is keyed group then release', async (t) => {
  const stub = stubReleaseDownloads(t, () => ({ 7: { 70: dl({ status: 'downloading' }) } }));
  const handle: { current: GroupDownloadsHandle } = renderHook(() => useGroupDownloads([7]));
  await waitFor(() => {
    // Checked first: if the request went to the wrong place, this fails with
    // the actual bad path instead of the generic "status is undefined" a
    // request that simply never landed would also produce.
    assert.deepEqual(stub.unexpectedPaths, []);
    assert.equal(handle.current.downloads.get(7)?.get(70)?.status, 'downloading');
  });
});

test('more than a hundred ids are chunked rather than sent in one request', async (t) => {
  const calls: number[][] = [];
  const stub = stubReleaseDownloads(t, (ids) => {
    calls.push(ids);
    return {};
  });
  renderHook(() => useGroupDownloads(Array.from({ length: 250 }, (_, i) => i + 1)));
  await waitFor(() => {
    assert.deepEqual(stub.unexpectedPaths, []);
    assert.equal(calls.length, 3);
  });
  assert.deepEqual(calls.map((batch) => batch.length), [100, 100, 50]);
});

test('a patch shows immediately and is not lost by the next poll', async (t) => {
  let answer: ReleaseDownloadsResponse = { 7: { 70: dl({ status: 'failed' }) } };
  const stub = stubReleaseDownloads(t, () => answer);
  const handle: { current: GroupDownloadsHandle } = renderHook(() => useGroupDownloads([7]));
  await waitFor(() => {
    assert.deepEqual(stub.unexpectedPaths, []);
    assert.equal(handle.current.downloads.get(7)?.get(70)?.status, 'failed');
  });

  // The retry's own response, patched in rather than waited for — this is the
  // whole reason `patch` exists: a poll is up to `POLL_MS` away and the button
  // must not look like it did nothing.
  // `waitFor` rather than a bare assert: React 18 batches a `setState` called
  // from plain code (not a DOM event) into a microtask flush, so the update
  // is real but not synchronous with this call.
  handle.current.patch(download({ id: 1, groupId: 7, releaseId: 70, status: 'queued' }));
  await waitFor(() => {
    assert.deepEqual(stub.unexpectedPaths, []);
    assert.equal(handle.current.downloads.get(7)?.get(70)?.status, 'queued');
  });

  answer = { 7: { 70: dl({ status: 'queued' }) } };
  await tick(POLL_MS + 50);
  assert.equal(handle.current.downloads.get(7)?.get(70)?.status, 'queued');
  assert.deepEqual(stub.unexpectedPaths, []);
});

test('a watched group with nothing downloading keeps an empty entry rather than losing its key', async (t) => {
  // The endpoint answers `{}` for such a group, and that is not the same as
  // omitting it: the caller (Task 6) stops watching a group on the strength
  // of an empty answer, and cannot tell "asked, nothing downloading" from
  // "never asked" if the key disappears on the way through this hook.
  const stub = stubReleaseDownloads(t, () => ({ 7: {}, 8: { 80: dl({ status: 'downloading' }) } }));
  const handle: { current: GroupDownloadsHandle } = renderHook(() => useGroupDownloads([7, 8]));

  // Group 8 is what this waits on — group 7 answering `{}` is not itself a
  // change `waitFor` could ever detect, since an empty `Map` synchronises on
  // nothing. Group 8's arrival is the signal that the same poll's answer for
  // group 7 has landed too.
  await waitFor(() => {
    assert.deepEqual(stub.unexpectedPaths, []);
    assert.equal(handle.current.downloads.get(8)?.get(80)?.status, 'downloading');
  });
  assert.equal(handle.current.downloads.has(7), true);
  assert.equal(handle.current.downloads.get(7)?.size, 0);
  assert.deepEqual(stub.unexpectedPaths, []);
});
