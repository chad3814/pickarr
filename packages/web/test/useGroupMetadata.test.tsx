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

/**
 * Records every delay passed to the real `setTimeout`, without replacing its
 * behaviour — every call still runs for real, on the real clock.
 *
 * A fake-timer clock (`t.mock.timers`) was the first thing tried here and it
 * hangs forever: this test environment's `act`/effect flush (React committing
 * `useEffect`, which is what starts the hook's first poll at all) turns out
 * to itself go through `setTimeout`, so mocking it stalls the very effect the
 * test is waiting on, not just the hook's own backoff. Recording the real
 * calls sidesteps that entirely — the hook's poll still runs on the real
 * clock, and the test only ever inspects what delay it *asked for*, never
 * waiting for a 5-minute cap to actually elapse.
 */
function spyOnSetTimeoutDelays(): { delays: number[]; restore: () => void } {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  const spy = (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof ms === 'number') delays.push(ms);
    return original(handler as never, ms, ...args);
  };
  // `setTimeout`'s real type also carries a `__promisify__` static property
  // (from `util.promisify`'s custom-promisified-function marker), which a
  // plain function literal does not have. This spy is only ever installed on
  // `globalThis` for the duration of one test and nothing here calls
  // `util.promisify(setTimeout)`, so the cast through `unknown` is safe: nothing
  // observes the missing property.
  globalThis.setTimeout = spy as unknown as typeof setTimeout;
  return {
    delays,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
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

test('a group deferred for hours schedules its next check at the cap, not the 8s ladder', async () => {
  // The whole point of reading `next_at` instead of guessing: a group the
  // worker will not retry for hours must stop costing a request every few
  // seconds, but a tab left open still has to notice eventually. Asserting on
  // the delay the hook actually asks `setTimeout` for — rather than waiting
  // for 5 real minutes to elapse — is what makes this both exact and fast;
  // see `spyOnSetTimeoutDelays` for why fake timers cannot be used here.
  const CAP_MS = 5 * 60_000;
  const farFuture = Date.now() + 6 * 60 * 60_000; // deferred six hours out
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    const view: MetadataView = { state: 'pending', nextAttemptAt: farFuture };
    return jsonResponse({ 11: view });
  }) as unknown as typeof fetch;

  const spy = spyOnSetTimeoutDelays();
  try {
    render(<Consumer ids={[11]} />);
    await waitFor(() => assert.ok(screen.getByText('11:pending')));

    assert.ok(
      spy.delays.includes(CAP_MS),
      `expected the 5-minute cap to be scheduled; saw ${JSON.stringify(spy.delays)}`,
    );
    assert.ok(
      !spy.delays.includes(8_000),
      'must not still be using the fixed ladder\'s 8s ceiling once next_at is hours away',
    );
  } finally {
    spy.restore();
  }
});

test('a group merely waiting its turn schedules its next check at the floor, not immediately', async () => {
  // next_at "in the past" (or a few ms from now) is the ordinary case — a
  // group behind others the worker has not reached yet this tick, not an
  // outage. The floor keeps that from becoming a hot loop while staying far
  // more responsive than a deferred group — the other half of the
  // self-tuning property the cap test above proves.
  const FLOOR_MS = 5_000;
  const justBehind = Date.now() - 10_000; // waiting its turn, next_at already past
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    const view: MetadataView = { state: 'pending', nextAttemptAt: justBehind };
    return jsonResponse({ 12: view });
  }) as unknown as typeof fetch;

  const spy = spyOnSetTimeoutDelays();
  try {
    render(<Consumer ids={[12]} />);
    await waitFor(() => assert.ok(screen.getByText('12:pending')));

    assert.ok(
      spy.delays.includes(FLOOR_MS),
      `expected the 5s floor for a next_at already past; saw ${JSON.stringify(spy.delays)}`,
    );
  } finally {
    spy.restore();
  }
});

test('a pending id with no nextAttemptAt falls back to the escalating ladder', async () => {
  // An older server, or any state carrying no queue row, sends `pending`
  // with nothing else. This must keep working exactly as it did before
  // `nextAttemptAt` existed: doubling from the 500ms start, capped at 8s —
  // never left guessing at the server's clock when the server said nothing.
  let getCalls = 0;
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    getCalls += 1;
    return jsonResponse({ 13: { state: 'pending' } });
  }) as unknown as typeof fetch;

  const spy = spyOnSetTimeoutDelays();
  try {
    render(<Consumer ids={[13]} />);
    await waitFor(() => assert.ok(screen.getByText('13:pending')));

    // The first still-pending schedule is the ladder's own 500ms start —
    // proof this path is untouched by the server-driven branch above.
    assert.ok(spy.delays.includes(500), `expected the 500ms ladder start; saw ${JSON.stringify(spy.delays)}`);

    // Real time, not mocked: waiting past that first step lets a second poll
    // fire and schedule the ladder's next (doubled) step.
    await waitFor(() => assert.ok(getCalls >= 2), { timeout: 2_000 });
    assert.ok(
      spy.delays.includes(1_000),
      `expected the ladder to double to 1000ms; saw ${JSON.stringify(spy.delays)}`,
    );
  } finally {
    spy.restore();
  }
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
