import type { DatabaseSync } from 'node:sqlite';
import type { JobRecord } from '@pickarr/contract';
import { createBoundedQueue } from '../util/bounded-queue.ts';

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
export const SAFETY_INTERVAL_MS = 60_000;

/** This task's scheduling half only. Task 5 supplies the real per-job lifecycle. */
export interface Dispatcher {
  /**
   * Re-derives the single timeout from the earliest ready, not-yet-queued
   * `run_at`, clamped to `MAX_TIMER_MS`. Call after anything that changes
   * what is due -- an enqueue, most directly. Leaves the existing timer
   * alone when the target it would compute has not changed, so a caller
   * that re-arms on every write does not thrash a still-valid timer.
   */
  rearm(): void;
  /** Clears the timer and the safety interval. Does not wait on anything in flight. */
  stop(): void;
}

/** The columns `fire` needs to hand a row to the injected runner as a `JobRecord`. */
interface DueRow {
  id: number;
  kind: string;
  payloadJson: string;
  attempts: number;
}

function readDueRow(row: unknown): DueRow {
  const r = row as { id: unknown; kind: unknown; payload_json: unknown; attempts: unknown };
  return {
    id: Number(r.id),
    kind: String(r.kind),
    payloadJson: String(r.payload_json),
    attempts: Number(r.attempts),
  };
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

export function createDispatcher(
  raw: DatabaseSync,
  /**
   * Whatever runs one job -- a stub in this task's own tests; in production,
   * `runJob` from `./run-job.ts` closed over its own dependencies, handler
   * lookup and plugin context at `start()` time, adapted to this narrower
   * shape rather than widening this slot to match its own. **Requirement on
   * any implementation passed here:** the row must be claimed
   * (`state = 'running'`) as the first synchronous act, before this
   * function's first `await`. `./run-job.ts`'s `runJob` satisfies this by
   * making the claim its first statement, before calling the handler.
   *
   * `dispatch` below removes `job.id` from the in-memory queued set the
   * instant the bounded queue grants this call a slot -- not when it
   * resolves -- because that is the moment a synchronous claim would
   * already have flipped the row out of `ready`, letting the database's own
   * `WHERE state = 'ready'` filter take over duty from the in-memory set
   * from then on. An implementation that claims the row only after its own
   * first `await` opens a window where the set has already forgotten the
   * id but the row is still `ready`: a fire (or the safety interval)
   * landing in that window dispatches the same row a second time -- the
   * exact bug the queued set exists to prevent.
   */
  runJob: (job: JobRecord) => Promise<void>,
  opts: DispatcherOptions,
): Dispatcher {
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
    // here -- from a stub in tests, or a bug -- must not become an
    // unhandled rejection that could take the process down.
    void queue.run(async () => {
      // The worker has now taken the job -- it is what frees this id for a
      // later fire to consider again, should the row ever return to `ready`.
      queuedIds.delete(row.id);
      await runJob(job);
    }).catch(() => {});
  }

  function fire(): void {
    const now = opts.now();
    const { clause, values } = excludeClause([...queuedIds]);
    const rows = raw.prepare(`
      SELECT id, kind, payload_json, attempts FROM jobs
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

  const intervalHandle = opts.timers.setInterval(rearm, SAFETY_INTERVAL_MS);
  rearm();

  return {
    rearm,
    stop(): void {
      if (timeoutHandle !== undefined) {
        opts.timers.clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      timerLive = false;
      opts.timers.clearInterval(intervalHandle);
    },
  };
}
