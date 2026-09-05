import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler, PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createRunner } from '../../src/jobs/runner.ts';
import { createDispatcher, MAX_TIMER_MS, SAFETY_INTERVAL_MS } from '../../src/jobs/dispatcher.ts';
import type { Timers } from '../../src/jobs/dispatcher.ts';

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

/** Inserts a `ready` row directly, the way a real `enqueue` will once Task 7 wires one up. */
function insertReadyJob(raw: DatabaseSync, now: number, runAt: number): number {
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });
  return runner.enqueue('test-plugin', { kind: 'noop', payload: {}, runAt });
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

/** A `sleep` that resolves on the next microtask, for every test that does not itself control it. */
const noopSleep = (_ms: number): Promise<void> => Promise.resolve();

/** A real signal, for every test that never fires it and needs no fake. */
const realAbortSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);

const noopLog = (): void => {};

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
  assert.equal(setTimeoutCalls[0]?.ms, MAX_TIMER_MS);
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
  assert.equal(setIntervalCalls[0]?.ms, SAFETY_INTERVAL_MS);

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

test('start returns a crashed running row to ready without losing its attempt', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });
  const id = runner.enqueue('alpha', { kind: 'stuck', payload: {} });

  // A handler that never resolves, standing in for a process that crashed
  // mid-handler -- the claim (and its attempt) is one statement, already
  // consumed by the time this call is even in flight, so there is no
  // window for this simulation to miss.
  const gate = neverSettles();
  const handler: JobHandler = async () => { await gate.promise; };
  const stalled = runner.runOnce(() => handler, () => fakeCtx);

  assert.equal(readState(raw, id), 'running');
  assert.equal(readAttempts(raw, id), 1);

  // `Runner.runOnce` above predates `run-job.ts`'s `started_at` stamp (Task 3)
  // and never sets it itself, so it is stamped here directly -- reproducing
  // what the real claim path leaves behind -- giving the sweep below an
  // actual `started_at` to prove it clears.
  raw.prepare('UPDATE jobs SET started_at = ? WHERE id = ?').run(now, id);
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

  gate.resolve();
  await stalled;
});

test('start dead-letters a running row already at its last attempt', async () => {
  // The infinite-boot-loop guard: a job kind that kills the process must not
  // be readied on every start.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 1 });
  const id = runner.enqueue('alpha', { kind: 'stuck', payload: {} });

  const gate = neverSettles();
  const handler: JobHandler = async () => { await gate.promise; };
  const stalled = runner.runOnce(() => handler, () => fakeCtx);

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

  gate.resolve();
  await stalled;
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

test('start returns how many rows it swept', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });
  const gate = neverSettles();
  const handler: JobHandler = async () => { await gate.promise; };
  runner.enqueue('alpha', { kind: 'stuck-a', payload: {} });
  runner.enqueue('alpha', { kind: 'stuck-b', payload: {} });
  const stalledA = runner.runOnce(() => handler, () => fakeCtx);
  const stalledB = runner.runOnce(() => handler, () => fakeCtx);

  // A third job, ready but never crashed, must not be counted by the sweep.
  insertReadyJob(raw, now, now + 500);

  const { timers } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  const swept = dispatcher.start(noHandlers, () => fakeCtx);

  assert.equal(swept, 2);

  gate.resolve();
  await stalledA;
  await stalledB;
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
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });
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
