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
 * Once {@link idleScheduler}'s floor has elapsed, how much longer it will
 * wait for a genuinely idle moment before running anyway. Independent of
 * `delayMs`, and small on purpose: this is a ceiling on the *idle* phase
 * alone, not on the wait as a whole, so a tab with no idle time to spare
 * (mid-scroll, mid-input) cannot delay `run` by more than this past its
 * floor. Not `0`, because `0` would defeat the reason to ask for idle time
 * at all -- some room to land after paint rather than ahead of it is the
 * whole point of the idle phase existing.
 */
const IDLE_CEILING_MS = 50;

/**
 * Runs `run` after at least `delayMs`, and -- where the browser offers
 * idle-priority scheduling -- gives it a further short window to land at
 * idle priority rather than ahead of paint or input.
 *
 * **`delayMs` is a floor, not a ceiling, because {@link Schedule}'s contract
 * says so** ("after *at least* `delayMs`") **and three things in `sync.ts`
 * measurably depend on that floor holding**: `TAIL_INTERVAL_MS` is a fixed
 * *rate*, not a fixed delay, so a tail scheduled early polls early, forever;
 * `BACKOFF_BASE_MS`/`BACKOFF_CEILING_MS`'s 1s/2s/4s ladder only slows
 * anything down if each step actually waits its length; and `REFUSAL_LIMIT`'s
 * "about thirty seconds of retrying" is that ladder's sum, not a count.
 *
 * This used to hand `delayMs` to `requestIdleCallback` as its `timeout`,
 * which is a "run by" cap, not a "run no sooner than" floor -- so on an idle
 * browser the callback ran at the next idle period, typically within one
 * frame, `delayMs` or no. Measured in Chromium: a healthy tail polled
 * **1015 times in 6 seconds** where the ladder calls for 2, and a failing one
 * retried **5547 times in 8 seconds** where the ladder calls for about 3 --
 * roughly 165/s and 690/s respectively, from one open tab, which amplifies
 * an outage rather than backing off it. The reasoning that produced that bug
 * was scoped to one caller: it is true of the backfill, which asks for
 * `BACKFILL_IDLE_MS = 0` and so has no floor to give up, but it does not
 * generalise to a `Schedule` also used for a fixed-rate poll and an
 * exponential backoff, and it was never re-checked against those.
 *
 * The fix keeps idle priority without giving up the floor: a real
 * `setTimeout` waits out `delayMs` first, unconditionally, and only then --
 * where `requestIdleCallback` exists -- does this ask for idle time, bounded
 * by {@link IDLE_CEILING_MS} rather than by `delayMs` again. Where it does
 * not exist, `run` fires the moment the floor elapses, exactly as the old
 * fallback branch did.
 *
 * `loop` is part of {@link Schedule}'s signature because `sync.ts`'s caller
 * needs it (it keys a `Map` of pending tasks by loop), not because this
 * adapter branches on it: priority between the tail and the backfill is
 * already carried by the `delayMs` each is scheduled with -- `0` for the
 * backfill, `nextTailDelay(...)` for the tail -- so nothing here has a
 * second decision left to make from the loop's name.
 *
 * Cancellation has to work from either phase, since a caller can cancel at
 * any time: the returned function always clears the `setTimeout`, and clears
 * the idle callback too if one was ever requested. A cancel during the
 * floor never reaches the idle phase at all (the timeout that would have
 * requested it is the thing being cleared); a cancel during the idle wait
 * clears that request directly.
 */
export const idleScheduler: Schedule = (_loop, delayMs, run) => {
  const hasIdleCallback = typeof requestIdleCallback === 'function';
  let idleHandle: number | undefined;

  const timeoutHandle = setTimeout(() => {
    if (hasIdleCallback) {
      idleHandle = requestIdleCallback(() => {
        run();
      }, { timeout: IDLE_CEILING_MS });
      return;
    }
    run();
  }, delayMs);

  return () => {
    clearTimeout(timeoutHandle);
    if (idleHandle !== undefined) cancelIdleCallback(idleHandle);
  };
};
