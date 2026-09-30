/**
 * The one-off backfill of video resolutions for releases identified before
 * Pickarr recorded one (issue #98).
 *
 * **Why a second question to the service, and why only this answer is
 * kept.** A matched release's lookup answer is cleared when it is linked
 * (`MediaWriter.relinkRssItem`), so there is nothing stored to read a
 * resolution from. The service is asked again by filename -- a fresh batch,
 * cached on its side -- and only `setVideoResolution` is called with what
 * comes back. The media item, cast, artwork and lookup state are left alone,
 * so a fresh answer that disagrees with the one that identified the release
 * changes nothing but this one column.
 */
import { DatabaseSync } from 'node:sqlite';
import type { JobHandler, Migration, PluginContext } from '@pickarr/contract';
import { MAX_BATCH } from './client.ts';
import { videoResolutionOf } from './quality.ts';
import { lookupTableName } from './table.ts';
import type { LookupCategory, LookupEnvelope } from './types.ts';

export const VIDEO_RESOLUTION_BACKFILL_JOB = 'video-resolution-backfill';

/**
 * How long the backfill waits before asking again after the service failed
 * or rate-limited a batch, or answered none of it yet. Ten minutes: far past
 * the runner's own backoff (1s to 8s over five attempts, about fifteen
 * seconds in all), which an outage or a 429 easily outlasts.
 */
export const BACKFILL_RETRY_DELAY_MS = 600_000;

/** The host's `DEFAULT_MAX_ATTEMPTS`, restated: a plugin migration cannot import the host. */
const MAX_ATTEMPTS = 5;

/**
 * Marks every release already identified, and queues one backfill job for
 * them. Listed by each plugin at the version it assigns -- 4 in all three
 * shipped plugins, after `placementTableMigration` at 3 -- so a collision is
 * visible in that plugin's own list.
 *
 * **It writes the host's `jobs` table with raw SQL**, because a migration is
 * handed the connection and not `JobQueue`. The columns it names are
 * `plugin_id`, `kind`, `payload_json`, `attempts`, `max_attempts`, `run_at`,
 * `state`, `last_error`, `created_at` and `updated_at`;
 * `host/test/plugins/backfill.test.ts` runs the row it writes through the
 * real dispatcher, so a change to that table fails there rather than
 * leaving a job nothing runs. Timestamps come from SQLite's own clock, in
 * milliseconds like every other job row, because a migration is given no
 * clock either.
 *
 * A fresh install has no identified release when this runs, so it marks
 * nothing and queues nothing.
 */
export function videoResolutionBackfillMigration(pluginId: string, version: number): Migration {
  const table = lookupTableName(pluginId);
  return {
    version,
    up: (db) => {
      // Two statements, not one: `check-test-hygiene.ts`'s credential rule
      // reads an `UPDATE ${table} SET …` whose table it cannot resolve as a
      // possible read of an unknown, possibly-credential table, and admits
      // that only when the table is the *one* unresolved piece in its own
      // statement -- the `ALTER TABLE` above it names `${table}` too, and
      // sharing one template would push the count past that.
      db.exec(`ALTER TABLE ${table} ADD COLUMN video_resolution_backfill INTEGER NOT NULL DEFAULT 0`);
      db.exec(`
UPDATE ${table} SET video_resolution_backfill = 1
 WHERE rss_item_id IN (SELECT id FROM rss_item WHERE lookup_state = 'resolved');
`);
      const marked = db.prepare(`SELECT 1 AS found FROM ${table} WHERE video_resolution_backfill = 1 LIMIT 1`).get();
      if (marked === undefined) return;
      db.prepare(`
INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, last_error, created_at, updated_at)
VALUES (?, ?, '{}', 0, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER), 'ready', NULL,
        CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER))
`).run(pluginId, VIDEO_RESOLUTION_BACKFILL_JOB, MAX_ATTEMPTS);
    },
  };
}

export interface VideoResolutionBackfillDeps {
  readonly pluginId: string;
  readonly category: LookupCategory;
  /** The clock a delayed successor's `runAt` is taken from -- `createLookupPlugin`'s own `deps.now`. */
  readonly now: () => number;
  /** One batch lookup by filename -- `createLookupPlugin` passes its own client's `batch`. */
  readonly batch: (ctx: PluginContext, signal: AbortSignal | undefined, names: readonly string[]) => Promise<readonly LookupEnvelope[]>;
}

/** `PluginContext.db` narrowed, the same check `engine.ts`'s `asDatabase` makes. */
function connection(ctx: PluginContext): DatabaseSync {
  if (!(ctx.db instanceof DatabaseSync)) {
    throw new TypeError('openmetadata: ctx.db is not a node:sqlite DatabaseSync');
  }
  return ctx.db;
}

/**
 * One batch of the backfill: up to `MAX_BATCH` marked releases, one request,
 * then per answer: a usable resolution is stored and the mark cleared, a
 * terminal answer with none stores `null` and clears it, and a partial or
 * pending answer with none is left marked with nothing written. Then the
 * same job again if marks remain -- at once if this batch cleared anything,
 * or `BACKFILL_RETRY_DELAY_MS` from now if it cleared nothing, so a batch
 * the service has not answered yet cannot hot-loop.
 *
 * **Orphans are cleared first.** A marked lookup row whose release was
 * deleted can never be returned by the join below, and counting it as
 * remaining would re-enqueue this job for ever.
 *
 * **An outage or a 429 schedules a successor instead of throwing.** A
 * failed batch call is logged, the same job kind is enqueued again
 * `BACKFILL_RETRY_DELAY_MS` from now, and the handler returns with every mark
 * intact -- nothing is written until the batch has answered. Throwing would
 * leave it to the runner's backoff, about fifteen seconds over five
 * attempts, and a dead-lettered backfill is never enqueued again: the plugin
 * migration inserts the only row there will ever be.
 *
 * **A local write fault still throws.** Once the answer is in, a failing
 * `setVideoResolution` or mark clear is a fault, not an outage; the rows
 * before it in the batch stay written and cleared, and the rest stay marked.
 */
export function createVideoResolutionBackfillJob(deps: VideoResolutionBackfillDeps): JobHandler {
  const table = lookupTableName(deps.pluginId);
  return async (_job, ctx, signal) => {
    const raw = connection(ctx);
    raw.prepare(`
UPDATE ${table} SET video_resolution_backfill = 0
 WHERE video_resolution_backfill = 1 AND rss_item_id NOT IN (SELECT id FROM rss_item)
`).run();
    const rows = raw.prepare(`
SELECT l.rss_item_id AS rssItemId, r.filename AS filename
  FROM ${table} l JOIN rss_item r ON r.id = l.rss_item_id
 WHERE l.video_resolution_backfill = 1
 ORDER BY l.id LIMIT ?
`).all(MAX_BATCH).map((row) => {
      const rssItemId = row['rssItemId'];
      const filename = row['filename'];
      if (typeof rssItemId !== 'number' || typeof filename !== 'string') {
        throw new TypeError('openmetadata: a backfill row is not an id and a filename');
      }
      return { rssItemId, filename };
    });
    if (rows.length === 0) return;

    let answers: readonly LookupEnvelope[];
    try {
      answers = await deps.batch(ctx, signal, rows.map((row) => row.filename));
    } catch (error) {
      ctx.log('the video resolution backfill could not reach the lookup service, so it asks again later', {
        // The message rather than the `Error`, the same shape `engine.ts`'s
        // `logged` uses: the host's `redactDetail` walks string values only.
        // No filename -- the batch's names are row contents.
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.jobs.enqueue({ kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, runAt: deps.now() + BACKFILL_RETRY_DELAY_MS });
      return;
    }
    const clear = raw.prepare(`UPDATE ${table} SET video_resolution_backfill = 0 WHERE rss_item_id = ?`);
    let cleared = 0;
    for (const [index, row] of rows.entries()) {
      const answer = answers[index];
      if (answer === undefined) throw new Error(`openmetadata: no backfill answer for release ${row.rssItemId}`);
      const resolution = videoResolutionOf(answer);
      // A partial or pending answer with no usable parse has not arrived,
      // and nothing polls a backfill's lookup: storing `null` and clearing
      // the mark would settle it for good. It stays marked and is asked
      // about again. One that already carries a parse is as good as final.
      if (resolution === null && (answer.partial || answer.state === 'pending')) continue;
      // eslint-disable-next-line no-await-in-loop -- one small UPDATE each; ordered so a throw leaves every later mark in place
      await ctx.media.setVideoResolution(row.rssItemId, resolution);
      clear.run(row.rssItemId);
      cleared += 1;
    }

    const remaining = raw.prepare(`
SELECT 1 AS found FROM ${table} l JOIN rss_item r ON r.id = l.rss_item_id
 WHERE l.video_resolution_backfill = 1 LIMIT 1
`).get();
    if (remaining !== undefined) {
      // A batch that cleared nothing -- every answer still partial -- waits
      // before asking again, so it cannot spin against the service; one that
      // made progress goes straight on to the next batch.
      await ctx.jobs.enqueue(cleared === 0
        ? { kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, runAt: deps.now() + BACKFILL_RETRY_DELAY_MS }
        : { kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {} });
    }
  };
}
