import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DownloadClients,
  DownloadSubmission,
  JobHandler,
  MediaPlugin,
  PluginContext,
} from '@pickarr/contract';
import { openTestDatabase } from '../src/db/open.ts';
import { migrateHost } from '../src/db/migrate.ts';
import { createHost, HOST_PLUGIN_ID } from '../src/host.ts';
import type { Host } from '../src/host.ts';
import type { QueuedFetch } from '../src/fetch/queue.ts';
import type { Timers } from '../src/jobs/dispatcher.ts';
import type { Secrets } from '../src/secrets/instance.ts';

/** A `QueuedFetch` that fails loudly if a test never meant to reach the network. */
const unusedFetch: QueuedFetch = {
  json: async () => { throw new Error('fetch.json: not used by this test'); },
  bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  text: async () => { throw new Error('fetch.text: not used by this test'); },
};

/** A `QueuedFetch` whose `text` is scripted; `json`/`bytes` still fail loudly, since nothing under test needs them. */
function textFetch(text: (url: string) => Promise<string>): QueuedFetch {
  return { ...unusedFetch, text };
}

/** An empty, well-formed RSS document -- a feed with nothing new to report. */
const EMPTY_RSS = '<?xml version="1.0"?><rss><channel></channel></rss>';

/** A controllable clock, so a reschedule's `run_at` can be pinned to a value the test chose, not one merely observed. */
function createClock(start: number): { now: () => number; set: (at: number) => void } {
  let value = start;
  return { now: () => value, set: (at) => { value = at; } };
}

/** One `setTimeout`/`setInterval` call, as the fake `Timers` below records it. */
interface TimerCall {
  handle: number;
  ms: number;
  fn: () => void;
}

/**
 * A `Timers` whose every call is logged rather than actually scheduled, the
 * same fake `dispatcher.test.ts` and `jobs/runner.test.ts` each build for
 * `createDispatcher` -- duplicated here rather than imported, since no file
 * in this package shares a test-support module with another. "Advancing the
 * clock" in this file means invoking a logged `fn` directly, never waiting
 * on real time.
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
      // is recorded nowhere -- only its handle needs to exist, so `stop()`
      // has something to clear.
      return handle;
    },
    clearInterval() {},
  };
  return { timers, setTimeoutCalls };
}

/**
 * Fires the most recently armed timer -- `Host.start()`'s dispatcher rearms
 * on every enqueue and after every fire, so whichever entry is latest is the
 * one standing for "whatever is next due" -- then waits for the dispatched
 * job (and anything it enqueues) to finish. The replacement for
 * `await host.runOnce()` throughout this file: where `runOnce()` returned
 * a claimed-something boolean, this returns nothing, because what a test
 * needs after it is never the fact that something ran but which row and in
 * what state it was left -- an effect assertion, not a return value.
 */
async function runDue(host: Host, setTimeoutCalls: TimerCall[]): Promise<void> {
  const fire = setTimeoutCalls.at(-1)?.fn;
  assert.ok(fire, 'no timer was armed for a due job');
  fire();
  await host.idle();
}

/** A `DownloadClients` that fails loudly if a test never meant to submit anywhere. */
const unusedDownloads: DownloadClients = {
  submit: async () => { throw new Error('downloads.submit: not used by this test'); },
};
/**
 * A `Secrets` that fails loudly if a test never meant to resolve a
 * credential. No test in this file reads a `download_client` row through
 * `readClientConfig`, so nothing here should reach the secrets chain --
 * `clients/config.test.ts` and `clients/reconcile-job.test.ts` are where a
 * real one is exercised.
 */
const unusedSecrets: Secrets = {
  get: async () => { throw new Error('secrets.get: not used by this test'); },
  saveSecret: () => { throw new Error('secrets.saveSecret: not used by this test'); },
};

/**
 * No test in this file attaches artwork, so this directory is never
 * created or written to -- `createArtworkStore` only touches the
 * filesystem from its first `put()`. A path under a directory that does
 * not exist means a test that unexpectedly did call an `attach*` method
 * would fail loudly on `mkdir`, rather than quietly writing somewhere real.
 */
const unusedArtworkDir = '/nonexistent/pickarr-test-artwork-unused';

/** An entry point a plugin under test never expects to be reached. */
function unusedEntryPoint(name: string): () => Promise<never> {
  return async () => { throw new Error(`${name}: not used by this test`); };
}

function insertFeed(raw: DatabaseSync, pluginId: string, url: string, pollIntervalS = 900): number {
  const result = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, poll_interval_s, created_at, updated_at) VALUES (?, 'feed', ?, ?, 0, 0)
  `).run(pluginId, url, pollIntervalS);
  return Number(result.lastInsertRowid);
}

/** Every `poll` job row the host currently holds, with its payload's `feedId` parsed out for filtering. */
function pollJobRows(raw: DatabaseSync): { id: number; feedId: number; state: string; runAt: number; attempts: number }[] {
  return raw.prepare(`
    SELECT id, payload_json, state, run_at, attempts FROM jobs WHERE plugin_id = ? AND kind = 'poll'
  `).all(HOST_PLUGIN_ID).map((row) => {
    const payload = JSON.parse(String((row as { payload_json: unknown }).payload_json)) as { feedId: unknown };
    return {
      id: Number((row as { id: unknown }).id),
      feedId: Number(payload.feedId),
      state: String((row as { state: unknown }).state),
      runAt: Number((row as { run_at: unknown }).run_at),
      attempts: Number((row as { attempts: unknown }).attempts),
    };
  });
}

function insertRssItem(raw: DatabaseSync, feedId: number): number {
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, 'x.mkv', 'https://example.test/x', 0, 0, 'nzb', 'pending')
  `).run(feedId);
  return Number(result.lastInsertRowid);
}

/** A minimal but complete `MediaPlugin` — every required entry point present, most unused. */
function makePlugin(overrides: Partial<MediaPlugin> & { id: string }): MediaPlugin {
  return {
    mediaType: 'movie',
    migrations: [],
    jobs: {},
    onNewRssItems: unusedEntryPoint('onNewRssItems'),
    onDownloadedFile: unusedEntryPoint('onDownloadedFile'),
    onDownloadRequest: unusedEntryPoint('onDownloadRequest'),
    ...overrides,
  };
}

function setup(overrides?: { fetch?: QueuedFetch; now?: () => number }) {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const { timers, setTimeoutCalls } = createFakeTimers();
  const host = createHost({
    raw,
    db,
    fetch: overrides?.fetch ?? unusedFetch,
    downloads: unusedDownloads,
    secrets: unusedSecrets,
    now: overrides?.now ?? (() => 1000),
    artworkDir: unusedArtworkDir,
    timers,
  });
  return { raw, db, host, setTimeoutCalls };
}

test('registering a plugin applies its migrations', () => {
  const { raw, host } = setup();
  const plugin = makePlugin({
    id: 'alpha',
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE alpha_thing (id INTEGER PRIMARY KEY)') }],
  });

  host.register(plugin);

  const names = new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
  assert.ok(names.has('alpha_thing'), 'migration was never applied');
});

test('new rss items are dispatched to the plugin owning their feed', async () => {
  const { raw, host } = setup();

  const alphaReceived: number[][] = [];
  const betaReceived: number[][] = [];
  const alpha = makePlugin({ id: 'alpha', onNewRssItems: async (ids) => { alphaReceived.push([...ids]); } });
  const beta = makePlugin({ id: 'beta', onNewRssItems: async (ids) => { betaReceived.push([...ids]); } });
  host.register(alpha);
  host.register(beta);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedB = insertFeed(raw, 'beta', 'https://b.test/feed');
  const a1 = insertRssItem(raw, feedA);
  const a2 = insertRssItem(raw, feedA);
  const b1 = insertRssItem(raw, feedB);

  await host.notifyNewRssItems([a1, b1, a2]);

  // Each plugin is called exactly once, with its whole own array — not once
  // per item, which a length check on the outer array alone would miss.
  assert.equal(alphaReceived.length, 1, 'alpha.onNewRssItems must be called exactly once');
  assert.deepEqual(alphaReceived[0], [a1, a2]);
  assert.equal(betaReceived.length, 1, 'beta.onNewRssItems must be called exactly once');
  assert.deepEqual(betaReceived[0], [b1]);
});

test('two plugins may register the same job kind without colliding', async () => {
  const { raw, host, setTimeoutCalls } = setup();

  const alphaRuns: unknown[] = [];
  const betaRuns: unknown[] = [];
  const alphaHandler: JobHandler = async (job) => { alphaRuns.push(job.payload); };
  const betaHandler: JobHandler = async (job) => { betaRuns.push(job.payload); };

  const alpha = makePlugin({
    id: 'alpha',
    jobs: { same: alphaHandler },
    onNewRssItems: async (_ids, ctx: PluginContext) => {
      await ctx.jobs.enqueue({ kind: 'same', payload: { owner: 'alpha' } });
    },
  });
  const beta = makePlugin({
    id: 'beta',
    jobs: { same: betaHandler },
    onNewRssItems: async (_ids, ctx: PluginContext) => {
      await ctx.jobs.enqueue({ kind: 'same', payload: { owner: 'beta' } });
    },
  });
  host.register(alpha);
  host.register(beta);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedB = insertFeed(raw, 'beta', 'https://b.test/feed');
  const a1 = insertRssItem(raw, feedA);
  const b1 = insertRssItem(raw, feedB);

  // Each onNewRssItems enqueues one job of kind "same" under its own plugin id.
  await host.notifyNewRssItems([a1, b1]);

  // Both rows are ready and due at the same `run_at`, and the default
  // concurrency comfortably covers two -- one fire claims both in the same
  // pass, no `concurrency: 1` needed: nothing here depends on one running
  // before the other, only that each runs exactly once.
  host.start();
  await runDue(host, setTimeoutCalls);

  assert.equal(alphaRuns.length, 1, 'alpha\'s own "same" handler must run exactly once');
  assert.deepEqual(alphaRuns[0], { owner: 'alpha' });
  assert.equal(betaRuns.length, 1, 'beta\'s own "same" handler must run exactly once');
  assert.deepEqual(betaRuns[0], { owner: 'beta' });
  // The effect `runOnce() === false` used to stand for: nothing else was
  // ever enqueued, so nothing of this kind is left runnable.
  const remaining = raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'same' AND state = 'ready'").get();
  assert.equal(Number((remaining as { n: unknown }).n), 0, 'only two jobs were enqueued');
});

test('a download request reaches the plugin owning that item\'s feed', async () => {
  const { raw, host } = setup();

  const alphaReceived: number[] = [];
  const betaReceived: number[] = [];
  const alpha = makePlugin({ id: 'alpha', onDownloadRequest: async (id) => { alphaReceived.push(id); } });
  const beta = makePlugin({ id: 'beta', onDownloadRequest: async (id) => { betaReceived.push(id); } });
  // Beta registers first, so a mutation that dispatches to "whichever plugin
  // registered first" rather than to the actual owner would send this
  // request to beta instead of alpha.
  host.register(beta);
  host.register(alpha);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedB = insertFeed(raw, 'beta', 'https://b.test/feed');
  const itemA = insertRssItem(raw, feedA);
  insertRssItem(raw, feedB); // owned by beta, whose handler must never fire for this request

  await host.requestDownload(itemA);

  assert.deepEqual(alphaReceived, [itemA]);
  assert.deepEqual(betaReceived, []);
});

test('a plugin submitting a download reaches the injected client and reads back its reference', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);

  // A recording client rather than the throwing one every other test here
  // uses: this is what proves `ctx.downloads.submit` is wired through to
  // whichever `DownloadClients` the host was constructed with, independent
  // of which implementation `main.ts` wires in production.
  const submitted: DownloadSubmission[] = [];
  const downloads: DownloadClients = {
    submit: async (submission) => {
      submitted.push(submission);
      return `sab-${submission.rssItemId}`;
    },
  };
  const host = createHost({
    raw, db, fetch: unusedFetch, downloads, secrets: unusedSecrets, now: () => 1000, artworkDir: unusedArtworkDir,
  });

  // The reference is read, not discarded. A call whose return value nothing
  // consumes pins only the parameters — `submit` could answer `undefined` and
  // this test would not notice.
  const references: string[] = [];
  host.register(makePlugin({
    id: 'alpha',
    onDownloadRequest: async (rssItemId, ctx) => {
      const reference = await ctx.downloads.submit({ rssItemId, downloadClientId: 7 });
      if (reference === null) {
        throw new Error('test double: expected a reference, got null');
      }
      references.push(reference.toUpperCase());
    },
  }));

  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const itemId = insertRssItem(raw, feedId);

  await host.requestDownload(itemId);

  assert.deepEqual(submitted, [{ rssItemId: itemId, downloadClientId: 7 }]);
  assert.deepEqual(references, [`SAB-${itemId}`]);
});

test('registering two plugins with the same id is refused', () => {
  const { host } = setup();
  host.register(makePlugin({ id: 'dupe' }));

  assert.throws(
    () => host.register(makePlugin({ id: 'dupe' })),
    /already registered/i,
  );
});

test('an rss item whose feed has no registered plugin is reported, not silently skipped', async () => {
  const { raw, host } = setup();

  const alphaReceived: number[][] = [];
  const alpha = makePlugin({ id: 'alpha', onNewRssItems: async (ids) => { alphaReceived.push([...ids]); } });
  host.register(alpha);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedGhost = insertFeed(raw, 'ghost', 'https://ghost.test/feed'); // 'ghost' never registered
  const itemA = insertRssItem(raw, feedA);
  const itemGhost = insertRssItem(raw, feedGhost);

  const outcome = await host.notifyNewRssItems([itemA, itemGhost]);

  // Reported as data, by id, not merely "the array is non-empty".
  assert.deepEqual(outcome.unowned, [itemGhost]);
  assert.deepEqual(outcome.failures, []);

  // The unowned item being reported must not have cost alpha its own,
  // legitimately owned, delivery.
  assert.equal(alphaReceived.length, 1);
  assert.deepEqual(alphaReceived[0], [itemA]);
});

test('a second plugin\'s failure is not masked by the first', async () => {
  const { raw, host } = setup();

  const alpha = makePlugin({ id: 'alpha', onNewRssItems: async () => { throw new Error('alpha failed'); } });
  const beta = makePlugin({ id: 'beta', onNewRssItems: async () => { throw new Error('beta failed'); } });
  host.register(alpha);
  host.register(beta);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedB = insertFeed(raw, 'beta', 'https://b.test/feed');
  const a1 = insertRssItem(raw, feedA);
  const b1 = insertRssItem(raw, feedB);

  const outcome = await host.notifyNewRssItems([a1, b1]);

  // Both plugins rejected; both must show up. `Promise.all` would reject on
  // whichever settles first and lose the other's failure entirely.
  assert.equal(outcome.failures.length, 2, 'both plugin failures must be reported, not just the first');
  const alphaFailure = outcome.failures.find((f) => f.pluginId === 'alpha');
  const betaFailure = outcome.failures.find((f) => f.pluginId === 'beta');
  assert.ok(alphaFailure, 'alpha\'s failure is missing');
  assert.ok(betaFailure, 'beta\'s failure is missing');
  assert.ok(alphaFailure.error instanceof Error && alphaFailure.error.message === 'alpha failed');
  assert.ok(betaFailure.error instanceof Error && betaFailure.error.message === 'beta failed');
});

test('a plugin failure does not suppress the unowned report', async () => {
  const { raw, host } = setup();

  const alpha = makePlugin({ id: 'alpha', onNewRssItems: async () => { throw new Error('alpha failed'); } });
  host.register(alpha);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedGhost = insertFeed(raw, 'ghost', 'https://ghost.test/feed'); // 'ghost' never registered
  const a1 = insertRssItem(raw, feedA);
  const itemGhost = insertRssItem(raw, feedGhost);

  // The compounding case: one plugin fails *and* one id is unowned, in the
  // same call. Both facts must come back together, neither hiding the other.
  const outcome = await host.notifyNewRssItems([a1, itemGhost]);

  assert.deepEqual(outcome.unowned, [itemGhost]);
  assert.equal(outcome.failures.length, 1);
  const failure = outcome.failures.find((f) => f.pluginId === 'alpha');
  assert.ok(failure, 'alpha\'s failure is missing');
  assert.ok(failure.error instanceof Error && failure.error.message === 'alpha failed');
});

test('registering a plugin whose id is the reserved host id is refused', () => {
  const { host } = setup();

  // Otherwise a plugin silently captures the host's own handlers.
  assert.throws(
    () => host.register(makePlugin({ id: HOST_PLUGIN_ID })),
    /reserved/i,
  );
});

test('a poll job dispatches to the host handler, not to a plugin', async () => {
  const { raw, host, setTimeoutCalls } = setup({ fetch: textFetch(async () => EMPTY_RSS) });

  // Alpha registers its own "poll" handler under its own plugin id. The
  // host's poll job runs under HOST_PLUGIN_ID, so this must never fire for
  // it -- proving dispatch is keyed by (pluginId, kind), not by kind alone.
  const alphaPollRuns: unknown[] = [];
  host.register(makePlugin({ id: 'alpha', jobs: { poll: async (job) => { alphaPollRuns.push(job.payload); } } }));

  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed');
  host.schedulePoll(feedId);

  host.start();
  await runDue(host, setTimeoutCalls);

  assert.equal(alphaPollRuns.length, 0, 'alpha\'s own "poll" handler must never run for the host\'s job');
  // The host's own handler ran instead: a poll that dispatched nowhere
  // would leave no rescheduled job behind.
  const ready = pollJobRows(raw).filter((r) => r.feedId === feedId && r.state === 'ready');
  assert.equal(ready.length, 1, 'the host handler must have run and rescheduled the next poll');

  // `Host.stop()` had no test in this file before this task -- nor did
  // `start()` or `idle()`, all three backed by a real `Dispatcher` with real
  // timers. Pinned here directly: stopping must mean an enqueue no longer
  // rearms, until `start()` runs again.
  host.stop();
  const armedBeforeStop = setTimeoutCalls.length;
  const otherFeedId = insertFeed(raw, 'alpha', 'https://a.test/other-feed');
  host.schedulePoll(otherFeedId, 5000);
  assert.equal(setTimeoutCalls.length, armedBeforeStop, 'a stopped host must not rearm on enqueue');

  host.start();
  assert.ok(setTimeoutCalls.length > armedBeforeStop, 'start() rearms once the dispatcher is running again');
});

test('a poll job re-enqueues itself at now plus the feed interval', async () => {
  const clock = createClock(1000);
  const { raw, host, setTimeoutCalls } = setup({ fetch: textFetch(async () => EMPTY_RSS), now: clock.now });

  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed', 300);
  host.schedulePoll(feedId, 1000);

  // Advance the clock between scheduling and running: asserting against the
  // clock's value AT EXECUTION, not the original schedule time, is what
  // proves the reschedule is computed from "now", not from a stale value --
  // an immediate re-enqueue (or one anchored to the old run_at) would not
  // land on this number.
  clock.set(5000);
  host.start();
  await runDue(host, setTimeoutCalls);

  const ready = pollJobRows(raw).filter((r) => r.feedId === feedId && r.state === 'ready');
  assert.equal(ready.length, 1, 'exactly one rescheduled job must remain for this feed');
  assert.equal(ready[0]?.runAt, 5000 + 300_000, 'run_at must be execution-time now() plus the feed\'s poll interval');
});

test('a poll whose re-enqueue is lost leaves its feed silent, and nothing in the host notices', async () => {
  let polls = 0;
  const { raw, host, setTimeoutCalls } = setup({
    fetch: textFetch(async () => {
      polls += 1;
      return EMPTY_RSS;
    }),
  });

  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed');
  host.schedulePoll(feedId);

  host.start();
  await runDue(host, setTimeoutCalls);
  assert.equal(polls, 1, 'the feed polled once');

  // The negative the suite otherwise cannot see: every job here succeeds,
  // so only killing the re-enqueue shows what a lost one costs. The row the
  // handler wrote is deleted -- what a lost enqueue leaves behind -- and
  // then the host is given every chance to notice: repeated `start()`s, whose
  // crash sweep is the only recovery mechanism left, and repeated claims. It
  // has none. Nothing rescans `rss_feed` for a feed with no pending poll job,
  // so this feed is never polled again for the life of the process and no log
  // line says so. That absence is the finding, and asserting it here is what
  // will fail loudly if a later slice adds the watchdog and forgets to say so.
  const rescheduled = pollJobRows(raw).filter((r) => r.feedId === feedId && r.state === 'ready');
  assert.equal(rescheduled.length, 1, 'there is a re-enqueued job to lose');
  const lost = rescheduled[0];
  assert.ok(lost !== undefined);
  raw.prepare('DELETE FROM jobs WHERE id = ?').run(lost.id);

  // `runOnce() === false` had no return value to carry across to the
  // dispatcher idiom; what is left to assert is that restarting the
  // dispatcher over a database with nothing ready sweeps nothing and arms no
  // new timer. Two separate, sequential checks -- "nothing is claimable" and
  // "and nothing has appeared in the meantime" -- not a loop: each `await`
  // here settles before the next assertion reads state the previous one
  // could have changed, which a `for` loop's own `await` would only
  // obscure behind an index.
  const armedBeforeFirst = setTimeoutCalls.length;
  assert.equal(host.start(), 0, 'nothing was left running to sweep');
  assert.equal(setTimeoutCalls.length, armedBeforeFirst, 'nothing due means no new timer is armed');
  await host.idle();

  const armedBeforeSecond = setTimeoutCalls.length;
  assert.equal(host.start(), 0, 'still nothing was left running to sweep');
  assert.equal(setTimeoutCalls.length, armedBeforeSecond, 'still nothing due means no new timer is armed');
  await host.idle();

  assert.equal(polls, 1, 'the feed was never polled again');
  assert.deepEqual(
    pollJobRows(raw).filter((r) => r.feedId === feedId && (r.state === 'ready' || r.state === 'running')),
    [],
    'nothing re-created the lost poll job',
  );
});

test('a poll re-run after a crash in its re-enqueue window leaves exactly one poll cycle', async () => {
  const clock = createClock(1000);
  const { raw, host, setTimeoutCalls } = setup({ fetch: textFetch(async () => EMPTY_RSS), now: clock.now });

  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed', 300);
  const firstJobId = host.schedulePoll(feedId, 1000);

  host.start();
  await runDue(host, setTimeoutCalls);
  const rescheduled = pollJobRows(raw).filter((r) => r.feedId === feedId && r.state === 'ready');
  assert.equal(rescheduled.length, 1, 'the first run rescheduled once');

  // The crash window: the handler's re-enqueue and its `state = 'done'`
  // write are separate autocommit statements, so a process death between
  // them leaves the ORIGINAL job `running` with its replacement already on
  // file. The next `start()`'s crash sweep hands the original back and it
  // runs a second time -- legitimately, and the handler must be idempotent
  // across that. A bare `runner.enqueue` is not: it would create a second
  // self-perpetuating cycle, permanently doubling this feed's poll rate, and
  // every later crash would double it again.
  raw.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(firstJobId);

  // `start()`'s own sweep is the whole of crash recovery now, and it is
  // idempotent, so calling it on a live host is exactly what a restart does
  // to a database in this state. The sweep recomputes `run_at` from the
  // backoff curve rather than leaving it where it was, so a crash loop backs
  // off across restarts -- pinned here because this is the only place the live
  // sweep's arithmetic is checked through a `Host` rather than against
  // `createDispatcher` directly.
  assert.equal(host.start(), 1, 'the sweep handed the crashed row back');
  const swept = pollJobRows(raw).find((r) => r.id === firstJobId);
  assert.equal(swept?.state, 'ready');
  assert.equal(swept?.runAt, 1000 + 1000, 'readied one backoff step out, per backoffMs(1)');

  // Then the clock moves to meet the readied row, which a real timer would
  // have waited out on its own.
  clock.set(6000);
  await runDue(host, setTimeoutCalls);

  const ready = pollJobRows(raw).filter((r) => r.feedId === feedId && r.state === 'ready');
  assert.equal(ready.length, 1, 'a re-run must not add a second cycle for one feed');
  assert.equal(ready[0]?.id, rescheduled[0]?.id, 'and the surviving cycle is the one the first run created');
  // The effect `runOnce() === true` used to stand for: the recovered row was
  // actually claimed and re-run to completion, not merely left `ready`.
  const firstJob = pollJobRows(raw).find((r) => r.id === firstJobId);
  assert.equal(firstJob?.state, 'done', 'the recovered job must have been claimed and re-run to completion');
  assert.equal(firstJob?.attempts, 2, 'a second claim consumes a second attempt');
});

test('a poll job that throws is retried rather than dead-lettered on its first attempt', async () => {
  // `run_at` below comes from `run-job.ts`'s own fixed retry curve
  // (`backoff.ts`), not an injectable one: `Host` gives its `Runner` no
  // `backoffMs` of its own, so every real retry through `Host.start()`
  // shares this one curve, rather than the injectable one `runner.test.ts`
  // exercises on its own, undecorated `Runner`.
  const { raw, host, setTimeoutCalls } = setup({ fetch: textFetch(async () => { throw new Error('network down'); }) });

  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed');
  host.schedulePoll(feedId);

  host.start();
  await runDue(host, setTimeoutCalls);

  const rows = pollJobRows(raw).filter((r) => r.feedId === feedId);
  // Exactly the original job: a reschedule computed before the throw (rather
  // than after a successful poll) would leave a second row behind here.
  assert.equal(rows.length, 1, 'a failed poll must not also have rescheduled a next one');
  assert.equal(rows[0]?.state, 'ready', 'a first failure must retry through backoff, not dead-letter');
  assert.equal(rows[0]?.attempts, 1);
  // 2000 is now (1000) plus 1000 -- `backoffMs(1)` from
  // `../src/jobs/backoff.ts` -- hardcoded rather than computed by calling
  // that function: computing it here would let a broken curve cancel itself
  // out against this same assertion.
  assert.equal(rows[0]?.runAt, 2000, 'run_at must be the failure time plus the first backoff step');
});

test('a poll for a feed that no longer exists stops rescheduling instead of looping', async () => {
  const { raw, host, setTimeoutCalls } = setup();

  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed');
  host.schedulePoll(feedId);
  raw.prepare('DELETE FROM rss_feed WHERE id = ?').run(feedId);

  // `fetch` is `unusedFetch` here: a correct implementation reads the feed
  // row before polling and never reaches the network at all for a feed
  // that is gone.
  host.start();
  await runDue(host, setTimeoutCalls);

  const rows = pollJobRows(raw).filter((r) => r.feedId === feedId);
  assert.equal(rows.length, 1, 'no new job was created for a deleted feed');
  assert.equal(rows[0]?.state, 'done', 'the job must succeed quietly, not dead-letter or retry against a row that is gone');
});

function insertRawPollJob(raw: DatabaseSync, payloadJson: string, runAt: number): number {
  const result = raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, last_error, created_at, updated_at)
    VALUES (?, 'poll', ?, 0, 5, ?, 'ready', NULL, 0, 0)
  `).run(HOST_PLUGIN_ID, payloadJson, runAt);
  return Number(result.lastInsertRowid);
}

test('calling schedulePoll twice for one feed leaves one poll job', () => {
  const { raw, host } = setup();
  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed');

  const first = host.schedulePoll(feedId);
  const second = host.schedulePoll(feedId);

  // The count, not just the return value: a mutation that still returns the
  // first id while having inserted a second row anyway would pass an
  // assertion on the return value alone.
  assert.equal(second, first, 'the second call must report the existing job, not create a new one');
  const rows = pollJobRows(raw).filter((r) => r.feedId === feedId);
  assert.equal(rows.length, 1, 'exactly one poll job must exist for this feed after two schedulePoll calls');
});

test('a corrupt poll payload does not stop another feed from being scheduled', () => {
  const { raw, host } = setup();

  // A row nothing here wrote: some other process, or an earlier schema,
  // left a poll job whose payload this host cannot read.
  insertRawPollJob(raw, JSON.stringify({ nope: 1 }), 1000);

  const feedId = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const jobId = host.schedulePoll(feedId);

  assert.equal(typeof jobId, 'number', 'the healthy feed must still get a job id back');
  const rows = pollJobRows(raw).filter((r) => r.feedId === feedId);
  assert.equal(rows.length, 1, 'the healthy feed must still have its own poll job scheduled');
});
