import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler, JobRecord, PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createRunner } from '../../src/jobs/runner.ts';
import { runJob, JOB_TIMEOUT_MS, ABORT_GRACE_MS } from '../../src/jobs/run-job.ts';

/**
 * A `PluginContext` whose capabilities all reject if called, the same shape
 * `runner.test.ts` uses. No test here exercises a plugin's own writes --
 * `runJob` only needs *some* context to hand a handler -- so a capability
 * firing at all means a test reached further than intended.
 */
const fakeCtx: PluginContext = {
  db: undefined,
  media: {
    createMediaItem: async () => { throw new Error('media.createMediaItem: not used by this test'); },
    updateMediaItem: async () => { throw new Error('media.updateMediaItem: not used by this test'); },
    claimProviderRef: async () => { throw new Error('media.claimProviderRef: not used by this test'); },
    relinkRssItem: async () => { throw new Error('media.relinkRssItem: not used by this test'); },
    dropMediaItem: async () => { throw new Error('media.dropMediaItem: not used by this test'); },
    attachPoster: async () => { throw new Error('media.attachPoster: not used by this test'); },
    attachBackground: async () => { throw new Error('media.attachBackground: not used by this test'); },
    attachLogo: async () => { throw new Error('media.attachLogo: not used by this test'); },
    upsertPerson: async () => { throw new Error('media.upsertPerson: not used by this test'); },
    attachRole: async () => { throw new Error('media.attachRole: not used by this test'); },
    setResolution: async () => { throw new Error('media.setResolution: not used by this test'); },
  },
  read: {
    mediaItem: async () => { throw new Error('read.mediaItem: not used by this test'); },
    mediaItemByProviderRef: async () => { throw new Error('read.mediaItemByProviderRef: not used by this test'); },
    rssItemsFor: async () => { throw new Error('read.rssItemsFor: not used by this test'); },
    downloadsFor: async () => { throw new Error('read.downloadsFor: not used by this test'); },
  },
  jobs: { enqueue: async () => { throw new Error('jobs.enqueue: not used by this test'); } },
  fetch: {
    json: async () => { throw new Error('fetch.json: not used by this test'); },
    bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  },
  downloads: { submit: async () => { throw new Error('downloads.submit: not used by this test'); } },
  log: () => {},
};

/** A row read back from `jobs`, narrowed the same way `runner.test.ts` does. */
function readJob(raw: DatabaseSync, id: number) {
  const row = raw.prepare(
    'SELECT state, attempts, run_at, last_error, started_at, updated_at FROM jobs WHERE id = ?',
  ).get(id);
  assert.ok(row, `job ${id} has no row`);
  return row as {
    state: unknown; attempts: unknown; run_at: unknown; last_error: unknown;
    started_at: unknown; updated_at: unknown;
  };
}

/** A `sleep` that resolves on the next microtask, for every test that does not itself control it. */
const noopSleep = (_ms: number): Promise<void> => Promise.resolve();

/** A real signal, for every test that never fires it and needs no fake. */
const realAbortSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);

const noopLog = (): void => {};

/** The default a `let` releaser starts from, before a test's promise assigns its resolver. */
const noop = (): void => {};

/** A handler that does nothing, for every test whose only interest is that it resolved. */
const resolves: JobHandler = async () => {};

/** Shared by every test whose handler must reject; none of them reads the message beyond asserting it. */
const boom: JobHandler = async () => { throw new Error('handler boom'); };

/** Lets pending microtasks run, without waiting on any real time. */
function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * Advances exactly one raw microtask tick -- `await undefined` rather than
 * `await Promise.resolve()` or a `queueMicrotask`-backed promise, both of
 * which cost more than one tick to observe from the awaiting side and would
 * let the very race this exists to catch resolve itself before the next
 * line runs. Unlike `tick()`'s full drain via `setImmediate`, this pins the
 * single-tick-wide window between `isPending()` flipping to `false` and
 * `completeRow`'s write landing -- measured directly against this file's
 * own `runJob`, not assumed.
 */
function hop(): Promise<void> {
  return Promise.resolve();
}

/** Seeds one `ready` row via the real `enqueue`, and the stale pre-claim `JobRecord` the dispatcher would hand `runJob`. */
function seedJob(
  raw: DatabaseSync, now: number, kind: string, defaultMaxAttempts: number,
): { id: number; job: JobRecord } {
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts });
  const id = runner.enqueue('alpha', { kind, payload: { name: 'ada' } });
  // The dispatcher reads this row *before* any claim, so its own copy of
  // `attempts` is always the pre-claim count -- 0 for a fresh job.
  return { id, job: { id, kind, payload: { name: 'ada' }, attempts: 0 } };
}

test('the worker marks the row running and stamps started_at before calling the handler', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { id, job } = seedJob(raw, now, 'greet', 5);

  let seenState: unknown;
  let seenStartedAt: unknown;
  const handler: JobHandler = async () => {
    const row = readJob(raw, id);
    seenState = row.state;
    seenStartedAt = row.started_at;
  };

  await runJob({ raw, now: () => now, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal }, job, handler, fakeCtx);

  assert.equal(seenState, 'running', 'the row must already be running when the handler is called');
  assert.equal(seenStartedAt, now);
});

test('the worker increments attempts, because reaching a worker is a try', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { id, job } = seedJob(raw, now, 'greet', 5);

  let seen: JobRecord | undefined;
  const handler: JobHandler = async (record) => { seen = record; };

  await runJob({ raw, now: () => now, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal }, job, handler, fakeCtx);

  assert.ok(seen, 'handler was never invoked');
  assert.equal(seen.attempts, 1, 'the handler sees the freshly claimed count, "1 on the first run"');
  assert.equal(readJob(raw, id).attempts, 1);
});

test('a handler that resolves completes its row', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { id, job } = seedJob(raw, now, 'greet', 5);

  // The abort signal fires while the handler is still running, standing in
  // for its real five-minute-later firing against a handler that happens to
  // finish around the same time -- the actual race, not just "long after".
  const controller = new AbortController();
  const abortSignal = (_ms: number): AbortSignal => controller.signal;

  let releaseHandler: () => void = noop;
  const late = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const handler: JobHandler = async () => { await late; };

  let releaseSleep: () => void = noop;
  const sleep = (_ms: number): Promise<void> => new Promise((resolve) => { releaseSleep = resolve; });

  const done = runJob({ raw, now: () => now, log: noopLog, sleep, abortSignal }, job, handler, fakeCtx);

  // The grace sleep is pending by the time `abort` returns; held here
  // rather than released immediately.
  controller.abort();
  await tick();

  // Release the handler, then let exactly one microtask hop pass before
  // releasing the grace sleep -- the narrow window where `isPending()`
  // has already flipped to `false` but `completeRow`'s write has not yet
  // landed, so the row is still `running` and the guard would still
  // match. A correct call to `isPending()` reads `false` here and never
  // calls `failRow`, so the row still reaches `done`. A mutant that reads
  // the property instead (always truthy, since it is a function) calls
  // `failRow` inside exactly this window, while the guard still matches,
  // and the failure sticks even though the job succeeded.
  releaseHandler();
  await hop();
  releaseSleep();

  await done;
  assert.equal(
    readJob(raw, id).state,
    'done',
    'a handler that succeeds during the grace window must not be marked failed by a stale pending check',
  );
});

test('a handler that rejects fails its row and reschedules with backoff', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { id, job } = seedJob(raw, now, 'boom', 5);

  await runJob({ raw, now: () => now, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal }, job, boom, fakeCtx);

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready');
  assert.equal(row.last_error, 'handler boom');
  // attempts is 1 after the claim; the backoff curve at attempts=1 is 1000ms.
  assert.equal(row.run_at, now + 1000);
});

test('a handler error carrying an api key in its message is redacted before it reaches last_error', async () => {
  // `downloads.ts` redacts before writing its own table, then rethrows the
  // unredacted error, which lands here unredacted unless this file also
  // redacts at the point of persistence -- see `failRow`'s own comment.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const secret = 'not-a-real-key';
  const leaky: JobHandler = async () => {
    throw new Error(`sabnzbd rejected https://sab.example.com/api?mode=addurl&apikey=${secret}&output=json`);
  };
  const { id, job } = seedJob(raw, now, 'leaky', 5);

  await runJob({ raw, now: () => now, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal }, job, leaky, fakeCtx);

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready');
  assert.ok(typeof row.last_error === 'string');
  assert.ok(!(row.last_error as string).includes(secret), 'the api key must not appear in last_error');
});

test('a handler at its last attempt is dead-lettered rather than rescheduled', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { id, job } = seedJob(raw, now, 'boom', 1);

  await runJob({ raw, now: () => now, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal }, job, boom, fakeCtx);

  const row = readJob(raw, id);
  assert.equal(row.state, 'dead');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'handler boom');
});

test('a handler still pending past the timeout plus grace has its row failed', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { id, job } = seedJob(raw, now, 'stuck', 5);

  // `AbortSignal.timeout`'s own delay is real wall-clock time with no seam
  // this module exposes globally -- so the test injects a signal it
  // controls directly, aborted on command, rather than one waited five
  // real minutes for.
  const controller = new AbortController();
  const abortSignal = (_ms: number): AbortSignal => controller.signal;

  let releaseSleep: () => void = noop;
  const sleep = (_ms: number): Promise<void> => new Promise((resolve) => { releaseSleep = resolve; });

  // Never settles, standing in for a handler still running past its timeout.
  const hang = new Promise<void>(() => {});
  const handler: JobHandler = async () => { await hang; };

  void runJob({ raw, now: () => now, log: noopLog, sleep, abortSignal }, job, handler, fakeCtx);

  // Dispatching `abort` runs its listeners synchronously, so the grace
  // sleep is already pending by the time this returns.
  controller.abort();
  await tick();
  releaseSleep();
  await tick();
  await tick();

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready');
  assert.match(String(row.last_error), /exceeded 5 minutes/);
});

test('a handler that settles after its timeout does not overwrite the failed row', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { id, job } = seedJob(raw, now, 'stuck', 5);

  const controller = new AbortController();
  const abortSignal = (_ms: number): AbortSignal => controller.signal;

  let releaseSleep: () => void = noop;
  const sleep = (_ms: number): Promise<void> => new Promise((resolve) => { releaseSleep = resolve; });

  let releaseHandler: () => void = noop;
  const late = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const handler: JobHandler = async () => { await late; };

  const done = runJob({ raw, now: () => now, log: noopLog, sleep, abortSignal }, job, handler, fakeCtx);

  controller.abort();
  await tick();
  releaseSleep();
  await tick();
  await tick();

  // The conditional-update guard's precondition: the timeout must have
  // already written its verdict before the handler is allowed to settle.
  const timedOut = readJob(raw, id);
  assert.equal(timedOut.state, 'ready', 'sanity: the timeout must already have failed the row');

  releaseHandler();
  await done;

  const after = readJob(raw, id);
  assert.equal(after.state, 'ready', 'a late settle must not flip the row to done');
  assert.match(String(after.last_error), /exceeded 5 minutes/, "the timeout's verdict must remain, not be overwritten");
});

test('a handler is given an AbortSignal', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { job } = seedJob(raw, now, 'greet', 5);

  let seenSignal: AbortSignal | undefined;
  const handler: JobHandler = async (_record, _ctx, signal) => { seenSignal = signal; };

  await runJob({ raw, now: () => now, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal }, job, handler, fakeCtx);

  assert.ok(seenSignal instanceof AbortSignal, 'the handler must receive a real AbortSignal');
});

test('a second claim on an already-claimed row is a detectable no-op, not a double increment', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { id, job } = seedJob(raw, now, 'stuck', 5);

  const controller = new AbortController();
  const abortSignal = (_ms: number): AbortSignal => controller.signal;

  // Never settles -- keeps the row `running` so a second claim has
  // something to collide with.
  const hang = new Promise<void>(() => {});
  const handler: JobHandler = async () => { await hang; };

  // The first claim succeeds and leaves the row `running`.
  void runJob({ raw, now: () => now, log: noopLog, sleep: noopSleep, abortSignal }, job, handler, fakeCtx);
  await tick();
  assert.equal(readJob(raw, id).state, 'running', 'sanity: the first claim must have landed');

  // A second claim against the same stale `JobRecord` -- standing in for
  // whatever future bug would hand `runJob` the same row twice -- must not
  // match the claim's `WHERE state = 'ready'` guard, and must not touch
  // `attempts` again.
  await assert.rejects(
    runJob({ raw, now: () => now, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal }, job, resolves, fakeCtx),
    /has no ready row to claim/,
  );
  assert.equal(readJob(raw, id).attempts, 1, 'a second claim must not double-increment attempts');
});

test('the timeout signal is created with JOB_TIMEOUT_MS, and the grace wait is ABORT_GRACE_MS', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { job } = seedJob(raw, now, 'stuck', 5);

  let seenTimeoutMs: number | undefined;
  const controller = new AbortController();
  const abortSignal = (ms: number): AbortSignal => { seenTimeoutMs = ms; return controller.signal; };

  let seenSleepMs: number | undefined;
  const sleep = (ms: number): Promise<void> => { seenSleepMs = ms; return Promise.resolve(); };

  // Never settles -- keeps the signal listener the only thing exercised.
  const hang = new Promise<void>(() => {});
  const handler: JobHandler = async () => { await hang; };

  void runJob({ raw, now: () => now, log: noopLog, sleep, abortSignal }, job, handler, fakeCtx);

  // The signal is created before `runJob`'s first `await`, so its `ms`
  // argument is already captured by the time this returns. Asserted against
  // the literal, not the imported `JOB_TIMEOUT_MS` -- comparing a captured
  // value to the very constant `runJob` itself read would still pass if
  // that constant were mutated, since both sides would read the same
  // (wrong) number. `assert.equal(JOB_TIMEOUT_MS, 300_000)` alongside pins
  // the exported constant to the same literal, so a mutation to either one
  // is still caught.
  assert.equal(seenTimeoutMs, 300_000, 'the signal must be created with a five-minute timeout');
  assert.equal(JOB_TIMEOUT_MS, 300_000, 'the exported constant itself must still be five minutes');

  controller.abort();
  await tick();

  assert.equal(seenSleepMs, 2_000, 'the grace wait must be asked for exactly two seconds');
  assert.equal(ABORT_GRACE_MS, 2_000, 'the exported constant itself must still be two seconds');
});

test("a grace wait that rejects is logged, not left an unhandled rejection", async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { job } = seedJob(raw, now, 'stuck', 5);

  const controller = new AbortController();
  const abortSignal = (_ms: number): AbortSignal => controller.signal;

  const sleepFailure = new Error('sleep exploded');
  const sleep = (_ms: number): Promise<void> => Promise.reject(sleepFailure);

  let seenMessage: string | undefined;
  let seenDetail: Readonly<Record<string, unknown>> | undefined;
  const log = (message: string, detail?: Readonly<Record<string, unknown>>): void => {
    seenMessage = message;
    seenDetail = detail;
  };

  // Never settles -- the grace wait is the only thing this test exercises.
  const hang = new Promise<void>(() => {});
  const handler: JobHandler = async () => { await hang; };

  void runJob({ raw, now: () => now, log, sleep, abortSignal }, job, handler, fakeCtx);
  controller.abort();
  await tick();

  assert.equal(seenMessage, 'job timeout handler failed', 'a rejecting grace wait must be caught and logged, not left unhandled');
  assert.equal(seenDetail?.err, sleepFailure, 'the log must carry the actual rejection');
});
