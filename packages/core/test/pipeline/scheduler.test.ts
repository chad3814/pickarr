import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, RECONCILE_INTERVAL_MS } from '../../src/pipeline/scheduler.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import type { ReconcileResult, UntrackedEntry } from '../../src/pipeline/reconcile.ts';

const UNTRACKED: UntrackedEntry[] = [
  { ref: 'foreign', name: 'Not Ours', state: 'downloading', percentage: 10 },
];

const NO_RECONCILE_WORK: ReconcileResult = {
  untracked: [],
  advanced: 0,
  failed: 0,
  removed: 0,
  imported: 0,
};

/** Yields to the macrotask queue so already-scheduled promise work can run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('reconcileNow caches the untracked snapshot for later reads', async () => {
  const db = openTestDatabase();
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => ({
      seen: 0,
      inserted: 0,
      parseErrors: 0,
      groupsCreated: 0,
      releasesAdded: 0,
      upgradesFlagged: 0,
      parseFailures: [],
      parseFailuresSuppressed: 0,
    }),
    reconcile: async () => ({ untracked: UNTRACKED, advanced: 0, failed: 0, imported: 0, removed: 0 }),
    clientIds: ['sab'],
    log: () => {},
  });

  assert.deepEqual(scheduler.untrackedFor('sab'), []);
  await scheduler.reconcileNow();
  assert.deepEqual(scheduler.untrackedFor('sab'), UNTRACKED);
  db.close();
});

test('a reconcile failure is logged and does not throw out of the tick', async () => {
  const db = openTestDatabase();
  const logged: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => {
      throw new Error('sab unreachable');
    },
    clientIds: ['sab'],
    log: (message) => logged.push(message),
  });

  await scheduler.reconcileNow();
  assert.ok(logged.some((line) => line.includes('sab unreachable')));
  db.close();
});

// Imports run inside a reconcile tick and can take minutes. A fixed 10s timer
// keeps firing throughout, and a queueing mutex would turn a five-minute
// import into ~30 stacked ticks that all run back-to-back the moment it
// finishes, each issuing its own pair of client requests. Ticks are samples,
// not work items: one that lands on a busy mutex has nothing to contribute
// that the next one won't, so it is dropped.
test('a timer tick that lands while a reconcile is still running is dropped, not queued', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const db = openTestDatabase();
  let calls = 0;
  let finishFirstTick: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => {
    finishFirstTick = resolve;
  });

  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => {
      calls += 1;
      await inFlight;
      return NO_RECONCILE_WORK;
    },
    clientIds: ['sab'],
    log: () => {},
  });

  try {
    scheduler.start();

    mock.timers.tick(RECONCILE_INTERVAL_MS);
    await settle();
    assert.equal(calls, 1, 'the first tick starts a reconcile');

    // Three more ticks while the first is still blocked.
    for (let tick = 0; tick < 3; tick += 1) mock.timers.tick(RECONCILE_INTERVAL_MS);
    await settle();
    assert.equal(calls, 1, 'ticks arriving during a run must not start a second one');

    finishFirstTick();
    await settle();
    assert.equal(calls, 1, 'and must not have queued up behind it either');

    // Not wedged: the next tick after the run finishes still works.
    mock.timers.tick(RECONCILE_INTERVAL_MS);
    await settle();
    assert.equal(calls, 2);
  } finally {
    scheduler.stop();
    mock.timers.reset();
    db.close();
  }
});

test('an ingest failure on one feed does not stop the others', async () => {
  const db = openTestDatabase();
  const ingested: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [
      { id: 'a', url: 'https://a.invalid', plugin: 'p', intervalSeconds: 1 },
      { id: 'b', url: 'https://b.invalid', plugin: 'p', intervalSeconds: 1 },
    ],
    ingestFeed: async (feed) => {
      if (feed.id === 'a') throw new Error('feed a is down');
      ingested.push(feed.id);
      return {
        seen: 0,
        inserted: 0,
        parseErrors: 0,
        groupsCreated: 0,
        releasesAdded: 0,
        upgradesFlagged: 0,
        parseFailures: [],
        parseFailuresSuppressed: 0,
      };
    },
    reconcile: async () => ({ untracked: [], advanced: 0, failed: 0, imported: 0, removed: 0 }),
    clientIds: [],
    log: () => {},
  });

  await scheduler.ingestAllNow();
  assert.deepEqual(ingested, ['b']);
  db.close();
});

// The count on IngestResult (parseErrors) says *that* names failed to parse;
// it never says *which* ones, so there was nothing to act on. Each failure
// the ingest function reports has to be logged on its own line so the raw
// title is visible, not just tallied.
test('ingestAllNow logs each parse failure individually, plus a suppressed count past the cap', async () => {
  const db = openTestDatabase();
  const logged: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [{ id: 'feed1', url: 'https://a.invalid', plugin: 'p', intervalSeconds: 900 }],
    ingestFeed: async () => ({
      seen: 3,
      inserted: 3,
      parseErrors: 3,
      groupsCreated: 0,
      releasesAdded: 0,
      upgradesFlagged: 0,
      parseFailures: [
        { title: 'Weird.Release.One', reason: 'unrecognized' },
        { title: 'Weird.Release.Two', reason: 'unrecognized' },
      ],
      parseFailuresSuppressed: 1,
    }),
    reconcile: async () => NO_RECONCILE_WORK,
    clientIds: [],
    log: (message) => logged.push(message),
  });

  await scheduler.ingestAllNow();

  assert.ok(logged.some((line) => line.includes('Weird.Release.One')));
  assert.ok(logged.some((line) => line.includes('Weird.Release.Two')));
  assert.ok(logged.some((line) => /1.*suppress/i.test(line)));
  db.close();
});
