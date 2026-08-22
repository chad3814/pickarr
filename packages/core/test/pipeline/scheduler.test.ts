import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, RECONCILE_INTERVAL_MS } from '../../src/pipeline/scheduler.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import type { ReconcileResult, UntrackedEntry } from '../../src/pipeline/reconcile.ts';

const UNTRACKED: UntrackedEntry[] = [
  { clientId: 'sab', ref: 'foreign', name: 'Not Ours', state: 'downloading', percentage: 10 },
];

const NO_RECONCILE_WORK: ReconcileResult = {
  untracked: [],
  advanced: 0,
  failed: 0,
  removed: 0,
  imported: 0,
  absent: 0,
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
    reconcile: async () => ({ untracked: UNTRACKED, advanced: 0, failed: 0, imported: 0, removed: 0, absent: 0 }),
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
    reconcile: async () => ({ untracked: [], advanced: 0, failed: 0, imported: 0, removed: 0, absent: 0 }),
    clientIds: [],
    log: () => {},
  });

  await scheduler.ingestAllNow();
  assert.deepEqual(ingested, ['b']);
  db.close();
});

// Mirrors the reconcile-overlap test above: a metadata tick is a sample, not
// a work item, so a tick landing on a still-running pass must be dropped,
// not queued behind it.
test('a metadata tick that lands while the previous one is still running is dropped, not queued', async () => {
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
    reconcile: async () => NO_RECONCILE_WORK,
    clientIds: [],
    log: () => {},
    runMetadata: async () => {
      calls += 1;
      await inFlight;
    },
    metadataIntervalMs: 1_000,
  });

  try {
    scheduler.start();

    mock.timers.tick(1_000);
    await settle();
    assert.equal(calls, 1, 'the first tick starts a metadata pass');

    // Three more ticks while the first is still blocked.
    for (let tick = 0; tick < 3; tick += 1) mock.timers.tick(1_000);
    await settle();
    assert.equal(calls, 1, 'ticks arriving during a run must not start a second one');

    finishFirstTick();
    await settle();
    assert.equal(calls, 1, 'and must not have queued up behind it either');

    // Not wedged: the next tick after the run finishes still works.
    mock.timers.tick(1_000);
    await settle();
    assert.equal(calls, 2);
  } finally {
    scheduler.stop();
    mock.timers.reset();
    db.close();
  }
});

// `runMetadataPass` guards its own per-row work, but the query that finds due
// rows in the first place is not guarded, so `runMetadata` can reject. Unlike
// `reconcilePass`, which never rejects because it swallows every per-client
// failure itself, this timer has to catch at its own call site — an uncaught
// rejection here is an unhandled rejection on the process, which crashes it
// by default. A transient failure must cost one skipped tick, not the
// container.
test('a metadata pass that rejects is logged, not thrown, and the timer survives it', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const db = openTestDatabase();
  const logged: string[] = [];
  let calls = 0;

  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => NO_RECONCILE_WORK,
    clientIds: [],
    log: (message) => logged.push(message),
    runMetadata: async () => {
      calls += 1;
      throw new Error('database is unavailable');
    },
    metadataIntervalMs: 1_000,
  });

  try {
    scheduler.start();

    mock.timers.tick(1_000);
    await settle();
    assert.equal(calls, 1);
    assert.ok(
      logged.some((line) => line.includes('database is unavailable')),
      'the rejection is logged',
    );

    // Not wedged, and the process did not crash on an unhandled rejection:
    // the next tick after a failure still runs.
    mock.timers.tick(1_000);
    await settle();
    assert.equal(calls, 2);
  } finally {
    scheduler.stop();
    mock.timers.reset();
    db.close();
  }
});

// `runMetadata` absent is how main.ts represents "metadata is disabled, or
// there is no client to ask" — the scheduler must not register a timer for
// it in that case, not just decline to call a function it doesn't have.
test('no metadata timer is registered when runMetadata is not supplied', (t) => {
  const db = openTestDatabase();
  const timerSpy = t.mock.method(global, 'setInterval');

  const baseDeps = {
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => NO_RECONCILE_WORK,
    clientIds: [],
    log: () => {},
  };

  const withoutMetadata = createScheduler(baseDeps);
  withoutMetadata.start();
  const callsWithoutMetadata = timerSpy.mock.calls.length;
  withoutMetadata.stop();

  timerSpy.mock.resetCalls();

  const withMetadata = createScheduler({
    ...baseDeps,
    runMetadata: async () => {},
    metadataIntervalMs: 1_000,
  });
  withMetadata.start();
  const callsWithMetadata = timerSpy.mock.calls.length;
  withMetadata.stop();

  assert.equal(
    callsWithMetadata,
    callsWithoutMetadata + 1,
    'supplying runMetadata must register exactly one additional timer',
  );
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

// --- Reconcile tick reporting -----------------------------------------------
//
// The counters existed and nothing printed them. That is the shape of the
// 2026-08-15 incident: 35 downloads were failed over seventeen minutes and the
// log said nothing at all about it. A tick that did something now says so.

test('a reconcile tick that did something logs its counters, absence included', async () => {
  const db = openTestDatabase();
  const logged: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => ({
      untracked: UNTRACKED,
      advanced: 2,
      failed: 0,
      imported: 1,
      removed: 1,
      absent: 5,
    }),
    clientIds: ['sab'],
    log: (message) => logged.push(message),
  });

  await scheduler.reconcileNow();

  const line = logged.find((message) => message.startsWith('reconcile sab:'));
  assert.ok(line !== undefined, 'a tick with news must report it');
  assert.match(line ?? '', /2 advanced/);
  assert.match(line ?? '', /1 imported/);
  assert.match(line ?? '', /5 missing from client/);
  assert.match(line ?? '', /1 untracked/);
  db.close();
});

test('a quiet reconcile tick logs nothing, because a line every ten seconds is a line nobody reads', async () => {
  const db = openTestDatabase();
  const logged: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => NO_RECONCILE_WORK,
    clientIds: ['sab'],
    log: (message) => logged.push(message),
  });

  await scheduler.reconcileNow();
  await scheduler.reconcileNow();

  assert.deepEqual(logged, []);
  db.close();
});

// Absence is sticky: a download missing from the client stays missing until it
// comes back, so `absent` is non-zero on every tick until something changes.
// Without deduplication, saying so would mean a line every tick forever.
test('an unchanged reconcile situation is stated once, and again only when it changes', async () => {
  const db = openTestDatabase();
  const logged: string[] = [];
  let absent = 3;
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => ({
      untracked: [],
      advanced: 0,
      failed: 0,
      imported: 0,
      removed: 0,
      absent,
    }),
    clientIds: ['sab'],
    log: (message) => logged.push(message),
  });

  await scheduler.reconcileNow();
  await scheduler.reconcileNow();
  await scheduler.reconcileNow();
  assert.equal(logged.length, 1, 'the same three rows are still missing; that is not news twice');

  absent = 4;
  await scheduler.reconcileNow();
  assert.equal(logged.length, 2);
  assert.match(logged[1] ?? '', /4 missing from client/);

  // A genuinely quiet tick clears the memory, so the same situation recurring
  // afterwards is reported rather than mistaken for a repeat of a fact that has
  // since stopped being true.
  absent = 0;
  await scheduler.reconcileNow();
  assert.equal(logged.length, 2, 'nothing to say');
  absent = 4;
  await scheduler.reconcileNow();
  assert.equal(logged.length, 3, 'it happened again, so it is said again');
  db.close();
});

test('no backfill timer is registered when runBackfill is not supplied', (t) => {
  // The mirror of the metadata assertion above, and it is what keeps backfill
  // inert: an install where no feed opted in must gain no timer, not a timer
  // ticking every hour over a runner that would walk nothing.
  const db = openTestDatabase();
  const timerSpy = t.mock.method(global, 'setInterval');

  const baseDeps = {
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => NO_RECONCILE_WORK,
    clientIds: [],
    log: () => {},
  };

  const withoutBackfill = createScheduler(baseDeps);
  withoutBackfill.start();
  const callsWithout = timerSpy.mock.calls.length;
  withoutBackfill.stop();

  timerSpy.mock.resetCalls();

  const withBackfill = createScheduler({
    ...baseDeps,
    runBackfill: async () => {},
    backfillIntervalMs: 1_000,
  });
  withBackfill.start();
  const callsWith = timerSpy.mock.calls.length;
  withBackfill.stop();

  assert.equal(
    callsWith,
    callsWithout + 1,
    'supplying runBackfill must register exactly one additional timer',
  );
  db.close();
});

test('a backfill pass still walking is skipped rather than queued', async () => {
  // `tryRun`, not `run`. A walk that is still fetching has nothing to gain from a
  // second pass starting behind it, and queueing them would turn a slow indexer
  // into a growing backlog of passes that each re-read the same page.
  const db = openTestDatabase();
  mock.timers.enable({ apis: ['setInterval'] });
  let started = 0;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = () => resolve();
  });

  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => NO_RECONCILE_WORK,
    clientIds: [],
    log: () => {},
    runBackfill: async () => {
      started += 1;
      await held;
    },
    backfillIntervalMs: 1_000,
  });

  try {
    scheduler.start();
    mock.timers.tick(1_000);
    await settle();
    mock.timers.tick(1_000);
    mock.timers.tick(1_000);
    await settle();

    assert.equal(started, 1);
    release();
    await settle();
  } finally {
    scheduler.stop();
    mock.timers.reset();
    db.close();
  }
});
