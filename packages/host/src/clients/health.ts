/**
 * A download client's health, as the reconcile cycle observes it (#93).
 *
 * **One writer.** Only `clients/reconcile-job.ts` calls these, once per
 * tick, and only on the outcome of contacting the client: reading its
 * config, building its adapter and taking its snapshot. A local fault after
 * a good snapshot says nothing about the client and is never recorded here.
 *
 * **Written only when it changes.** `download_client` is synced. A write on
 * every successful poll, every 10 seconds, would send an update to every
 * open browser forever. A success writes only when it ends a streak of
 * failures; a failure writes each time, and failures arrive at the
 * backed-off pace `reconcileRetryDelayMs` sets.
 */
import type { DatabaseSync } from 'node:sqlite';
import { CLIENT_UNREACHABLE_AFTER_FAILURES } from '@pickarr/contract';
import { doublingDelayMs } from '../jobs/backoff.ts';

/** The first retry after a failed contact, doubled per further failure. The same as the healthy interval, so one blip costs nothing extra. */
const CONTACT_RETRY_BASE_MS = 10_000;
/** The longest a failing client waits between checks. */
const CONTACT_RETRY_CAP_MS = 300_000;

export function recordContactSuccess(raw: DatabaseSync, clientId: number, at: number): void {
  raw.prepare(`
    UPDATE download_client SET consecutive_failures = 0, unreachable_since = NULL, updated_at = ?
     WHERE id = ? AND consecutive_failures > 0
  `).run(at, clientId);
}

/** Records one failed contact and answers the new consecutive-failure count (0 if the client row is gone). */
export function recordContactFailure(raw: DatabaseSync, clientId: number, at: number): number {
  raw.prepare(`
    UPDATE download_client
       SET consecutive_failures = consecutive_failures + 1,
           unreachable_since = coalesce(unreachable_since, ?),
           updated_at = ?
     WHERE id = ?
  `).run(at, at, clientId);
  const row = raw.prepare('SELECT consecutive_failures FROM download_client WHERE id = ?').get(clientId);
  const failures = row === undefined ? undefined : row['consecutive_failures'];
  return typeof failures === 'number' ? failures : 0;
}

/**
 * How long to wait before contacting a client again after its `failures`th
 * consecutive failure. `failures` below 1 is treated as 1: `recordContactFailure`
 * answers 0 when the client row it was updating had already vanished, and
 * that is not a failure count one rung gentler than the first -- it is the
 * same failure, on a row this host can no longer re-read. Passing 0 straight
 * through to `doublingDelayMs` would answer 5s, half of the ladder's actual
 * first rung (10s) and a value nothing else on it ever produces.
 */
export function reconcileRetryDelayMs(failures: number): number {
  return doublingDelayMs(Math.max(failures, 1), CONTACT_RETRY_BASE_MS, CONTACT_RETRY_CAP_MS);
}

export function isReachable(consecutiveFailures: number): boolean {
  return consecutiveFailures < CLIENT_UNREACHABLE_AFTER_FAILURES;
}
