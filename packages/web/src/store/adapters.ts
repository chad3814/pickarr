/**
 * The two browser adapters `sync.ts` needs and deliberately does not supply
 * itself (design spec §5; this task's brief): a real `fetch` and a real
 * idle-priority scheduler. `webLocksLease` (`leader.ts`) is the third and
 * already exists -- nothing here wraps it, because it needs no wrapping (its
 * own doc comment, this task's brief).
 *
 * `sync.ts`'s own header explains why these live in a separate module: "No
 * `globalThis.fetch`, no bare `setTimeout`, no `requestIdleCallback`" is a
 * rule for the *loops*, not for the whole package. Something has to touch
 * these globals for the app to work in a real tab, and this file is that
 * something -- task 6 wires its two exports into `CreateStoreDeps` alongside
 * `webLocksLease` and `Date.now`.
 */
import type { Schedule, SyncFetch } from './sync.ts';

/**
 * `fetch`, unqualified, is the same function as `window.fetch` in a browser
 * tab -- there is exactly one global object there, and `window` names it.
 * Written as a bare identifier rather than `window.fetch` so this module
 * runs unchanged wherever a global `fetch` exists, including this file's own
 * tests (`node --test`, no `window`).
 *
 * Passes `signal` through unmodified: the Global Constraint this task's
 * brief opens with, and the reason `sync.ts` bounds every request with
 * `FETCH_DEADLINE_MS` at all -- a deadline an adapter drops does nothing,
 * and every stubbed-fetch test in that suite still passes.
 *
 * `credentials: 'same-origin'` and nothing else authenticates the request:
 * the client never reads, stores or forwards the session cookie itself
 * (design spec §4, Global Constraints) -- `better-auth` owns it, and the
 * browser's own cookie jar is what carries it here.
 *
 * A real `Response` satisfies `sync.ts`'s `SyncResponse` by structural
 * assignment (that type's own doc comment): it has `ok`, `status`, and a
 * `json()` typed loosely enough to match, and this function is declared
 * `SyncFetch` rather than `(url, signal) => Promise<Response>` so nothing
 * downstream of it can reach for a `Response`-only member such as `headers`
 * or `.text()` -- the store must never touch a `Response`.
 */
export const realFetch: SyncFetch = (url, signal) => fetch(url, { signal, credentials: 'same-origin' });

/**
 * Runs `run` at browser idle priority where the browser offers one, and on a
 * plain timer where it does not.
 *
 * `requestIdleCallback` is absent in Safari before 16.4 and in every
 * jsdom-like test environment (design spec §5) -- checked with `typeof`
 * rather than a feature-detection library, since that is enough to tell
 * whether calling it will throw.
 *
 * `loop` is part of {@link Schedule}'s signature because `sync.ts`'s caller
 * needs it (it keys a `Map` of pending tasks by loop), not because this
 * adapter branches on it: priority between the tail and the backfill is
 * already carried by the `delayMs` each is scheduled with -- `0` for the
 * tail, `BACKFILL_IDLE_MS` for the backfill -- so nothing here has a second
 * decision left to make from the loop's name.
 *
 * `delayMs` is passed to `requestIdleCallback` as its `timeout`, which is a
 * "run by" cap rather than a "run no sooner than" floor: a browser that is
 * idle immediately can run `run` before `delayMs` elapses. `Schedule`'s own
 * contract ("after at least `delayMs`") is met exactly by the `setTimeout`
 * fallback below; the idle path trades that lower bound for the thing idle
 * scheduling exists to buy -- not running ahead of paint or input -- which
 * is the right trade for a background cursor with no correctness dependency
 * on when, only on whether, it eventually runs.
 */
export const idleScheduler: Schedule = (_loop, delayMs, run) => {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(() => {
      run();
    }, { timeout: delayMs });
    return () => {
      cancelIdleCallback(handle);
    };
  }
  const handle = setTimeout(() => {
    run();
  }, delayMs);
  return () => {
    clearTimeout(handle);
  };
};
