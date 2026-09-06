/**
 * Exponential, capped at a minute. The one curve every retry-on-failure
 * path in this package uses: a rejected handler's own retry
 * (`run-job.ts`'s `failRow`) and a crashed process's readied row
 * (`dispatcher.ts`'s crash sweep).
 */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** (attempts - 1), 60_000);
}
