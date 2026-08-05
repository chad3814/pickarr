import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMutex } from '../../src/pipeline/mutex.ts';

test('runs exclusively and in order', async () => {
  const mutex = createMutex();
  const events: string[] = [];

  const slow = mutex.run(async () => {
    events.push('slow:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('slow:end');
  });
  const fast = mutex.run(async () => {
    events.push('fast:start');
    events.push('fast:end');
  });

  await Promise.all([slow, fast]);
  assert.deepEqual(events, ['slow:start', 'slow:end', 'fast:start', 'fast:end']);
});

test('a rejection does not wedge the mutex', async () => {
  const mutex = createMutex();
  await assert.rejects(
    mutex.run(async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(await mutex.run(async () => 'ok'), 'ok');
});

test('tryRun skips instead of queueing when busy', async () => {
  const mutex = createMutex();
  let ran = 0;
  const held = mutex.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const skipped = await mutex.tryRun(async () => {
    ran += 1;
  });

  await held;
  assert.equal(skipped, false);
  assert.equal(ran, 0);
});

test('tryRun runs immediately once a preceding run has released the mutex', async () => {
  const mutex = createMutex();
  let ran = 0;

  await mutex.run(async () => {});
  const started = await mutex.tryRun(async () => {
    ran += 1;
  });

  assert.equal(started, true);
  assert.equal(ran, 1);
});

test(
  'a nested acquisition on the same mutex throws instead of deadlocking',
  { timeout: 2000 },
  async () => {
    const mutex = createMutex();

    await assert.rejects(
      mutex.run(async () => {
        await mutex.run(async () => {});
      }),
      /reentrant/i,
    );

    // The mutex must still be usable afterward — the rejected nested
    // acquisition must not have left `pending` or `tail` in a stuck state.
    assert.equal(await mutex.run(async () => 'ok'), 'ok');
  },
);
