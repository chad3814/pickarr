import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { realFetch, idleScheduler } from '../../src/store/adapters.ts';

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

test('idleScheduler uses requestIdleCallback when it exists', () => {
  const idle = stubIdleCallback();
  const timer = spyOnRealTimer();
  let ran = false;

  idleScheduler('backfill', 5000, () => {
    ran = true;
  });

  assert.equal(idle.calls.length, 1, 'requestIdleCallback is called once');
  assert.equal(timer.setTimeoutCalls.length, 0, 'setTimeout is not used when requestIdleCallback exists');
  const [callback, options] = idle.calls[0] ?? [undefined, undefined];
  assert.equal(options?.timeout, 5000, 'the schedule delay is passed through as the idle callback\'s timeout');
  assert.equal(ran, false, 'run is not called until the idle callback fires');
  callback?.({ didTimeout: false, timeRemaining: () => 0 });
  assert.equal(ran, true, 'run is called once the idle callback fires');
});

test('idleScheduler falls back to setTimeout when it does not exist', async () => {
  // No stubIdleCallback() here: this test:server environment has neither
  // requestIdleCallback nor cancelIdleCallback, which is exactly the
  // condition this test exercises.
  assert.equal(typeof globalThis.requestIdleCallback, 'undefined', 'this test relies on requestIdleCallback being genuinely absent');
  const timer = spyOnRealTimer();
  let ran = false;

  const cancel = idleScheduler('tail', 25, () => {
    ran = true;
  });

  assert.equal(timer.setTimeoutCalls.length, 1, 'setTimeout is used when requestIdleCallback does not exist');
  assert.equal(timer.setTimeoutCalls[0]?.[1], 25, 'the schedule delay is passed through as the real setTimeout\'s delay');

  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  assert.equal(ran, true, 'run is called once the real timer fires');
  cancel();
});

test('cancelling works on both paths', () => {
  const idle = stubIdleCallback();
  let ranOnIdlePath = false;
  const cancelIdle = idleScheduler('backfill', 5000, () => {
    ranOnIdlePath = true;
  });
  cancelIdle();
  assert.equal(idle.cancelled.length, 1, 'cancelling the idle-callback path calls cancelIdleCallback');
  const [callback] = idle.calls[0] ?? [undefined];
  callback?.({ didTimeout: false, timeRemaining: () => 0 });
  assert.equal(ranOnIdlePath, true, 'the stub itself does not honour cancellation -- only that idleScheduler asked it to');

  Reflect.deleteProperty(globalThis, 'requestIdleCallback');
  Reflect.deleteProperty(globalThis, 'cancelIdleCallback');
  const timer = spyOnRealTimer();
  let ranOnTimerPath = false;
  const cancelTimer = idleScheduler('tail', 5000, () => {
    ranOnTimerPath = true;
  });
  cancelTimer();
  assert.equal(timer.clearedHandles.length, 1, 'cancelling the setTimeout path calls clearTimeout');
  assert.equal(ranOnTimerPath, false, 'a cancelled real setTimeout does not run its callback');
});
