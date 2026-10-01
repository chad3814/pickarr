/**
 * Exponential, capped at a minute. The one curve every retry-on-failure
 * path in this package uses: a rejected handler's own retry
 * (`run-job.ts`'s `failRow`) and a crashed process's readied row
 * (`dispatcher.ts`'s crash sweep).
 */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** (attempts - 1), 60_000);
}

/**
 * `baseMs` doubled once per attempt after the first, held at `capMs`:
 * attempt 1 is `baseMs`, attempt 2 is `2 × baseMs`, and so on. Shared by
 * the reconcile cycle's own backoff after a failed contact
 * (`clients/reconcile-job.ts`) and by the per-row import backoff
 * (`clients/deliver.ts`), which differ only in their base and cap.
 */
export function doublingDelayMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}
