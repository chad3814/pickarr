import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useGroupMetadata } from '../src/api/useGroupMetadata.ts';
import type { MetadataView } from '../src/api/client.ts';
import { fetchStub, jsonResponse } from './fetchStub.ts';

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
 *
 * The `title-<id>` lines are their own nodes for the same reason. A requery's
 * whole point is an answer that is `confirmed` both before and after, so
 * `state` alone cannot tell a fresher answer from the one it replaced — the
 * title can, and the tests that drive the sequence the real server emits need
 * exactly that distinction.
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
      {ids.map((id) => {
        const view = metadata.get(id);
        const title = view?.state === 'confirmed' ? view.title ?? '-' : '-';
        return <p key={id}>{`title-${id}:${title}`}</p>;
      })}
      {ids.map((id) => (
        <button key={id} type="button" onClick={() => rearm(id)}>{`rearm-${id}`}</button>
      ))}
    </div>
  );
}

/**
 * Moves `Date.now` forward without touching the real clock anything else runs
 * on — the same shape as `spyOnSetTimeoutDelays` below, and installed for the
 * duration of one test with a `finally` restore.
 *
 * This is how a test reaches a rearm's wall-clock deadline
 * (`REARM_WATCH_MS`, two minutes) in under a second. Mocked timers are not an
 * option in this file for the reason that helper documents, and the hook's own
 * polls have to keep running on the real clock for the deadline to be
 * *observed* at all: it is checked when a poll's answer arrives, not by a
 * timer of its own.
 */
function skewClock(): { advance: (ms: number) => void; restore: () => void } {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow.call(Date) + offset;
  return {
    advance: (ms: number) => {
      offset += ms;
    },
    restore: () => {
      Date.now = realNow;
    },
  };
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
  globalThis.fetch = fetchStub(async (input, init) => {
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
  });

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
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      requestCalls += 1;
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    return jsonResponse({ 9: { state: 'none' } });
  });

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
  globalThis.fetch = fetchStub(async (input) => {
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
            hasBackground: false,
          };
    return jsonResponse({ 5: view });
  });

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
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    const view: MetadataView = { state: 'pending', nextAttemptAt: farFuture };
    return jsonResponse({ 11: view });
  });

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
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    const view: MetadataView = { state: 'pending', nextAttemptAt: justBehind };
    return jsonResponse({ 12: view });
  });

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
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    getCalls += 1;
    return jsonResponse({ 13: { state: 'pending' } });
  });

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

  globalThis.fetch = fetchStub(async (input, init) => {
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
  });

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
    hasBackground: false,
  };
  const fresher: MetadataView = { ...original, title: 'Fresher title' };
  // Three answers in sequence: the settled answer this hook resolves to
  // before any rearm, a `pending` right after the rearm (the defensive case
  // above), and finally a genuinely different confirmed answer — the one
  // that actually stops the poll, proving it did not just get stuck ignoring
  // every future answer once it declined the `pending` one.
  const answers: MetadataView[] = [original, { state: 'pending' }, fresher];

  let getCalls = 0;
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    getCalls += 1;
    const view = answers[Math.min(getCalls, answers.length) - 1]!;
    return jsonResponse({ [ID]: view });
  });

  render(<Consumer ids={[ID]} />);
  await waitFor(() => assert.ok(screen.getByText(`${ID}:confirmed`)));
  const callsBeforeRearm = getCalls;

  fireEvent.click(screen.getByRole('button', { name: `rearm-${ID}` }));

  // Re-armed, not orphaned: a second `GET /api/metadata` for this id
  // actually happens.
  await waitFor(() => assert.ok(getCalls > callsBeforeRearm), { timeout: 3_000 });
  // That second answer was `pending`, and it must never reach the screen.
  assert.ok(screen.getByText(`${ID}:confirmed`));
  assert.ok(!screen.queryByText(`${ID}:pending`));

  // The third answer differs from the pre-rearm snapshot, so the poll stops
  // there instead of chasing a `pending` that was never real forever.
  await waitFor(() => assert.ok(getCalls >= 3), { timeout: 3_000 });
  const callsOnceStopped = getCalls;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(getCalls, callsOnceStopped);
});

/**
 * The answer sequence a real requery actually produces, and the one the two
 * tests below drive: `[original, original, …, fresher]`.
 *
 * The test above stubs a `pending` in the middle, which is a defensive case
 * the server never emits — `requeueMetadata` does not touch `group_metadata`
 * and `metadataViewOf` short-circuits on the answer row, so a group with an
 * answer reads back as that answer no matter what its queue row says. That
 * makes it the wrong sequence to prove the feature works: an artificial
 * `pending` keeps the poll alive through `stillWatching`'s `state === 'pending'`
 * branch, so `sameMetadata` could be broken outright and the poll would still
 * reach the fresher answer. Replacing `sameMetadata` with `() => false` must
 * fail the two tests below, and does.
 */
const ORIGINAL: MetadataView = {
  state: 'confirmed',
  title: 'Original title',
  releaseDate: null,
  durationSeconds: null,
  synopsis: null,
  hasPoster: false,
  hasBackground: false,
};
const FRESHER: MetadataView = { ...ORIGINAL, title: 'Fresher title' };

test('a rearmed id polls through an unchanged answer and lands the fresher one — the sequence the real server emits', async () => {
  const ID = 21;
  // By call: the hook's own mount-time answer, the *same* answer again right
  // after the requery (the worker has not drained the requeued row yet, and
  // there is nothing on the wire to say so), and finally the new one.
  const answers: MetadataView[] = [ORIGINAL, ORIGINAL, FRESHER];

  let getCalls = 0;
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 0, alreadyAnswered: 1, pending: 0, missing: 0, unavailable: 0 });
    }
    getCalls += 1;
    return jsonResponse({ [ID]: answers[Math.min(getCalls, answers.length) - 1]! });
  });

  render(<Consumer ids={[ID]} />);
  await waitFor(() => assert.ok(screen.getByText(`title-${ID}:Original title`)));
  const callsBeforeRearm = getCalls;

  fireEvent.click(screen.getByRole('button', { name: `rearm-${ID}` }));

  // The second answer is byte-identical to the pre-rearm one, and that is
  // precisely what must *not* end the watch: this is the round where a broken
  // `sameMetadata` stops polling and the fresher answer below never arrives
  // without a reload.
  await waitFor(() => assert.ok(getCalls > callsBeforeRearm), { timeout: 3_000 });
  assert.ok(screen.getByText(`title-${ID}:Original title`));

  await waitFor(() => assert.ok(screen.getByText(`title-${ID}:Fresher title`)), { timeout: 3_000 });
  assert.ok(!screen.queryByText(`title-${ID}:Original title`));

  // And it stops there rather than carrying on against an answer it has
  // already accepted.
  const callsOnceStopped = getCalls;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(getCalls, callsOnceStopped);
});

test('a rearm gives up after its deadline instead of polling an unchanged answer forever, and a second press re-arms it', async () => {
  const ID = 22;
  // The modal outcome of a requery: the provider says exactly the same thing
  // it said before, so no poll will ever see a difference. Without a deadline
  // this is one `GET /api/metadata` every 8 seconds for as long as the route
  // stays mounted.
  const ID_ANSWER = { current: ORIGINAL };

  let getCalls = 0;
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 0, alreadyAnswered: 1, pending: 0, missing: 0, unavailable: 0 });
    }
    getCalls += 1;
    return jsonResponse({ [ID]: ID_ANSWER.current });
  });

  const clock = skewClock();
  try {
    render(<Consumer ids={[ID]} />);
    await waitFor(() => assert.ok(screen.getByText(`title-${ID}:Original title`)));
    const callsBeforeRearm = getCalls;

    fireEvent.click(screen.getByRole('button', { name: `rearm-${ID}` }));
    await waitFor(() => assert.ok(getCalls > callsBeforeRearm), { timeout: 3_000 });

    // Past the two-minute watch. The deadline is read when a poll's answer
    // lands, so exactly one more poll happens and it is the one that drops
    // the id.
    clock.advance(3 * 60_000);
    await waitFor(() => assert.ok(getCalls >= callsBeforeRearm + 2), { timeout: 3_000 });
    const callsOnceGivenUp = getCalls;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(getCalls, callsOnceGivenUp, 'the watch expired instead of polling forever');

    // What the user is left with: the answer the card already had, still on
    // screen — nothing blanked, nothing claimed to have changed.
    assert.ok(screen.getByText(`title-${ID}:Original title`));

    // And the way out is the button itself. A second press stores a fresh
    // deadline, so the bound is per press rather than per session — this one
    // finds the answer the expired watch never saw.
    ID_ANSWER.current = FRESHER;
    fireEvent.click(screen.getByRole('button', { name: `rearm-${ID}` }));
    await waitFor(() => assert.ok(screen.getByText(`title-${ID}:Fresher title`)), { timeout: 3_000 });
  } finally {
    clock.restore();
  }
});

test('rearming before the hook has any answer of its own still watches the id', async () => {
  // The window is real: the Requery button renders from the route's own
  // `group.metadata`, so it is clickable before this hook's first
  // `GET /api/metadata` comes back — and again for every "Load more" page.
  // With no answer to snapshot, the id used to be fetched once as merely
  // unknown, resolve on the *pre-requery* answer the server is still
  // reporting, and need a reload to ever show the requery's result.
  const ID = 23;
  const answers: MetadataView[] = [ORIGINAL, FRESHER];

  let getCalls = 0;
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 0, alreadyAnswered: 1, pending: 0, missing: 0, unavailable: 0 });
    }
    getCalls += 1;
    if (getCalls === 1) {
      // Hangs until the rearm's own effect re-run aborts it, which is what
      // "the click landed before the first answer did" means in practice.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return jsonResponse({ [ID]: answers[Math.min(getCalls - 1, answers.length) - 1]! });
  });

  render(<Consumer ids={[ID]} />);
  // In flight and unanswered: the hook knows nothing about this id yet.
  await waitFor(() => assert.ok(getCalls === 1));
  assert.ok(screen.getByText(`${ID}:unknown`));

  fireEvent.click(screen.getByRole('button', { name: `rearm-${ID}` }));

  // The first answer to arrive after the rearm is the old one, and it becomes
  // the baseline rather than ending the watch — so the fresher answer lands
  // without a reload.
  await waitFor(() => assert.ok(screen.getByText(`title-${ID}:Original title`)), { timeout: 3_000 });
  await waitFor(() => assert.ok(screen.getByText(`title-${ID}:Fresher title`)), { timeout: 3_000 });
});

// `refreshed` on the POST response. The server re-asks a `'none'` answer that
// has gone stale, and the id it re-asked is one this hook has already stopped
// watching — a settled answer drops out of `unresolved` for the rest of the
// mount. Without the rearm the new answer would sit unread until a reload, which
// is the whole reason the route reports which ids it refreshed rather than only
// how many.

test('an id the server reports as refreshed is watched again, with no button pressed', async () => {
  const ID = 4;
  let gets = 0;
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({
        queued: 1, alreadyAnswered: 0, pending: 0, missing: 0, unavailable: 0, refreshed: [ID],
      });
    }
    gets += 1;
    // The stale answer the card already had, then the answer the re-ask found.
    // A hook that stopped watching on the first would never reach the second.
    const view: MetadataView =
      gets === 1
        ? { state: 'none' }
        : {
            state: 'confirmed',
            title: 'Found on the retry',
            releaseDate: null,
            durationSeconds: null,
            synopsis: null,
            hasPoster: false,
            hasBackground: false,
          };
    return jsonResponse({ [ID]: view });
  });

  render(<Consumer ids={[ID]} />);

  // Deliberately not `waitFor('4:none')` first. The DOM does pass through that
  // state, but observing it is a race this test kept losing under a loaded
  // suite: `waitFor` polls on an interval, and when the rearm is quick both
  // commits land between two polls, so the first check it makes already reads
  // `confirmed`. Asserting an intermediate render the implementation is under no
  // obligation to hold still for tests nothing and fails at random.
  //
  // The property survives without it. The stub answers `'none'` first and can
  // only answer `'confirmed'` on a *second* GET, so a hook that stopped watching
  // at the settled answer — the behaviour before `refreshed` existed — leaves the
  // title at `-` forever. Reaching the title at all is the whole claim, and
  // nothing clicked `rearm-4` to get there.
  await waitFor(() => assert.ok(screen.getByText(`title-${ID}:Found on the retry`)), { timeout: 3_000 });
  assert.ok(gets >= 2, 'the confirmed answer can only have come from a second poll');
});

test('a response with no refreshed field settles as before', async () => {
  // Every server built before this field sends exactly this, and so does every
  // ordinary request where nothing went stale. Treating an absent field as
  // "rearm everything" would turn the lazy trigger into a permanent poll of the
  // whole page, which is the property `unresolved` exists to protect.
  const ID = 5;
  let gets = 0;
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/request') {
      return jsonResponse({ queued: 1, alreadyAnswered: 0, pending: 0, missing: 0 });
    }
    gets += 1;
    return jsonResponse({ [ID]: { state: 'none' } satisfies MetadataView });
  });

  render(<Consumer ids={[ID]} />);
  await waitFor(() => assert.ok(screen.getByText(`${ID}:none`)));

  const settledAfter = gets;
  // Comfortably longer than the hook's first backoff step, so a hook that kept
  // watching would have polled again by now.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(gets, settledAfter, 'a settled id with no refresh is not polled again');
});
