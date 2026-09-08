import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, MediaPlugin } from '@pickarr/contract';
import type { Host } from '../src/host.ts';
import { createHost, DEFAULT_MAX_ATTEMPTS, HOST_PLUGIN_ID } from '../src/host.ts';
import { migrateHost } from '../src/db/migrate.ts';
import { openDatabase, openTestDatabase } from '../src/db/open.ts';
import type { QueuedFetch } from '../src/fetch/queue.ts';
import type { Timers } from '../src/jobs/dispatcher.ts';
import type { ReadServer, ReadServerDeps } from '../src/api/server.ts';
import { DEFAULT_PORT } from '../src/api/server.ts';
import {
  createPluginIdForType,
  createShutdown,
  formatLogDetail,
  main,
  resolveArtworkDir,
  resolveReadPort,
  scheduleKnownFeeds,
} from '../src/main.ts';

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
 * A `ReadServer` that records nothing but its own closing, on an address no
 * test connects to: every test in this file replaces the real
 * `createReadServer`, so nothing here ever binds a socket. `packages/host/test/api/server.test.ts`
 * is where the real listener is exercised, on a kernel-assigned port.
 */
function fakeServer(onClose: () => void): ReadServer {
  return {
    host: '127.0.0.1',
    port: 0,
    family: 'IPv4',
    close: async () => {
      onClose();
    },
  };
}

/** A `Host` whose every method fails loudly if a test never meant to reach it. */
function fakeHost(overrides: Partial<Host>): Host {
  return {
    register: () => { throw new Error('register: not used by this test'); },
    notifyNewRssItems: async () => { throw new Error('notifyNewRssItems: not used by this test'); },
    requestDownload: async () => { throw new Error('requestDownload: not used by this test'); },
    deliverToPlugin: async () => { throw new Error('deliverToPlugin: not used by this test'); },
    schedulePoll: () => { throw new Error('schedulePoll: not used by this test'); },
    scheduleReconcile: async () => { throw new Error('scheduleReconcile: not used by this test'); },
    // Throwing, not a no-op: a no-op default here would let a test pass
    // while `main`'s real `start()`/`stop()` calls go unexercised -- see
    // `createShutdown`'s own tests below, which override exactly the two
    // methods each needs and nothing else.
    start: () => { throw new Error('start: not used by this test'); },
    stop: () => { throw new Error('stop: not used by this test'); },
    idle: async () => { throw new Error('idle: not used by this test'); },
    ...overrides,
  };
}

/**
 * A complete `MediaPlugin` owning `OWNER_ID`'s feeds, with no migrations and
 * no reachable entry point beyond what a given test overrides.
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

/** A `QueuedFetch` that fails loudly if a test never meant to reach the network. */
const unusedFetch: QueuedFetch = {
  json: async () => { throw new Error('fetch.json: not used by this test'); },
  bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  text: async () => { throw new Error('fetch.text: not used by this test'); },
};

/** A `DownloadClients` that fails loudly if a test never meant to submit anywhere. */
const unusedDownloads: DownloadClients = {
  submit: async () => { throw new Error('downloads.submit: not used by this test'); },
};

/** No test in this file writes artwork, so this directory is never created or read. */
const unusedArtworkDir = '/nonexistent/pickarr-main-test-artwork-unused';

/**
 * A `Timers` whose every call is logged rather than actually scheduled, the
 * same fake `host.test.ts`, `dispatcher.test.ts` and `jobs/runner.test.ts`
 * each build for their own use -- duplicated here rather than imported,
 * since no file in this package shares a test-support module with another.
 * Real timers are never armed by a test that supplies this: `main`'s own
 * tests below run under `node --test` with no `--test-force-exit`, so a
 * real `setInterval` left running past a test's own assertions would hang
 * the whole suite, not merely that one test.
 */
function createFakeTimers(): { timers: Timers; setTimeoutCalls: { fn: () => void }[] } {
  let nextHandle = 0;
  const setTimeoutCalls: { handle: number; fn: () => void }[] = [];
  const timers: Timers = {
    setTimeout(fn) {
      const handle = ++nextHandle;
      setTimeoutCalls.push({ handle, fn });
      return handle;
    },
    clearTimeout() {},
    setInterval() {
      return ++nextHandle;
    },
    clearInterval() {},
  };
  return { timers, setTimeoutCalls };
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

/** Inserts a `ready` job of any kind directly, the same way a row this host did not create might arrive. */
function insertRawJob(raw: DatabaseSync, pluginId: string, kind: string, payloadJson: string, runAt: number): number {
  const result = raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, 'ready', 0, 0)
  `).run(pluginId, kind, payloadJson, DEFAULT_MAX_ATTEMPTS, runAt);
  return Number(result.lastInsertRowid);
}

function readJob(raw: DatabaseSync, id: number): { state: string; attempts: number } {
  const row = raw.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as { state: unknown; attempts: unknown };
  return { state: String(row.state), attempts: Number(row.attempts) };
}

test('main starts the dispatcher before it schedules known feeds, so a feed whose poll crashed on its last attempt still has a runnable job', async () => {
  // The silent feed-stop this exists to catch, and it is an ORDERING
  // defect, not a missing call: `schedulePoll` counts a poll job left
  // `running` as pending and declines to replace it, and `start()`'s sweep
  // dead-letters that same row because the crash consumed its last
  // permitted attempt. Schedule first and the feed ends up with no poll job
  // in any runnable state, forever, with nothing to notice. Start first and
  // it gets a fresh cycle. Measured both ways: 0 jobs against 1.
  //
  // A real `Host` over a real database file, not a `fakeHost`: the defect
  // lives in how the sweep and `schedulePoll` see each other's rows, which
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

    // A fake `Timers`, not real ones: `main` arms the dispatcher for real
    // through `host.start()` now, and this test only cares what state that
    // leaves in the database the instant `main` returns -- not about a real
    // `setInterval` outliving the test and hanging the suite.
    const { timers } = createFakeTimers();
    // `createReadServer` replaced, as every test running `main` must: the
    // real one binds a real port and `main` hands back no way to close it.
    await runMain(databasePath, {
      plugins: [ownerPlugin],
      timers,
      createReadServer: async () => fakeServer(() => {}),
    });

    const after = openDatabase(databasePath);
    try {
      assert.equal(
        runnablePollJobs(after.raw),
        1,
        'the feed must still have a poll job something will claim; 0 here means main scheduled before it started the dispatcher',
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

test('main boots with no plugin registered, and still schedules a poll for every known feed', async () => {
  // `main` used to refuse this outright: a poll's dedup insert consumes an
  // item's identity through (feed_id, guid), so an unowned item looked
  // permanently destroyed. `rss_item.delivered_at` (see `feeds/reader.ts`)
  // is what removed that danger -- an unowned row simply stays undelivered
  // and is re-offered once a plugin registers -- so booting with an empty
  // plugin list, exactly what the shipped `SHIPPED_PLUGINS` is today, must
  // now succeed rather than throw.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-no-plugin-'));
  try {
    const databasePath = join(dir, 'pickarr.db');
    const seed = openDatabase(databasePath);
    migrateHost(seed.raw);
    insertFeed(seed.raw, 'https://a.test/feed.xml');
    seed.raw.close();

    const { timers } = createFakeTimers();
    await runMain(databasePath, {
      plugins: [],
      timers,
      createReadServer: async () => fakeServer(() => {}),
    });

    const after = openDatabase(databasePath);
    try {
      assert.equal(
        runnablePollJobs(after.raw),
        1,
        'a feed known before boot must still get a poll job scheduled, even with no plugin registered',
      );
    } finally {
      after.raw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a job whose handler rejects does not stop the host from running the next one', async () => {
  // The pump-era analogue of this test drove a scripted `runOnce` through a
  // rejection and back; there is no pump left to drive, so this drives a
  // real `Host` the same way `main` builds one, with two jobs of its own
  // plugin's kinds due in the same batch -- one whose handler always
  // throws, one that always succeeds.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const { timers, setTimeoutCalls } = createFakeTimers();
  const host = createHost({
    raw,
    db,
    fetch: unusedFetch,
    downloads: unusedDownloads,
    now: () => 1000,
    artworkDir: unusedArtworkDir,
    timers,
  });

  const okRuns: unknown[] = [];
  host.register({
    ...ownerPlugin,
    jobs: {
      boom: async () => { throw new Error('handler exploded'); },
      ok: async (job) => { okRuns.push(job.payload); },
    },
  });

  const boomId = insertRawJob(raw, OWNER_ID, 'boom', '{}', 1000);
  insertRawJob(raw, OWNER_ID, 'ok', JSON.stringify({ marker: true }), 1000);

  host.start();
  const fire = setTimeoutCalls.at(-1)?.fn;
  assert.ok(fire, 'no timer was armed for the due jobs');
  fire();
  await host.idle();

  assert.deepEqual(okRuns, [{ marker: true }], 'the ok job ran to completion despite the boom job rejecting in the same batch');
  const boom = readJob(raw, boomId);
  assert.equal(boom.state, 'ready', 'a rejecting handler is retried through backoff, not left running or lost, and the host keeps going');
  assert.equal(boom.attempts, 1);
});

test('createShutdown stops the host, closes the database and exits exactly once, even if a second signal lands mid-shutdown', () => {
  const { raw } = openTestDatabase();
  let stopped = 0;
  let closed = 0;
  const host = fakeHost({ stop: () => { stopped += 1; } });
  const exitCalls: number[] = [];
  const shutdown = createShutdown(host, raw, fakeServer(() => { closed += 1; }), { exit: (code) => { exitCalls.push(code); } });

  shutdown('SIGINT received');
  shutdown('SIGTERM received');

  assert.equal(closed, 1, 'the listener is closed exactly once too, not once per signal');
  assert.equal(stopped, 1, 'stop must run exactly once even though shutdown was asked for twice');
  assert.deepEqual(exitCalls, [0], 'exit must run exactly once, with the process\'s own success code');
  assert.throws(() => raw.prepare('SELECT 1').get(), 'the database must actually be closed, not merely stopped');
});

test('createShutdown exits without waiting for a hung idle(), which the pump it replaces could never have passed', () => {
  // `Host.stop()` is typed `(): void` and `createShutdown` never calls
  // `idle()` at all -- proven here by handing it an `idle` that would hang
  // the process forever if it were ever reached. A mutation that awaited
  // `host.idle()` before exiting would have to hang the same way and fail
  // this assertion, never reaching it.
  //
  // The same goes for the listener, one layer out: `close()` here never
  // settles, so a `createShutdown` that awaited it would never reach the
  // exit either.
  const { raw } = openTestDatabase();
  let idleCalls = 0;
  const host = fakeHost({
    stop: () => {},
    idle: () => { idleCalls += 1; return new Promise<void>(() => {}); },
  });
  const exitCalls: number[] = [];
  const neverCloses: ReadServer = {
    host: '127.0.0.1',
    port: 0,
    family: 'IPv4',
    close: () => new Promise<void>(() => {}),
  };
  const shutdown = createShutdown(host, raw, neverCloses, { exit: (code) => { exitCalls.push(code); } });

  shutdown('SIGINT received');

  assert.deepEqual(exitCalls, [0], 'shutdown must already have exited by the time this synchronous line runs');
  assert.equal(idleCalls, 0, 'a prompt shutdown never touches idle() in the first place');
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

test('main starts the server after the host and closes it before stopping', async () => {
  // Two orderings, one property, and both halves fail the same way: silently,
  // in production only.
  //
  // **Started after `host.start()`.** The socket must not answer a read
  // before the crash sweep has run and the dispatcher is armed. `start()` is
  // the only thing in this process that arms the dispatcher's safety
  // interval, so a `setInterval` already recorded by the time the server is
  // built is exactly the evidence that `start()` came first -- and a
  // `createReadServer` call moved above it reverses the two entries below.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-server-'));
  const previousPort = process.env['PICKARR_READ_API_PORT'];
  try {
    delete process.env['PICKARR_READ_API_PORT'];
    const databasePath = join(dir, 'pickarr.db');
    const seed = openDatabase(databasePath);
    migrateHost(seed.raw);
    insertFeed(seed.raw, 'https://a.test/feed.xml');
    seed.raw.close();

    const order: string[] = [];
    const { timers } = createFakeTimers();
    const recording: Timers = {
      setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
      clearTimeout: (handle) => { timers.clearTimeout(handle); },
      setInterval: (fn, ms) => {
        order.push('host started');
        return timers.setInterval(fn, ms);
      },
      clearInterval: (handle) => { timers.clearInterval(handle); },
    };

    // The one test seam that keeps this from binding a real socket: `main`'s
    // own `createReadServer` would take a port, and a port written down in a
    // test is a port two tests can fight over.
    const built: ReadServerDeps[] = [];
    await runMain(databasePath, {
      plugins: [ownerPlugin],
      timers: recording,
      createReadServer: async (serverDeps) => {
        order.push('server listening');
        built.push(serverDeps);
        return fakeServer(() => {});
      },
    });

    assert.deepEqual(
      order,
      ['host started', 'server listening'],
      'the listener opens only once the host is running; reversed here means main serves reads over an unswept database',
    );
    assert.equal(built.length, 1, 'exactly one listener, not one per plugin or per feed');
    const serverDeps = built[0];
    assert.ok(serverDeps, 'the server was built with deps main composed');
    assert.equal(serverDeps.port, DEFAULT_PORT, 'the documented default, with PICKARR_READ_API_PORT unset');
    assert.equal(
      serverDeps.pluginIdForType('movie'),
      OWNER_ID,
      'the type mapping is built from main\'s own plugin list, which is what keeps src/api off host.ts',
    );
    assert.equal(serverDeps.pluginIdForType('book'), undefined, 'and answers nothing for a type no plugin claims');
  } finally {
    if (previousPort === undefined) delete process.env['PICKARR_READ_API_PORT'];
    else process.env['PICKARR_READ_API_PORT'] = previousPort;
    await rm(dir, { recursive: true, force: true });
  }

  // **Closed before stopping.** `createShutdown` is the whole of the process's
  // teardown, and it is exercised directly here for the same reason its own
  // two tests are: driving this through a real signal would run the real
  // `process.exit` and take the test runner with it.
  const { raw } = openTestDatabase();
  const teardown: string[] = [];
  const host = fakeHost({ stop: () => { teardown.push('host stopped'); } });
  const shutdown = createShutdown(host, raw, fakeServer(() => { teardown.push('listener closed'); }), {
    exit: () => { teardown.push('exited'); },
  });

  shutdown('SIGTERM received');

  assert.deepEqual(
    teardown,
    ['listener closed', 'host stopped', 'exited'],
    'the listener stops first, so no read is accepted against a host that has already been told to stop',
  );
});

test('resolveReadPort reads PICKARR_READ_API_PORT, defaults to 8787, and refuses anything that is not a port', () => {
  // Taken as an argument rather than read from `process.env` inside, so this
  // asserts the precedence without mutating the environment every other test
  // in this process shares.
  assert.equal(resolveReadPort(undefined), DEFAULT_PORT, 'unset means the documented default');
  assert.equal(resolveReadPort(''), DEFAULT_PORT, 'and an empty variable is an unset one');
  assert.equal(resolveReadPort('9999'), 9999);
  assert.equal(resolveReadPort('1'), 1);
  assert.equal(resolveReadPort('65535'), 65535);

  // Refused loudly at boot rather than coerced: `Number.parseInt` -- which
  // 1.x's own `resolveServerPort` uses -- reads '80abc' as 80 and would
  // silently listen on a port nobody asked for.
  for (const bad of ['0', '65536', 'eight', '80abc', '-1', '8.5', ' 80', '0x50']) {
    assert.throws(() => resolveReadPort(bad), /PICKARR_READ_API_PORT/, `${bad} must be refused, not coerced`);
  }
});

test('createPluginIdForType maps each plugin\'s media type, and refuses two plugins claiming one', () => {
  const movies: MediaPlugin = { ...ownerPlugin, id: 'movies', mediaType: 'movie' };
  const shows: MediaPlugin = { ...ownerPlugin, id: 'shows', mediaType: 'tv' };

  const typeToPlugin = createPluginIdForType([movies, shows]);
  assert.equal(typeToPlugin('movie'), 'movies');
  assert.equal(typeToPlugin('tv'), 'shows');
  assert.equal(typeToPlugin('book'), undefined, 'a type nothing claims has no id, which the route answers 404 for');
  assert.equal(createPluginIdForType([])('movie'), undefined, 'and a host with no plugins claims no type at all');

  // Refused at construction, not resolved per request: with two plugins on
  // one type there is no right answer, and picking either would route a whole
  // media type's reads to whichever happened to be registered first -- a
  // configuration error that would present as one plugin's library being
  // empty.
  assert.throws(
    () => createPluginIdForType([movies, { ...shows, mediaType: 'movie' }]),
    /movie/,
    'the throw names the contested type',
  );
});

test('formatLogDetail writes key=value pairs, and cannot spill an object it is handed', () => {
  assert.equal(
    formatLogDetail({ route: '/api/media', error: 'https://sab.test/api?apikey=***' }),
    'route=/api/media error=https://sab.test/api?apikey=***',
    'the read server\'s own failure line, already redacted by the time it arrives',
  );
  assert.equal(formatLogDetail({}), '', 'an empty record adds nothing');

  // The property that makes this safe to hand any record: `String` of an
  // object is `[object Object]`, so a row or a config logged by mistake
  // cannot reach the console as its contents. This is the rule about never
  // logging an object, enforced by the formatter rather than by remembering.
  assert.equal(
    formatLogDetail({ row: { title: 'A Secret Title', apiKey: 'SECRET-KEY-9' } }),
    'row=[object Object]',
    'a row hands over nothing, not even its keys',
  );
});
