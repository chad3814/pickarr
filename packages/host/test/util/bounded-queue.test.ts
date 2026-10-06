import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedQueue } from '../../src/util/bounded-queue.ts';

/**
 * A task under test's own control: `run()` starts it but it does not
 * resolve (or reject) until the test calls `settle()`/`fail()`, so
 * concurrency can be observed as a count of tasks in flight rather than
 * inferred from timing.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending microtasks (including a queue's own wake-up chaining) run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('a limit of one runs tasks one at a time', async () => {
  const queue = createBoundedQueue(1);
  let active = 0;
  let max = 0;

  const first = deferred<void>();
  const second = deferred<void>();

  const firstRun = queue.run(async () => {
    active += 1;
    max = Math.max(max, active);
    await first.promise;
    active -= 1;
  });
  const secondRun = queue.run(async () => {
    active += 1;
    max = Math.max(max, active);
    await second.promise;
    active -= 1;
  });

  await tick();
  assert.equal(active, 1, 'the second task must not have started while the first is in flight');
  assert.equal(queue.active(), 1);

  first.resolve();
  await firstRun;

  await tick();
  assert.equal(active, 1, 'the second task only starts once the first has finished');

  second.resolve();
  await secondRun;

  assert.equal(max, 1, 'at most one task was ever in flight at once');
});

test('a limit of two runs two at once and makes a third wait', async () => {
  const queue = createBoundedQueue(2);
  let active = 0;
  let max = 0;

  const first = deferred<void>();
  const second = deferred<void>();
  const third = deferred<void>();

  function makeTask(gate: Promise<void>): () => Promise<void> {
    return async () => {
      active += 1;
      max = Math.max(max, active);
      await gate;
      active -= 1;
    };
  }

  const firstRun = queue.run(makeTask(first.promise));
  const secondRun = queue.run(makeTask(second.promise));
  const thirdRun = queue.run(makeTask(third.promise));

  await tick();
  assert.equal(active, 2, 'two tasks at a limit of two must run at once');
  assert.equal(queue.active(), 2);

  first.resolve();
  await firstRun;

  await tick();
  assert.equal(active, 2, 'the third task starts as soon as a slot frees, not before');

  second.resolve();
  third.resolve();
  await Promise.all([secondRun, thirdRun]);

  assert.equal(max, 2, 'never more than the configured limit ran at once');
});

test('a rejected task releases its slot, so the next task still runs', async () => {
  const queue = createBoundedQueue(1);

  await assert.rejects(
    queue.run(async () => {
      throw new Error('task exploded');
    }),
    /task exploded/,
  );

  let ran = false;
  await queue.run(async () => {
    ran = true;
  });
  assert.equal(ran, true, 'a task queued after a rejection must still get to run');
});

test('a rejected task rejects its own caller, not the queue', async () => {
  const queue = createBoundedQueue(1);

  const failing = queue.run(async () => {
    throw new Error('only this caller should see this');
  });

  await assert.rejects(failing, /only this caller should see this/);

  // The queue itself must still be usable -- a rejection is not a fatal
  // event for anything other than the caller that issued the failing task.
  const result = await queue.run(async () => 'ok');
  assert.equal(result, 'ok');
});

test('an invalid limit throws at construction, naming the value', () => {
  assert.throws(() => createBoundedQueue(0), /\b0\b/);
  assert.throws(() => createBoundedQueue(-1), /-1/);
  assert.throws(() => createBoundedQueue(1.5), /1\.5/);
  assert.throws(() => createBoundedQueue(Number.NaN), /NaN/);
  assert.doesNotThrow(() => createBoundedQueue(1));
});

test('idle resolves once nothing is running or waiting', async () => {
  const queue = createBoundedQueue(1);
  const first = deferred<void>();
  const second = deferred<void>();

  const firstRun = queue.run(() => first.promise);
  const secondRun = queue.run(() => second.promise);

  let idleResolved = false;
  const idlePromise = queue.idle().then(() => {
    idleResolved = true;
  });

  await tick();
  assert.equal(idleResolved, false, 'idle must not resolve while a task is running');

  first.resolve();
  await firstRun;

  await tick();
  assert.equal(idleResolved, false, 'idle must not resolve while the second task, woken from waiting, is now running');

  second.resolve();
  await secondRun;
  await idlePromise;
  assert.equal(idleResolved, true, 'idle resolves once nothing is running or waiting');
});

test('idle resolves immediately on an untouched queue', async () => {
  const queue = createBoundedQueue(3);

  let idleResolved = false;
  await queue.idle().then(() => {
    idleResolved = true;
  });

  assert.equal(idleResolved, true);
});

test('setLimit raised releases exactly the new headroom\'s worth of waiters', async () => {
  const queue = createBoundedQueue(1);
  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  let started = 0;
  const runs = gates.map((gate) => queue.run(async () => {
    started += 1;
    await gate.promise;
  }));
  await tick();
  assert.equal(started, 1, 'one slot, one task running');

  queue.setLimit(3);
  await tick();
  assert.equal(started, 3, 'raising to three starts two more and no more');
  assert.equal(queue.limit(), 3);

  for (const gate of gates) gate.resolve();
  await Promise.all(runs);
});

test('setLimit lowered cancels nothing and opens no slot until running drops below the new limit', async () => {
  const queue = createBoundedQueue(3);
  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  let started = 0;
  const runs = gates.map((gate) => queue.run(async () => {
    started += 1;
    await gate.promise;
  }));
  await tick();
  assert.equal(started, 3);

  queue.setLimit(1);
  await tick();
  assert.equal(started, 3, 'the three in flight keep running');
  assert.equal(queue.active(), 3);

  gates[0]!.resolve();
  await tick();
  assert.equal(started, 3, 'two still running is not below a limit of one, so the fourth waits');

  gates[1]!.resolve();
  await tick();
  assert.equal(started, 3, 'one running equals the limit; still no slot');

  gates[2]!.resolve();
  await tick();
  assert.equal(started, 4, 'running fell to zero, so the waiter resumes');

  gates[3]!.resolve();
  await Promise.all(runs);
});

test('setLimit refuses the same values the constructor does', () => {
  const queue = createBoundedQueue(2);
  assert.throws(() => queue.setLimit(0), /bounded queue limit must be an integer of at least 1, got 0/);
  assert.throws(() => queue.setLimit(1.5), /got 1\.5/);
  assert.equal(queue.limit(), 2, 'a refused value changes nothing');
});
