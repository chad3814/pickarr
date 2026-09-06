import type { DatabaseSync } from 'node:sqlite';
import type { JobEnqueue } from '@pickarr/contract';

export interface RunnerOptions {
  /** Injected clock, so an inserted row's `created_at`/`run_at` are testable without waiting on wall time. */
  now: () => number;
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
}

export function createRunner(raw: DatabaseSync, opts: RunnerOptions): Runner {
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
  };
}
