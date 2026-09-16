/**
 * The sync loops: bootstrap, the tail, the backfill, the generation check and
 * the reset (design spec §5, §6; sync protocol design §5, §5.3, §5.4).
 *
 * **Two cursors, run concurrently, from one pivot.** `GET
 * /api/sync/bootstrap` answers `{ since, before, generation }` where `before`
 * is the pivot `W` and `since` is `W - 1`, so the tail's `id > since` and the
 * backfill's `id < before` meet at `W` and overlap nowhere. The pivot is not
 * a start line: the tail walks *up* from it and the backfill walks *down*
 * from it, which is why both are productive from their first request and why
 * neither waits for the other (sync design §5.3, §5.4).
 *
 * **Everything external is injected** -- `fetch`, the scheduler, the clock
 * and the lease. No `globalThis.fetch`, no bare `setTimeout`, no
 * `requestIdleCallback`: `schedule` is the seam that lets a test drive both
 * loops deterministically, because fake timers hang this suite (`CLAUDE.md`).
 * {@link webLocksLease} is the one adapter here that names a browser API, and
 * it is a separate exported function rather than a default inside
 * {@link startSync} so that the loops themselves reference no global at all.
 *
 * **Nothing is cached in memory.** Every tick reads the cursors and the
 * generation back out of `meta` before it does anything, and reads them again
 * inside the critical section before it applies. Two reasons, and both are
 * failures a cache would have:
 *
 * - A follower promoted to leader must re-check the generation before its
 *   first fetch (spec §5): it may have been elected in the middle of another
 *   tab's reset, so anything it read when it started is of the database that
 *   reset replaced.
 * - The two loops write the *same* `cursors` record -- `Cursors` is a pair --
 *   so a tail tick that wrote back a `before` it read before the backfill
 *   advanced would silently undo the backfill's progress, and vice versa.
 *   The re-read inside the critical section is what makes each loop write the
 *   other's current value rather than a stale one.
 */
import { request, done } from './idb.ts';
import { applyBatch } from './apply.ts';
import {
  readCursors,
  writeCursors,
  readGeneration,
  writeGeneration,
  type Cursors,
} from './meta.ts';
import type { SyncOp } from './wire.ts';
import { emit, emitReset } from './notify.ts';
import {
  holdLease,
  broadcast,
  onMessage,
  serializeChanged,
  deserializeChanged,
} from './leader.ts';

/** The lease name spec §5 names: one tab holds it and is the only one that fetches. */
export const LEASE_NAME = 'pickarr-sync';

/**
 * How long after a tail poll *started* the next one starts. Fixed rate
 * rather than fixed delay, which is what {@link SyncDeps.now} is for -- see
 * `nextTailDelay`.
 */
const TAIL_INTERVAL_MS = 3000;

/**
 * The backfill asks for `0`, meaning "as soon as the scheduler will have
 * me". It is the scheduler's job to decide that idle priority is what spec §5
 * asks for; this module cannot, because it is not allowed to name
 * `requestIdleCallback`.
 */
const BACKFILL_IDLE_MS = 0;

/** The failure ladder: 1s, 2s, 4s … clamped. Per loop, and reset by any success. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CEILING_MS = 30_000;

/** Which of the two cursors a scheduled task belongs to. The scheduler needs it to choose a priority. */
export type SyncLoop = 'tail' | 'backfill';

/**
 * The part of `Response` this module uses, and nothing more.
 *
 * Narrowed deliberately: `Response.json()` is typed `Promise<any>`, and
 * assigning that into a typed local is the shape that lets an unvalidated
 * body through with no cast and no error (Global Constraints: never `any`).
 * Declaring `Promise<unknown>` here forces every field to go through
 * `parseBootstrap`/`parsePage` below. A real `fetch` satisfies this by
 * structural assignment, so production passes `globalThis.fetch` unchanged.
 */
export interface SyncResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type SyncFetch = (url: string) => Promise<SyncResponse>;

/** Cancels a scheduled task that has not run yet. Calling it after the task ran does nothing. */
export type Cancel = () => void;

/**
 * Runs `run` after at least `delayMs`, and answers a {@link Cancel}.
 *
 * `run` returns `void` and **must be called for its effect, not awaited**:
 * this module hands over a synchronous wrapper that starts the tick and
 * contains its own rejection, for the reason `store/notify.ts`'s `invoke`
 * documents -- an `async` function is assignable to `() => void`, so a
 * rejection from one handed straight to a scheduler escapes every `catch`
 * and, under `node --test`, is attributed to whichever test is running.
 */
export type Schedule = (loop: SyncLoop, delayMs: number, run: () => void) => Cancel;

/**
 * The lease, as the loops need it: one method, which calls back once this
 * instance holds it.
 *
 * Injected rather than taken from `store/leader.ts` directly, and the reason
 * is spec §11 -- "a test that cannot deny the lock cannot assert it". It also
 * cannot be `leader.ts`'s `isLeader()`, which is one module-global flag: two
 * `startSync` instances in one process are how "only the lease holder
 * fetches" is testable at all, and a global flag cannot tell them apart.
 *
 * There is no `isHeld()` here on purpose. Whether this instance may fetch is
 * not a question the loops ask -- they do not exist until `onGranted` fires,
 * which is a stronger guarantee than a guard that could be read at the wrong
 * moment.
 */
export interface Lease {
  hold(onGranted: (release: Promise<void>) => void): void;
}

export interface SyncDeps {
  db: IDBDatabase;
  fetch: SyncFetch;
  schedule: Schedule;
  /** Milliseconds, monotonic-ish. Used only to hold the tail to a fixed *rate* rather than a fixed delay. */
  now: () => number;
  locks: Lease;
}

export interface SyncHandle {
  /** Cancels both loops and stops relaying other tabs' messages. Safe to call more than once. */
  stop(): void;
}

/** A sync response that was not `2xx`. Names the url and the status and **never reads the body** (Global Constraints: no row contents in a log) -- a failure's body is exactly the thing most likely to carry one. */
export class SyncHttpError extends Error {
  constructor(url: string, status: number) {
    super(`sync request to ${url} answered ${String(status)}`);
    this.name = 'SyncHttpError';
  }
}

/** A response whose shape is not the protocol's. Names the field at fault and no value from the body. */
export class MalformedResponseError extends Error {
  constructor(url: string, detail: string) {
    super(`sync response from ${url} is malformed: ${detail}`);
    this.name = 'MalformedResponseError';
  }
}

/**
 * An op arrived on the cursor that cannot emit it: a `create` on the tail, or
 * an `upsert` on the backfill.
 *
 * This is a server bug, and the batch is refused rather than applied. The two
 * client obligations (sync design §5.3) are keyed off the op kind -- a
 * `create` never overwrites, a `delete` tombstones rather than removes -- so
 * applying an op under the wrong kind is silently the one failure those rules
 * exist to prevent: a stale value overwriting a newer one, or a deleted row
 * coming back, permanently and for one row at a time.
 *
 * Names the loop, the kind, the table and the id. Never the value.
 */
export class WrongOpKindError extends Error {
  constructor(loop: SyncLoop, op: { op: string; table: string; id: number }) {
    super(
      `the ${loop} cursor cannot emit a "${op.op}" op, and sent one for ["${op.table}", ${String(op.id)}]`,
    );
    this.name = 'WrongOpKindError';
  }
}

/** Which kinds each cursor is allowed to emit (sync design §5.1, §5.2). */
const EMITTABLE: Readonly<Record<SyncLoop, ReadonlySet<string>>> = {
  tail: new Set(['upsert', 'delete']),
  backfill: new Set(['create']),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function asGeneration(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

interface Bootstrap {
  since: number;
  before: number;
  generation: string;
}

function parseBootstrap(url: string, body: unknown): Bootstrap {
  if (!isRecord(body)) throw new MalformedResponseError(url, 'the body is not an object');
  const since = asInteger(body.since);
  const before = asInteger(body.before);
  const generation = asGeneration(body.generation);
  if (since === undefined) throw new MalformedResponseError(url, '"since" is not an integer');
  if (before === undefined) throw new MalformedResponseError(url, '"before" is not an integer');
  if (generation === undefined) throw new MalformedResponseError(url, '"generation" is not a non-empty string');
  return { since, before, generation };
}

/**
 * One op off the wire, rebuilt field by field.
 *
 * `value` is carried across when it is present and dropped when it is not,
 * checked by value rather than by key presence. Either spelling ends in the
 * same place -- `applyBatch` refuses a create or upsert carrying no usable
 * value whichever route it arrives by -- so this is not a second guard and
 * does not need to be: it exists so that a wire response with an explicit
 * `"value": null` is described here, at the boundary that parses the
 * response, rather than reaching a function whose subject is the replica.
 */
function parseOp(url: string, raw: unknown): SyncOp {
  if (!isRecord(raw)) throw new MalformedResponseError(url, 'an op is not an object');
  const kind = raw.op;
  if (kind !== 'create' && kind !== 'upsert' && kind !== 'delete') {
    throw new MalformedResponseError(url, 'an op has no recognised "op" kind');
  }
  const table = raw.table;
  if (typeof table !== 'string' || table === '') {
    throw new MalformedResponseError(url, 'an op has no "table"');
  }
  const id = asInteger(raw.id);
  if (id === undefined) throw new MalformedResponseError(url, 'an op has no integer "id"');
  return raw.value === undefined ? { op: kind, table, id } : { op: kind, table, id, value: raw.value };
}

interface Page {
  ops: readonly SyncOp[];
  /** `null` only ever from the backfill, and it means the walk is exhausted (sync design §5.2). */
  cursor: number | null;
  generation: string;
}

/**
 * `{ ops, cursor, generation }`, validated.
 *
 * **A null `cursor` from the tail is refused.** `tailSince` answers `since`
 * unchanged for an empty page and the last entry's id otherwise -- never
 * null -- so a null there is a server bug, and `Cursors.since` has no
 * reading for it. Exhaustion is the backfill's word alone.
 */
function parsePage(url: string, loop: SyncLoop, body: unknown): Page {
  if (!isRecord(body)) throw new MalformedResponseError(url, 'the body is not an object');
  const generation = asGeneration(body.generation);
  if (generation === undefined) throw new MalformedResponseError(url, '"generation" is not a non-empty string');
  const rawOps = body.ops;
  if (!Array.isArray(rawOps)) throw new MalformedResponseError(url, '"ops" is not an array');
  const ops: readonly SyncOp[] = rawOps.map((raw: unknown) => parseOp(url, raw));
  const cursor = body.cursor === null ? null : asInteger(body.cursor);
  if (cursor === undefined) throw new MalformedResponseError(url, '"cursor" is not an integer or null');
  if (cursor === null && loop === 'tail') {
    throw new MalformedResponseError(url, 'the tail answered a null cursor, which only the backfill may do');
  }
  return { ops, cursor, generation };
}

/** Refuses the whole batch if any op is of a kind this cursor cannot emit. See {@link WrongOpKindError}. */
function refuseWrongKinds(loop: SyncLoop, ops: readonly SyncOp[]): void {
  for (const op of ops) {
    if (!EMITTABLE[loop].has(op.op)) throw new WrongOpKindError(loop, op);
  }
}

/** What one tick did, and whether its loop should be scheduled again. */
type Outcome =
  /** Schedule this loop again. */
  | 'continue'
  /** The backfill answered a null cursor. Exhaustion is permanent (sync design §5.2) -- do not schedule it again. */
  | 'retired'
  /** Something else has already scheduled this loop -- the reset does, for both. */
  | 'handled';

function ignore(): void {
  // The mutex's tail: a rejection is the caller's to report, not the queue's.
}

/**
 * Starts the sync loops. Returns immediately; nothing is fetched until this
 * instance is granted the lease.
 */
export function startSync(deps: SyncDeps): SyncHandle {
  const { db, now } = deps;

  /** `stop()` was called. Terminal. */
  let stopped = false;
  /** This instance holds the lease. Until it does, no tick runs and nothing is scheduled. */
  let leading = false;
  const pending = new Map<SyncLoop, Cancel>();
  const failures = new Map<SyncLoop, number>();

  function mayFetch(): boolean {
    return leading && !stopped;
  }

  /**
   * Serialises the read-modify-write half of a tick against the other loop's.
   *
   * **A page fetch stays outside it**, which is what keeps the two cursors
   * concurrent in the sense spec §5 means: neither loop waits for the other's
   * page. Only the moment where a tick re-reads `cursors` and writes the pair
   * back is exclusive -- because `Cursors` is a pair and each loop owns one
   * half of it, so an interleaved read-then-write loses the other half's
   * advance (see this module's doc comment).
   *
   * **Two fetches do run inside it, and both are bootstraps.** The one in
   * `ensureBootstrapped` and the one in `reset` are deliberately serialised:
   * they decide the pivot *both* loops descend from and ascend from, so two
   * of them racing would leave each loop walking from a different origin.
   * That is the right trade and it has a cost worth naming rather than
   * discovering: while a bootstrap is in flight, **both** loops are blocked,
   * so a `/api/sync/bootstrap` that never answers stalls the whole store
   * silently -- no timeout, no log line, and `stop()` does not revive it.
   * An earlier version of this comment said the fetch stays outside, full
   * stop, which was false of half the call sites and hid exactly that.
   */
  let queue: Promise<void> = Promise.resolve();
  function exclusive<T>(body: () => Promise<T>): Promise<T> {
    const result = queue.then(body);
    queue = result.then(ignore, ignore);
    return result;
  }

  /**
   * A tab that does not fetch learns what changed here, and nowhere else:
   * `applyBatch` never runs in its process, so this is the only thing that
   * ever wakes its subscribers.
   *
   * **A message arriving while this tab holds the lease is its own echo, and
   * is dropped.** Only a lease holder ever broadcasts -- it is the only tab
   * that applies a batch or runs a reset -- so there is no other sender it
   * could be from. And the echo is real rather than theoretical: a
   * `BroadcastChannel` does not deliver to the object that posted, but
   * `broadcast` posts from a channel of its own, and every *other* same-name
   * channel in the same context receives it, `onMessage`'s shared one
   * included (measured: two channels in one process, one post, both other
   * listeners fired). Without this guard the leader emitted every change
   * twice and a reset twice.
   *
   * What it costs: a tab promoted between the old leader's broadcast and its
   * delivery drops that one message. It re-reads the generation before its
   * first fetch anyway (spec §5), so the state it would have been told about
   * is the state it is about to check.
   */
  const unsubscribe = onMessage((msg) => {
    if (leading) return;
    if (msg.type === 'reset') {
      emitReset();
      return;
    }
    emit(deserializeChanged(msg.changed));
  });

  function stopLoops(): void {
    for (const cancel of pending.values()) cancel();
    pending.clear();
  }

  /**
   * At most one pending task per loop: an existing one is cancelled rather
   * than left to fire alongside the new one, which is what makes a reset able
   * to restart both loops without either running twice.
   */
  function schedule(loop: SyncLoop, delayMs: number): void {
    if (!mayFetch()) return;
    pending.get(loop)?.();
    pending.set(
      loop,
      deps.schedule(loop, delayMs, () => {
        void tick(loop);
      }),
    );
  }

  function backoffFor(count: number): number {
    return Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** (count - 1));
  }

  /**
   * Reports and retries. Never handed a row -- only the error, which is the
   * failing layer's own words about its own failure, exactly as
   * `store/notify.ts` reports a subscriber's.
   */
  function reportFailure(loop: SyncLoop, err: unknown): void {
    const count = (failures.get(loop) ?? 0) + 1;
    failures.set(loop, count);
    console.error(`pickarr: the ${loop} sync loop failed (attempt ${String(count)})`, err);
    schedule(loop, backoffFor(count));
  }

  /** Fixed rate, not fixed delay: a tick that took 800ms of a 3s interval is followed 2.2s later. */
  function nextTailDelay(startedAt: number): number {
    return Math.max(0, TAIL_INTERVAL_MS - (now() - startedAt));
  }

  /**
   * The cursors and the generation, read together in one `readonly`
   * transaction so a reset landing between the two reads cannot produce a
   * pair from two different databases. `undefined` if either is absent --
   * which is a fresh replica, or one the reset has just wiped.
   */
  async function readMeta(): Promise<{ cursors: Cursors; generation: string } | undefined> {
    const tx = db.transaction('meta', 'readonly');
    const [cursors, generation] = await Promise.all([readCursors(tx), readGeneration(tx)]);
    if (cursors === undefined || generation === undefined) return undefined;
    return { cursors, generation };
  }

  async function fetchJson(url: string): Promise<unknown> {
    const res = await deps.fetch(url);
    // Refused before the body is touched. A failed response's body is the
    // most likely place for a row to be echoed back, and nothing here needs
    // it -- the status is the whole of what a retry decision turns on.
    if (!res.ok) throw new SyncHttpError(url, res.status);
    return res.json();
  }

  async function fetchPage(loop: SyncLoop, from: number): Promise<Page> {
    const url =
      loop === 'tail'
        ? `/api/sync?since=${String(from)}`
        : `/api/sync/backfill?before=${String(from)}`;
    return parsePage(url, loop, await fetchJson(url));
  }

  /**
   * `GET /api/sync/bootstrap`, then the pivot and the generation written
   * together in one transaction. Answers the generation it wrote, which is
   * the one the reset broadcasts.
   *
   * Both `put`s are issued before either is awaited, so they are in the same
   * transaction by construction rather than by trusting that an `await`
   * between them lands inside the transaction's window.
   */
  async function bootstrapCursors(): Promise<string> {
    const boot = parseBootstrap('/api/sync/bootstrap', await fetchJson('/api/sync/bootstrap'));
    const tx = db.transaction('meta', 'readwrite');
    await Promise.all([
      writeCursors(tx, { since: boot.since, before: boot.before }),
      writeGeneration(tx, boot.generation),
    ]);
    await done(tx);
    return boot.generation;
  }

  /** Bootstraps if and only if nothing is stored, inside the critical section so the two loops cannot both do it. */
  function ensureBootstrapped(): Promise<void> {
    return exclusive(async () => {
      if (stopped) return;
      if ((await readMeta()) === undefined) await bootstrapCursors();
    });
  }

  /** `rows` and `meta`, both emptied in one transaction, so no reader ever sees one without the other. */
  async function wipe(): Promise<void> {
    const tx = db.transaction(['rows', 'meta'], 'readwrite');
    await Promise.all([
      request(tx.objectStore('rows').clear()),
      request(tx.objectStore('meta').clear()),
    ]);
    await done(tx);
  }

  /**
   * The generation mismatch: this replica is of a database that no longer
   * exists (spec §6).
   *
   * **The order is the contract, not an implementation detail.** Wipe, then
   * re-bootstrap and write the new cursors and token, and only *then* tell
   * the other tabs -- a tab that re-read on hearing the broadcast before the
   * commit would see a half-wiped store. The loops are restarted last,
   * including the backfill, which has a fresh pivot to walk down from even
   * if it had already retired against the old one.
   *
   * Wiping *before* the bootstrap fetch, rather than after it, is also the
   * fail-safe half: if the fetch never answers, this client is left with an
   * empty replica and no cursors, which bootstraps cleanly on its next start.
   * The other order would leave a stale replica of a dead database in place.
   */
  async function reset(): Promise<void> {
    await wipe();
    const generation = await bootstrapCursors();
    broadcast({ type: 'reset', generation });
    emitReset();
    schedule('tail', 0);
    schedule('backfill', BACKFILL_IDLE_MS);
  }

  async function runOnce(loop: SyncLoop): Promise<Outcome> {
    const meta = await readMeta();
    if (meta === undefined) {
      await ensureBootstrapped();
      return 'continue';
    }
    // Where this loop asks from, and -- for the backfill -- whether it asks at
    // all. A stored `before` of `null` means the walk is exhausted, and
    // exhaustion is permanent (sync design §5.2). Read out of `meta` rather
    // than held in a flag, so it survives a reload and so a reset writing a
    // fresh pivot un-retires the walk with nothing having to remember it did.
    let from: number;
    if (loop === 'tail') {
      from = meta.cursors.since;
    } else {
      if (meta.cursors.before === null) return 'retired';
      from = meta.cursors.before;
    }
    const page = await fetchPage(loop, from);

    return exclusive(async () => {
      if (!mayFetch()) return 'handled';
      const fresh = await readMeta();
      // A wiped store, or one whose token this page does not belong to. Both
      // mean the same thing and take the same route -- `undefined !==
      // page.generation` is true, so there is no special case for the first.
      if (fresh?.generation !== page.generation) {
        await reset();
        return 'handled';
      }
      // Compare-and-swap on this loop's own cursor. It moved while the fetch
      // was in flight, so this page was computed against a position that no
      // longer exists -- which is what a reset by the *other* loop leaves
      // behind. Applying its cursor would write a position from the old
      // database's log over the new one's.
      const held = loop === 'tail' ? fresh.cursors.since : fresh.cursors.before;
      if (held !== from) return 'continue';

      refuseWrongKinds(loop, page.ops);

      const next: Cursors =
        loop === 'tail'
          ? { since: page.cursor ?? fresh.cursors.since, before: fresh.cursors.before }
          : { since: fresh.cursors.since, before: page.cursor };
      const retired = loop === 'backfill' && next.before === null;

      // Nothing to write: no ops, and the cursor did not move. Skipped rather
      // than applied so an idle tail does not open a transaction every poll.
      // A page with no ops whose cursor *did* move is still applied -- the
      // backfill's cursor is the lowest entry it read, not the lowest op it
      // served, so a page of entries it could not resolve advances the walk
      // with nothing to show (sync design §5.2).
      if (page.ops.length === 0 && next.since === fresh.cursors.since && next.before === fresh.cursors.before) {
        return retired ? 'retired' : 'continue';
      }

      const changed = await applyBatch(db, page.ops, next);
      // Carries table names and ids only, by `Changed`'s own shape. The
      // leader's own subscribers were already woken by `applyBatch`; this is
      // for the tabs that do not fetch.
      if (changed.touched.size > 0) {
        broadcast({ type: 'changed', changed: serializeChanged(changed) });
      }
      return retired ? 'retired' : 'continue';
    });
  }

  async function tick(loop: SyncLoop): Promise<void> {
    pending.delete(loop);
    if (!mayFetch()) return;
    const startedAt = now();
    try {
      const outcome = await runOnce(loop);
      failures.delete(loop);
      if (outcome !== 'continue') return;
      schedule(loop, loop === 'tail' ? nextTailDelay(startedAt) : BACKFILL_IDLE_MS);
    } catch (err) {
      reportFailure(loop, err);
    }
  }

  /**
   * Bootstraps eagerly on the grant so the first tick of each loop already
   * has a pivot, then starts both. A failure here falls through to the tail's
   * backoff, whose next tick reaches `ensureBootstrapped` by
   * {@link runOnce}'s own absent-meta branch.
   */
  async function begin(): Promise<void> {
    try {
      await ensureBootstrapped();
      if (!mayFetch()) return;
      schedule('tail', 0);
      schedule('backfill', BACKFILL_IDLE_MS);
    } catch (err) {
      reportFailure('tail', err);
    }
  }

  deps.locks.hold((release) => {
    leading = true;
    // `leader.ts`'s `release` never settles, which is the production case:
    // a browser tears the lock down with the tab. A lease that *does* release
    // means this tab is no longer the one that fetches, so the loops stop --
    // but the channel relay above does not, because a demoted tab still
    // displays rows and still needs to hear about them.
    void release.then(
      () => {
        leading = false;
        stopLoops();
      },
      (err: unknown) => {
        console.error('pickarr: the sync lease rejected', err);
      },
    );
    void begin();
  });

  return {
    stop(): void {
      stopped = true;
      leading = false;
      stopLoops();
      unsubscribe();
    },
  };
}

/**
 * The production {@link Lease}: `store/leader.ts`'s Web Lock, with a
 * per-instance view of whether it was granted.
 *
 * Separate from {@link startSync} so that the loops name no browser API at
 * all, and so a test can supply a lease it is able to *deny* (spec §11).
 */
export function webLocksLease(name: string = LEASE_NAME): Lease {
  return {
    hold(onGranted: (release: Promise<void>) => void): void {
      holdLease(name, onGranted);
    },
  };
}
