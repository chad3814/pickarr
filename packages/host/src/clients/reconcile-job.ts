/**
 * The `reconcile` job: one per download client, on a timer the dispatcher
 * already owns. The handler reads the client's config, builds its adapter,
 * fetches a snapshot, walks it (`reconcile.ts`), delivers whatever finished
 * (`deliver.ts`), and only then reschedules itself -- the same shape
 * `host.ts`'s own `poll` job already uses, for the same reasons.
 *
 * **Rescheduling happens only after the whole tick resolves, never around a
 * throw.** A handler that reschedules unconditionally would give a failing
 * client two live cycles for one -- the dispatcher's own retry of this same
 * row, through its backoff curve, *and* a fresh job this handler enqueued
 * regardless -- and every further failure would double the rate again,
 * permanently. Leaving the reschedule off the throw path means a failing
 * tick is retried through the dispatcher's own backoff on the row that is
 * already there, which is what `host.ts`'s `pollHandler` does and what its
 * own doc comment explains at more length.
 *
 * **The client row is read first, before any work.** `readClientConfig`
 * throws on a client id it cannot find, and if that lookup happened only
 * after, say, a network call, a deleted client's tick would throw AFTER
 * doing needless work, never reach the "stop rescheduling" check below, and
 * retry to exhaustion against a row that no longer exists instead of ending
 * its cycle cleanly. The existence check here selects only `id` -- never
 * `api_key`, `username` or `password`, which only `readClientConfig` may
 * select at all.
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
import { HOST_PLUGIN_ID } from '../host.ts';
import { pendingJobId, readPayloadNumber } from '../jobs/pending.ts';
import type { QueuedFetch } from '../fetch/queue.ts';
import { readClientConfig } from './config.ts';
import type { ClientConfig } from './config.ts';
import { createQbittorrentClient } from './qbittorrent.ts';
import { createSabnzbdClient } from './sabnzbd.ts';
import { normalizeClientCategory } from './snapshot.ts';
import type { ClientSnapshot } from './snapshot.ts';
import { walkSnapshot } from './reconcile.ts';
import { deliverCompleted } from './deliver.ts';
import type { DeliverDeps } from './deliver.ts';

/** How long after a tick resolves before the same client is reconciled again. */
export const RECONCILE_INTERVAL_S = 60;

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
 * must never select `api_key`, `username` or `password`; only
 * `readClientConfig` may.
 */
function clientRowExists(raw: DatabaseSync, clientId: number): boolean {
  const row = raw.prepare('SELECT id FROM download_client WHERE id = ?').get(clientId);
  return row !== undefined;
}

/** The two calls a reconcile tick needs from a client's adapter -- never `submit`, which this job never calls. */
interface ReconcileAdapter {
  snapshot(): Promise<ClientSnapshot>;
  /** Absent for qBittorrent -- see `deliver.ts`'s own module doc for why removing a job from qBittorrent has no safe call to make. */
  remove?(ref: string): Promise<void>;
}

/**
 * Builds the adapter this tick talks to, from the config `readClientConfig`
 * already decided. Mirrors `clients/downloads.ts`'s own `buildPlan`: switch
 * on `config.kind`, not on `config.implementation` or `config.type`, since
 * `kind` is what already encodes the auth strategy a request needs.
 */
function buildReconcileAdapter(config: ClientConfig, fetch: QueuedFetch): ReconcileAdapter {
  const kind = config.kind;
  switch (kind) {
    case 'sabnzbd': {
      const client = createSabnzbdClient(config, fetch);
      return { snapshot: () => client.snapshot(), remove: (ref: string) => client.remove(ref) };
    }
    case 'qbittorrent-bearer':
    case 'qbittorrent-login': {
      const client = createQbittorrentClient(config, fetch);
      return { snapshot: () => client.snapshot() };
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
 * Builds the `reconcile` `JobHandler`. See the module doc for the full
 * ordering and why each step is where it is.
 */
export function createReconcileHandler(deps: {
  raw: DatabaseSync;
  fetch: QueuedFetch;
  now: () => number;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  deliver: (pluginId: string, file: DownloadedFile) => Promise<void>;
}): JobHandler {
  return async (job: JobRecord, ctx) => {
    const { clientId } = readReconcilePayload(job.payload);

    // The client was deleted; end its reconcile cycle rather than dead-letter
    // on a row that is gone. See the module doc for why this check must run
    // before any other work, including `readClientConfig`.
    if (!clientRowExists(deps.raw, clientId)) return;

    const config = readClientConfig(deps.raw, clientId);
    const category = normalizeClientCategory(config.category);
    const adapter = buildReconcileAdapter(config, deps.fetch);

    const snapshot = await adapter.snapshot();
    if (snapshot.unreadable.length > 0) {
      // See `ClientSnapshot.unreadable`'s own doc comment: this is the one
      // consumer that exists to log these, so an adapter's guess about an
      // unrecognised status or state shows up as a named value to add to a
      // list, rather than as an unexplained failure with no trace of why.
      deps.log('client reported status or state values this adapter could not interpret', {
        clientId,
        kind: config.kind,
        values: snapshot.unreadable,
      });
    }

    walkSnapshot({
      raw: deps.raw,
      clientId,
      category,
      snapshot,
      now: deps.now(),
      log: deps.log,
    });

    // Two shapes, not one object literal with `remove` always present:
    // `exactOptionalPropertyTypes` is on, and an explicit `remove: undefined`
    // is not the same thing as the property being absent -- qBittorrent's
    // adapter has no `remove` at all (see `buildReconcileAdapter`).
    const deliverDeps: DeliverDeps = adapter.remove === undefined
      ? { raw: deps.raw, clientId, now: deps.now(), stat: statForDeliver, deliver: deps.deliver, log: deps.log }
      : {
        raw: deps.raw, clientId, now: deps.now(), stat: statForDeliver, deliver: deps.deliver,
        remove: adapter.remove, log: deps.log,
      };
    await deliverCompleted(deliverDeps);

    // Reschedule only now that the whole tick has resolved -- see the
    // module doc for why a throw above must never reach this line.
    await scheduleReconcile(
      deps.raw,
      ctx.jobs,
      clientId,
      deps.now() + RECONCILE_INTERVAL_S * 1000,
      job.id,
      deps.log,
    );
  };
}
