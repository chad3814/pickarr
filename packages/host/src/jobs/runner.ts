import type { DatabaseSync } from 'node:sqlite';
import type { JobEnqueue, JobHandler, JobRecord, PluginContext } from '@pickarr/contract';
import { runJob } from './run-job.ts';

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
  /**
   * TEST ADAPTER, deleted in the task that removes the last caller. Claims
   * and runs at most one due job, reusing `run-job.ts`'s own claim, timeout
   * race and abort grace — the same execution `Host.start()`'s dispatcher
   * uses — so the 64 existing call sites keep working while they are
   * migrated file by file. Production must call `Host.start()`; a pump loop
   * calling this would rebuild the coupling the dispatcher exists to
   * remove.
   *
   * Deliberately NOT built on top of `Dispatcher.start()`: that call sweeps
   * every `running` row on every invocation, treating each as crash debris
   * — correct for a dispatcher that owns the whole table for as long as it
   * runs, wrong for an adapter that may be called again before an earlier,
   * still-in-flight call has finished, whose own claimed-but-not-yet-done
   * row would then be swept out from under it. A plain, read-only "what is
   * due" query has no such side effect. Returns false when none was ready.
   */
  runOnce(
    handlers: (pluginId: string, kind: string) => JobHandler | undefined,
    ctxFor: (pluginId: string) => PluginContext,
  ): Promise<boolean>;
  /**
   * Returns jobs left `running` by a crashed process to `ready` — except a
   * job already at its last permitted attempt, which goes to `dead` instead:
   * a rejected handler's dead-letter check lives in `run-job.ts`'s own
   * `catch`, which a process that crashes outright never reaches, so
   * without this a job kind that reliably kills the process would be
   * readied again on every restart and the host would never finish starting.
   * Returns how many rows were touched, ready or dead.
   *
   * Deliberately independent of the dispatcher's own crash sweep
   * (`Dispatcher.start()`): that sweep re-applies backoff to a readied row's
   * `run_at`, which is a real behaviour difference from this method's own
   * tested contract of leaving `run_at` untouched. Kept as its own
   * standalone statement rather than reconciled with it, since nothing here
   * needs it to change.
   */
  recover(): number;
}

/** A real sleep, for `run-job.ts`'s abort-grace wait when this adapter's handler outlives its timeout. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Surfaces what would otherwise vanish silently through `run-job.ts`'s
 * timeout-handler wrapper. Never a no-op: a detected failure is only worth
 * detecting if something reports it.
 */
function adapterLog(message: string, detail?: Readonly<Record<string, unknown>>): void {
  console.error(`[runner] ${message}`, detail ?? {});
}

/** A row read back by `runOnce`'s own due-job query, narrowed from `unknown`. */
interface DueRow {
  id: number;
  pluginId: string;
  kind: string;
  payloadJson: string;
  attempts: number;
}

function readDueRow(row: unknown): DueRow {
  const r = row as { id: unknown; plugin_id: unknown; kind: unknown; payload_json: unknown; attempts: unknown };
  return {
    id: Number(r.id),
    pluginId: String(r.plugin_id),
    kind: String(r.kind),
    payloadJson: String(r.payload_json),
    attempts: Number(r.attempts),
  };
}

/** The one column `wrapHandlerForBackoff` needs beyond what `JobRecord` carries. */
function readMaxAttempts(raw: DatabaseSync, jobId: number): number {
  const row = raw.prepare('SELECT max_attempts FROM jobs WHERE id = ?').get(jobId);
  if (!row) {
    throw new Error(`runner: job id ${jobId} has no row to read max_attempts from`);
  }
  return Number((row as { max_attempts: unknown }).max_attempts);
}

/**
 * Wraps a real handler so a rejection is settled by *this runner's own*
 * injected `backoffMs`, not `run-job.ts`'s fixed curve. `RunnerOptions`
 * lets each `createRunner` caller choose its own backoff — `runner.test.ts`
 * pins several different curves — and `run-job.ts` has no seam for that: its
 * own `backoffMs` is a private, uninjectable copy of the same formula
 * `dispatcher.ts`'s crash sweep uses. Delegating a rejection to it would
 * silently replace whatever curve this runner was built with.
 *
 * So this catches the rejection here, before `run-job.ts`'s own `catch`
 * ever sees it, and writes the same `ready`-with-backoff-or-`dead` outcome
 * `run-job.ts` would have written, but computed from `opts.backoffMs`. It
 * then resolves rather than rethrows: `run-job.ts`'s own `completeRow`
 * still runs next, but its `WHERE state = 'running'` guard — the same guard
 * that protects a handler settling after its own timeout — makes it a
 * no-op here, since this has already moved the row to `ready` or `dead`.
 *
 * The claim itself, the timeout race, and the abort grace are untouched:
 * they are `run-job.ts`'s, reused rather than re-implemented, and none of
 * them reads `backoffMs`.
 */
function wrapHandlerForBackoff(raw: DatabaseSync, opts: RunnerOptions, handler: JobHandler): JobHandler {
  return async (job: JobRecord, ctx: PluginContext, signal?: AbortSignal) => {
    try {
      await handler(job, ctx, signal);
    } catch (err) {
      const now = opts.now();
      const message = err instanceof Error ? err.message : String(err);
      const maxAttempts = readMaxAttempts(raw, job.id);
      if (job.attempts >= maxAttempts) {
        raw.prepare("UPDATE jobs SET state = 'dead', last_error = ?, updated_at = ? WHERE id = ? AND state = 'running'")
          .run(message, now, job.id);
      } else {
        const runAt = now + opts.backoffMs(job.attempts);
        raw.prepare("UPDATE jobs SET state = 'ready', run_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running'")
          .run(runAt, message, now, job.id);
      }
    }
  };
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

    async runOnce(handlers, ctxFor) {
      const now = opts.now();
      // Read-only: which row would be claimed next, exactly the same
      // ordering `dispatcher.ts`'s own `fire()` uses. Nothing here writes —
      // the write is `run-job.ts`'s own claim, below — so this can never
      // itself disturb a row some other in-flight call already claimed.
      const row = raw.prepare(`
        SELECT id, plugin_id, kind, payload_json, attempts FROM jobs
         WHERE state = 'ready' AND run_at <= ?
         ORDER BY run_at, id LIMIT 1
      `).get(now);
      if (!row) return false;
      const due = readDueRow(row);

      const handler = handlers(due.pluginId, due.kind);
      if (!handler) {
        // An unhandled job kind is a visible dead-letter row, not a job
        // that silently vanishes because no method existed to catch it —
        // the same outcome `dispatcher.ts`'s own no-handler branch writes,
        // deliberately not preceded by a claim: a kind nobody will ever
        // register a handler for gains nothing from an attempt charged
        // against it.
        raw.prepare('UPDATE jobs SET state = ?, last_error = ?, updated_at = ? WHERE id = ?')
          .run('dead', `no handler for job kind "${due.kind}" registered by plugin "${due.pluginId}"`, now, due.id);
        return true;
      }

      // `payload` stays `unknown`, same as `dispatcher.ts`'s own `dispatch`:
      // the contract makes no promise about its shape.
      const payload: unknown = JSON.parse(due.payloadJson);
      const job: JobRecord = { id: due.id, kind: due.kind, payload, attempts: due.attempts };
      const ctx = ctxFor(due.pluginId);

      await runJob(
        { raw, now: opts.now, log: adapterLog, sleep: realSleep, abortSignal: (ms) => AbortSignal.timeout(ms) },
        job,
        wrapHandlerForBackoff(raw, opts, handler),
        ctx,
      );
      return true;
    },

    recover() {
      const now = opts.now();
      // Attempts are left untouched either way: the crashed attempt already
      // consumed one, in the same statement that claimed the row. A row already at
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
