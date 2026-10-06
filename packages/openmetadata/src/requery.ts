/**
 * The daily requery sweep: asks the lookup service again about unresolved
 * releases whose suggested date says the answer may exist soon.
 *
 * **Why.** A release named after a scene or an episode that has not aired
 * yet is `unresolved` on arrival and stays that way: the lookup engine
 * (`./engine.ts`) deliberately enqueues nothing for an unresolved answer,
 * since that is "the state a human might fix". For a dated release the
 * human's fix is to wait a day and press Retry, which is what this job
 * does on their behalf.
 *
 * **The rule**, per plugin, over every unresolved and unlinked `rss_item`
 * whose feed the plugin owns:
 *
 *     if (count > 0 and count < AUTO_REQUERY_LIMIT) or suggestedDate >= today - 2 days:
 *         count += 1; requery
 *
 * A chain starts when the stored envelope carries a date that is today or
 * later, or within the two days before today (UTC calendar days). Once
 * started it continues whatever the date says, one requery per sweep,
 * until five have been made -- a date that aged out of the window on day
 * three must not end a chain the rule began. A manual Retry does not count.
 *
 * **Where the date is.** Measured against the live service (2026-10-06):
 * a scene carries `parsed.releasedOn`, a dated episode `parsed.airDate`,
 * and an unresolved answer that still found a low-confidence match carries
 * `media.releaseDate`. A film has only `parsed.year`, which is not a date,
 * so films never start a chain.
 *
 * **Rows touched within the last hour are left alone.** A row a manual
 * Retry or a mass retry just re-asked about would otherwise be asked twice
 * in one tick; the lookup service answers both, but one is waste.
 *
 * **The sweep books its successor first**, a day out, before it reads
 * anything: a sweep that throws is retried by the runner and then
 * dead-lettered, and without the booking the cadence would die with it.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler, PluginContext } from '@pickarr/contract';
import { LOOKUP_JSON_TOO_LARGE } from '@pickarr/contract';

export const REQUERY_SWEEP_JOB = 'requery-sweep';
export const REQUERY_SWEEP_INTERVAL_MS = 86_400_000;
/** How many sweeps may requery one release before leaving it to a human. */
export const AUTO_REQUERY_LIMIT = 5;
/** A suggested date this many days before today still starts a chain. */
export const RECENT_RELEASE_WINDOW_DAYS = 2;
/** A row written more recently than this is skipped this sweep. */
export const REQUERY_QUIET_MS = 3_600_000;

/** The sweep's payload: `pendingJobId` needs one numeric key to dedupe on, and this is it. */
export const REQUERY_SWEEP_PAYLOAD = { sweep: 1 } as const;

/** `YYYY-MM-DD` in UTC. */
export function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function daysBefore(iso: string, days: number): string {
  return isoDate(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

function isoDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DAY.exec(value);
  return match === null ? null : match[0];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The date the stored envelope suggests for this release, or `null` when it suggests none. */
export function suggestedDate(lookupJson: string | null): string | null {
  if (lookupJson === null || lookupJson === LOOKUP_JSON_TOO_LARGE) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(lookupJson);
  } catch {
    return null;
  }
  const outer = record(envelope);
  if (outer === null) return null;
  const parsed = record(outer['parsed']);
  const media = record(outer['media']);
  return isoDay(parsed?.['releasedOn']) ?? isoDay(parsed?.['airDate']) ?? isoDay(media?.['releaseDate']);
}

export function shouldRequery(
  row: { readonly autoRequeryCount: number; readonly suggestedDate: string | null },
  today: string,
): boolean {
  if (row.autoRequeryCount >= AUTO_REQUERY_LIMIT) return false;
  if (row.autoRequeryCount > 0) return true;
  if (row.suggestedDate === null) return false;
  return row.suggestedDate >= daysBefore(today, RECENT_RELEASE_WINDOW_DAYS);
}

/** The ids this sweep should requery for `pluginId`, in id order. */
export function requeryCandidates(raw: DatabaseSync, pluginId: string, now: number): number[] {
  const rows = raw.prepare(`
    SELECT rss_item.id AS id, rss_item.lookup_json AS lookup_json, rss_item.auto_requery_count AS count
      FROM rss_item JOIN rss_feed ON rss_feed.id = rss_item.feed_id
     WHERE rss_feed.plugin_id = ?
       AND rss_item.media_item_id IS NULL
       AND rss_item.lookup_state = 'unresolved'
       AND rss_item.updated_at <= ?
     ORDER BY rss_item.id
  `).all(pluginId, now - REQUERY_QUIET_MS) as unknown as { id: number; lookup_json: string | null; count: number }[];
  const today = isoDate(now);
  return rows
    .filter((row) => shouldRequery({ autoRequeryCount: row.count, suggestedDate: suggestedDate(row.lookup_json) }, today))
    .map((row) => row.id);
}

/**
 * Builds the sweep handler for one lookup plugin. `enqueueLookups` is the
 * engine's own "look these ids up" path -- the same one a new rss item
 * takes -- so a requery is a lookup like any other.
 */
export function createRequerySweep(
  pluginId: string,
  enqueueLookups: (ids: readonly number[], ctx: PluginContext) => Promise<void>,
  now: () => number,
): JobHandler {
  return async (_job, ctx) => {
    const at = now();
    await ctx.jobs.enqueue({ kind: REQUERY_SWEEP_JOB, payload: REQUERY_SWEEP_PAYLOAD, runAt: at + REQUERY_SWEEP_INTERVAL_MS });

    const raw = ctx.db as DatabaseSync;
    const ids = requeryCandidates(raw, pluginId, at);
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(', ');
    raw.prepare(`UPDATE rss_item SET auto_requery_count = auto_requery_count + 1 WHERE id IN (${placeholders})`).run(...ids);
    await enqueueLookups(ids, ctx);
    ctx.log('requery sweep re-asked about unresolved releases', { pluginId, count: ids.length });
  };
}
