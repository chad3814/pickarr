import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useGroupMetadata } from '../src/api/useGroupMetadata.ts';
import type { MetadataView } from '../src/api/client.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of it.
afterEach(cleanup);

/**
 * Renders what the hook currently knows, one line per id, so a test can
 * assert on rendered text instead of reaching into the hook directly. The
 * `rearm-<id>` buttons live outside the `<ul>` rather than beside each
 * `<li>`'s own text — nesting one in the same element would fold its label
 * into that `<li>`'s `textContent`, breaking every existing `getByText('N:state')`
 * assertion in this file that has nothing to do with `rearm`.
 */
function Consumer({ ids }: { ids: readonly number[] }) {
  const { metadata, rearm } = useGroupMetadata(ids);
  return (
    <div>
      <ul>
        {ids.map((id) => (
          <li key={id}>{`${id}:${metadata.get(id)?.state ?? 'unknown'}`}</li>
        ))}
      </ul>
      {ids.map((id) => (
        <button key={id} type="button" onClick={() => rearm(id)}>{`rearm-${id}`}</button>
      ))}
    </div>
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

test('rearm re-polls a settled id rather than leaving it unwatched, and never shows it as less settled than it already was', async () => {
  // This is the direct regression test for the bug the Requery button's
  // first cut had: rearming a `confirmed` id must resume this hook's own
  // polling for it (not leave it orphaned), and must never let the display
  // regress to `pending` even if a poll answers with one — which
  // `requeueMetadata`'s own doc says the real server never actually does for
  // an id it has already answered, but the display must not depend on that
  // staying true to avoid blanking a card that already has an answer.
  const ID = 20;
  const original: MetadataView = {
    state: 'confirmed',
    title: 'Original title',
    releaseDate: null,
    durationSeconds: null,
    synopsis: null,
    hasPoster: false,
  };
  const fresher: MetadataView = { ...original, title: 'Fresher title' };
  // Three answers in sequence: the settled answer this hook resolves to
  // before any rearm, a `pending` right after the rearm (the defensive case
  // above), and finally a genuinely different confirmed answer — the one
  // that actually stops the poll, proving it did not just get stuck ignoring
  // every future answer once it declined the `pending` one.
  const answers: MetadataView[] = [original, { state: 'pending' }, fresher];

  let getCalls = 0;
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    getCalls += 1;
    const view = answers[Math.min(getCalls, answers.length) - 1]!;
    return jsonResponse({ [ID]: view });
  }) as unknown as typeof fetch;

  render(<Consumer ids={[ID]} />);
  await waitFor(() => assert.ok(screen.getByText(`${ID}:confirmed`)));
  const callsBeforeRearm = getCalls;

  fireEvent.click(screen.getByRole('button', { name: `rearm-${ID}` }));

  // Re-armed, not orphaned: a second `GET /api/metadata` for this id
  // actually happens.
  await waitFor(() => assert.ok(getCalls > callsBeforeRearm), { timeout: 3_000 });
  // That second answer was `pending`, and it must never reach the screen.
  assert.ok(screen.getByText(`${ID}:confirmed`));
  // #40: never `assert.equal(screen.queryByText(x), null)`.
  assert.ok(!screen.queryByText(`${ID}:pending`));

  // The third answer differs from the pre-rearm snapshot, so the poll stops
  // there instead of chasing a `pending` that was never real forever.
  await waitFor(() => assert.ok(getCalls >= 3), { timeout: 3_000 });
  const callsOnceStopped = getCalls;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(getCalls, callsOnceStopped);
});
