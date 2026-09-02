import type { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { sql } from 'drizzle-orm';
import type { JobEnqueue, JobHandler, JobRecord, PluginContext } from '@pickarr/contract';

export interface RunnerOptions {
  /** Injected clock, so backoff is testable without waiting on wall time. */
  now: () => number;
  backoffMs: (attempts: number) => number;
  defaultMaxAttempts: number;
}

export interface Runner {
  /**
   * `(pluginId, job)`, not just `job`. This is asymmetric with `JobQueue.enqueue`
   * on purpose: a plugin's own `ctx.jobs.enqueue` already knows which plugin it
   * is — trusting a plugin to name its own `pluginId` would let it enqueue work
   * under another plugin's identity — while the runner serves every plugin and
   * the `jobs` row needs a `plugin_id` to dispatch on. Unifying the two shapes
   * would force one of those facts to give way.
   */
  enqueue(pluginId: string, job: JobEnqueue): number;
  /** Claims and runs at most one job. Returns false when none was ready. */
  runOnce(
    handlers: (pluginId: string, kind: string) => JobHandler | undefined,
    ctxFor: (pluginId: string) => PluginContext,
  ): Promise<boolean>;
  /**
   * Returns jobs left `running` by a crashed process to `ready` — except a
   * job already at its last permitted attempt, which goes to `dead` instead:
   * `runOnce`'s dead-letter check lives in the `catch` for a *rejected*
   * handler, which a process that crashes outright never reaches, so
   * without this a job kind that reliably kills the process would be
   * readied again on every restart and the host would never finish starting.
   * Returns how many rows were touched, ready or dead.
   */
  recover(): number;
}

/** The columns named in the claim statement's `RETURNING` clause. */
interface ClaimedRow {
  id: number;
  plugin_id: string;
  kind: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
}

export function createRunner(raw: DatabaseSync, opts: RunnerOptions): Runner {
  // A local Drizzle handle over the same raw connection, not a new database —
  // `{ client: raw }` is the form that shares it. Only used for the claim
  // statement below, which is a single `UPDATE ... RETURNING` that node:sqlite
  // itself can run, but Drizzle's `db.all<T>(sql\`…\`)` gives it a typed result
  // instead of the driver's untyped row objects.
  const db = drizzle({ client: raw });

  return {
    enqueue(pluginId, job) {
      const now = opts.now();
      const runAt = job.runAt ?? now;
      const maxAttempts = job.maxAttempts ?? opts.defaultMaxAttempts;
      const payloadJson = JSON.stringify(job.payload);
      const result = raw.prepare(`
        INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, last_error, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?, 'ready', NULL, ?, ?)
      `).run(pluginId, job.kind, payloadJson, maxAttempts, runAt, now, now);
      return Number(result.lastInsertRowid);
    },

    async runOnce(handlers, ctxFor) {
      const now = opts.now();

      // The claim is one statement, so two workers can never take the same
      // job even though this is single-process today: the row a second caller
      // could see is already `running` by the time its own `UPDATE` runs.
      const claimed = db.all<ClaimedRow>(sql`
        UPDATE jobs SET state = 'running', updated_at = ${now}
         WHERE id = (SELECT id FROM jobs
                      WHERE state = 'ready' AND run_at <= ${now}
                      ORDER BY run_at, id LIMIT 1)
        RETURNING id, plugin_id, kind, payload_json, attempts, max_attempts
      `);
      const row = claimed.at(0);
      if (!row) return false;

      // Incremented before the handler runs, not after: a handler that
      // crashes the process still has to have consumed an attempt, or crash
      // recovery (`recover`) hands the row back to `ready` with its attempt
      // count untouched and it retries forever.
      const attempts = row.attempts + 1;
      raw.prepare('UPDATE jobs SET attempts = ?, updated_at = ? WHERE id = ?').run(attempts, now, row.id);

      const pluginId = row.plugin_id;
      const handler = handlers(pluginId, row.kind);
      if (!handler) {
        // An unhandled job kind is a visible dead-letter row, not a job that
        // silently vanishes because no method existed to catch it.
        raw.prepare('UPDATE jobs SET state = ?, last_error = ?, updated_at = ? WHERE id = ?')
          .run('dead', `no handler for job kind "${row.kind}" registered by plugin "${pluginId}"`, now, row.id);
        return true;
      }

      // `payload` stays `unknown` all the way out — the contract makes no
      // promise about its shape, so nothing here narrows it further.
      const payload: unknown = JSON.parse(row.payload_json);
      const record: JobRecord = { id: row.id, kind: row.kind, payload, attempts };
      const ctx = ctxFor(pluginId);

      try {
        await handler(record, ctx);
        raw.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?').run('done', now, row.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempts >= row.max_attempts) {
          // Dead-lettering means the row stays, with `last_error` set, rather
          // than being deleted — a job that vanishes on failure is a job
          // nobody can diagnose.
          raw.prepare('UPDATE jobs SET state = ?, last_error = ?, updated_at = ? WHERE id = ?')
            .run('dead', message, now, row.id);
        } else {
          const runAt = now + opts.backoffMs(attempts);
          raw.prepare('UPDATE jobs SET state = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
            .run('ready', runAt, message, now, row.id);
        }
      }
      return true;
    },

    recover() {
      const now = opts.now();
      // Attempts are left untouched either way: the crashed attempt already
      // consumed one, back when the claim incremented it. A row already at
      // `max_attempts` does not get another try — it goes straight to
      // `dead` — because readying it just hands the same crash back to the
      // next restart.
      //
      // `last_error` is overwritten, not appended to, on the rows going
      // dead: a rejected handler leaves a stack trace there, but a crashed
      // process leaves nothing, and that is a different diagnosis. The crash
      // message is the more specific, more current fact about why the row
      // is dead *now* — a stale rejection message from an earlier attempt
      // would only mislead whoever reads it next.
      const result = raw.prepare(`
        UPDATE jobs
           SET state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
               last_error = CASE WHEN attempts >= max_attempts
                 THEN 'process crashed while this job was running, on its last permitted attempt'
                 ELSE last_error END,
               updated_at = ?
         WHERE state = ?
      `).run(now, 'running');
      return Number(result.changes);
    },
  };
}
