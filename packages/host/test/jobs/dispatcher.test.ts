import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { JobRecord } from '@pickarr/contract';
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

test('arming sets one timeout for the earliest due job', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now + 500);
  const { timers, setTimeoutCalls } = createFakeTimers();

  createDispatcher(raw, async () => {}, { now: () => now, timers });

  assert.equal(setTimeoutCalls.length, 1);
  assert.equal(setTimeoutCalls[0]?.ms, 500);
});

test('enqueueing a job due sooner re-arms the timer', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  insertReadyJob(raw, now, now + 4000);
  const { timers, setTimeoutCalls, clearTimeoutCalls } = createFakeTimers();

  const dispatcher = createDispatcher(raw, async () => {}, { now: () => now, timers });
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

  const dispatcher = createDispatcher(raw, async () => {}, { now: () => now, timers });
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

  createDispatcher(raw, async () => {}, { now: () => now, timers });

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
  createDispatcher(raw, async (job: JobRecord) => { dispatched.push(job.id); }, {
    now: () => now,
    timers,
    concurrency: 2,
  });
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

  // Every stub call resolves right away, so if a third job were ever handed
  // to the queue at all it would, given enough microtask turns, eventually
  // run -- a bounded queue only *delays* work beyond its limit, it does not
  // drop it. That is what makes this a test of the SQL cap and not, like a
  // synchronous-only assertion would be, a test of the queue's own limit:
  // a queue told about all three would still get around to the third.
  const dispatched: number[] = [];
  createDispatcher(raw, async (job: JobRecord) => { dispatched.push(job.id); }, {
    now: () => now,
    timers,
    concurrency: 2,
  });
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
  // Marks the row `running` the moment it is actually invoked, standing in
  // for the claim Task 5's real worker makes as its first act -- Task 4's
  // own `fire`/`dispatch` write nothing to the rows, so nothing else here
  // would ever exclude a job whose handler is merely slow rather than gone.
  const runJob = async (job: JobRecord): Promise<void> => {
    calls.push(job.id);
    raw.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    if (job.id === occupierId) {
      await occupierGate.promise;
    }
  };

  createDispatcher(raw, runJob, { now: () => now, timers, concurrency: 1 });
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
  // Claims the row synchronously, the way any real `runJob` must (see the
  // requirement documented on `createDispatcher`'s `runJob` parameter) --
  // otherwise the occupier's own still-`ready` row would be what arming
  // finds first, rather than the scenario this test means to isolate.
  const runJob = async (job: JobRecord): Promise<void> => {
    raw.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    if (job.id === occupierId) {
      await occupierGate.promise;
    }
  };

  createDispatcher(raw, runJob, { now: () => now, timers, concurrency: 1 });
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

  createDispatcher(raw, async () => {}, { now: () => now, timers });
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

  const dispatcher = createDispatcher(raw, async () => {}, { now: () => now, timers });
  const timeoutHandle = setTimeoutCalls[0]?.handle;
  const intervalHandle = setIntervalCalls[0]?.handle;

  dispatcher.stop();

  assert.deepEqual(clearTimeoutCalls, [timeoutHandle]);
  assert.deepEqual(clearIntervalCalls, [intervalHandle]);
});

