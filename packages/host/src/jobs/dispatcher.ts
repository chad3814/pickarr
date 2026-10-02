import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler, JobRecord, PluginContext } from '@pickarr/contract';
import { createBoundedQueue } from '../util/bounded-queue.ts';
import { runJob } from './run-job.ts';
import { backoffMs } from './backoff.ts';

/**
 * The two native timer pairs the dispatcher needs, injected so a test can
 * observe exactly which handle was cleared and what delay was set rather
 * than waiting on real wall-clock time.
 */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DispatcherOptions {
  now: () => number;
  timers: Timers;
  /** Max jobs executing at once. Defaults to DEFAULT_CONCURRENCY. */
  concurrency?: number;
  /**
   * Passed straight through to `run-job.ts`'s `runJob` for every job this
   * dispatcher runs, and used here too: the one place left where a claim's
   * own thrown no-op (`run-job.ts`'s `WHERE state = 'ready'` guard) would
   * otherwise vanish silently is `dispatch`'s own `catch` below, and this is
   * what it logs through instead of swallowing.
   */
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  /** Passed straight through to `run-job.ts`'s `runJob`, for its abort-grace wait. */
  sleep: (ms: number) => Promise<void>;
  /** Passed straight through to `run-job.ts`'s `runJob`, for its per-job timeout race. */
  abortSignal: (ms: number) => AbortSignal;
}

export const DEFAULT_CONCURRENCY = 8;
/**
 * `setTimeout` beyond roughly 24.8 days (2^31 ms, a 32-bit signed overflow)
 * fires immediately in Node rather than waiting. Left unclamped, a
 * far-future or corrupt `run_at` would fire, find nothing due, re-arm with
 * the same huge delay, and fire again -- a hot loop, not a late job.
 * Clamping every computed delay to this value is also what lets the safety
 * interval below share the timer's own upper bound.
 */
export const MAX_TIMER_MS = 60_000;
/**
 * How often the safety interval re-arms the timer, and also how often it prunes `done` rows.
 * It re-arms first, so a prune that throws cannot skip the re-arm.
 */
export const SAFETY_INTERVAL_MS = 60_000;
/**
 * How long a `done` job stays: a day of `recent` history for the Activities
 * page. `dead` rows are never pruned -- they are what an operator reads.
 */
export const DONE_JOB_RETENTION_MS = 86_400_000;

export interface Dispatcher {
  /**
   * Re-derives the single timeout from the earliest ready, not-yet-queued
   * `run_at`, clamped to `MAX_TIMER_MS`. Call after anything that changes
   * what is due -- an enqueue, most directly. Leaves the existing timer
   * alone when the target it would compute has not changed, so a caller
   * that re-arms on every write does not thrash a still-valid timer.
   */
  rearm(): void;
  /**
   * Sweeps every row a crash left `running` -- there is one process, so a
   * `running` row at this call is by definition one it crashed mid-handler,
   * and `runJob`'s claim stamping `started_at` (`run-job.ts`) means it was
   * genuinely tried, not merely claimed and abandoned. A row already at its
   * last permitted attempt goes
   * to `dead` rather than `ready` -- a job kind that reliably kills the
   * process must not be readied on every boot -- and everything else goes
   * back to `ready` with `run_at` recomputed from the backoff curve, so a
   * crash loop backs off instead of spinning. Then arms the timer and
   * starts the safety interval. Returns how many rows the sweep touched,
   * ready or dead.
   *
   * `handlers` and `ctxFor` are what this dispatcher uses, from here on, to
   * route a due row to the plugin that owns it: closing the real `runJob`
   * (`./run-job.ts`) over its own dependencies, the row's own handler and
   * its plugin's context. That wiring cannot live in `dispatch` below on
   * its own, because `JobRecord` -- the only per-job shape anything
   * downstream of the claim ever sees -- carries no plugin id; only the raw
   * row does.
   */
  start(
    handlers: (pluginId: string, kind: string) => JobHandler | undefined,
    ctxFor: (pluginId: string) => PluginContext,
  ): number;
  /**
   * Clears the timer and the safety interval and returns -- it does not
   * drain. A handler already in flight is abandoned deliberately: its row
   * stays `running`, and the next `start()` sweeps it. Waiting here for a
   * handler that may be hung would reintroduce the exact coupling this
   * whole slice removes; the durable `jobs` row, not this method, is what
   * makes abandoning it safe.
   *
   * It does not cancel work already handed to the bounded queue either,
   * including tasks still waiting for a slot: those run, and claim their
   * rows, after this returns. Safe as production uses it, because
   * `main.ts`'s `createShutdown` calls `stop()`, closes the database and
   * exits with no `await` between them, so Node never resumes a queued task.
   * A future caller that stops without exiting would get claims against a
   * closing database, and the queued-id set is not emptied here either.
   */
  stop(): void;
  /**
   * Resolves once nothing dispatched is still running or waiting for a slot.
   *
   * **A test affordance, and it must not be used for shutdown** -- see
   * `stop()` above for why waiting on in-flight work is the coupling this
   * slice exists to remove. No production caller exists.
   */
  idle(): Promise<void>;
}

/** The columns `fire` needs to hand a row to `start`'s handler lookup and to the real `runJob` as a `JobRecord`. */
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

/** A `running` row read back by the sweep, narrowed the same way `readDueRow` is. */
interface RunningRow {
  id: number;
  attempts: number;
  maxAttempts: number;
}

function readRunningRow(row: unknown): RunningRow {
  const r = row as { id: unknown; attempts: unknown; max_attempts: unknown };
  return { id: Number(r.id), attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts) };
}

/**
 * Builds the `AND id NOT IN (?, ?, ...)` clause and its bound values for a
 * set of ids to exclude, or an empty clause and no values when the set is
 * empty -- `NOT IN ()` is not valid SQL, so the clause itself has to vanish
 * rather than bind against nothing.
 */
function excludeClause(ids: readonly number[]): { clause: string; values: number[] } {
  if (ids.length === 0) return { clause: '', values: [] };
  return { clause: `AND id NOT IN (${ids.map(() => '?').join(',')})`, values: [...ids] };
}

export function createDispatcher(raw: DatabaseSync, opts: DispatcherOptions): Dispatcher {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const queue = createBoundedQueue(concurrency);

  /**
   * Ids handed to the queue but not yet taken off it. A dispatched job's
   * row stays `ready` until a worker starts it (jobs.started_at is stamped
   * only then), so without this, the next fire -- or the safety interval --
   * would see the same still-`ready` row and dispatch it a second time.
   * In-memory only, on purpose: it dies with the process, and a row left
   * `ready` by a crash should be selectable again with nothing to exclude it.
   */
  const queuedIds = new Set<number>();

  let timeoutHandle: unknown;
  /** What `timeoutHandle` was last armed for. `undefined` means unarmed. */
  let armedRunAt: number | undefined;
  /**
   * Whether `timeoutHandle` still corresponds to a pending timer. Set false
   * the instant the timer's own callback runs, so `rearm`'s "nothing
   * changed" shortcut below can never mistake an already-fired, now-inert
   * handle for one still counting down.
   */
  let timerLive = false;
  let intervalHandle: unknown;

  /**
   * Built by `start`, from the `handlers`/`ctxFor` it is given -- `undefined`
   * until then. Nothing can dispatch a job before `start` runs: `fire` is
   * only ever reached through the timer or the safety interval, and both are
   * armed exclusively inside `start`. So the only way `dispatch` below could
   * ever find this still `undefined` is something bypassing that lifecycle
   * entirely, which is a bug worth a clear throw rather than a silent no-op.
   */
  let runClaimedJob: ((pluginId: string, job: JobRecord) => Promise<void>) | undefined;

  /**
   * The earliest `run_at` among ready rows not already queued. Queued ids
   * are excluded here, not only in `fire`: a queued row's `run_at` is
   * already in the past by definition (it was due when queued), so
   * counting it would arm a zero-delay timer that fires, finds nothing new
   * to dispatch (fire's own exclusion skips it), and re-arms on that same
   * row again -- a busy-wait spin while a backlog drains, rather than one
   * timer per row that actually needs waking.
   */
  function earliestArmableRunAt(): number | undefined {
    const { clause, values } = excludeClause([...queuedIds]);
    const row = raw.prepare(`
      SELECT run_at FROM jobs WHERE state = 'ready' ${clause} ORDER BY run_at, id LIMIT 1
    `).get(...values);
    if (!row) return undefined;
    return Number((row as { run_at: unknown }).run_at);
  }

  function rearm(): void {
    const nextRunAt = earliestArmableRunAt();
    if (timerLive && nextRunAt === armedRunAt) {
      // Already counting down toward the same target -- leave it alone
      // rather than clear a perfectly good timer just to set an identical one.
      return;
    }
    if (timeoutHandle !== undefined) {
      opts.timers.clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    armedRunAt = nextRunAt;
    if (nextRunAt === undefined) {
      timerLive = false;
      return;
    }
    const delay = Math.min(Math.max(nextRunAt - opts.now(), 0), MAX_TIMER_MS);
    timeoutHandle = opts.timers.setTimeout(onTimerFire, delay);
    timerLive = true;
  }

  function dispatch(row: DueRow): void {
    queuedIds.add(row.id);
    // `payload` stays `unknown`, the same as `runner.ts`'s claim does: the
    // contract makes no promise about its shape, so nothing here narrows it.
    const payload: unknown = JSON.parse(row.payloadJson);
    const job: JobRecord = { id: row.id, kind: row.kind, payload, attempts: row.attempts };
    // Neither awaited nor its rejection allowed to propagate: `fire` awaits
    // nothing (the queue worker owns the wait), and an uncaught rejection
    // here must not become an unhandled rejection that could take the
    // process down.
    void queue.run(async () => {
      // The worker has now taken the job -- it is what frees this id for a
      // later fire to consider again, should the row ever return to `ready`.
      // This is also the precondition documented on `runClaimedJob` above:
      // whatever runs from here on must claim the row (state = 'running')
      // as its own first synchronous act, before its own first `await`, or
      // a fire landing in the gap this line just opened dispatches the same
      // row a second time.
      queuedIds.delete(row.id);
      if (!runClaimedJob) {
        // Unreachable by construction, and so covered by no test: `fire` is
        // only ever reached through timers armed exclusively inside `start`,
        // which assigns this first. Kept as a loud throw rather than dropped
        // because the alternative to a clear message, if that ever stopped
        // holding, is a silent no-op on a row nobody runs.
        throw new Error(`dispatcher: job id ${row.id} fired before start() wired a handler`);
      }
      await runClaimedJob(row.pluginId, job);
    }).catch((err: unknown) => {
      // Surfaces what would otherwise disappear here silently -- most
      // notably the claim guard's own throw (`run-job.ts`'s
      // `WHERE state = 'ready'` no-op detection) on a row claimed twice: a
      // detected no-op is only worth detecting if something reports it.
      opts.log('dispatcher: job run failed', { jobId: row.id, pluginId: row.pluginId, err });
    });
  }

  function fire(): void {
    const now = opts.now();
    const { clause, values } = excludeClause([...queuedIds]);
    const rows = raw.prepare(`
      SELECT id, plugin_id, kind, payload_json, attempts FROM jobs
       WHERE state = 'ready' AND run_at <= ? ${clause}
       ORDER BY run_at, id LIMIT ?
    `).all(now, ...values, concurrency);
    for (const row of rows) {
      dispatch(readDueRow(row));
    }
  }

  function onTimerFire(): void {
    // The handle that led here has already fired and is now inert; marking
    // it dead first is what lets `rearm`'s shortcut safely re-arm even when
    // the next target happens to compute to the same `run_at` as before --
    // otherwise a clamp-capped wakeup that finds nothing newly due would
    // never re-arm at all.
    timerLive = false;
    fire();
    rearm();
  }

  /** Deletes `done` rows older than the retention. Fires the `jobs` triggers, so the Activities page refreshes. */
  function prune(): void {
    raw.prepare("DELETE FROM jobs WHERE state = 'done' AND updated_at < ?").run(opts.now() - DONE_JOB_RETENTION_MS);
  }

  /**
   * The crash-recovery sweep. Every `running` row here was genuinely
   * started (`runJob`'s claim, in `run-job.ts`, stamps `started_at` only
   * then) by a process that is no longer running it -- there is exactly
   * one, and it is this one, alive
   * right now. Attempts are left untouched either way: the crashed attempt
   * already consumed one, in the same statement that claimed the row.
   */
  function sweep(): number {
    const now = opts.now();
    const rows = raw.prepare("SELECT id, attempts, max_attempts FROM jobs WHERE state = 'running'").all();
    let count = 0;
    for (const row of rows) {
      const { id, attempts, maxAttempts } = readRunningRow(row);
      if (attempts >= maxAttempts) {
        // Dead-lettering, not readying: readying a row with nothing left to
        // retry would hand the same crash back to every future restart, and
        // the host would never finish starting. The message names the
        // crash specifically -- a rejected handler leaves its own message
        // in `last_error`, and a crash is a different diagnosis.
        raw.prepare("UPDATE jobs SET state = 'dead', last_error = ?, updated_at = ? WHERE id = ?")
          .run('process crashed while this job was running, on its last permitted attempt', now, id);
      } else {
        // Backed off, not immediate: `run_at` is recomputed from the same
        // curve a rejected handler's own retry uses, so a job kind that
        // crashes the process backs off across restarts instead of being
        // readied -- and re-crashing -- the instant the host comes back up.
        // `started_at` is cleared: this row is not running anything right
        // now, and a `ready` row with a stale `started_at` would misreport
        // that.
        const runAt = now + backoffMs(attempts);
        raw.prepare("UPDATE jobs SET state = 'ready', run_at = ?, started_at = NULL, updated_at = ? WHERE id = ?")
          .run(runAt, now, id);
      }
      count += 1;
    }
    return count;
  }

  return {
    rearm,
    start(handlers, ctxFor) {
      runClaimedJob = async (pluginId, job) => {
        const handler = handlers(pluginId, job.kind);
        if (!handler) {
          // A visible dead-letter for a job kind nothing has registered --
          // a job that vanishes on an unhandled kind is one nobody can
          // diagnose.
          raw.prepare("UPDATE jobs SET state = 'dead', last_error = ?, updated_at = ? WHERE id = ?")
            .run(`no handler for job kind "${job.kind}" registered by plugin "${pluginId}"`, opts.now(), job.id);
          return;
        }
        const ctx = ctxFor(pluginId);
        await runJob({ raw, now: opts.now, log: opts.log, sleep: opts.sleep, abortSignal: opts.abortSignal }, job, handler, ctx);
      };

      const swept = sweep();

      // Idempotent against a second `start()` call: clear whatever an
      // earlier call armed rather than leak a second timer or interval
      // alongside it.
      if (timeoutHandle !== undefined) {
        opts.timers.clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      timerLive = false;
      if (intervalHandle !== undefined) {
        opts.timers.clearInterval(intervalHandle);
      }
      intervalHandle = opts.timers.setInterval(() => { rearm(); prune(); }, SAFETY_INTERVAL_MS);
      rearm();

      return swept;
    },
    stop(): void {
      if (timeoutHandle !== undefined) {
        opts.timers.clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      timerLive = false;
      if (intervalHandle !== undefined) {
        opts.timers.clearInterval(intervalHandle);
        intervalHandle = undefined;
      }
    },
    idle(): Promise<void> {
      return queue.idle();
    },
  };
}
