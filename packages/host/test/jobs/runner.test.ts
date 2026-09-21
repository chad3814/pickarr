import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobHandler, JobRecord, PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createRunner } from '../../src/jobs/runner.ts';
import { createDispatcher } from '../../src/jobs/dispatcher.ts';
import type { Timers } from '../../src/jobs/dispatcher.ts';

/**
 * A `PluginContext` whose capabilities all reject if called. No test here
 * exercises a plugin's own writes — a job here only ever needs *some*
 * context to hand a handler — so a capability firing at all means a test
 * reached further than intended.
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
  library: {
    place: async () => { throw new Error('library.place: not used by this test'); },
  },
  fetch: {
    json: async () => { throw new Error('fetch.json: not used by this test'); },
    bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  },
  downloads: { submit: async () => { throw new Error('downloads.submit: not used by this test'); } },
  log: () => {},
};

/** A row read back from `jobs`, narrowed the same way `migrate.test.ts` does. */
function readJob(raw: ReturnType<typeof openTestDatabase>['raw'], id: number) {
  const row = raw.prepare(
    'SELECT state, attempts, run_at, last_error, updated_at FROM jobs WHERE id = ?',
  ).get(id);
  assert.ok(row, `job ${id} has no row`);
  return row as {
    state: unknown; attempts: unknown; run_at: unknown; last_error: unknown; updated_at: unknown;
  };
}

/** Shared by every test whose handler must throw; none of them reads the message. */
const boom: JobHandler = async () => { throw new Error('handler boom'); };

/** One `setTimeout`/`setInterval` call, as the fake `Timers` below records it. */
interface TimerCall {
  handle: number;
  ms: number;
  fn: () => void;
}

/**
 * A `Timers` whose every call is logged rather than actually scheduled, the
 * same fake `dispatcher.test.ts` builds for `createDispatcher` directly —
 * duplicated here rather than imported, since neither file shares a
 * test-support module with the other. "Advancing the clock" in this file
 * means invoking a logged `fn` directly, never waiting on real time.
 */
function createFakeTimers(): { timers: Timers; setTimeoutCalls: TimerCall[] } {
  let nextHandle = 0;
  const setTimeoutCalls: TimerCall[] = [];
  const timers: Timers = {
    setTimeout(fn, ms) {
      const handle = ++nextHandle;
      setTimeoutCalls.push({ handle, ms, fn });
      return handle;
    },
    clearTimeout() {},
    setInterval(_fn, _ms) {
      const handle = ++nextHandle;
      // No test here drives the safety interval directly, so its own call
      // is recorded nowhere — only its handle needs to exist, so `stop()`
      // has something to clear.
      return handle;
    },
    clearInterval() {},
  };
  return { timers, setTimeoutCalls };
}

/** A `sleep` no test here ever waits on: nothing in this file drives a handler past its timeout. */
const noopSleep = (_ms: number): Promise<void> => Promise.resolve();

/** A real signal, for every test that never fires it and needs no fake. */
const realAbortSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);

const noopLog = (): void => {};

test('a ready job is claimed, run, and marked done', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 3 });

  const id = runner.enqueue('alpha', { kind: 'greet', payload: { name: 'ada' } });
  assert.equal(typeof id, 'number');

  let seen: JobRecord | undefined;
  const handler: JobHandler = async (job) => { seen = job; };

  // Driven directly through `createDispatcher`, the same object
  // `Host.start()`/`stop()`/`idle()` wrap, rather than through `Host`
  // itself: this file, like `dispatcher.test.ts`, needs no plugin
  // registration, no fetch queue and no download clients — only a raw
  // database and the dispatcher's own methods.
  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer for the due job');
  fire();
  await dispatcher.idle();

  assert.ok(seen, 'handler was never invoked');
  assert.equal(seen.id, id);
  assert.equal(seen.kind, 'greet');
  assert.deepEqual(seen.payload, { name: 'ada' });
  assert.equal(seen.attempts, 1);

  const row = readJob(raw, id);
  assert.equal(row.state, 'done');
});

test('a job whose run_at is in the future is not claimed', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 3 });

  const id = runner.enqueue('alpha', { kind: 'greet', payload: {}, runAt: now + 10_000 });

  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => boom, () => fakeCtx);

  // `boom` stands in for "must not run": `fire` re-checks `run_at <= now()`
  // against the clock, not against the fact that a timer callback ran, so
  // invoking it here — as if 10 real seconds had somehow already elapsed —
  // still finds nothing due. If it ever dispatched anyway, `boom` throwing
  // would move the row out of `ready` and the assertions below would catch it.
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();
  await dispatcher.idle();

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready', 'a job not yet due must not be claimed');
  assert.equal(row.attempts, 0);
});

test('a throwing handler is retried with backoff written to run_at', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  // A rejected handler retries through `run-job.ts`'s own `failRow`, which
  // always uses `../../src/jobs/backoff.ts`'s fixed curve, the one every
  // retry path in this package shares — `RunnerOptions` has no `backoffMs`
  // of its own to inject one.
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 5 });

  const id = runner.enqueue('alpha', { kind: 'boom', payload: {} });

  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => boom, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();
  await dispatcher.idle();

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready');
  // Read back from the row, not from elapsed time: the clock is injected.
  // 1000 is `backoffMs(1)` from `../../src/jobs/backoff.ts`, hardcoded
  // rather than computed by calling that function: computing it here would
  // let a broken curve cancel itself out against this same assertion.
  assert.equal(row.run_at, now + 1000);
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'handler boom');
});

test('backoff is measured from when the handler failed, not from when the job was claimed', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  let now = 1000;
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 5 });

  const id = runner.enqueue('alpha', { kind: 'slow', payload: {} });

  // A handler that takes longer than its own backoff. The clock has to move
  // *across* the handler, which is why the frozen clock every other test here
  // injects cannot catch this: with `now` constant, the claim time and the
  // failure time are the same number and either implementation passes.
  const slow: JobHandler = async () => {
    now += 30_000;
    throw new Error('handler boom');
  };

  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => slow, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();
  await dispatcher.idle();

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready');
  // 31_000 is when it failed. Offsetting from the claim would give 2_000,
  // already in the past — a handler slower than its curve would retry with
  // no delay at all, and one much slower would retry instantly until it
  // died. 1000 is `backoffMs(1)`, hardcoded for the same reason as the test
  // above: computing it here would let a broken curve cancel itself out.
  assert.equal(row.run_at, 31_000 + 1000, 'run_at is the failure time plus the backoff');
  assert.equal(row.updated_at, 31_000, 'the row was written when the handler failed, not when it was claimed');
});

test('a handler that always throws reaches dead after max_attempts, and its row remains', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  let now = 1000;
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 2 });

  const id = runner.enqueue('alpha', { kind: 'boom', payload: {} });

  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => boom, () => fakeCtx);
  const firstFire = setTimeoutCalls[0]?.fn;
  assert.ok(firstFire, 'construction did not arm a timer');
  firstFire();
  await dispatcher.idle();

  const afterFirst = readJob(raw, id);
  assert.equal(afterFirst.state, 'ready', 'first failure retries, it does not dead-letter yet');
  assert.equal(afterFirst.attempts, 1);

  // Advance the clock to (at least) the backoff the first failure wrote,
  // then re-derive the timer from the now-due row rather than assume the
  // dispatcher rearmed on its own — nothing here calls `rearm` except this
  // test, since a real host's safety interval is what would do it in
  // production.
  now = Number(afterFirst.run_at);
  dispatcher.rearm();
  const secondFire = setTimeoutCalls.at(-1)?.fn;
  assert.ok(secondFire, 'rearm did not arm a timer for the retry');
  secondFire();
  await dispatcher.idle();

  const row = readJob(raw, id);
  assert.equal(row.state, 'dead');
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, 'handler boom');
});

test('the claim and the attempt increment are one statement, not two', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 3 });

  // Every UPDATE to `jobs`, recorded as it lands. A process can be killed
  // between two statements but not inside one, so "how many writes did the
  // claim take" is the whole of whether a crash can land between taking the
  // row and consuming its attempt — and it is not observable from JavaScript,
  // which never runs between two synchronous statements.
  raw.exec(`
    CREATE TABLE jobs_audit (seq INTEGER PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL);
    CREATE TRIGGER jobs_audit_update AFTER UPDATE ON jobs BEGIN
      INSERT INTO jobs_audit (state, attempts) VALUES (NEW.state, NEW.attempts);
    END;
  `);

  runner.enqueue('alpha', { kind: 'audited', payload: {} });

  // Read from inside the handler: by then the claim has finished and nothing
  // else has written the row yet.
  let duringHandler: { state: unknown; attempts: unknown }[] = [];
  const handler: JobHandler = async () => {
    duringHandler = raw.prepare('SELECT state, attempts FROM jobs_audit ORDER BY seq').all()
      .map((row) => {
        const audited = row as { state: unknown; attempts: unknown };
        return { state: audited.state, attempts: audited.attempts };
      });
  };

  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();
  await dispatcher.idle();

  // One write, carrying both facts. Two writes — `running` with the old
  // count, then the count — is the window a crash slips through: the next
  // `start()`'s crash sweep would read `attempts` as unconsumed, ready the
  // row, and hand the same process-killing job back on every restart.
  assert.deepEqual(duringHandler, [{ state: 'running', attempts: 1 }]);
});

test('a job whose kind has no handler goes dead rather than silently vanishing', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 3 });

  const id = runner.enqueue('alpha', { kind: 'mystery', payload: {} });

  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => undefined, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();
  await dispatcher.idle();

  const row = readJob(raw, id);
  assert.equal(row.state, 'dead');
  assert.equal(typeof row.last_error, 'string');
  assert.ok(String(row.last_error).includes('mystery'), 'last_error should name the unhandled kind');
  // Never claimed: a kind nobody will ever register a handler for gains
  // nothing from an attempt charged against it.
  assert.equal(row.attempts, 0, 'an unhandled kind must not be charged an attempt it never ran');
});

test('claiming takes the earliest run_at, then the lowest id', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 3 });

  const late = runner.enqueue('alpha', { kind: 'k', payload: {}, runAt: now });
  const earlyLowerId = runner.enqueue('alpha', { kind: 'k', payload: {}, runAt: now - 100 });
  const earlyHigherId = runner.enqueue('alpha', { kind: 'k', payload: {}, runAt: now - 100 });
  assert.ok(earlyLowerId < earlyHigherId);

  const order: number[] = [];
  const handler: JobHandler = async (job) => { order.push(job.id); };

  // `concurrency: 1`: all three rows are already due, so with the
  // dispatcher's own default concurrency a single fire would claim all
  // three in one pass — proving the same `ORDER BY run_at, id` but not the
  // one-at-a-time claiming three sequential `runOnce` calls exercised.
  // Forcing one slot is what makes each of the three `fire` calls below
  // land on exactly the next row in claim order, each queued behind the
  // last until its own slot frees.
  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, {
    now: () => now, timers, concurrency: 1, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal,
  });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();
  fire();
  fire();
  await dispatcher.idle();

  assert.deepEqual(order, [earlyLowerId, earlyHigherId, late]);
});
