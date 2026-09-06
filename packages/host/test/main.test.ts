import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaPlugin } from '@pickarr/contract';
import type { Host } from '../src/host.ts';
import { DEFAULT_MAX_ATTEMPTS, HOST_PLUGIN_ID } from '../src/host.ts';
import { migrateHost } from '../src/db/migrate.ts';
import { openDatabase, openTestDatabase } from '../src/db/open.ts';
import type { Pump } from '../src/main.ts';
import { main, resolveArtworkDir, scheduleKnownFeeds, startPump } from '../src/main.ts';

/** The plugin id every feed row below names, so `main` can register an owner for it. */
const OWNER_ID = 'double';

/** Matches `host.test.ts`'s own helper, minimally: a row shaped enough for `scheduleKnownFeeds` to read its id back. */
function insertFeed(raw: DatabaseSync, url: string): number {
  const result = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, poll_interval_s, created_at, updated_at)
    VALUES (?, 'feed', ?, 900, 0, 0)
  `).run(OWNER_ID, url);
  return Number(result.lastInsertRowid);
}

/**
 * A `Host` whose every method fails loudly if a test never meant to reach
 * it. `recover` defaults to a harmless no-op rather than throwing: it is a
 * one-statement `UPDATE` no pump test cares about either way, and a
 * "throws if unused" default would only make every test override a call it
 * has no opinion on.
 */
function fakeHost(overrides: Partial<Host>): Host {
  return {
    register: () => { throw new Error('register: not used by this test'); },
    notifyNewRssItems: async () => { throw new Error('notifyNewRssItems: not used by this test'); },
    requestDownload: async () => { throw new Error('requestDownload: not used by this test'); },
    runOnce: async () => { throw new Error('runOnce: not used by this test'); },
    recover: () => 0,
    schedulePoll: () => { throw new Error('schedulePoll: not used by this test'); },
    // Throwing, not a no-op: `main.ts` calls none of these today, so a
    // no-op default looks harmless -- but Task 11 wires `main` to call a
    // real `start()`/`stop()`, and `start: () => 0` would then silently
    // satisfy that call and even produce a plausible "0 job(s) recovered"
    // log line for a `main` that never touched a real dispatcher at all.
    start: () => { throw new Error('start: not used by this test'); },
    stop: () => { throw new Error('stop: not used by this test'); },
    idle: async () => { throw new Error('idle: not used by this test'); },
    ...overrides,
  };
}

/**
 * A complete `MediaPlugin` owning `OWNER_ID`'s feeds, with no migrations and
 * no reachable entry point: the tests below hand `main` a stub pump, so
 * nothing is ever polled and no plugin method can run. What it is for is
 * `main`'s refusal to start without one.
 */
const ownerPlugin: MediaPlugin = {
  id: OWNER_ID,
  mediaType: 'movie',
  migrations: [],
  jobs: {},
  onNewRssItems: async () => { throw new Error('onNewRssItems: not used by this test'); },
  onDownloadedFile: async () => { throw new Error('onDownloadedFile: not used by this test'); },
  onDownloadRequest: async () => { throw new Error('onDownloadRequest: not used by this test'); },
};

/** A `Pump` that never claims anything, so a test can inspect exactly the state `main` left behind. */
function stubPump(): Pump {
  return { stop: () => {}, done: Promise.resolve() };
}

/**
 * Runs `main` against a database of the test's own, with `PICKARR_DATABASE`
 * restored afterwards whatever happens -- this is the process's own
 * environment, and a test that left it pointing at a temporary directory
 * would corrupt every test after it in this file.
 */
async function runMain(databasePath: string, deps: Parameters<typeof main>[1]): Promise<void> {
  const previous = process.env['PICKARR_DATABASE'];
  process.env['PICKARR_DATABASE'] = databasePath;
  try {
    await main([], deps);
  } finally {
    if (previous === undefined) delete process.env['PICKARR_DATABASE'];
    else process.env['PICKARR_DATABASE'] = previous;
  }
}

/** How many `poll` jobs are in a state anything will ever claim again. */
function runnablePollJobs(raw: DatabaseSync): number {
  const row = raw.prepare(`
    SELECT COUNT(*) AS n FROM jobs WHERE plugin_id = ? AND kind = 'poll' AND state IN ('ready', 'running')
  `).get(HOST_PLUGIN_ID);
  return Number((row as { n: unknown }).n);
}

test('the pump runs ready jobs until none remain, then sleeps', async () => {
  let calls = 0;
  async function runOnce(): Promise<boolean> {
    calls += 1;
    // Ready for the first three claims, idle, one more job arrives, idle
    // again -- so the test can tell "sleeps once, then stops for good" (a
    // pump that exits the loop when nothing is ready) apart from the real
    // contract, which keeps polling.
    return calls === 1 || calls === 2 || calls === 3 || calls === 5;
  }
  const sleepCalls: number[] = [];
  const pump = startPump(fakeHost({ runOnce }), {
    idleMs: 42,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      if (sleepCalls.length >= 2) pump.stop();
    },
  });
  await pump.done;

  assert.equal(calls, 6, 'kept claiming across a second idle period rather than stopping after the first');
  assert.deepEqual(sleepCalls, [42, 42], 'slept once per empty claim, not merely once ever');
});

test('stopping the pump lets the in-flight job finish before done resolves', async () => {
  let resolveRunOnce: ((ready: boolean) => void) | undefined;
  let finished = false;
  function runOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      resolveRunOnce = (ready) => {
        finished = true;
        resolve(ready);
      };
    });
  }
  const pump = startPump(fakeHost({ runOnce }), { idleMs: 1, sleep: async () => {} });

  assert.ok(resolveRunOnce !== undefined, 'the first claim is already in flight');
  pump.stop();

  let doneSettled = false;
  void pump.done.then(() => { doneSettled = true; });

  // Give `done` every chance to resolve early and wrongly, before the
  // in-flight job it is supposed to be draining has actually finished.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false, 'the in-flight job has not finished yet');
  assert.equal(doneSettled, false, 'done must not resolve while the claimed job is still in flight');

  const resolve = resolveRunOnce;
  assert.ok(resolve !== undefined);
  resolve(true);
  await pump.done;

  assert.equal(finished, true, 'the in-flight job ran to completion');
  assert.equal(doneSettled, true);
});

test('main recovers before it schedules, so a feed whose poll crashed on its last attempt still has a runnable job', async () => {
  // The silent feed-stop this exists to catch, and it is an ORDERING
  // defect, not a missing call: `schedulePoll` counts a poll job left
  // `running` as pending and declines to replace it, and `recover`
  // dead-letters that same row because the crash consumed its last
  // permitted attempt. Schedule first and the feed ends up with no poll job
  // in any runnable state, forever, with nothing to notice. Recover first
  // and it gets a fresh cycle. Measured both ways: 0 jobs against 1.
  //
  // A real `Host` over a real database file, not a `fakeHost`: the defect
  // lives in how `recover` and `schedulePoll` see each other's rows, which
  // is precisely what a fake cannot show.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-ordering-'));
  try {
    const databasePath = join(dir, 'pickarr.db');
    const seed = openDatabase(databasePath);
    migrateHost(seed.raw);
    const feedId = insertFeed(seed.raw, 'https://a.test/feed.xml');
    seed.raw.prepare(`
      INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, created_at, updated_at)
      VALUES (?, 'poll', ?, ?, ?, 0, 'running', 0, 0)
    `).run(HOST_PLUGIN_ID, JSON.stringify({ feedId }), DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
    assert.equal(runnablePollJobs(seed.raw), 1, 'the crashed job starts out looking runnable');
    seed.raw.close();

    const started: Host[] = [];
    await runMain(databasePath, {
      plugins: [ownerPlugin],
      startPump: (host) => {
        started.push(host);
        return stubPump();
      },
    });
    assert.equal(started.length, 1, 'main started the pump exactly once, last');

    const after = openDatabase(databasePath);
    try {
      assert.equal(
        runnablePollJobs(after.raw),
        1,
        'the feed must still have a poll job something will claim; 0 here means main scheduled before it recovered',
      );
      // Specifically a NEW cycle, not the crashed row still sitting there:
      // the dead-lettered original must remain visible for diagnosis.
      const states = after.raw.prepare(`
        SELECT state FROM jobs WHERE plugin_id = ? AND kind = 'poll' ORDER BY id
      `).all(HOST_PLUGIN_ID).map((row) => String((row as { state: unknown }).state));
      assert.deepEqual(states, ['dead', 'ready'], 'the crashed job dead-letters and a fresh cycle is scheduled beside it');
    } finally {
      after.raw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('main refuses to start with no plugin registered, and leaves no database behind', async () => {
  // Not a degraded mode: a poll consumes each item's identity through the
  // (feed_id, guid) dedup index, so items polled before any plugin owns
  // their feed are destroyed rather than queued -- no later poll re-offers
  // them and nothing rescans `resolution = 'pending'`. The shipped process
  // registers no plugin, so this refusal is what it does on every boot
  // until a plugin slice lands.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-refusal-'));
  try {
    const databasePath = join(dir, 'pickarr.db');
    await assert.rejects(
      runMain(databasePath, {
        startPump: () => { throw new Error('startPump: must never be reached with no plugin registered'); },
      }),
      /no media plugin registered/,
    );

    // The guard runs before the database is opened, so a refusal is not a
    // half-built host: nothing migrated, nothing on disk to explain.
    assert.deepEqual(await readdir(dir), [], 'refusing must not create a database file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the pump keeps running after a job throws', async () => {
  let calls = 0;
  async function runOnce(): Promise<boolean> {
    calls += 1;
    if (calls === 2) throw new Error('boom: a handler failed');
    // Ready, throws (itself a sleep, since a rejection counts as nothing
    // claimed), ready again, idle, ready again, idle -- so a rejected claim
    // is shown not merely to be survived but to leave the pump claiming
    // normally on every call after it.
    return calls === 1 || calls === 3 || calls === 5;
  }
  const sleepCalls: number[] = [];
  const pump = startPump(fakeHost({ runOnce }), {
    idleMs: 7,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      if (sleepCalls.length >= 3) pump.stop();
    },
  });
  await pump.done;

  assert.equal(calls, 6, 'claimed again after a rejected runOnce, rather than stopping on it');
  assert.deepEqual(sleepCalls, [7, 7, 7], 'the throw itself, plus the two real idle periods around it');
});

test('resolveArtworkDir defaults to artwork/ beside the database file', () => {
  assert.equal(resolveArtworkDir('/config/pickarr.db'), '/config/artwork', 'siblings the database file, not a bare relative path and not inside it');
  assert.equal(
    resolveArtworkDir('/data/hosts/one/pickarr.db'),
    '/data/hosts/one/artwork',
    'the directory the database file lives in, whatever that directory is',
  );
});

test('scheduleKnownFeeds schedules a poll for every rss_feed row, and none when there are none', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const scheduled: number[] = [];
  const host = fakeHost({
    schedulePoll: (feedId) => {
      scheduled.push(feedId);
      return feedId;
    },
  });

  assert.deepEqual(scheduleKnownFeeds(host, raw), [], 'a database with no feeds schedules nothing, and does not throw');
  assert.deepEqual(scheduled, []);

  const idA = insertFeed(raw, 'https://a.test/feed.xml');
  const idB = insertFeed(raw, 'https://b.test/feed.xml');

  const result = scheduleKnownFeeds(host, raw);

  assert.deepEqual(result, [idA, idB], 'returns every feed id it scheduled');
  assert.deepEqual(scheduled, [idA, idB], 'called schedulePoll once per feed row');
});
