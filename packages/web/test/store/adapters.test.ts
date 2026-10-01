import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { realFetch, idleScheduler, realEventStream } from '../../src/store/adapters.ts';

/**
 * Everything a test stubs on a global here is undone in `afterEach`, which
 * runs whether the test passed or threw (`CLAUDE.md`: a failing test that
 * skips its own cleanup can hang the whole file). Nothing in this file opens
 * a timer or a channel that outlives its test, so there is nothing here that
 * *would* hang -- but restoring globals unconditionally is what keeps one
 * test's stub from leaking into the next regardless.
 */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Replaces `globalThis.fetch` for the duration of one test and records every
 * call, restoring the original in `afterEach` via the caller's `cleanups`
 * array.
 */
function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): { calls: [RequestInfo | URL, RequestInit | undefined][] } {
  const original = globalThis.fetch;
  const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    return impl(input, init);
  };
  cleanups.push(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

/**
 * Adds a `requestIdleCallback`/`cancelIdleCallback` pair to `globalThis` for
 * the duration of one test. Absent in this test:server environment by
 * default (Node has neither), which is exactly what the fallback test below
 * relies on needing no stubbing at all.
 *
 * `Reflect.deleteProperty` rather than the `delete` operator to remove it
 * afterwards: `requestIdleCallback`/`cancelIdleCallback` are declared as
 * plain (non-optional) ambient globals, so `delete globalThis.requestIdleCallback`
 * does not type-check -- TypeScript only allows `delete` on an optional
 * property. `Reflect.deleteProperty` is untyped in exactly the way this
 * needs and does the same thing at runtime.
 */
function stubIdleCallback(): {
  calls: [IdleRequestCallback, IdleRequestOptions | undefined][];
  cancelled: number[];
} {
  const calls: [IdleRequestCallback, IdleRequestOptions | undefined][] = [];
  const cancelled: number[] = [];
  let nextHandle = 1;
  globalThis.requestIdleCallback = (callback: IdleRequestCallback, options?: IdleRequestOptions) => {
    calls.push([callback, options]);
    const handle = nextHandle;
    nextHandle += 1;
    return handle;
  };
  globalThis.cancelIdleCallback = (handle: number) => {
    cancelled.push(handle);
  };
  cleanups.push(() => {
    Reflect.deleteProperty(globalThis, 'requestIdleCallback');
    Reflect.deleteProperty(globalThis, 'cancelIdleCallback');
  });
  return { calls, cancelled };
}

/**
 * Records every delay passed to the real `setTimeout` and every handle
 * passed to the real `clearTimeout`, without replacing either's behaviour --
 * every call still runs for real, on the real clock. Fake timers
 * (`t.mock.timers`) hang this suite (`CLAUDE.md`); this sidesteps that
 * entirely by never touching timer *behaviour*, only observing the
 * arguments each real call was made with.
 *
 * `setTimeout`'s real type also carries a `__promisify__` static property
 * (from `util.promisify`'s custom-promisified-function marker), which a
 * plain function literal does not have. This spy is only ever installed on
 * `globalThis` for the duration of one test and nothing here calls
 * `util.promisify(setTimeout)`, so the cast through `unknown` is safe:
 * nothing observes the missing property. (Same shape as the deleted
 * `useGroupMetadata.test.tsx`'s `spyOnSetTimeoutDelays`, `CLAUDE.md`.)
 */
function spyOnRealTimer(): {
  setTimeoutCalls: [TimerHandler, number | undefined][];
  clearedHandles: (NodeJS.Timeout | string | number | undefined)[];
} {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const setTimeoutCalls: [TimerHandler, number | undefined][] = [];
  const clearedHandles: (NodeJS.Timeout | string | number | undefined)[] = [];
  const spySetTimeout = (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    setTimeoutCalls.push([handler, ms]);
    return originalSetTimeout(handler, ms, ...args);
  };
  // The one cast in this file, and it is not a type error being silenced: in
  // this tsconfig `globalThis.setTimeout` is Node's, returning `Timeout`,
  // while the call expression above resolves to the DOM overload, returning
  // `number`. So the two ends of the assignment disagree about the platform.
  // Two honest routes were measured and are worse: dropping the cast fails
  // TS2741 for a missing `__promisify__`, and carrying that property forward
  // with `Object.assign` then fails TS2322 on `number` vs `Timeout`. The spy
  // itself is correct; the environment declares one global twice.
  globalThis.setTimeout = spySetTimeout as unknown as typeof setTimeout;
  globalThis.clearTimeout = (handle?: NodeJS.Timeout | string | number) => {
    clearedHandles.push(handle);
    originalClearTimeout(handle);
  };
  cleanups.push(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  return { setTimeoutCalls, clearedHandles };
}

test('realFetch hands window.fetch the signal it was given', async () => {
  const { calls } = stubFetch(async () => new Response('{}', { status: 200 }));
  const controller = new AbortController();

  await realFetch('https://test.invalid/api/sync/tail', controller.signal);

  assert.equal(calls.length, 1);
  const [, init] = calls[0] ?? [undefined, undefined];
  assert.equal(init?.signal, controller.signal, 'the exact signal realFetch was given must reach fetch, or the store\'s one-minute deadline does nothing');
});

test('realFetch sends credentials so the session cookie travels', async () => {
  const { calls } = stubFetch(async () => new Response('{}', { status: 200 }));

  await realFetch('https://test.invalid/api/sync/tail', new AbortController().signal);

  const [, init] = calls[0] ?? [undefined, undefined];
  assert.equal(init?.credentials, 'same-origin', 'the client authenticates with the browser\'s own cookie jar and nothing else (design spec §4)');
});

test('realFetch answers a SyncResponse, not a Response', async () => {
  stubFetch(async () => new Response(JSON.stringify({ queued: 3 }), { status: 200 }));

  const response = await realFetch('https://test.invalid/api/sync/tail', new AbortController().signal);

  // Only the three members SyncResponse declares -- ok, status, json() --
  // are read here. Nothing reaches for headers, .text() or any other
  // Response-only member, because the store's own type never gets one.
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { queued: 3 });
});

test('realFetch rejects when handed an already-aborted signal', async () => {
  // Deliberately no `stubFetch`: this is the only test in the file that runs
  // against the platform's own `fetch`. The three above stub it, so they pin
  // the *shape* of the call -- that the identical signal object is forwarded
  // -- and can say nothing about what an abort does. Design spec §7 item 1
  // specifies both halves ("passes the caller's `AbortSignal` to
  // `window.fetch`, and an aborted signal rejects rather than resolving"),
  // and `sync.ts`'s `FETCH_DEADLINE_MS` rests on the second: were an aborted
  // signal ever to resolve, the deadline would silently stop bounding
  // anything and every stubbed-fetch test in that suite would still pass.
  await assert.rejects(
    realFetch('https://test.invalid/api/sync/tail', AbortSignal.abort()),
    // The rejection's *name*, not merely that it rejected. A bare "it
    // rejects" passes with the signal dropped entirely: `test.invalid` is a
    // reserved name that resolves nowhere, so an unsignalled request to it
    // rejects too -- with `TypeError: fetch failed`, once DNS gives up. That
    // is the hollow assertion CLAUDE.md's testing-hazards section is about,
    // reached here by a different route, and it was checked the way that
    // section asks: dropping `signal` from `realFetch` turns this red.
    // `AbortError` is reachable only through the signal.
    { name: 'AbortError' },
    'an aborted signal must reject rather than resolve, or the store\'s one-minute deadline bounds nothing (design spec §7 item 1)',
  );
  // No network is reached, so this stays a unit test and needs no host:
  // `fetch` rejects on an already-aborted signal before it resolves a name
  // or opens a socket -- which is itself what the `AbortError` above, rather
  // than a `TypeError`, proves happened.
});

/** A real timer, not `t.mock.timers` (CLAUDE.md: fake timers hang this suite). Kept short throughout this file's idleScheduler tests so waiting for a real floor to elapse stays a unit test, not an integration one. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('idleScheduler waits out delayMs before ever asking requestIdleCallback for idle time', async () => {
  const idle = stubIdleCallback();
  const timer = spyOnRealTimer();
  let ran = false;

  idleScheduler('backfill', 100, () => {
    ran = true;
  });

  assert.equal(timer.setTimeoutCalls.length, 1, 'the floor is a real setTimeout');
  assert.equal(timer.setTimeoutCalls[0]?.[1], 100, 'the schedule delay is the floor the real setTimeout waits out');
  assert.equal(idle.calls.length, 0, 'requestIdleCallback is not asked for until the floor has elapsed -- this is the fix: it used to be asked immediately, with delayMs handed to it as its own timeout');

  await delay(120);

  assert.equal(idle.calls.length, 1, 'requestIdleCallback is asked for once the floor elapses');
  const [callback, options] = idle.calls[0] ?? [undefined, undefined];
  assert.ok(
    typeof options?.timeout === 'number' && options.timeout > 0 && options.timeout < 100,
    'the idle phase has its own small ceiling, independent of and smaller than the schedule delay',
  );
  assert.equal(ran, false, 'run is not called until the idle callback itself fires');
  callback?.({ didTimeout: false, timeRemaining: () => 0 });
  assert.equal(ran, true, 'run is called once the idle callback fires');
});

test('idleScheduler runs at the floor when requestIdleCallback does not exist', async () => {
  // No stubIdleCallback() here: this test:server environment has neither
  // requestIdleCallback nor cancelIdleCallback, which is exactly the
  // condition this test exercises.
  assert.equal(typeof globalThis.requestIdleCallback, 'undefined', 'this test relies on requestIdleCallback being genuinely absent');
  const timer = spyOnRealTimer();
  let ran = false;

  const cancel = idleScheduler('tail', 25, () => {
    ran = true;
  });

  assert.equal(timer.setTimeoutCalls.length, 1, 'the floor is a real setTimeout even with no idle callback available');
  assert.equal(timer.setTimeoutCalls[0]?.[1], 25, 'the schedule delay is passed through as the real setTimeout\'s delay');

  await delay(40);
  assert.equal(ran, true, 'run is called once the real timer fires, with no idle phase to wait through');
  cancel();
});

test('cancelling during the floor clears the pending setTimeout and never reaches the idle phase', async () => {
  const idle = stubIdleCallback();
  const timer = spyOnRealTimer();
  let ran = false;

  const cancel = idleScheduler('backfill', 20, () => {
    ran = true;
  });
  cancel();

  assert.equal(timer.clearedHandles.length, 1, 'cancelling during the floor clears the setTimeout');
  assert.equal(idle.calls.length, 0, 'the idle phase was never entered, so there is nothing there yet to cancel');

  await delay(35);

  assert.equal(idle.calls.length, 0, 'a cancelled floor never goes on to ask for idle time');
  assert.equal(ran, false, 'a cancelled floor never runs');
});

test('cancelling during the idle wait clears the idle callback', async () => {
  const idle = stubIdleCallback();
  let ran = false;

  const cancel = idleScheduler('backfill', 20, () => {
    ran = true;
  });

  await delay(35);
  assert.equal(idle.calls.length, 1, 'the idle phase has been entered');

  cancel();
  assert.equal(idle.cancelled.length, 1, 'cancelling during the idle wait calls cancelIdleCallback');

  const [callback] = idle.calls[0] ?? [undefined];
  callback?.({ didTimeout: false, timeRemaining: () => 0 });
  assert.equal(ran, true, 'the stub itself does not honour cancellation -- only that idleScheduler asked it to, same as before the fix');
});

test('idleScheduler honours delayMs as a floor even when the browser is immediately idle', async () => {
  // Models the most-idle a browser can be: requestIdleCallback's own
  // callback fires on the very next microtask, the way it would on a tab
  // doing nothing else at all. That is exactly the condition that exposed
  // the defect this test pins -- measured in Chromium, an idle tab polled a
  // tail 1015 times in 6 seconds where the design calls for 2, because
  // `delayMs` used to be handed to requestIdleCallback as its own timeout
  // rather than waited out first. A real clock, not `t.mock.timers`
  // (CLAUDE.md: fake timers hang this suite), kept fast (tens of
  // milliseconds) so this stays a unit test rather than the e2e spec that
  // pins the same property in a real browser.
  cleanups.push(() => {
    Reflect.deleteProperty(globalThis, 'requestIdleCallback');
    Reflect.deleteProperty(globalThis, 'cancelIdleCallback');
  });
  globalThis.requestIdleCallback = (callback: IdleRequestCallback): number => {
    queueMicrotask(() => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
    });
    return 1;
  };
  globalThis.cancelIdleCallback = (): void => {};

  const delayMs = 30;
  const startedAt = Date.now();
  const elapsedMs = await new Promise<number>((resolve) => {
    idleScheduler('tail', delayMs, () => {
      resolve(Date.now() - startedAt);
    });
  });

  assert.ok(
    elapsedMs >= delayMs,
    `run fired after ${elapsedMs}ms, before its ${delayMs}ms floor had elapsed -- an immediately-idle browser must not be able to skip the floor`,
  );
});

test('realEventStream opens nothing where EventSource does not exist, and an EventSource where it does', () => {
  // Review Focus 4: jsdom has no EventSource, and neither does node:test.
  assert.equal(typeof EventSource, 'undefined', 'this environment is the one without it');
  assert.equal(realEventStream('/api/sync/events'), undefined);
  class FakeSource {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(): void {}
    close(): void {}
  }
  const g = globalThis as { EventSource?: unknown };
  g.EventSource = FakeSource;
  cleanups.push(() => {
    delete g.EventSource;
  });
  const stream = realEventStream('/api/sync/events');
  assert.ok(stream instanceof FakeSource);
  assert.equal(stream.url, '/api/sync/events');
});
