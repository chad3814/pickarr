/** Doubling backoff from one minute, capped so a long outage never stops retrying. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * The retry curve both provider-facing passes share.
 *
 * `pipeline/metadata.ts` and `pipeline/performers.ts` retry against the same
 * rate-limited service, and share this curve rather than keeping a second copy
 * of it: two curves aimed at one service is two things to tune, and one of them
 * will be forgotten.
 *
 * It lives in a module of its own rather than in whichever pass was written
 * first, because sharing it *from* `metadata.ts` made the two passes import each
 * other — `performers.ts` for this function, `metadata.ts` for
 * `enqueuePerformerSearch`. That cycle worked only by accident: both crossings
 * were hoisted `function` declarations called from inside function bodies, so
 * neither module read the other during evaluation. Turn either into a `const`
 * arrow or a module-level value and the same code becomes a `TypeError` at
 * startup, on a line that looks unrelated to the edit. A leaf module both sides
 * depend on keeps the sharing and removes the cycle.
 */
export function backoffFor(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, MAX_BACKOFF_MS);
}
