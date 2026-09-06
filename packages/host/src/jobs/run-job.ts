import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler, JobRecord, PluginContext } from '@pickarr/contract';
import { makeQPromise } from './qpromise.ts';
import { backoffMs } from './backoff.ts';

/**
 * How long a handler may run before the dispatcher gives up on it and fails
 * its row. Enforced here, never requested of the handler: nothing can kill a
 * JavaScript function mid-execution, so this bounds the row, not the work.
 */
export const JOB_TIMEOUT_MS = 300_000;

/**
 * How long a handler gets to unwind cooperatively once its signal aborts,
 * before the timeout stops waiting and fails the row anyway.
 */
export const ABORT_GRACE_MS = 2_000;

/** The claim's `RETURNING` columns, narrowed from `unknown` rather than asserted. */
function readClaimedRow(row: Record<string, unknown>): { attempts: number; maxAttempts: number } {
  return { attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts) };
}

/**
 * One job's lifecycle: claim the row, race the handler against a five-minute
 * abort, and write the outcome back so a handler that settles after its own
 * timeout cannot undo what the timeout already decided.
 *
 * **The claim is this function's first synchronous act, before its own first
 * `await`.** This is a requirement documented on `createDispatcher`'s
 * injected runner slot (`dispatcher.ts`), not a preference here: that
 * dispatcher drops a job's id from its in-memory queued-id set the instant a
 * worker takes it, trusting the row to already be out of `ready` by then. An
 * implementation that claims after its own first `await` opens a window
 * where the set has forgotten the id but the row is still `ready`, and a
 * fire landing in that window dispatches the same row a second time.
 */
export async function runJob(
  deps: {
    raw: DatabaseSync;
    now: () => number;
    log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
    sleep: (ms: number) => Promise<void>;
    /**
     * Almost always `AbortSignal.timeout` itself. Injected, not called
     * directly, because it is the one seam a test could otherwise only
     * reach by monkey-patching the global -- which reaches every consumer
     * of `AbortSignal.timeout` in the process, not just this call, and
     * cannot assert what `ms` this function actually asked for.
     */
    abortSignal: (ms: number) => AbortSignal;
  },
  job: JobRecord,
  handler: JobHandler,
  ctx: PluginContext,
): Promise<void> {
  // The claim: state, started_at and the attempt, all in one statement, so a
  // crash cannot land between "marked running" and "attempt consumed" and
  // leave the count wrong for whichever recovery reads it next. A crash
  // before this line leaves the row exactly as it was, `ready` at its
  // original `run_at`, charged no attempt for a try that never happened.
  //
  // Conditional on `state = 'ready'` for the same reason `completeRow` and
  // `failRow` below are conditional on `state = 'running'`: nothing today
  // can call this twice for the same row (the dispatcher's synchronous
  // claim keeps its in-memory queued-id set and this statement in lockstep),
  // but if that ever stopped holding, an unconditional `UPDATE` would
  // double-increment `attempts` silently. This guard turns that into a
  // detectable no-op instead -- `claimedRow` comes back empty, exactly as it
  // does for a row that never existed.
  const claimedAt = deps.now();
  const claimedRow = deps.raw.prepare(`
    UPDATE jobs SET state = 'running', started_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND state = 'ready'
    RETURNING attempts, max_attempts
  `).get(claimedAt, claimedAt, job.id);
  if (!claimedRow) {
    throw new Error(`runJob: job id ${job.id} has no ready row to claim`);
  }
  const { attempts, maxAttempts } = readClaimedRow(claimedRow);

  // The handler sees the count this claim just consumed, not the stale
  // pre-claim value the dispatcher read before handing `job` here --
  // `JobRecord.attempts` promises "1 on the first run", and only the freshly
  // claimed count keeps that promise.
  const claimedJob: JobRecord = { ...job, attempts };

  function completeRow(): void {
    // Conditional on `state = 'running'`: `await running` below resumes
    // whenever the handler finally settles, even long after the timeout, and
    // would otherwise overwrite the row the timeout already failed.
    deps.raw.prepare("UPDATE jobs SET state = 'done', updated_at = ? WHERE id = ? AND state = 'running'")
      .run(deps.now(), job.id);
  }

  function failRow(err: unknown): void {
    const failedAt = deps.now();
    const message = err instanceof Error ? err.message : String(err);
    if (attempts >= maxAttempts) {
      // Dead-lettering leaves the row rather than deleting it, with
      // `last_error` set -- a job that vanishes on failure is one nobody can
      // diagnose. Also conditional on `state = 'running'`, for the same
      // late-settle reason as `completeRow`.
      deps.raw.prepare("UPDATE jobs SET state = 'dead', last_error = ?, updated_at = ? WHERE id = ? AND state = 'running'")
        .run(message, failedAt, job.id);
    } else {
      const runAt = failedAt + backoffMs(attempts);
      deps.raw.prepare("UPDATE jobs SET state = 'ready', run_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running'")
        .run(runAt, message, failedAt, job.id);
    }
  }

  const signal = deps.abortSignal(JOB_TIMEOUT_MS);
  const running = makeQPromise(handler(claimedJob, ctx, signal));

  signal.addEventListener('abort', () => {
    // Wrapped rather than an `async` listener directly: an async listener
    // that rejects has nowhere to report, so its failure would surface as an
    // unhandled rejection instead of a failed row.
    void (async () => {
      await deps.sleep(ABORT_GRACE_MS);
      // Called, not read: `isPending` is a function, and the function value
      // itself is always truthy. This is quieter than it sounds -- a timer-
      // based `sleep` never observes it at all, and the `WHERE state =
      // 'running'` guard on `failRow` absorbs it for any job that has
      // already completed by the time this runs. The one real window is a
      // single microtask hop wide: the tick where `isPending()` has already
      // flipped to `false` but `completeRow`'s write has not yet landed, so
      // the row is still `running` and the guard still matches. A handler
      // that happens to settle inside that hop, right as its own timeout
      // fires, gets marked failed despite having succeeded.
      if (running.isPending()) failRow(new Error('job exceeded 5 minutes'));
    })().catch((err: unknown) => deps.log('job timeout handler failed', { err }));
  }, { once: true });

  try {
    // Safe to `await` inside this `try` precisely because the dispatcher
    // never awaits `runJob` itself -- the queue worker does, and the queue's
    // own concurrency bounds how many slots a hung handler can hold.
    await running;
    completeRow();
  } catch (err: unknown) {
    failRow(err);
  }
}
