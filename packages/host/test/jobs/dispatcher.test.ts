import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler, PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createRunner } from '../../src/jobs/runner.ts';
import { createDispatcher, DEFAULT_CONCURRENCY, MAX_TIMER_MS, SAFETY_INTERVAL_MS } from '../../src/jobs/dispatcher.ts';
import type { Dispatcher, Timers } from '../../src/jobs/dispatcher.ts';

/** One `setTimeout`/`setInterval` call, as the fake `Timers` below records it. */
interface TimerCall {
  handle: number;
  ms: number;
  fn: () => void;
}

/**
 * A `Timers` whose every call is logged rather than actually scheduled, so a
 * test can assert exactly which handle was cleared and what delay was set --
 * and, by invoking a logged `fn` directly, simulate a timer firing without
 * ever waiting on real time.
 */
function createFakeTimers(): {
  timers: Timers;
  setTimeoutCalls: TimerCall[];
  clearTimeoutCalls: unknown[];
  setIntervalCalls: TimerCall[];
  clearIntervalCalls: unknown[];
} {
  let nextHandle = 0;
  const setTimeoutCalls: TimerCall[] = [];
  const clearTimeoutCalls: unknown[] = [];
  const setIntervalCalls: TimerCall[] = [];
  const clearIntervalCalls: unknown[] = [];
  const timers: Timers = {
    setTimeout(fn, ms) {
      const handle = ++nextHandle;
      setTimeoutCalls.push({ handle, ms, fn });
      return handle;
    },
    clearTimeout(handle) {
      clearTimeoutCalls.push(handle);
    },
    setInterval(fn, ms) {
      const handle = ++nextHandle;
      setIntervalCalls.push({ handle, ms, fn });
      return handle;
    },
    clearInterval(handle) {
      clearIntervalCalls.push(handle);
    },
  };
  return { timers, setTimeoutCalls, clearTimeoutCalls, setIntervalCalls, clearIntervalCalls };
}

/** Inserts a `ready` row directly, the way `Runner.enqueue` does. */
function insertReadyJob(raw: DatabaseSync, now: number, runAt: number): number {
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 3 });
  return runner.enqueue('test-plugin', { kind: 'noop', payload: {}, runAt });
}

/**
 * Inserts a `running` row directly, standing in for a claim a crashed
 * process left behind -- without needing a handler that never resolves and
 * a promise this file would otherwise have to keep alive across the sweep.
 * `started_at` is set, the same way a real claim (`run-job.ts`'s) leaves it,
 * so the sweep below has an actual value to prove it clears.
 */
function insertRunningJob(raw: DatabaseSync, opts: { attempts: number; maxAttempts: number; now: number }): number {
  const result = raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, started_at, last_error, created_at, updated_at)
    VALUES ('alpha', 'stuck', '{}', ?, ?, ?, 'running', ?, NULL, ?, ?)
  `).run(opts.attempts, opts.maxAttempts, opts.now, opts.now, opts.now, opts.now);
  return Number(result.lastInsertRowid);
}

/** The `jobs.state` column for one row, read back with the `{ field: unknown }` narrowing this codebase uses throughout. */
function readState(raw: DatabaseSync, id: number): string {
  const row = raw.prepare('SELECT state FROM jobs WHERE id = ?').get(id);
  assert.ok(row, `job ${id} has no row`);
  return String((row as { state: unknown }).state);
}

/** The `jobs.attempts` column for one row. */
function readAttempts(raw: DatabaseSync, id: number): number {
  const row = raw.prepare('SELECT attempts FROM jobs WHERE id = ?').get(id);
  assert.ok(row, `job ${id} has no row`);
  return Number((row as { attempts: unknown }).attempts);
}

/** The `jobs.run_at` column for one row. */
function readRunAt(raw: DatabaseSync, id: number): number {
  const row = raw.prepare('SELECT run_at FROM jobs WHERE id = ?').get(id);
  assert.ok(row, `job ${id} has no row`);
  return Number((row as { run_at: unknown }).run_at);
}

/** The `jobs.last_error` column for one row. */
function readLastError(raw: DatabaseSync, id: number): string | null {
  const row = raw.prepare('SELECT last_error FROM jobs WHERE id = ?').get(id);
  assert.ok(row, `job ${id} has no row`);
  const value = (row as { last_error: unknown }).last_error;
  return value === null ? null : String(value);
}

/** The `jobs.started_at` column for one row. */
function readStartedAt(raw: DatabaseSync, id: number): number | null {
  const row = raw.prepare('SELECT started_at FROM jobs WHERE id = ?').get(id);
  assert.ok(row, `job ${id} has no row`);
  const value = (row as { started_at: unknown }).started_at;
  return value === null ? null : Number(value);
}

/** Lets pending microtasks -- including a bounded queue's own wake-up chaining -- run. */
function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/** A stub that never calls back, and a resolver a test can trigger later. */
function neverSettles(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

/** `neverSettles` with the rejecting half exposed too, for the late-settle tests below that need a handler to fail rather than succeed. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A `sleep` that resolves on the next microtask, for every test that does not itself control it. */
const noopSleep = (_ms: number): Promise<void> => Promise.resolve();

/** A real signal, for every test that never fires it and needs no fake. */
const realAbortSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);

const noopLog = (): void => {};

/** A handler that always rejects, for the one test below that needs a real rejection on the row before a crash. */
const boom: JobHandler = async () => { throw new Error('handler boom'); };

/**
 * A `PluginContext` whose capabilities all reject if called, the same shape
 * `run-job.test.ts` and `runner.test.ts` use. No test here exercises a
 * plugin's own writes, so a capability firing at all means a test reached
 * further than intended.
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
  jobs: { enqueue: async () => { throw new Error('jobs.enqueue: not used by this test'); } },
  fetch: {
    json: async () => { throw new Error('fetch.json: not used by this test'); },
    bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  },
  downloads: { submit: async () => { throw new Error('downloads.submit: not used by this test'); } },
  log: () => {},
};

/** `handlers` for every test whose `start()` is not expected to dispatch anything. */
function noHandlers(): JobHandler | undefined {
  throw new Error('handlers: not used by this test');
}

test('arming sets one timeout for the earliest due job', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now + 500);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);

  assert.equal(setTimeoutCalls.length, 1);
  assert.equal(setTimeoutCalls[0]?.ms, 500);
});

test('enqueueing a job due sooner re-arms the timer', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now + 4000);
  const { timers, setTimeoutCalls, clearTimeoutCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);
  const firstHandle = setTimeoutCalls[0]?.handle;
  assert.equal(setTimeoutCalls[0]?.ms, 4000);

  insertReadyJob(raw, now, now + 1000);
  dispatcher.rearm();

  assert.deepEqual(clearTimeoutCalls, [firstHandle]);
  assert.equal(setTimeoutCalls.length, 2);
  assert.equal(setTimeoutCalls[1]?.ms, 1000);
  assert.notEqual(setTimeoutCalls[1]?.handle, firstHandle);
});

test('enqueueing a job due later leaves the existing timer alone', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now + 1000);
  const { timers, setTimeoutCalls, clearTimeoutCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);
  assert.equal(setTimeoutCalls.length, 1);
  assert.equal(setTimeoutCalls[0]?.ms, 1000);

  insertReadyJob(raw, now, now + 5000);
  dispatcher.rearm();

  assert.equal(clearTimeoutCalls.length, 0);
  assert.equal(setTimeoutCalls.length, 1, 'no second setTimeout call was made');
});

test('a delay beyond the clamp is capped rather than firing immediately', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  insertReadyJob(raw, now, now + thirtyDaysMs);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);

  assert.equal(setTimeoutCalls.length, 1);
  // Asserted against the literal, not the imported `MAX_TIMER_MS` -- comparing
  // the observed delay to the very constant `rearm` itself read would still
  // pass if that constant were mutated, since both sides would move together.
  // Measured: `MAX_TIMER_MS = 2_147_483_648` -- the exact 32-bit overflow
  // `dispatcher.ts`'s own doc says "fires immediately in Node rather than
  // waiting ... a hot loop, not a late job" -- passed the whole host suite.
  // `assert.equal(MAX_TIMER_MS, 60_000)` alongside pins the exported constant
  // to the same literal, so a mutation to either one is still caught. Same
  // idiom as `run-job.test.ts`'s `JOB_TIMEOUT_MS`/`ABORT_GRACE_MS` pair.
  assert.equal(setTimeoutCalls[0]?.ms, 60_000, 'a far-future run_at must be clamped to one minute');
  assert.equal(MAX_TIMER_MS, 60_000, 'the exported clamp itself must still be one minute');
});

test('firing dispatches due jobs oldest first, up to the concurrency', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  // Inserted in the *reverse* of their `run_at` order, so their ids
  // ascend the opposite way `run_at` does: an implementation that
  // ordered by `id` instead of `run_at` would dispatch these in the
  // wrong order rather than coincidentally getting it right.
  insertReadyJob(raw, now, 300);
  const second = insertReadyJob(raw, now, 200);
  const first = insertReadyJob(raw, now, 100);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const dispatched: number[] = [];
  const handler: JobHandler = async (job) => { dispatched.push(job.id); };
  const dispatcher = createDispatcher(raw, {
    now: () => now, timers, concurrency: 2, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal,
  });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();

  assert.deepEqual(dispatched, [first, second]);
});

test('firing leaves jobs beyond the concurrency ready for the next fire', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, 100);
  insertReadyJob(raw, now, 200);
  const third = insertReadyJob(raw, now, 300);
  const { timers, setTimeoutCalls } = createFakeTimers();

  // Every handler resolves right away, so if a third job were ever handed
  // to the queue at all it would, given enough microtask turns, eventually
  // run -- a bounded queue only *delays* work beyond its limit, it does not
  // drop it. That is what makes this a test of the SQL cap and not, like a
  // synchronous-only assertion would be, a test of the queue's own limit:
  // a queue told about all three would still get around to the third.
  const dispatched: number[] = [];
  const handler: JobHandler = async (job) => { dispatched.push(job.id); };
  const dispatcher = createDispatcher(raw, {
    now: () => now, timers, concurrency: 2, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal,
  });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();

  await Promise.all(Array.from({ length: 8 }, tick));

  assert.equal(dispatched.length, 2, 'the row beyond the cap was never handed to the queue');
  assert.equal(readState(raw, third), 'ready', 'the row beyond the cap was never written to');
});

test('the default concurrency bounds the high direction: nine due rows dispatch exactly eight', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const ids = Array.from({ length: 9 }, (_, i) => insertReadyJob(raw, now, 100 + i));
  const ninth = ids.at(-1);
  assert.ok(ninth !== undefined, 'the fixture must have inserted nine rows');
  const { timers, setTimeoutCalls } = createFakeTimers();

  // No `concurrency` override, deliberately: every other test here passes its
  // own, so the shipped default had no importer at all -- not even a test --
  // and the direction the cap exists for went unmeasured. Spec section 5 puts
  // it plainly ("a pathological batch cannot open hundreds of sockets"), and
  // measured, `DEFAULT_CONCURRENCY = 1000` passed the whole host suite, since
  // only the low direction was covered.
  const dispatched: number[] = [];
  const handler: JobHandler = async (job) => { dispatched.push(job.id); };
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();

  // Every handler resolves at once, so a dispatcher that had handed all nine
  // to the queue would, given enough microtask turns, get around to all nine:
  // a bounded queue only delays work beyond its limit, it does not drop it.
  // That is what makes this a test of the cap and not of the queue's own
  // limit. The fake timers never fire on their own, so the re-arm that
  // follows this fire cannot smuggle in a second batch either.
  await Promise.all(Array.from({ length: 12 }, tick));

  assert.equal(dispatched.length, 8, 'exactly the cap was dispatched, not the whole batch');
  // The literal, then the constant -- the same pairing the clamp above uses,
  // for the same reason.
  assert.equal(DEFAULT_CONCURRENCY, 8, 'the exported default itself must still be eight');
  assert.equal(readState(raw, ninth), 'ready', 'the row beyond the cap was never written to');
});

test('a job already queued is not dispatched twice by a later fire', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const occupierId = insertReadyJob(raw, now, now - 1);
  const targetId = insertReadyJob(raw, now, now);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const occupierGate = neverSettles();
  const calls: number[] = [];
  // The real worker claims the row (state = 'running') as its own first
  // synchronous act, before this handler ever runs -- so nothing here needs
  // to write that state itself, unlike Task 4's own stub.
  const handler: JobHandler = async (job) => {
    calls.push(job.id);
    if (job.id === occupierId) {
      await occupierGate.promise;
    }
  };

  const dispatcher = createDispatcher(raw, {
    now: () => now, timers, concurrency: 1, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal,
  });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');

  // Round 1: the occupier is oldest, so it alone is selected and takes the
  // sole slot, awaiting a promise this test controls.
  fire();
  assert.deepEqual(calls, [occupierId]);

  // Round 2: the occupier's row is now `running`, so the target is next in
  // line -- but the occupier still holds the only slot, so the target's own
  // task must wait rather than start. It stays in the queued set.
  fire();
  assert.deepEqual(calls, [occupierId], 'the target has not been taken yet');

  // Round 3: fired again before the target was ever taken. If the queued
  // set did not exclude it, this would select and queue it a second time.
  fire();
  assert.deepEqual(calls, [occupierId]);

  occupierGate.resolve();
  await tick();
  await tick();

  assert.deepEqual(calls, [occupierId, targetId], 'the target ran exactly once');
});

test('arming skips a job that is queued but not yet taken, landing on the next job\'s time instead', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  // Oldest first: the occupier is claimed and permanently holds the sole
  // slot; the target is due too, but the occupier never frees the slot for
  // it to be taken; `later` is not due yet at all.
  const occupierId = insertReadyJob(raw, now, now - 500);
  const targetId = insertReadyJob(raw, now, now - 400);
  insertReadyJob(raw, now, now + 5000);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const occupierGate = neverSettles();
  const handler: JobHandler = async (job) => {
    if (job.id === occupierId) {
      await occupierGate.promise;
    }
  };

  const dispatcher = createDispatcher(raw, {
    now: () => now, timers, concurrency: 1, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal,
  });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');

  // Round 1: the occupier is oldest, so it alone is selected, takes the
  // sole slot, and claims its row -- excluding it from arming from here on.
  fire();

  // Round 2: the target is next due, so it is selected and added to the
  // queued set -- but the occupier still holds the only slot, so the
  // target's own task never starts. It stays `ready` *and* queued. Without
  // `earliestArmableRunAt` excluding queued ids, arming here would see the
  // target's own already-past `run_at`, compute a delay of zero, and spin:
  // fire, find the target excluded from dispatch by the queued set exactly
  // as it should be, re-arm on that same past time, fire again, forever --
  // the very hot loop `MAX_TIMER_MS` exists to prevent, reached by never
  // rearming past a job stuck in this window rather than by a huge delay.
  fire();

  const latest = setTimeoutCalls.at(-1);
  assert.ok(latest, 'no timer was armed after the second fire');
  assert.equal(latest.ms, 5000, 'armed for the next job, not a zero delay on the stuck one');
  assert.equal(readState(raw, targetId), 'ready', 'the stuck job was never written to either');

  occupierGate.resolve();
});

test('the safety interval re-derives the timeout', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const { timers, setTimeoutCalls, setIntervalCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);
  assert.equal(setTimeoutCalls.length, 0, 'nothing was ready at construction');
  assert.equal(setIntervalCalls.length, 1);
  // The literal, for the reason spelled out on the clamp above: measured,
  // `SAFETY_INTERVAL_MS = 86_400_000` -- a day rather than a minute, so a lost
  // timer costs a day of latency instead of a minute -- passed the whole host
  // suite against the imported constant.
  assert.equal(setIntervalCalls[0]?.ms, 60_000, 'the safety net must re-derive every minute');
  assert.equal(SAFETY_INTERVAL_MS, 60_000, 'the exported interval itself must still be one minute');

  // A job appears without anyone telling the dispatcher directly -- the
  // interval is the safety net that notices anyway.
  insertReadyJob(raw, now, now + 750);
  const onInterval = setIntervalCalls[0]?.fn;
  assert.ok(onInterval, 'no interval was armed');
  onInterval();

  assert.equal(setTimeoutCalls.length, 1);
  assert.equal(setTimeoutCalls[0]?.ms, 750);
});

test('stop clears both the timer and the interval', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now + 500);
  const { timers, setTimeoutCalls, clearTimeoutCalls, setIntervalCalls, clearIntervalCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);
  const timeoutHandle = setTimeoutCalls[0]?.handle;
  const intervalHandle = setIntervalCalls[0]?.handle;

  dispatcher.stop();

  assert.deepEqual(clearTimeoutCalls, [timeoutHandle]);
  assert.deepEqual(clearIntervalCalls, [intervalHandle]);
});

test('start returns a crashed running row to ready without losing its attempt', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const id = insertRunningJob(raw, { attempts: 1, maxAttempts: 3, now });

  assert.equal(readState(raw, id), 'running');
  assert.equal(readAttempts(raw, id), 1);
  assert.notEqual(readStartedAt(raw, id), null, 'fixture set up a running row with a started_at to clear');

  // A brand new dispatcher over the same database, standing in for the restart.
  const { timers } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  const swept = dispatcher.start(noHandlers, () => fakeCtx);

  assert.equal(swept, 1);
  const row = readState(raw, id);
  assert.equal(row, 'ready');
  // The crashed attempt already consumed a try; the sweep must not reset
  // that count, or a handler that crashes the process retries forever.
  assert.equal(readAttempts(raw, id), 1);
  // Backed off, not immediate: the curve is the same one a rejected
  // handler's own retry uses.
  assert.equal(readRunAt(raw, id), now + 1000);
  // A ready row with a stale started_at would misreport that it is running
  // something right now, when nothing is.
  assert.equal(readStartedAt(raw, id), null, 'started_at is cleared on the row the sweep readied');
});

test('start dead-letters a running row already at its last attempt', () => {
  // The infinite-boot-loop guard: a job kind that kills the process must not
  // be readied on every start.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const id = insertRunningJob(raw, { attempts: 1, maxAttempts: 1, now });

  assert.equal(readState(raw, id), 'running');
  assert.equal(readAttempts(raw, id), 1, '== max_attempts: nothing left to retry with');

  const { timers } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  const swept = dispatcher.start(noHandlers, () => fakeCtx);

  assert.equal(swept, 1);
  assert.equal(readState(raw, id), 'dead');
  assert.match(
    String(readLastError(raw, id)),
    /crashed/,
    'a row dead because the process died has to say that is why',
  );
});

test('start arms the timer from the earliest ready job', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now + 750);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);

  assert.equal(setTimeoutCalls.length, 1);
  assert.equal(setTimeoutCalls[0]?.ms, 750);
});

test('start returns how many rows it swept', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertRunningJob(raw, { attempts: 1, maxAttempts: 3, now });
  insertRunningJob(raw, { attempts: 1, maxAttempts: 3, now });

  // A third job, ready but never crashed, must not be counted by the sweep.
  insertReadyJob(raw, now, now + 500);

  const { timers } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  const swept = dispatcher.start(noHandlers, () => fakeCtx);

  assert.equal(swept, 2);
});

test('stop does not wait for an in-flight handler', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const gate = neverSettles();
  const handler: JobHandler = async () => { await gate.promise; };
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();

  // `stop` is typed `(): void`, but `await` on whatever it actually returns
  // at runtime is what would catch a mutant that quietly turned it into an
  // `async` function awaiting the queue's own `idle()` -- a stop that
  // awaited an in-flight handler would reintroduce the shutdown hang this
  // whole slice exists to remove, and never return here at all.
  await dispatcher.stop();

  gate.resolve();
});

test('a row left running by stop is swept by the next start', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const id = insertReadyJob(raw, now, now);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const gate = neverSettles();
  const handler: JobHandler = async () => { await gate.promise; };
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();

  assert.equal(readState(raw, id), 'running');
  await dispatcher.stop();
  assert.equal(readState(raw, id), 'running', 'stop abandoned the row rather than waiting for it');

  // A brand new dispatcher over the same database, standing in for the restart.
  const { timers: timers2 } = createFakeTimers();
  const restarted = createDispatcher(raw, { now: () => now, timers: timers2, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  const swept = restarted.start(noHandlers, () => fakeCtx);

  assert.equal(swept, 1);
  assert.equal(readState(raw, id), 'ready');
  assert.equal(readAttempts(raw, id), 1, 'the crashed attempt is not lost');

  gate.resolve();
});

test('start wires the real runJob through the dispatcher, so a due job is claimed exactly once', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const id = insertReadyJob(raw, now, now);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const claims: number[] = [];
  // No internal `await` at all -- the whole point is to give a fire landing
  // in the synchronous-claim window (were one ever to open) every chance to
  // win a race, rather than being scheduled out of it by the handler's own delay.
  const handler: JobHandler = async (job) => { claims.push(job.id); };
  const logs: unknown[] = [];
  const dispatcher = createDispatcher(raw, {
    now: () => now,
    timers,
    concurrency: 2,
    log: (message, detail) => { logs.push({ message, detail }); },
    sleep: noopSleep,
    abortSignal: realAbortSignal,
  });
  dispatcher.start(() => handler, () => fakeCtx);

  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  // Firing repeatedly, as the safety interval could in production: the real
  // worker's claim (`run-job.ts`'s `runJob`) is documented as this
  // dispatcher's requirement -- its own first synchronous act, before its
  // own first `await` -- and this is the first test anywhere that wires the
  // real one through the real dispatcher to hold it to that. If the claim
  // ever moved past an `await`, one of these later fires would dispatch the
  // row a second time while it is still `ready`, and the second worker's
  // own claim would then find the row already taken and throw -- caught,
  // and logged, by `dispatch`'s own `catch` in `dispatcher.ts`.
  fire();
  fire();
  fire();
  await dispatcher.idle();

  assert.deepEqual(claims, [id], 'the handler ran exactly once');
  assert.deepEqual(logs, [], 'no second claim was ever attempted -- the row was claimed exactly once');
});

test('start dead-letters a job whose kind has no handler registered, naming the kind and plugin', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 3 });
  const id = runner.enqueue('alpha', { kind: 'mystery', payload: {} });
  const { timers, setTimeoutCalls } = createFakeTimers();

  // No handler answers for any kind -- the same shape a plugin that never
  // registered a handler for this job's kind presents.
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(() => undefined, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');
  fire();
  await dispatcher.idle();

  assert.equal(readState(raw, id), 'dead', 'a job nobody can run must not vanish silently as ready or running');
  const lastError = String(readLastError(raw, id));
  assert.match(lastError, /mystery/, 'last_error should name the unhandled kind');
  assert.match(lastError, /alpha/, 'last_error should name the plugin that owns the row');
  // Never claimed: a kind nobody will ever register a handler for gains
  // nothing from an attempt charged against it, so this goes straight from
  // `ready` to `dead` without `run-job.ts`'s claim ever touching it.
  assert.equal(readAttempts(raw, id), 0, 'an unhandled kind must not be charged an attempt it never ran');
  assert.equal(readStartedAt(raw, id), null, 'an unhandled kind was never started');
});

test('start called twice does not leak a second timer or interval', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now + 500);
  const { timers, setTimeoutCalls, clearTimeoutCalls, setIntervalCalls, clearIntervalCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);
  const firstTimeoutHandle = setTimeoutCalls[0]?.handle;
  const firstIntervalHandle = setIntervalCalls[0]?.handle;

  dispatcher.start(noHandlers, () => fakeCtx);

  // A second start that skipped clearing would leave the first interval
  // running forever alongside the second, firing rearm() twice on every
  // tick with nothing left to notice the leak.
  assert.equal(setIntervalCalls.length, 2, 'a second start armed its own interval');
  assert.deepEqual(clearIntervalCalls, [firstIntervalHandle], 'the first interval was cleared before the second was armed');
  assert.equal(setTimeoutCalls.length, 2, 'a second start re-armed its own timer');
  assert.deepEqual(clearTimeoutCalls, [firstTimeoutHandle], 'the first timer was cleared before the second was armed');
});

/**
 * The shared fixture for the two late-settle races below. One row, a
 * dispatcher wired to the real `runJob`, a handler that hands each of its
 * invocations back as a `Deferred` the test settles by hand, and an
 * `abortSignal` seam that hands back a controller per attempt so a test can
 * fire one attempt's five-minute timeout without waiting five minutes or
 * touching `AbortSignal.timeout` globally.
 *
 * Deliberately at dispatcher level rather than `run-job.ts` level: the whole
 * race needs the dispatcher's own timer to re-fire between the timeout's
 * write and the orphan's, which is exactly what `runJob` alone cannot do and
 * why five reviews of `run-job.ts` never saw this.
 */
function lateSettleFixture(): {
  raw: DatabaseSync;
  id: number;
  gates: Deferred[];
  controllers: AbortController[];
  now: () => number;
  setNow: (at: number) => void;
  dispatcher: Dispatcher;
  fireLatest: () => void;
} {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  let now = 1000;
  // `insertReadyJob`'s `defaultMaxAttempts` is 3, so attempt 1 is nowhere
  // near the dead-letter branch -- the stale-closure retry is the path under
  // test, not the dead-letter one.
  const id = insertReadyJob(raw, now, now);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const gates: Deferred[] = [];
  const controllers: AbortController[] = [];
  const handler: JobHandler = async () => {
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
  };

  const dispatcher = createDispatcher(raw, {
    now: () => now,
    timers,
    log: noopLog,
    sleep: noopSleep,
    abortSignal: () => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    },
  });
  dispatcher.start(() => handler, () => fakeCtx);

  return {
    raw,
    id,
    gates,
    controllers,
    now: () => now,
    setNow: (at) => { now = at; },
    dispatcher,
    fireLatest: () => {
      const fire = setTimeoutCalls.at(-1)?.fn;
      assert.ok(fire, 'no timer was armed');
      fire();
    },
  };
}

/**
 * Drives the fixture to the state both races start from: attempt 1 claimed
 * and hung, its own five minutes expired so the timeout has readied the row,
 * and attempt 2 claimed off that readied row and hung in turn -- with
 * attempt 1's handler still pending the whole time, because nothing can kill
 * a JavaScript function mid-execution.
 */
async function reachSecondAttempt(f: ReturnType<typeof lateSettleFixture>): Promise<void> {
  f.fireLatest();
  assert.equal(readAttempts(f.raw, f.id), 1, 'attempt 1 claimed the row');
  assert.equal(readState(f.raw, f.id), 'running');
  assert.equal(f.gates.length, 1);

  // Attempt 1's five minutes expire. `noopSleep` makes the two-second grace
  // immediate, so the timeout's own `failRow` lands within a microtask.
  f.controllers[0]?.abort();
  await tick();
  assert.equal(readState(f.raw, f.id), 'ready', 'the timeout returned the row for a retry');
  assert.equal(readRunAt(f.raw, f.id), 2000, 'readied one backoff step out, per backoffMs(1)');

  // The retry comes due and a second worker legitimately claims it. Attempt
  // 1's handler has not settled and never will on its own.
  f.setNow(readRunAt(f.raw, f.id));
  f.dispatcher.rearm();
  f.fireLatest();
  assert.equal(readAttempts(f.raw, f.id), 2, 'attempt 2 claimed the same row');
  assert.equal(readState(f.raw, f.id), 'running');
  assert.equal(f.gates.length, 2, 'two handler invocations are live at once');
}

test('an orphaned handler that resolves cannot mark done a row a later attempt is still running', async () => {
  const f = lateSettleFixture();
  await reachSecondAttempt(f);

  // Attempt 1's abandoned handler finally succeeds -- five minutes late, and
  // about work whose row was failed and re-claimed since. Guarded on state
  // alone this write matches (`running` is true again) and records the job
  // `done` while attempt 2 is mid-flight, discarding attempt 2's real outcome.
  f.gates[0]?.resolve();
  await tick();
  await tick();

  assert.equal(readState(f.raw, f.id), 'running', 'the orphan must not decide a row it no longer owns');
  assert.equal(readAttempts(f.raw, f.id), 2, 'and attempt 2 is still the one holding it');

  // Attempt 2, the one that actually owns the row, still decides it.
  f.gates[1]?.resolve();
  await f.dispatcher.idle();
  assert.equal(readState(f.raw, f.id), 'done');
  assert.equal(readAttempts(f.raw, f.id), 2);
});

test('an orphaned handler that rejects cannot ready a row a later attempt is still running, so no third copy is dispatched', async () => {
  const f = lateSettleFixture();
  await reachSecondAttempt(f);

  // The other direction, and the worse one: guarded on state alone, this
  // `failRow` runs against attempt 1's stale closure (`attempts = 1`,
  // nowhere near `max_attempts`), returns the row to `ready` with a fresh
  // `run_at` while attempt 2 is still `running`, and the next fire finds a
  // legitimately-`ready` row with no queued id to exclude it -- putting a
  // THIRD copy of the same job in flight. Measured at three live
  // invocations before the attempt guard was added.
  f.gates[0]?.reject(new Error('orphan rejected five minutes late'));
  await tick();
  await tick();

  assert.equal(readState(f.raw, f.id), 'running', 'the orphan must not ready a row attempt 2 still holds');
  assert.equal(readAttempts(f.raw, f.id), 2);

  // The moment a stale retry would have come due, driven the way the
  // dispatcher's own timer would drive it.
  f.setNow(4000);
  f.dispatcher.rearm();
  f.fireLatest();
  assert.equal(f.gates.length, 2, 'no third concurrent copy of the job was dispatched');

  f.gates[1]?.resolve();
  await f.dispatcher.idle();
  assert.equal(readState(f.raw, f.id), 'done');
});

test('a claim that finds no ready row is surfaced through the log rather than swallowed', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  // Oldest first, at a concurrency of one: the occupier is claimed and holds
  // the sole slot, so the target is selected by a later fire and sits in the
  // queue -- selected, queued, and not yet claimed. That waiting window is
  // the only place a test can get between selection and the claim, because
  // under the cap the worker claims inside `dispatch`'s own call stack.
  const occupierId = insertReadyJob(raw, now, now - 1);
  const targetId = insertReadyJob(raw, now, now);
  const { timers, setTimeoutCalls } = createFakeTimers();

  const occupierGate = neverSettles();
  const handler: JobHandler = async (job) => {
    if (job.id === occupierId) {
      await occupierGate.promise;
    }
  };

  const logs: { message: string; detail: Readonly<Record<string, unknown>> | undefined }[] = [];
  const dispatcher = createDispatcher(raw, {
    now: () => now,
    timers,
    concurrency: 1,
    log: (message, detail) => { logs.push({ message, detail }); },
    sleep: noopSleep,
    abortSignal: realAbortSignal,
  });
  dispatcher.start(() => handler, () => fakeCtx);
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer');

  fire();
  fire();
  assert.equal(readState(raw, targetId), 'ready', 'the target is queued but not yet claimed');

  // Something else settles the row while it waits. `run-job.ts`'s claim guard
  // (`WHERE state = 'ready'`) turns that into a detected no-op and throws,
  // and `dispatch`'s `catch` is the ONLY channel that surfaces it -- the
  // ledger's own remedy for this plan required it to be surfaced rather than
  // swallowed. Asserted positively, on presence and content: the sibling test
  // above asserts `logs` is EMPTY, which would also hold if the log line were
  // renamed, if `opts.log` were disconnected, or if the catch swallowed
  // again. Measured: replacing the call with `void err;` typechecked and
  // passed the whole host suite.
  raw.prepare("UPDATE jobs SET state = 'done' WHERE id = ?").run(targetId);
  occupierGate.resolve();
  await dispatcher.idle();
  // One extra hop past `idle()`, and it is load-bearing: the bounded queue
  // frees its slot in `run`'s own `finally`, which runs BEFORE the task's
  // rejection reaches `dispatch`'s `.catch`. So `idle()` resolves one
  // microtask ahead of the log line, and asserting straight after it reads an
  // empty array for a build that logs perfectly well.
  await tick();

  assert.equal(logs.length, 1, 'exactly one failure was reported: the target\'s claim');
  const entry = logs[0];
  assert.ok(entry, 'no log entry was recorded at all');
  assert.equal(entry.message, 'dispatcher: job run failed');
  assert.equal(entry.detail?.jobId, targetId, 'the report has to name which job failed');
  assert.equal(entry.detail?.pluginId, 'test-plugin', 'and which plugin owns it');
  assert.match(
    String(entry.detail?.err),
    /no ready row to claim/,
    'the claim guard\'s own diagnosis has to reach the log, not just the fact that something failed',
  );
});

test('the sweep replaces a stale rejection message rather than letting it explain a crash', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  let now = 1000;
  // Two permitted attempts. The first rejects, so the row really does carry a
  // rejection's message -- which is what makes the assertion below capable of
  // failing at all. A job that had never rejected would have `last_error`
  // NULL, and "the crash message is not the rejection's" would hold whatever
  // the sweep wrote. The second attempt is the last permitted one, and this
  // time the process dies mid-handler.
  //
  // Ported from `runner.test.ts`, where it pinned the now-removed
  // `Runner.recover()`. The method is gone; the property outlives it, because
  // `sweep` overwrites `last_error` on the rows it dead-letters -- and nothing
  // else covers that overwrite. `start dead-letters a running row already at
  // its last attempt` above builds its fixture with `last_error` NULL, so it
  // would pass just as happily against a sweep that left a stale rejection in
  // place to misexplain a crash.
  const runner = createRunner(raw, { now: () => now, defaultMaxAttempts: 2 });
  const id = runner.enqueue('alpha', { kind: 'stuck', payload: {} });

  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  let currentHandler: JobHandler = boom;
  dispatcher.start(() => currentHandler, () => fakeCtx);
  const firstFire = setTimeoutCalls[0]?.fn;
  assert.ok(firstFire, 'construction did not arm a timer');
  firstFire();
  await dispatcher.idle();
  assert.equal(readLastError(raw, id), 'handler boom', 'attempt one left a real rejection message behind');

  const hang = neverSettles();
  currentHandler = async () => { await hang.promise; };
  now = readRunAt(raw, id);
  dispatcher.rearm();
  const secondFire = setTimeoutCalls.at(-1)?.fn;
  assert.ok(secondFire, 'rearm did not arm a timer for the retry');
  secondFire();
  assert.equal(readAttempts(raw, id), 2, 'the retry consumed the last permitted attempt');
  assert.equal(readState(raw, id), 'running');

  // The restart: a brand new dispatcher over the same database, whose sweep
  // finds the row `running` with nothing left to retry.
  const { timers: timers2 } = createFakeTimers();
  const restarted = createDispatcher(raw, { now: () => now, timers: timers2, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  assert.equal(restarted.start(noHandlers, () => fakeCtx), 1);

  assert.equal(readState(raw, id), 'dead');
  // Not merely "some non-empty string": a crash and a rejection are different
  // diagnoses, and the sweep sets this message specifically so a reader can
  // tell which happened.
  assert.notEqual(
    readLastError(raw, id),
    'handler boom',
    'this row is dead because the process died, not because the handler threw',
  );
  assert.match(String(readLastError(raw, id)), /crashed/);

  hang.resolve();
  await dispatcher.idle();
});
