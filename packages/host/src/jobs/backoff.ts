/**
 * Exponential, capped at a minute. The one curve every retry-on-failure
 * path in this package uses: a rejected handler's own retry
 * (`run-job.ts`'s `failRow`), a crashed process's readied row
 * (`dispatcher.ts`'s crash sweep), and `host.ts`'s `DEFAULT_BACKOFF_MS`,
 * which is what `Runner.runOnce()`'s test adapter falls back to when a
 * caller injects no `backoffMs` of its own.
 *
 * `Runner.recover()` deliberately does NOT use this: it leaves a recovered
 * row's `run_at` untouched, a real, documented policy difference from the
 * crash sweep's own backoff-on-recovery — see `runner.ts`'s own
 * `Runner.recover()` doc for why that disagreement is intentional and
 * stays. This module is only the curve every path that *does* back off
 * shares; it says nothing about which paths back off at all.
 */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** (attempts - 1), 60_000);
}
