/**
 * The `reconcile` job: one per download client, on a timer the dispatcher
 * already owns. The handler reads the client's config, builds its adapter,
 * fetches a snapshot, walks it (`reconcile.ts`), delivers whatever finished
 * (`deliver.ts`), logs what the tick did (`logTickSummary`), and only then
 * reschedules itself -- the same shape `host.ts`'s own `poll` job already
 * uses, for the same reasons.
 *
 * **The tick never rejects.** `runTick` below catches every failure --
 * contacting the client (its config, its adapter, its snapshot) is one
 * phase, and everything the rest of the tick does is another -- and answers
 * one of four outcomes rather than rejecting: `ok`, `unreachable`, `fault`,
 * or `abandoned` (see below). `createReconcileHandler`'s handler reaches its
 * one call to `scheduleReconcile` on every outcome except `abandoned`.
 *
 * **The dispatcher's timeout is the one remaining retry path.**
 * `run-job.ts`'s `runJob` races this handler against `JOB_TIMEOUT_MS` and,
 * on timeout, readies this very job row -- `state = 'ready'`, a fresh
 * `run_at` -- while the handler keeps running: nothing can kill a running
 * JavaScript function, so the timeout bounds the row, not the work (see
 * `run-job.ts`'s own doc on `JOB_TIMEOUT_MS`). That readied row already IS
 * the retry; the dispatcher's own timer will pick it back up on its own.
 * If this handler went on, after that, to call `scheduleReconcile` anyway,
 * it would enqueue a SECOND, sibling job for the same client:
 * `scheduleReconcile`'s guard excludes only the row that is itself still
 * `running`, and the timeout has already moved this row out of `running`
 * and back to `ready`, so the guard no longer sees anything to decline
 * against and happily schedules a competing cycle. Two cycles running at
 * once means `deliver()` can be called twice for the same completed row.
 *
 * **So a tick that finds its own job already reclaimed stops, rather than
 * rescheduling.** `runTick` checks `signal?.aborted` once its snapshot has
 * resolved -- the one point in the tick cheap enough to check without
 * threading the signal into every adapter's own fetches, which this module
 * deliberately does not do (see `buildReconcileAdapter`: no adapter is ever
 * handed this signal). If the signal is already aborted by then, the tick
 * abandons: it skips the walk and the delivery pass entirely and answers
 * `{ kind: 'abandoned' }`. `createReconcileHandler` does not call
 * `scheduleReconcile` for that outcome -- not even through the
 * `exceptJobId` guard below, which would find nothing to except now that
 * the row is `ready` again and decline to schedule anything, silencing the
 * client's cycle for good. The row the dispatcher already readied is the
 * only continuation this client needs.
 *
 * **In-flight requests still finish.** Checking `signal?.aborted` is not
 * cancelling anything -- nothing here calls `AbortController.abort` on any
 * request this tick itself issued, and no adapter is ever given the signal
 * to cancel with. The snapshot that already resolved finishes exactly as it
 * would have otherwise; an abandoned tick simply declines to start the
 * walk and the delivery pass that would have come after it, which is also
 * why the check sits where it does: after the snapshot, before any of this
 * host's own post-snapshot writes begin, so an abandoned tick never leaves
 * one of those half-done.
 *
 * **The client row is read first, before any work.** `readClientConfig`
 * throws on a client id it cannot find, and if that lookup happened only
 * after, say, a network call, a deleted client's tick would throw AFTER
 * doing needless work, never reach the "stop rescheduling" check below, and
 * retry to exhaustion against a row that no longer exists instead of ending
 * its cycle cleanly. The existence check here selects only `id` -- never
 * `api_key_secret_name`, `username` or `password_secret_name`, which only
 * `readClientConfig` may select at all. Those two name a secret rather than
 * holding one since migration 14, but the rule is unchanged: resolving a
 * name is `readClientConfig`'s job, and a module that never selects one can
 * never resolve one either.
 *
 * **Reschedule goes through `scheduleReconcile`, never a bare `enqueue`.**
 * This handler can legitimately run twice: the enqueue below and the
 * runner's `state = 'done'` write are separate autocommit statements, so a
 * process death between them leaves this job `running`, the next
 * `start()`'s crash sweep readies it, and a bare re-enqueue on the re-run
 * would create a SECOND self-perpetuating cycle, permanently doubling this
 * client's reconcile rate. `scheduleReconcile`'s own guard -- shared with
 * `host.ts`'s poll cycle via `jobs/pending.ts`'s `pendingJobId` -- is what
 * keeps that from happening, and `job.id` is passed as the guard's
 * `exceptJobId` because this job is itself `running` while its own handler
 * executes; without that exclusion the guard would find it, decline to
 * schedule anything, and silence this client's reconcile cycle for good.
 */
import { stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile, JobHandler, JobQueue, JobRecord } from '@pickarr/contract';
import { HOST_PLUGIN_ID } from '../host-id.ts';
import { pendingJobId, readPayloadNumber } from '../jobs/pending.ts';
import type { QueuedFetch } from '../fetch/queue.ts';
import { readClientConfig } from './config.ts';
import type { ClientConfig } from './config.ts';
import type { Secrets } from '../secrets/instance.ts';
import { createQbittorrentClient } from './qbittorrent.ts';
import { createSabnzbdClient } from './sabnzbd.ts';
import { normalizeClientCategory } from './snapshot.ts';
import type { ClientSnapshot, SnapshotAsk } from './snapshot.ts';
import { rowsForClientByStatus } from './rows.ts';
import { SWEPT_STATUSES, walkSnapshot } from './reconcile.ts';
import type { ReconcileResult } from './reconcile.ts';
import { deliverCompleted } from './deliver.ts';
import type { DeliverDeps, DeliverResult } from './deliver.ts';
import { recordContactFailure, recordContactSuccess, reconcileRetryDelayMs } from './health.ts';
import { redactText } from './redact.ts';

/** How long after a tick resolves before the same client is reconciled again. */
export const RECONCILE_INTERVAL_S = 10;

/**
 * Narrows a `reconcile` job's `unknown` payload rather than casting it, so a
 * malformed row fails loudly instead of coercing silently -- the same shape
 * `host.ts`'s own `readPollPayload` gives its `poll` job, built on the same
 * shared, non-throwing `readPayloadNumber` (`jobs/pending.ts`).
 */
function readReconcilePayload(payload: unknown): { clientId: number } {
  const clientId = readPayloadNumber(payload, 'clientId');
  if (clientId === undefined) {
    throw new Error(`reconcile job payload is not shaped like { clientId: number }: ${JSON.stringify(payload)}`);
  }
  return { clientId };
}

/**
 * Whether `download_client` row `clientId` still exists. Selects only `id`
 * -- this is the read the module doc's "read first" step describes, and it
 * must never select `api_key_secret_name`, `username` or
 * `password_secret_name`; only `readClientConfig` may.
 */
function clientRowExists(raw: DatabaseSync, clientId: number): boolean {
  const row = raw.prepare('SELECT id FROM download_client WHERE id = ?').get(clientId);
  return row !== undefined;
}

/**
 * The calls a reconcile tick needs from a client's adapter -- never
 * `submit`, which this job never calls -- as a union discriminated on the
 * client's transport (`config.ts`'s own `ClientType` spelling).
 *
 * **A union, not one interface with an optional `remove`.** The spec's §2
 * rejects a `reclaimsFinishedJobs` boolean because "a flag would leave a
 * method on the interface that must never be invoked, which is the shape of
 * a future bug", and concludes "optionality makes the wrong call impossible
 * to write". That holds of the *adapters*: `createQbittorrentClient`
 * genuinely returns no `remove`, so there is nothing to call. It did not
 * hold of this type. An optional `remove` is still a declared member here,
 * so `remove: (ref) => client.remove(ref)` added to the torrent branch
 * below type-checked, ran, and would have had Pickarr delete torrents --
 * stopping the seed and abandoning the ratio, which §9 says never happens
 * -- with every test still passing. The optionality handed the possibility
 * straight back.
 *
 * With the arms split, the torrent arm has no `remove` field at all, so
 * writing one into it is not a call nobody happens to make: it is an
 * excess property on a discriminated union member, and it fails to
 * compile. That is the difference between a rule and a convention.
 */
type ReconcileAdapter =
  | {
    transport: 'nzb';
    snapshot(ask: SnapshotAsk): Promise<ClientSnapshot>;
    /** Present only on this arm -- an nzb client's history delete costs nothing but the history entry. */
    remove(ref: string): Promise<void>;
  }
  | {
    transport: 'torrent';
    snapshot(ask: SnapshotAsk): Promise<ClientSnapshot>;
  };

/**
 * What this tick will ask the snapshot about (#107): the refs of the
 * client's non-terminal rows, and whether any of them has no ref yet.
 *
 * The same `SWEPT_STATUSES` query `sweepAbsent` runs, deliberately: the
 * sweep is the pass that reads absence, so the set it reads absence for is
 * the set the adapter must have looked for before it may stop paging. A
 * row in that set with a null ref is a `recoverRefs` candidate, which
 * needs the whole list, and sets `everything`. Read before the snapshot,
 * which is the only ordering that can inform it.
 */
export function snapshotAskFor(raw: DatabaseSync, clientId: number): SnapshotAsk {
  const refs = new Set<string>();
  let everything = false;
  for (const row of rowsForClientByStatus(raw, clientId, SWEPT_STATUSES)) {
    if (row.clientRef === null) everything = true;
    else refs.add(row.clientRef);
  }
  return { refs, everything };
}

/**
 * Builds the adapter this tick talks to, from the config `readClientConfig`
 * already decided. Mirrors `clients/downloads.ts`'s own `buildPlan`: switch
 * on `config.kind`, not on `config.implementation` or `config.type`, since
 * `kind` is what already encodes the auth strategy a request needs.
 *
 * Exported for `reconcile-job.test.ts` alone. The composition this function
 * performs -- which client kind ends up with a reclaim capability -- was
 * the one thing no test covered: the adapter having no `remove`
 * (`qbittorrent.test.ts`) and reclaim skipping a deps object without one
 * (`deliver.test.ts`) were both asserted in isolation, and neither said
 * anything about what happens here, in between them.
 */
export function buildReconcileAdapter(config: ClientConfig, fetch: QueuedFetch): ReconcileAdapter {
  const kind = config.kind;
  switch (kind) {
    case 'sabnzbd': {
      const client = createSabnzbdClient(config, fetch);
      return { transport: 'nzb', snapshot: (ask) => client.snapshot(ask), remove: (ref: string) => client.remove(ref) };
    }
    case 'qbittorrent-bearer':
    case 'qbittorrent-login': {
      const client = createQbittorrentClient(config, fetch);
      return { transport: 'torrent', snapshot: (ask) => client.snapshot(ask) };
    }
    default: {
      // Unreachable given today's three-member `ClientConfig['kind']` union
      // -- kept so a fourth kind added without a case here fails to
      // compile instead of falling through silently. Never the config
      // itself, only the discriminant: `config` carries `apiKey`,
      // `username` and `password`.
      const impossible: never = kind;
      throw new Error(`download client has unknown kind ${JSON.stringify(String(impossible))}`);
    }
  }
}

/**
 * Logs what one tick did, as a single line naming the client and every
 * counter that is not zero.
 *
 * **Every non-zero counter, not all of them, and nothing at all when a tick
 * did nothing.** Both `walkSnapshot` and `deliverCompleted` return their
 * counts, and until this existed both returns were discarded: `advanced`,
 * `completed`, `failed`, `untracked`, `recovered`, `absent`,
 * `refsAlreadyHeld`, `recoverFailures`, `delivered`, `reclaimed`,
 * `unowned`, `reclaimFailures` and `undeliverable` were all computed on
 * every tick of every client and visible only to a test. `reclaimFailures`
 * exists because "a client refusing every delete looks identical to a
 * client with nothing left to reclaim if all you have is `reclaimed: 0`" --
 * and nobody outside a test had `reclaimed: 0` either.
 *
 * Filtering to the non-zero ones is the choice worth arguing. A settled
 * client ticks every `RECONCILE_INTERVAL_S` (10s) forever with nothing to
 * report, so logging all
 * thirteen every time -- twelve of them zero -- is a line an operator
 * learns to skip, and a line nobody reads is worth no more than the silence
 * it replaced. Omitting the zeros means the line's *length* carries
 * information: a tick that says `{ clientId, advanced: 3 }` is a normal
 * one, and a tick that mentions `reclaimFailures` at all is the whole of
 * the signal that column was added for. A tick with nothing non-zero logs
 * nothing, so a healthy installation stays quiet and this cannot become the
 * noise that hides the tick that mattered.
 *
 * Counters and one id, never a config and never a row: `config` carries
 * `apiKey`, `username` and `password`, and a `DownloadRow` carries a
 * client-supplied path and a client ref. This is the same rule
 * `deliver.ts`'s `reportUndeliverable` follows for the same reason.
 */
function logTickSummary(
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void,
  clientId: number,
  walked: ReconcileResult,
  delivery: DeliverResult,
): void {
  // Spread rather than named field by field, so a counter added to either
  // result type is reported the day it is added. Naming them here is what
  // let wave 1's own new counters go unlogged; a list restated in a second
  // place is a list that drifts. The `Record<string, number>` annotation is
  // load-bearing too: a future non-numeric field on either result fails to
  // compile here rather than being silently stringified into a log line.
  const counters: Record<string, number> = { ...walked, ...delivery };
  const named: Record<string, number> = {};
  for (const [name, value] of Object.entries(counters)) {
    if (value !== 0) named[name] = value;
  }
  if (Object.keys(named).length === 0) return;

  log('reconcile tick', { clientId, ...named });
}

/** `deliverCompleted`'s `stat` dependency, over the real filesystem. Hoisted to module scope: it closes over nothing from any handler's own call. */
async function statForDeliver(path: string): Promise<{ sizeBytes: number }> {
  const stats = await stat(path);
  return { sizeBytes: stats.size };
}

/**
 * Enqueues the first `reconcile` job for `clientId`, unless one is already
 * `ready` or `running` for it -- the same guarded, idempotent shape
 * `host.ts`'s `schedulePoll`/`enqueuePollUnlessPending` give a feed's poll
 * cycle, built on the same shared `pendingJobId` (`jobs/pending.ts`) so the
 * two guards can never drift apart.
 *
 * `jobs` is the contract's `JobQueue` -- `PluginContext.jobs`, the same
 * shape a plugin's own `ctx.jobs.enqueue` is -- so this returns a
 * `Promise`, not a plain number the way `schedulePoll` does: there is no
 * synchronous id to hand back the moment this actually needs to create a
 * row.
 *
 * `exceptJobId` and `log` are for this module's own reschedule, below --
 * the running job must not find itself pending, and a corrupt payload
 * this scan meets along the way is logged rather than allowed to fail the
 * whole scan. External callers (`main.ts`'s boot-time scheduling,
 * `Host.scheduleReconcile`) pass neither: an outside caller is never the
 * row it is scanning for, and a boot-time caller with nothing to log
 * through is not a reason to fail scheduling a healthy client.
 */
export async function scheduleReconcile(
  raw: DatabaseSync,
  jobs: JobQueue,
  clientId: number,
  runAt?: number,
  exceptJobId?: number,
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void = () => {},
): Promise<number> {
  const existing = pendingJobId(raw, HOST_PLUGIN_ID, 'reconcile', 'clientId', clientId, exceptJobId, log);
  if (existing !== undefined) return existing;
  // Built as two shapes, not one object literal with `runAt` always
  // present: `exactOptionalPropertyTypes` is on, and an explicit
  // `runAt: undefined` is not the same thing as the property being absent.
  return runAt === undefined
    ? jobs.enqueue({ kind: 'reconcile', payload: { clientId } })
    : jobs.enqueue({ kind: 'reconcile', payload: { clientId }, runAt });
}

/**
 * The dependencies `createReconcileHandler` and `runTick` both need. Pulled
 * out of `createReconcileHandler`'s own parameter so `runTick` can name a
 * type instead of repeating the inline object type -- the same fields, the
 * same docblocks, nothing added or dropped.
 */
export interface ReconcileHandlerDeps {
  raw: DatabaseSync;
  fetch: QueuedFetch;
  /**
   * Resolves the `secret` name a client row holds into the credential its
   * adapter sends. Required rather than optional: a default here would be a
   * second place the secrets chain is configured, and the chain's order is
   * its whole contract.
   */
  secrets: Secrets;
  now: () => number;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  deliver: (pluginId: string, file: DownloadedFile) => Promise<void>;
}

/** What one tick decided, for `createReconcileHandler` to turn into a reschedule delay. */
type TickOutcome =
  | { kind: 'ok' }
  | { kind: 'unreachable'; failures: number }
  | { kind: 'fault' }
  | { kind: 'abandoned' };

/**
 * One tick, never rejecting. Contacting the client (its config, its adapter,
 * its snapshot) is one phase, and a failure there is the client's: it is
 * recorded against its health and answered `unreachable`. Everything after a
 * good snapshot is this host's own work, and a fault there is logged and
 * answered `fault`, leaving health alone. `signal` is checked once the
 * snapshot has resolved, and `{ kind: 'abandoned' }` is answered instead of
 * doing any of that post-snapshot work if it is already aborted -- see the
 * module doc for why that is the dispatcher's timeout having already
 * readied this same job, and why the check sits here rather than being
 * threaded into the adapter's own fetches.
 */
async function runTick(
  deps: ReconcileHandlerDeps,
  clientId: number,
  lastUnreadable: Map<number, string>,
  signal?: AbortSignal,
): Promise<TickOutcome> {
  let config: Awaited<ReturnType<typeof readClientConfig>>;
  let category: string | null;
  let adapter: ReturnType<typeof buildReconcileAdapter>;
  let snapshot: ClientSnapshot;
  try {
    config = await readClientConfig(deps.raw, clientId, deps.secrets);
    category = normalizeClientCategory(config.category);
    adapter = buildReconcileAdapter(config, deps.fetch);
    snapshot = await adapter.snapshot(snapshotAskFor(deps.raw, clientId));
  } catch (error) {
    const failures = recordContactFailure(deps.raw, clientId, deps.now());
    deps.log('could not reach the download client, will try again', {
      clientId,
      failures,
      error: error instanceof Error ? redactText(error.message) : String(error),
    });
    return { kind: 'unreachable', failures };
  }

  if (signal?.aborted) {
    // The dispatcher's timeout has already readied this job's own row while
    // this tick was still waiting on the snapshot above. That readied row
    // is the retry; see the module doc for why nothing further runs and why
    // `createReconcileHandler` must not reschedule on this outcome either.
    deps.log('reconcile tick abandoned: the dispatcher already readied this job, so a sibling job is not needed', {
      clientId,
    });
    return { kind: 'abandoned' };
  }

  try {
    // Inside this `try`, not between the two: a snapshot succeeding says
    // the client is reachable, but writing that down is still this host's
    // own work, on a row the tick's post-snapshot phase already owns (see
    // the module doc). A throw here -- the same injected-`ABORT` fault
    // `reconcile-job.test.ts` proves against `download_client` -- is a
    // local fault like any other below, not a reason to leave the client's
    // last-known `consecutive_failures`/`unreachable_since` only partly
    // reset, or to let the throw escape to the dispatcher.
    recordContactSuccess(deps.raw, clientId, deps.now());

    if (snapshot.unreadable.length > 0) {
      // See `ClientSnapshot.unreadable`'s own doc comment: this is the one
      // consumer that exists to log these, so an adapter's guess about an
      // unrecognised status or state shows up as a named value to add to a
      // list, rather than as an unexplained failure with no trace of why.
      //
      // Logged only when the set of values differs from the last one logged
      // for this client -- both adapters already answer `unreadable` sorted
      // (see `snapshot.ts`'s own doc comment), so joining it is a stable key
      // without this module re-sorting it. Without this, a client stuck
      // reporting the same unrecognised status would log the identical line
      // every `RECONCILE_INTERVAL_S` forever.
      const key = snapshot.unreadable.join(',');
      if (lastUnreadable.get(clientId) !== key) {
        deps.log('client reported status or state values this adapter could not interpret', {
          clientId,
          kind: config.kind,
          values: snapshot.unreadable,
        });
        lastUnreadable.set(clientId, key);
      }
    } else {
      // Nothing unreadable this tick: forget what was last logged, so a
      // value that goes away and later comes back is reported again rather
      // than staying silent because of a match against a stale memory.
      lastUnreadable.delete(clientId);
    }

    const walked = walkSnapshot({
      raw: deps.raw,
      clientId,
      category,
      snapshot,
      now: deps.now(),
      log: deps.log,
    });

    // Branched on the adapter's own discriminant, not on whether some
    // `remove` happens to be present: `adapter.transport` is what decides
    // whether this client has a reclaim capability at all, and on the
    // `'torrent'` arm there is no `remove` to reach for even by mistake
    // (see `ReconcileAdapter`).
    //
    // Two shapes, not one object literal with `remove` always present:
    // `exactOptionalPropertyTypes` is on, and an explicit `remove: undefined`
    // is not the same thing as the property being absent, which is what
    // `deliverCompleted`'s own "if `deps.remove` is present" test reads.
    const deliverDeps: DeliverDeps = adapter.transport === 'torrent'
      ? { raw: deps.raw, clientId, now: deps.now(), stat: statForDeliver, deliver: deps.deliver, log: deps.log }
      : {
        raw: deps.raw, clientId, now: deps.now(), stat: statForDeliver, deliver: deps.deliver,
        remove: adapter.remove, log: deps.log,
      };
    const delivery = await deliverCompleted(deliverDeps);

    // One line per tick, after both passes have run, so a tick is described
    // once rather than in two halves a reader has to pair up. See
    // `logTickSummary` for why only the non-zero counters are named.
    logTickSummary(deps.log, clientId, walked, delivery);
    return { kind: 'ok' };
  } catch (error) {
    deps.log('a reconcile tick failed after a good snapshot, will try again', {
      clientId,
      error: error instanceof Error ? redactText(error.message) : String(error),
    });
    return { kind: 'fault' };
  }
}

/**
 * Builds the `reconcile` `JobHandler`. See the module doc for the full
 * ordering and why each step is where it is.
 */
export function createReconcileHandler(deps: ReconcileHandlerDeps): JobHandler {
  // One handler per client-independent dispatcher registration, so one map
  // closed over here is shared by every tick of every client this handler
  // ever runs -- which is exactly what lets "the same values as last time"
  // mean anything. Keyed by `clientId`, holding each client's last-logged
  // `snapshot.unreadable`, joined (see `runTick`'s own comment on the key).
  const lastUnreadable = new Map<number, string>();

  return async (job: JobRecord, ctx, signal) => {
    const { clientId } = readReconcilePayload(job.payload);

    // The client was deleted; end its reconcile cycle rather than dead-letter
    // on a row that is gone. See the module doc for why this check must run
    // before any other work, including `readClientConfig`.
    if (!clientRowExists(deps.raw, clientId)) return;

    const outcome = await runTick(deps, clientId, lastUnreadable, signal);
    // `abandoned` is the one outcome that does not reach `scheduleReconcile`
    // at all -- not even through its `exceptJobId` guard, which would find
    // nothing to except now that the dispatcher's timeout has already moved
    // this row back to `ready`, and would therefore decline to schedule
    // anything. See the module doc.
    if (outcome.kind === 'abandoned') return;
    const delayMs = outcome.kind === 'unreachable'
      ? reconcileRetryDelayMs(outcome.failures)
      : RECONCILE_INTERVAL_S * 1000;
    // The only reschedule, and every other outcome reaches it: see the
    // module doc.
    await scheduleReconcile(deps.raw, ctx.jobs, clientId, deps.now() + delayMs, job.id, deps.log);
  };
}
