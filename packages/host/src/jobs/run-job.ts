import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler, JobRecord, PluginContext } from '@pickarr/contract';
import { makeQPromise } from './qpromise.ts';
import { backoffMs } from './backoff.ts';
import { redactUrl } from '../clients/redact.ts';

/**
 * How long a handler may run before the dispatcher gives up on it and fails
 * its row. Enforced here, never requested of the handler: nothing can kill a
 * JavaScript function mid-execution, so this bounds the row, not the work.
 *
 * **Deliberately above the largest per-hostname fetch timeout**
 * (`fetch/queue.ts`'s `FetchTimeouts`, whose slowest entry is the lookup
 * service's five minutes -- the hard ceiling of the platform it runs on).
 * When the two were both five minutes this one always won, because it is
 * armed when the job starts and the fetch timeout only when the request is
 * issued: the fetch ceiling could never fire, and a slow lookup surfaced as
 * a job killed for running long rather than as a timeout naming the url.
 * The gap is what keeps those two distinguishable in a log, and what lets a
 * request actually use the whole window the far end allows.
 *
 * Raising this raises how long one dead-lettered row can hold a dispatcher
 * slot, which is the cost. Lowering the fetch ceiling instead was the
 * alternative, and it buys the same separation by giving every lookup less
 * time than its service is willing to spend.
 */
export const JOB_TIMEOUT_MS = 360_000;

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
 * One job's lifecycle: claim the row, race the handler against a six-minute
 * abort, and write the outcome back so a handler that settles after its own
 * timeout cannot undo what the timeout already decided -- nor decide anything
 * about a later attempt that has since re-claimed the same row. See the
 * comment on `completeRow`/`failRow` below for why the second half needs the
 * claimed `attempts` and not just `state = 'running'`.
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
  // Conditional on `state = 'ready'` for the same family of reasons
  // `completeRow` and `failRow` below guard on state and attempt: nothing today
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

  // Every outcome write below is conditional on BOTH `state = 'running'` and
  // `attempts = <the count this claim consumed>`, and the attempt half is the
  // load-bearing one across invocations.
  //
  // The state alone is enough within one `runJob`: there is exactly one claim
  // here, so `await running` resuming long after the timeout finds a row the
  // timeout already moved out of `running`, and the write no-ops.
  //
  // It is NOT enough once the dispatcher is in the frame. The timeout path
  // returns this row to `ready` at `now + backoffMs(attempts)`; the
  // dispatcher's timer picks it up a second later and a second worker
  // legitimately claims it back to `running`. This handler is still pending
  // -- nothing can kill it -- so a `state = 'running'` test would match
  // again, while every value in this closure (`attempts`, `maxAttempts`, and
  // the handler's own outcome) describes an attempt that is over. Measured
  // both ways: a late resolve marked the row `done` while attempt 2 was
  // mid-flight, and a late reject readied it under attempt 1's stale count,
  // putting a third copy of the same job in flight. The dispatcher's
  // queued-id set cannot see either, because the row is legitimately `ready`
  // with nothing queued for it at that moment.
  //
  // `attempts` is the discriminator because the claim above is the only
  // statement in the codebase that writes it, one increment per attempt, so
  // two attempts can never share a value. (`started_at` reads more naturally
  // but two claims in the same millisecond would collide.)
  function completeRow(): void {
    deps.raw.prepare("UPDATE jobs SET state = 'done', updated_at = ? WHERE id = ? AND state = 'running' AND attempts = ?")
      .run(deps.now(), job.id, attempts);
  }

  function failRow(err: unknown): void {
    const failedAt = deps.now();
    // Redacted before it reaches the column, not merely trusted to already
    // be safe. Every throw site in this slice redacts at its own source --
    // `clients/downloads.ts` does, before its own `markFailed` write, and
    // rethrows the already-redacted result -- so nothing observed today
    // actually carries a credential this far. But `last_error` is written
    // here, once, for every handler this dispatcher will ever run, present
    // or future; redacting here makes that safe by construction rather than
    // safe only for as long as every caller remembers to.
    const message = redactUrl(err instanceof Error ? err.message : String(err));
    if (attempts >= maxAttempts) {
      // Dead-lettering leaves the row rather than deleting it, with
      // `last_error` set -- a job that vanishes on failure is one nobody can
      // diagnose.
      deps.raw.prepare("UPDATE jobs SET state = 'dead', last_error = ?, updated_at = ? WHERE id = ? AND state = 'running' AND attempts = ?")
        .run(message, failedAt, job.id, attempts);
    } else {
      const runAt = failedAt + backoffMs(attempts);
      deps.raw.prepare("UPDATE jobs SET state = 'ready', run_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running' AND attempts = ?")
        .run(runAt, message, failedAt, job.id, attempts);
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
      // based `sleep` never observes it at all, and `failRow`'s own
      // state-and-attempt guard absorbs it for any job that has
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
