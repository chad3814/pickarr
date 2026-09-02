import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobHandler, JobRecord, PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createRunner } from '../../src/jobs/runner.ts';

/**
 * A `PluginContext` whose capabilities all reject if called. No test here
 * exercises a plugin's own writes — `runOnce` only needs *some* context to
 * hand a handler — so a capability firing at all means a test reached further
 * than intended.
 */
const fakeCtx: PluginContext = {
  db: undefined,
  media: {
    createMediaItem: async () => { throw new Error('media.createMediaItem: not used by this test'); },
    claimProviderRef: async () => { throw new Error('media.claimProviderRef: not used by this test'); },
    relinkRssItem: async () => { throw new Error('media.relinkRssItem: not used by this test'); },
    dropMediaItem: async () => { throw new Error('media.dropMediaItem: not used by this test'); },
    attachPoster: async () => { throw new Error('media.attachPoster: not used by this test'); },
    attachBackground: async () => { throw new Error('media.attachBackground: not used by this test'); },
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

/** The default `release` a `let` starts from, before a test's promise assigns its resolver. */
const noop = () => {};

test('a ready job is claimed, run, and marked done', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });

  const id = runner.enqueue('alpha', { kind: 'greet', payload: { name: 'ada' } });
  assert.equal(typeof id, 'number');

  let seen: JobRecord | undefined;
  const handler: JobHandler = async (job) => { seen = job; };
  const ran = await runner.runOnce(() => handler, () => fakeCtx);

  assert.equal(ran, true);
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
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });

  runner.enqueue('alpha', { kind: 'greet', payload: {}, runAt: now + 10_000 });

  // `boom` stands in for "must not run": nothing due means `runOnce` never
  // gets far enough to call it.
  const ran = await runner.runOnce(() => boom, () => fakeCtx);

  assert.equal(ran, false);
});

test('a throwing handler is retried with backoff written to run_at', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: (attempts) => attempts * 5000, defaultMaxAttempts: 5 });

  const id = runner.enqueue('alpha', { kind: 'boom', payload: {} });
  const ran = await runner.runOnce(() => boom, () => fakeCtx);

  assert.equal(ran, true);
  const row = readJob(raw, id);
  assert.equal(row.state, 'ready');
  // Read back from the row, not from elapsed time: the clock is injected.
  assert.equal(row.run_at, now + 5000);
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'handler boom');
});

test('backoff is measured from when the handler failed, not from when the job was claimed', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  let now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 5000, defaultMaxAttempts: 5 });

  const id = runner.enqueue('alpha', { kind: 'slow', payload: {} });

  // A handler that takes longer than its own backoff. The clock has to move
  // *across* the handler, which is why the frozen clock every other test here
  // injects cannot catch this: with `now` constant, the claim time and the
  // failure time are the same number and either implementation passes.
  const slow: JobHandler = async () => {
    now += 30_000;
    throw new Error('handler boom');
  };
  assert.equal(await runner.runOnce(() => slow, () => fakeCtx), true);

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready');
  // 31_000 is when it failed. Offsetting from the claim would give 6_000,
  // already in the past — a handler slower than its curve would retry with no
  // delay at all, and one much slower would retry instantly until it died.
  assert.equal(row.run_at, 36_000, 'run_at is the failure time plus the backoff');
  assert.equal(row.updated_at, 31_000, 'the row was written when the handler failed, not when it was claimed');
});

test('a handler that always throws reaches dead after max_attempts, and its row remains', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  let now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 2 });

  const id = runner.enqueue('alpha', { kind: 'boom', payload: {} });

  const first = await runner.runOnce(() => boom, () => fakeCtx);
  assert.equal(first, true);
  assert.equal(readJob(raw, id).state, 'ready', 'first failure retries, it does not dead-letter yet');

  now += 1;
  const second = await runner.runOnce(() => boom, () => fakeCtx);
  assert.equal(second, true);

  const row = readJob(raw, id);
  assert.equal(row.state, 'dead');
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, 'handler boom');
});

test('the claim and the attempt increment are one statement, not two', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });

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
  assert.equal(await runner.runOnce(() => handler, () => fakeCtx), true);

  // One write, carrying both facts. Two writes — `running` with the old
  // count, then the count — is the window a crash slips through: `recover`
  // would read `attempts` as unconsumed, ready the row, and hand the same
  // process-killing job back on every restart.
  assert.deepEqual(duringHandler, [{ state: 'running', attempts: 1 }]);
});

test('recover returns a job left running to ready', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });

  const id = runner.enqueue('alpha', { kind: 'stuck', payload: {} });

  // A handler that never resolves, standing in for a process that crashed
  // mid-handler. Calling `runOnce` without awaiting it runs the claim — which
  // is one statement, so there is no point between taking the row and
  // consuming its attempt for this simulation to miss — and then leaves the
  // row `running` forever, which is what a crashed process leaves behind.
  let release = noop;
  const hang = new Promise<void>((resolve) => { release = resolve; });
  const handler: JobHandler = async () => { await hang; };
  const stalled = runner.runOnce(() => handler, () => fakeCtx);

  const stuck = readJob(raw, id);
  assert.equal(stuck.state, 'running');
  assert.equal(stuck.attempts, 1);

  // Simulate the restart: a brand new runner over the same database.
  const restarted = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });
  const recovered = restarted.recover();
  assert.equal(recovered, 1);

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready');
  // The crashed attempt already consumed a try; recovering it must not reset
  // that count, or a handler that crashes the process retries forever.
  assert.equal(row.attempts, 1);

  release();
  await stalled;
});

test('recover dead-letters a job that crashed on its last permitted attempt, rather than readying it', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 1 });

  const id = runner.enqueue('alpha', { kind: 'stuck', payload: {} });

  // Same crash simulation as the test above, but `defaultMaxAttempts` is 1,
  // so the one attempt this claim consumes is also the last permitted one.
  let release = noop;
  const hang = new Promise<void>((resolve) => { release = resolve; });
  const handler: JobHandler = async () => { await hang; };
  const stalled = runner.runOnce(() => handler, () => fakeCtx);

  const stuck = readJob(raw, id);
  assert.equal(stuck.state, 'running');
  assert.equal(stuck.attempts, 1); // == max_attempts: nothing left to retry with

  const restarted = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 1 });
  const recovered = restarted.recover();
  assert.equal(recovered, 1);

  const row = readJob(raw, id);
  // Readying this row again would hand the same crash back to the next
  // restart, forever - it has to dead-letter instead.
  assert.equal(row.state, 'dead');
  assert.equal(row.attempts, 1);
  // Not merely "some non-empty string": a crash and a rejection are different
  // diagnoses, and `recover` sets this message specifically so a reader can
  // tell which happened. Any other non-empty literal would satisfy a length
  // check and satisfy nobody reading the row.
  assert.match(
    String(row.last_error),
    /crashed/,
    'a row dead because the process died has to say that is why',
  );

  release();
  await stalled;
});

test('recover replaces a stale rejection message rather than letting it explain a crash', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const options = { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 2 };
  const runner = createRunner(raw, options);

  const id = runner.enqueue('alpha', { kind: 'stuck', payload: {} });

  // Attempt one rejects, so the row really does carry a rejection's message —
  // which is what makes the assertion below capable of failing. A job that had
  // never rejected would have `last_error` NULL, and "the crash message is not
  // the rejection's" would hold whatever `recover` wrote.
  assert.equal(await runner.runOnce(() => boom, () => fakeCtx), true);
  assert.equal(readJob(raw, id).last_error, 'handler boom');

  // Attempt two is the last permitted one, and this time the process dies.
  let release = noop;
  const hang = new Promise<void>((resolve) => { release = resolve; });
  const handler: JobHandler = async () => { await hang; };
  const stalled = runner.runOnce(() => handler, () => fakeCtx);
  assert.equal(readJob(raw, id).attempts, 2);

  assert.equal(createRunner(raw, options).recover(), 1);

  const row = readJob(raw, id);
  assert.equal(row.state, 'dead');
  assert.notEqual(
    row.last_error,
    'handler boom',
    'this row is dead because the process died, not because the handler threw',
  );
  assert.match(String(row.last_error), /crashed/);

  release();
  await stalled;
});

test('a job whose kind has no handler goes dead rather than silently vanishing', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });

  const id = runner.enqueue('alpha', { kind: 'mystery', payload: {} });
  const ran = await runner.runOnce(() => undefined, () => fakeCtx);

  assert.equal(ran, true);
  const row = readJob(raw, id);
  assert.equal(row.state, 'dead');
  assert.equal(typeof row.last_error, 'string');
  assert.ok(String(row.last_error).includes('mystery'), 'last_error should name the unhandled kind');
});

test('claiming takes the earliest run_at, then the lowest id', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });

  const late = runner.enqueue('alpha', { kind: 'k', payload: {}, runAt: now });
  const earlyLowerId = runner.enqueue('alpha', { kind: 'k', payload: {}, runAt: now - 100 });
  const earlyHigherId = runner.enqueue('alpha', { kind: 'k', payload: {}, runAt: now - 100 });
  assert.ok(earlyLowerId < earlyHigherId);

  const order: number[] = [];
  const handler: JobHandler = async (job) => { order.push(job.id); };

  assert.equal(await runner.runOnce(() => handler, () => fakeCtx), true);
  assert.equal(await runner.runOnce(() => handler, () => fakeCtx), true);
  assert.equal(await runner.runOnce(() => handler, () => fakeCtx), true);

  assert.deepEqual(order, [earlyLowerId, earlyHigherId, late]);
});
