import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, MediaPlugin } from '@pickarr/contract';
import { API_KEY_SECRET } from '@pickarr/openmetadata';
import type { Host } from '../src/host.ts';
import { createHost, DEFAULT_MAX_ATTEMPTS, HOST_PLUGIN_ID } from '../src/host.ts';
import { migrateHost } from '../src/db/migrate.ts';
import { openDatabase, openTestDatabase } from '../src/db/open.ts';
import type { QueuedFetch } from '../src/fetch/queue.ts';
import type { Timers } from '../src/jobs/dispatcher.ts';
import type { ReadServer, ReadServerDeps } from '../src/api/server.ts';
import { DEFAULT_HOST, DEFAULT_PORT, createReadServer } from '../src/api/server.ts';
import { isClaimed } from '../src/auth/claim.ts';
import { AUTH_SECRET_KEY, CLAIM_TOKEN_KEY, readHostState, writeHostState } from '../src/db/host-state.ts';
import { envNameFor } from '../src/secrets/names.ts';
import type { HostSettings } from '../src/main.ts';
import {
  createPluginIdForType,
  createShutdown,
  formatLogDetail,
  main,
  resolveArtworkDir,
  resolveConfigPath,
  resolveOpenmetadataUrl,
  resolvePublicUrl,
  resolveReadHost,
  resolveReadPort,
  resolveSettings,
  scheduleKnownFeeds,
  shippedPlugins,
} from '../src/main.ts';
import { DEFAULT_CONFIG_PATH } from '../src/config/schemas.ts';
import type { Secrets } from '../src/secrets/instance.ts';

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

/** Every environment variable `main` reads, so each test starts from a known one. */
const MAIN_VARIABLES = [
  'PICKARR_DATABASE',
  'PICKARR_READ_API_PORT',
  'PICKARR_READ_API_HOST',
  'PICKARR_PUBLIC_URL',
  // Cleared for the same reason as the rest: a stray value in the shell
  // would point `resolveSettings` at a real file this suite never wrote,
  // and every test below relies on the default path resolving to no file
  // (`readConfigDocument`'s `{}` for `ENOENT`) unless it sets this itself.
  'PICKARR_CONFIG',
  // `main` reads this one too, and it is the one whose leaking in from the
  // shell would be hardest to diagnose: set to anything, it becomes the
  // signing secret in place of the persisted row, so a developer who happens
  // to export it would change which cookie every test here can present.
  'BETTER_AUTH_SECRET',
  // The lookup service's origin, and the key the three plugins authenticate
  // to it with. Both are read by `main`, and the key is the one whose
  // presence a boot now warns about -- so a developer who exports it would
  // otherwise silence the warning these tests assert on, and one who exports
  // the url would point a boot at a host that does not exist.
  'PICKARR_OPENMETADATA_URL',
  'PICKARR_OPENMETADATA_KEY',
] as const;

/**
 * Runs `main` against a database of the test's own and hands back every line
 * the boot wrote, with every variable `main` reads restored afterwards
 * whatever happens -- this is the process's own environment, and a test that
 * left `PICKARR_DATABASE` pointing at a temporary directory would corrupt
 * every test after it in this file.
 *
 * **The other five are deleted rather than left alone**, and `env` sets only
 * what a test is actually asserting about. `main` reads
 * `PICKARR_READ_API_PORT`, `PICKARR_READ_API_HOST`, `PICKARR_PUBLIC_URL`,
 * `PICKARR_CONFIG` and `BETTER_AUTH_SECRET`, so a value one of them happened
 * to hold in the shell that started the run would change what these tests
 * observe -- and the failure would read as a defect in `main` rather than as
 * an environment nobody cleared.
 *
 * **Every boot is captured, whether its test reads a line or not.** An
 * unclaimed boot prints a real claim token, which is `main`'s one credential
 * line, and a test run's own output is no place for one even when the
 * database it opens is deleted a moment later. Measured rather than feared:
 * before this captured unconditionally, three tests here that assert nothing
 * but job rows were each putting a freshly generated token on stdout.
 */
async function runMain(
  databasePath: string,
  deps: Parameters<typeof main>[1],
  env: Readonly<Record<string, string>> = {},
): Promise<string[]> {
  const previous = new Map(MAIN_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of MAIN_VARIABLES) delete process.env[name];
  process.env['PICKARR_DATABASE'] = databasePath;
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  try {
    return await captureConsole(() => main([], deps));
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Every line the process wrote to its console while `run` was in flight, with
 * `console` put back whatever happens.
 *
 * All four methods, not only the `console.log` `main`'s own `log` writes to:
 * the property the tests below assert is that the signing secret reaches no
 * log line *at all*, and a line Better Auth's own logger wrote would be as
 * bad as one of ours -- and would not come through an injected fake `log`,
 * which is why this captures the console rather than taking a seam.
 *
 * **Nothing here is ever printed by an assertion.** The captured lines carry
 * a live claim token on an unclaimed boot, so every assertion over them
 * compares a boolean or a count and carries a message of its own; none of them
 * hands a line to a helper that would format it into a failure.
 */
async function captureConsole(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((value) => String(value)).join(' '));
  };
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  try {
    await run();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines;
}

/**
 * A database file, migrated, with whatever a test wants on it already -- the
 * shape every `main` test needs, since `main` opens the path it is given
 * rather than a handle it is passed. The seeding connection is closed before
 * `main` opens its own.
 */
function seedDatabase(databasePath: string, seed: (raw: DatabaseSync) => void = () => {}): void {
  const { raw } = openDatabase(databasePath);
  try {
    migrateHost(raw);
    seed(raw);
  } finally {
    raw.close();
  }
}

/** The one account a claimed install has, inserted directly rather than signed up for. */
function insertOwner(raw: DatabaseSync): void {
  raw.prepare(`
    INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('placeholder-owner', 'Placeholder Owner', 'owner@example.invalid', 0, 0, 0)
  `).run();
}

/**
 * Obviously synthetic placeholders that say so in their own text, the same
 * ones `api/server.test.ts` uses.
 *
 * The claim token is **seeded rather than generated**, which is what keeps
 * every test below from handling a real one: a real token is worth the whole
 * install for as long as it is unspent, and this one is worth nothing outside
 * the temporary database it was written to.
 */
const PLACEHOLDER_CLAIM_TOKEN = 'placeholder-not-a-real-claim-token';
const PASSWORD = 'placeholder-not-a-real-password';
const OWNER_EMAIL = 'owner@example.invalid';

/**
 * A public origin no request below is ever *sent* to -- it is only ever an
 * `Origin` header and, through `PICKARR_PUBLIC_URL`, a `baseURL`. `.test` is
 * reserved by RFC 2606, so it resolves nowhere even if something tried, and
 * it is neither `localhost` nor an address `trustedOrigins` can place -- which
 * is what makes a request accepted from it evidence that the variable was
 * read.
 */
const PUBLIC_URL = 'http://pickarr.test:9999';

/**
 * The `Cookie` header a browser would send back, built from a response's
 * `Set-Cookie` headers -- the same shape `api/server.test.ts` builds, and it
 * throws rather than returning an empty string for the same reason: a
 * silently cookie-less request cannot be told apart from a session that
 * failed to round-trip.
 */
function cookieHeader(response: Response): string {
  const pairs = response.headers.getSetCookie().map((value) => {
    const [pair] = value.split(';');
    if (pair === undefined) throw new Error('a Set-Cookie header with no name=value pair');
    return pair;
  });
  if (pairs.length === 0) throw new Error('the response set no cookie to send back');
  return pairs.join('; ');
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
  // plugin list, passed here through `deps.plugins` rather than the shipped
  // default, must succeed rather than throw.
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
    downloads: () => unusedDownloads,
    secrets: unusedSecrets,
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
  // `runMain` clears every variable `main` reads, so the defaults asserted
  // below are the defaults and not whatever the shell happened to export.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-server-'));
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath, (raw) => {
      insertFeed(raw, 'https://a.test/feed.xml');
    });

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
    assert.equal(serverDeps.port, DEFAULT_PORT, 'the documented default, with PICKARR_READ_API_PORT unset and no config file');
    assert.equal(
      serverDeps.host,
      DEFAULT_HOST,
      'and an unset PICKARR_READ_API_HOST resolves through the config file\'s own default -- serverConfigSchema\'s '
      + '\'0.0.0.0\', the same value DEFAULT_HOST names -- rather than being passed through as undefined',
    );
    assert.equal(
      serverDeps.pluginIdForType('movie'),
      OWNER_ID,
      'the type mapping is built from main\'s own plugin list, which is what keeps src/api off host.ts',
    );
    assert.equal(serverDeps.pluginIdForType('book'), undefined, 'and answers nothing for a type no plugin claims');
  } finally {
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

/**
 * `main`, with the **real** `createReadServer` -- wrapped rather than
 * replaced.
 *
 * Every other test in this file hands `main` a `fakeServer`, and that is what
 * leaves `main`'s own `authFor` closure uncovered: the closure over this
 * process's database, its persisted signing secret and its public url is
 * called by the *listener*, once the listener knows what it bound. So the two
 * tests below let a real listener bind, and wrap it only to keep the handle --
 * `main` returns none, and a leaked listener outlives the test -- and to ask
 * for port 0.
 *
 * **The port is the only thing overridden.** `main`'s own `resolveReadPort`
 * refuses 0 outright, deliberately: a *process* told to listen on an
 * arbitrary free port answers at an address nothing can be configured to
 * poll. A port written down in a test, meanwhile, is a port two tests can
 * fight over. Everything else, `authFor` included, is exactly what `main`
 * composed.
 *
 * The ordering this exercises is production's rather than this test's:
 * `baseURL` must be the origin requests actually arrive at or Better Auth
 * refuses every POST (design spec §2), so `createReadServer` binds first and
 * builds the auth instance from the address it reads back. Port 0 only makes
 * that ordering visible -- it does not create it, and a fixed port would not
 * remove it.
 */
async function runMainListening(
  databasePath: string,
  deps: Parameters<typeof main>[1],
  env: Readonly<Record<string, string>> = {},
): Promise<{ server: ReadServer; lines: string[] }> {
  let listening: ReadServer | undefined;
  let lines: string[] = [];
  try {
    lines = await runMain(databasePath, {
      ...deps,
      createReadServer: async (serverDeps) => {
        listening = await createReadServer({ ...serverDeps, port: 0 });
        return listening;
      },
    }, env);
  } catch (error) {
    // Closed here rather than left to the test's own `finally`: the handle
    // never reached the caller, so nothing else can close it.
    await listening?.close();
    throw error;
  }
  if (listening === undefined) throw new Error('main returned without building a listener');
  return { server: listening, lines };
}

test('an unclaimed install prints its claim token on boot', async () => {
  // **The token is seeded, not generated by this boot**, and that is what
  // makes this the "every boot" case rather than the first-boot one: a print
  // gated on having just minted the token would pass against a fresh
  // database and fail here, which is the second boot an owner who missed the
  // line the first time actually performs.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-claim-print-'));
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath, (raw) => {
      writeHostState(raw, CLAIM_TOKEN_KEY, PLACEHOLDER_CLAIM_TOKEN, 0);
    });

    const { timers } = createFakeTimers();
    const lines = await runMain(databasePath, {
      plugins: [],
      timers,
      createReadServer: async () => fakeServer(() => {}),
    });

    const carrying = lines.filter((line) => line.includes(PLACEHOLDER_CLAIM_TOKEN));
    assert.equal(
      carrying.length,
      1,
      'exactly one line carries the token: it is a credential until it is spent, and one line is the whole of its exposure',
    );
    const line = carrying[0] ?? '';
    assert.equal(
      line.includes('single-use'),
      true,
      'the line says the token is single-use, because a token that reads as reusable invites being left lying around',
    );
    assert.equal(
      line.includes('succeeds'),
      true,
      'and that only a sign-up which succeeds spends it, so the line cannot be read as "one attempt is all you get"',
    );
    // Last of all, which is what `main`'s own startup-order doc claims and
    // the only part of "at a level someone starting the process will see"
    // that is testable: the bottom of the output is where they are looking.
    assert.equal(
      lines.at(-1) === line,
      true,
      'the token line is the last thing the boot writes, above nothing that would scroll it away',
    );

    const after = openDatabase(databasePath);
    try {
      // `assert.ok(a === b)`, not `assert.equal`: the equality helpers format
      // both operands into a failure, and one of these is the token.
      assert.ok(
        readHostState(after.raw, CLAIM_TOKEN_KEY) === PLACEHOLDER_CLAIM_TOKEN,
        'printing the token neither spends it nor mints a second one',
      );
      assert.equal(isClaimed(after.raw), false, 'the fixture is an unclaimed install, which is why there was anything to print');
    } finally {
      after.raw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a claimed install prints no token', async () => {
  // **A token left on record *and* an account**, which is the fixture that
  // isolates the check: a boot that printed whatever `ensureClaimToken`
  // handed back would print this row, so the absence below is the
  // `isClaimed` test and not an empty table.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-claimed-'));
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath, (raw) => {
      insertOwner(raw);
      writeHostState(raw, CLAIM_TOKEN_KEY, PLACEHOLDER_CLAIM_TOKEN, 0);
    });

    const { timers } = createFakeTimers();
    const lines = await runMain(databasePath, {
      plugins: [],
      timers,
      createReadServer: async () => fakeServer(() => {}),
    });

    assert.ok(lines.length > 0, 'the boot printed something, so the two absences below are not an empty capture');
    assert.equal(
      lines.filter((line) => line.includes(PLACEHOLDER_CLAIM_TOKEN)).length,
      0,
      'a claimed install prints no token, and this one had one on record to print',
    );
    assert.equal(
      lines.filter((line) => line.toLowerCase().includes('claim token')).length,
      0,
      'and says nothing about claiming, which would only invite an attempt that is already refused',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the signing secret is never printed', async () => {
  // The noisiest boot there is: nothing seeded, so this process generates the
  // secret itself, mints and prints a claim token, and -- with no public url
  // configured -- writes `createAuth`'s warning too. Every line of it is
  // asserted against the one value none of them may carry.
  //
  // **A real listener, because a faked one never builds the auth instance.**
  // `ensureAuthSecret` is called inside `main`'s `authFor` closure, which the
  // *listener* calls back once it knows its own address -- so a boot whose
  // `createReadServer` is replaced by a fake persists no secret at all, and
  // this test would then assert the absence of a value that was never
  // generated. Measured, not assumed: with the fake, `host_state` had no
  // `auth.secret` row.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-secret-'));
  let server: ReadServer | undefined;
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath);

    const { timers } = createFakeTimers();
    const { server: listener, lines } = await runMainListening(databasePath, { plugins: [], timers });
    server = listener;

    const after = openDatabase(databasePath);
    try {
      const secret = readHostState(after.raw, AUTH_SECRET_KEY);
      assert.ok(secret !== null, 'the boot generated and persisted a signing secret, which is the value nothing may print');
      assert.ok(secret.length >= 32, 'and a real one, not an empty string that would make every assertion below vacuous');
      assert.ok(lines.length > 0, 'the boot printed something, so the absence below is not an empty capture');
      for (const [index, line] of lines.entries()) {
        // The secret's own **value**, never a placeholder standing in for it
        // -- and compared into a boolean with a message of its own, because
        // `assert.equal(line, ...)` would print the line, and therefore the
        // secret, into the failure it reported.
        assert.equal(line.includes(secret), false, `line ${index} of the boot log must not carry the signing secret`);
      }
    } finally {
      after.raw.close();
    }
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('main wires auth so a data route refuses without a session', async () => {
  // **Driven through `main`, not through `createReadServer`.** `main` builds
  // the auth instance the guard asks -- the `authFor` closure over this
  // process's database, its persisted secret and its public url -- and every
  // other test in this file replaces `createReadServer` with a fake, so
  // nothing else covers that closure at all. Task 5 flagged exactly this gap;
  // this is the test that closes it.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-auth-'));
  let server: ReadServer | undefined;
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath, (raw) => {
      writeHostState(raw, CLAIM_TOKEN_KEY, PLACEHOLDER_CLAIM_TOKEN, 0);
    });

    // The boot's own lines go unread here and are captured anyway, by
    // `runMain`: this one generates a real signing secret, and a real boot
    // whose console is not captured is how a line carrying one would reach
    // the run's output. Measured rather than feared -- the mutation that logs
    // the secret printed it from exactly this test, back when it was the one
    // `main` test not capturing, while the test written to catch that was
    // busy catching it somewhere else.
    const { timers } = createFakeTimers();
    const { server: listener } = await runMainListening(databasePath, { plugins: [ownerPlugin], timers });
    server = listener;
    const origin = `http://${server.host}:${server.port}`;

    const anonymous = await fetch(`${origin}/api/media?type=movie`);
    assert.equal(anonymous.status, 401, 'a data route refuses a caller with no session, through the auth main wired in');

    // The listener is answering, so the refusal above is the guard rather
    // than a socket with nothing behind it.
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200, 'the one open route answers, so the refusal above is the guard and not a dead listener');

    // And the other half, which is what proves `baseURL` came from the
    // address the listener bound: the `Origin` below is the unspecified
    // address, which `trustedOrigins` will not place (it is neither
    // `localhost` nor in any of the blocks `isPlaceableOrigin` matches --
    // `0` is not `127`, `10`, `172.16/12`, `192.168` or `169.254`), so
    // nothing but `baseURL` itself can be what lets this POST through.
    const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        email: OWNER_EMAIL,
        password: PASSWORD,
        name: 'Placeholder Owner',
        claimToken: PLACEHOLDER_CLAIM_TOKEN,
      }),
    });
    assert.equal(signUp.status, 200, 'sign-up through main\'s own mount, carrying the claim token this boot printed');

    const signedIn = await fetch(`${origin}/api/media?type=movie`, {
      headers: { cookie: cookieHeader(signUp) },
    });
    assert.equal(signedIn.status, 200, 'and the session that sign-up issued reaches the data, so the guard is not simply refusing everything');
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('main binds PICKARR_READ_API_HOST and hands PICKARR_PUBLIC_URL to auth as its origin', async () => {
  // The two variables this step adds, both read in exactly one place (design
  // spec §6) and both observed here at the far end: the host from the
  // listener's own address, the public url from what Better Auth will accept
  // a POST from.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-public-'));
  let server: ReadServer | undefined;
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath, (raw) => {
      writeHostState(raw, CLAIM_TOKEN_KEY, PLACEHOLDER_CLAIM_TOKEN, 0);
    });

    const { timers } = createFakeTimers();
    const { server: listener, lines } = await runMainListening(
      databasePath,
      { plugins: [ownerPlugin], timers },
      { PICKARR_READ_API_HOST: '127.0.0.1', PICKARR_PUBLIC_URL: PUBLIC_URL },
    );
    server = listener;
    assert.equal(
      server.host,
      '127.0.0.1',
      'the interface PICKARR_READ_API_HOST named, read back from the listener rather than from what was asked for',
    );

    assert.equal(
      lines.filter((line) => line.includes('no public url configured')).length,
      0,
      'PICKARR_PUBLIC_URL reached createAuth, which writes that warning only when it has none',
    );

    // A sign-up driven from the configured public origin, which is neither
    // `baseURL`'s bound address nor an origin `trustedOrigins` could place on
    // its own -- so a 200 here is PICKARR_PUBLIC_URL doing the only job it
    // has. Without it this is 403 and the deployment behind a proxy can
    // never sign in.
    const signUp = await fetch(`http://${server.host}:${server.port}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
      body: JSON.stringify({
        email: OWNER_EMAIL,
        password: PASSWORD,
        name: 'Placeholder Owner',
        claimToken: PLACEHOLDER_CLAIM_TOKEN,
      }),
    });
    assert.equal(signUp.status, 200, 'a request from the configured public origin is accepted, which is the whole of what PICKARR_PUBLIC_URL buys');
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty BETTER_AUTH_SECRET behaves exactly as an unset one, through the real boot path', async () => {
  // The other five variables `main` reads each have a test at this level
  // asserting exactly this ("an empty PICKARR_READ_API_HOST, ... is unset,
  // not configured emptiness", below) -- reading `resolveSettings`'s return
  // value, since each has an observable effect there. `BETTER_AUTH_SECRET`
  // has no such return value to read: its effect is only which secret
  // `createAuth` was given, which is observable only through a real cookie
  // round-trip. `auth/instance.test.ts` pins `resolveAuthSecret`'s own
  // behavior directly; this pins the call site in `main` that feeds it --
  // `configuredEnvValue(process.env['BETTER_AUTH_SECRET'])` -- which nothing
  // exercised until now.
  //
  // Two boots against the same on-disk database: the first with the
  // variable unset, so it generates and persists a secret and this test can
  // sign up and hold a cookie signed with it; the second with the variable
  // set to `''`. If `''` reached `createAuth` as a literal empty-string
  // secret rather than as `undefined`, the second boot would sign with a
  // different secret than the first persisted, and the first boot's cookie
  // would be refused by the second. Accepted is the only outcome that means
  // the empty variable was treated as unset -- exactly the property
  // `auth/instance.test.ts`'s own boot-to-boot test proves for a *truly*
  // unset variable across two boots of `resolveAuthSecret` directly; this is
  // that same proof, run through `main`'s real call site instead.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-secret-empty-'));
  let firstServer: ReadServer | undefined;
  let secondServer: ReadServer | undefined;
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath, (raw) => {
      writeHostState(raw, CLAIM_TOKEN_KEY, PLACEHOLDER_CLAIM_TOKEN, 0);
    });

    const first = createFakeTimers();
    const { server: booted } = await runMainListening(databasePath, { plugins: [], timers: first.timers });
    firstServer = booted;

    const signUp = await fetch(`http://${booted.host}:${booted.port}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://${booted.host}:${booted.port}` },
      body: JSON.stringify({
        email: OWNER_EMAIL,
        password: PASSWORD,
        name: 'Placeholder Owner',
        claimToken: PLACEHOLDER_CLAIM_TOKEN,
      }),
    });
    assert.equal(signUp.status, 200, 'sign-up against the first boot, which generated and persisted the secret this test checks survives');
    const cookie = cookieHeader(signUp);

    await firstServer.close();
    firstServer = undefined;

    const second = createFakeTimers();
    const { server: restarted } = await runMainListening(
      databasePath,
      { plugins: [], timers: second.timers },
      { BETTER_AUTH_SECRET: '' },
    );
    secondServer = restarted;

    const session = await fetch(`http://${restarted.host}:${restarted.port}/api/auth/get-session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 200, '200 with a body of null is what an unaccepted cookie answers, not 401 -- the design spec\'s §2 measured that');
    assert.ok(
      await session.json() !== null,
      'BETTER_AUTH_SECRET="" must resolve to the same secret as an unset one: a cookie the first boot issued was refused by the second',
    );
  } finally {
    await firstServer?.close();
    await secondServer?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Writes `document` to a temp config file, points `PICKARR_CONFIG` at it,
 * calls `resolveSettings`, and hands the result to `body` -- then cleans up
 * both the file and the environment variable, even when `body` rejects, so
 * one test's config file can never leak into the next.
 */
async function withConfigFile(
  document: Readonly<Record<string, unknown>>,
  body: (settings: HostSettings) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-settings-'));
  const path = join(dir, 'pickarr.config.json');
  await writeFile(path, JSON.stringify(document));
  const previous = process.env['PICKARR_CONFIG'];
  process.env['PICKARR_CONFIG'] = path;
  try {
    const settings = await resolveSettings(process.env);
    await body(settings);
  } finally {
    if (previous === undefined) delete process.env['PICKARR_CONFIG'];
    else process.env['PICKARR_CONFIG'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('the config file supplies host, port and database path when no variable does', async () => {
  await withConfigFile({ server: { host: '127.0.0.1', port: 9100 }, database: { path: '/tmp/from-file.db' } }, async (settings) => {
    assert.equal(settings.readHost, '127.0.0.1');
    assert.equal(settings.port, 9100);
    assert.equal(settings.databasePath, '/tmp/from-file.db');
  });
});

test('an environment variable beats the file', async (t) => {
  process.env['PICKARR_READ_API_PORT'] = '9200';
  process.env['PICKARR_DATABASE'] = '/tmp/from-env.db';
  t.after(() => { delete process.env['PICKARR_READ_API_PORT']; delete process.env['PICKARR_DATABASE']; });
  await withConfigFile({ server: { port: 9100 }, database: { path: '/tmp/from-file.db' } }, async (settings) => {
    assert.equal(settings.port, 9200, 'the variable must win');
    assert.equal(settings.databasePath, '/tmp/from-env.db', 'the variable must win');
  });
});

test('an empty PICKARR_READ_API_HOST, PICKARR_READ_API_PORT or PICKARR_DATABASE is unset, not configured emptiness', async (t) => {
  // A compose file that declares a key with no value passes exactly this --
  // not "the operator configured emptiness", but "the operator said
  // nothing" -- uniformly for `readHost`, `port` and `databasePath`, the
  // same rule `publicUrl` already applied on its own. `resolveSettings`'s
  // own comment carries the measurement this protects against: an empty
  // `PICKARR_READ_API_HOST` reaching the listener unchanged binds the IPv6
  // wildcard `::` where `0.0.0.0` is documented, on this Node.
  //
  // These two assertions replace ones this file used to make directly
  // against `resolveReadHost('')` and `resolveReadPort('')`, back when
  // those functions carried the "empty means unset" rule themselves. That
  // rule now lives one level up, in `resolveSettings`'s own
  // `configuredEnvValue`, in one function for all five variables rather
  // than duplicated per resolver -- so it is asserted here instead. The
  // fifth, `PICKARR_CONFIG`, has its own test below, because its effect is
  // not visible in the settings these three assert on.
  process.env['PICKARR_READ_API_HOST'] = '';
  process.env['PICKARR_READ_API_PORT'] = '';
  process.env['PICKARR_DATABASE'] = '';
  t.after(() => {
    delete process.env['PICKARR_READ_API_HOST'];
    delete process.env['PICKARR_READ_API_PORT'];
    delete process.env['PICKARR_DATABASE'];
  });

  await withConfigFile({ server: { host: '127.0.0.1', port: 9100 }, database: { path: '/tmp/from-file.db' } }, async (settings) => {
    assert.equal(settings.readHost, '127.0.0.1', 'empty is unset, so the file\'s value wins');
    assert.equal(settings.port, 9100, 'empty is unset, so the file\'s value wins');
    assert.equal(settings.databasePath, '/tmp/from-file.db', 'empty is unset, so the file\'s value wins');
  });

  await withConfigFile({}, async (settings) => {
    assert.equal(settings.readHost, '0.0.0.0', 'empty is unset, so the schema default applies with no file either');
    assert.equal(settings.port, 8787, 'empty is unset, so the schema default applies with no file either');
    assert.equal(settings.databasePath, '/config/pickarr.db', 'empty is unset, so the schema default applies with no file either');
  });
});

test('an empty PICKARR_CONFIG resolves to exactly the same file as an absent one', async () => {
  // The fifth variable, and the one the "empty is unset" rule was written
  // four times and missed: `readFile('')` rejects `ENOENT`, which
  // `readConfigDocument` reads as "no file on a first boot", so an empty
  // variable used to mean *there is no config file* rather than *use the
  // default one* -- an install whose `database.path` pointed elsewhere then
  // migrated and served a different database, with nothing logged as wrong.
  //
  // Asserted against `resolveConfigPath` rather than through
  // `resolveSettings`, because which file was opened is the one decision of
  // the five that the returned settings cannot show: on a machine without
  // `DEFAULT_CONFIG_PATH` both the empty and the absent case resolve to the
  // schema defaults either way, which is exactly why this went unnoticed.
  assert.equal(resolveConfigPath({}), DEFAULT_CONFIG_PATH, 'absent means the default file');
  assert.equal(resolveConfigPath({ PICKARR_CONFIG: '' }), DEFAULT_CONFIG_PATH, 'and empty is absent, not "no file at all"');
  assert.equal(
    resolveConfigPath({ PICKARR_CONFIG: '/tmp/pickarr-somewhere-else.config.json' }),
    '/tmp/pickarr-somewhere-else.config.json',
    'a variable the operator did set still decides the file',
  );

  // And the boot as a whole survives the empty value the same way it
  // survives the absent one, rather than throwing on an empty path.
  const empty = await resolveSettings({ PICKARR_CONFIG: '' });
  const absent = await resolveSettings({});
  assert.deepEqual(
    { host: empty.readHost, port: empty.port, database: empty.databasePath, secrets: empty.secretsBaseDir },
    { host: absent.readHost, port: absent.port, database: absent.databasePath, secrets: absent.secretsBaseDir },
  );
});

test('with neither a variable nor a file, the schema defaults apply', async () => {
  await withConfigFile({}, async (settings) => {
    assert.equal(settings.readHost, '0.0.0.0');
    assert.equal(settings.port, 8787);
    assert.equal(settings.databasePath, '/config/pickarr.db');
  });
});

test('a config file with a publicUrl carrying a path refuses the boot', async () => {
  await assert.rejects(
    () => withConfigFile({ server: { publicUrl: 'http://host/pickarr' } }, async () => {}),
    /publicUrl/,
    'the file must not be able to reintroduce the auth slice B1 failure',
  );
});

test('resolveReadHost reads PICKARR_READ_API_HOST, and validates the string an operator set', () => {
  // Taken as an argument rather than read from `process.env` inside, the same
  // way `resolveReadPort` is and for the same reason. `resolveSettings` is
  // what decides whether the operator said anything at all -- this function
  // is called only once that is already true, which is why it no longer has
  // an "unset" case of its own; `resolveSettings`'s own precedence tests
  // above cover that branch now.
  assert.equal(resolveReadHost('127.0.0.1'), '127.0.0.1', 'a configured interface passes through');
  assert.equal(resolveReadHost('::1'), '::1', 'including a v6 one: what can actually be bound is the listener\'s question, not this function\'s');
  assert.equal(DEFAULT_HOST, '0.0.0.0', 'and the default an unset variable leaves in place -- via the config file\'s own default now -- is every interface');
});

test('resolvePublicUrl reads PICKARR_PUBLIC_URL, and refuses anything that is not an http origin', () => {
  assert.equal(resolvePublicUrl(undefined), undefined, 'unset is the ordinary case: no proxy, and the bound address is the origin');
  assert.equal(resolvePublicUrl(''), undefined, 'and an empty variable is an unset one');
  assert.equal(resolvePublicUrl('https://pickarr.example'), 'https://pickarr.example');
  assert.equal(
    resolvePublicUrl('http://pickarr.example:8787/'),
    'http://pickarr.example:8787/',
    'a trailing slash is left alone here and normalized where it matters, by createAuth',
  );

  // Refused at boot rather than carried into `baseURL`, because the failure
  // it would otherwise cause is silent and total: Better Auth compares every
  // state-changing request's `Origin` against `baseURL`, so a malformed one
  // refuses every sign-in with 403 and nothing in the log says why -- on the
  // slice where a session is the only thing protecting the socket.
  //
  // **The last three are the case this test used to argue for and never
  // try.** A *relative* path does not parse and was refused by the scheme
  // check all along; an absolute url carrying a path -- which is what a
  // reverse proxy on a subpath looks like, and what a variable named `_URL`
  // rather than `_ORIGIN` invites -- parsed, passed, and became Better Auth's
  // `baseURL`. Measured with `baseURL = http://127.0.0.1:<port>/pickarr`:
  // every auth route answers 404 on the path `api/server.ts` forwards, so
  // sign-in, sign-up and sign-out are all unreachable, while `/api/health`
  // answers 200 and a container health check calls the host healthy. A query
  // string and a fragment do exactly the same thing, measured the same way,
  // which is why an origin rather than a pathname is what this enforces.
  const refused = [
    'pickarr.example',
    'pickarr.example:8787',
    'myapp://pickarr',
    '/pickarr',
    'http://',
    'http://pickarr.example/pickarr',
    'https://pickarr.example:8787/pickarr/',
    'http://pickarr.example/?x=1',
    'http://pickarr.example/#frag',
  ];
  for (const bad of refused) {
    assert.throws(
      () => resolvePublicUrl(bad),
      // A validator rather than a regex, because two properties are being
      // pinned and the second is this branch's own constraint: the refusal
      // names the variable and the rule it broke, and **never the value**. A
      // boot that dies on an unreadable environment variable is precisely
      // where a url would otherwise reach a log.
      (error: unknown) => {
        assert.ok(error instanceof Error, 'a refusal is an Error');
        assert.match(error.message, /^PICKARR_PUBLIC_URL /, 'the refusal names the variable first');
        assert.ok(
          !error.message.includes(bad),
          'the refusal quotes the configured value, which no message this repo emits may carry',
        );
        return true;
      },
      `${bad} must be refused at boot, not carried into baseURL`,
    );
  }
});

test('resolveReadPort reads PICKARR_READ_API_PORT, and refuses anything that is not a port', () => {
  // Taken as an argument rather than read from `process.env` inside, so this
  // asserts validation without mutating the environment every other test in
  // this process shares. The "unset means DEFAULT_PORT" branch this test used
  // to assert is gone along with the function's own default: `resolveSettings`
  // now decides whether the operator said anything at all, and calls this
  // only once that is already true -- `schemas.test.ts` asserts the default
  // that now lives solely in `serverConfigSchema`, and the precedence tests
  // above assert `resolveSettings` reaches for it, so DEFAULT_PORT here is
  // only the value both must resolve to.
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

test('resolveOpenmetadataUrl defaults, and refuses what is not an origin', () => {
  assert.equal(resolveOpenmetadataUrl(undefined), 'https://openmetadata.nexus');
  assert.equal(resolveOpenmetadataUrl(''), 'https://openmetadata.nexus');
  assert.equal(resolveOpenmetadataUrl('https://metadata.example.test'), 'https://metadata.example.test');
  // A trailing slash is trimmed, so nothing downstream builds a double slash.
  assert.equal(resolveOpenmetadataUrl('https://metadata.example.test/'), 'https://metadata.example.test');
  assert.throws(() => resolveOpenmetadataUrl('metadata.example.test'), /PICKARR_OPENMETADATA_URL/);
  assert.throws(() => resolveOpenmetadataUrl('https://metadata.example.test/api'), /PICKARR_OPENMETADATA_URL/);
});

test('resolveOpenmetadataUrl refuses credentials in the url rather than silently dropping them', () => {
  // `parsed.origin` discards userinfo, so this used to be accepted and then
  // stripped: the operator's `Authorization` never travelled, every lookup
  // answered 401, and nothing anywhere said why. Refused instead, on the
  // branch whose headline invariant is that a credential is never logged.
  assert.throws(
    () => resolveOpenmetadataUrl('https://svc:s3cret@proxy.internal'),
    /PICKARR_OPENMETADATA_URL/,
  );
  assert.throws(
    () => resolveOpenmetadataUrl('https://svc@proxy.internal'),
    /PICKARR_OPENMETADATA_URL/,
  );
});

test('no resolveOpenmetadataUrl refusal names the value it refused', () => {
  // The same rule `resolvePublicUrl` is held to thirty lines above it, and
  // the reason this one needs its own test: a url may carry userinfo, so
  // interpolating the configured value into a boot-time failure prints a
  // credential into the log.
  const refused = [
    'metadata.example.test',
    'myapp://metadata.example.test',
    'https://metadata.example.test/api',
    'https://metadata.example.test/?x=1',
    'https://metadata.example.test/#frag',
    'https://svc:s3cret@proxy.internal',
  ];
  for (const bad of refused) {
    assert.throws(
      () => resolveOpenmetadataUrl(bad),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'a refusal is an Error');
        assert.match(error.message, /^PICKARR_OPENMETADATA_URL /, 'the refusal names the variable first');
        assert.ok(
          !error.message.includes(bad),
          'the refusal quotes the configured value, which no message this repo emits may carry',
        );
        return true;
      },
    );
  }
});

test('a boot with no lookup key says so, and still boots', async () => {
  // §2.3 resolves the key per request, deliberately, and that stands -- but
  // per-request resolution means a deployment that never set the variable
  // starts cleanly, schedules every feed, and only discovers the problem
  // minutes later as a dead-lettered lookup job per item. This is the
  // likeliest field misconfiguration there is, and one line at boot is the
  // difference between five minutes and an afternoon.
  //
  // Asked through the secret store rather than of one variable: an operator
  // who put the key in the secrets directory or the `secret` table is
  // configured, and a check that only knew the environment would warn at
  // them anyway. The resolved value is discarded unread, and no line names
  // it. Warning rather than fatal, because a host that serves reads with one
  // plugin misconfigured is the right behaviour.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-keyless-'));
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath, insertOwner);

    const { timers } = createFakeTimers();
    // No `plugins`, so `main` builds the three real ones -- which is the
    // only case where the key matters at all.
    const lines = await runMain(databasePath, {
      timers,
      createReadServer: async () => fakeServer(() => {}),
    });

    const warned = lines.filter((line) => line.includes(envNameFor(API_KEY_SECRET)));
    assert.equal(warned.length, 1, 'exactly one line names the variable to set');
    assert.equal(
      lines.some((line) => line.includes('running: database')),
      true,
      'and the host still finished booting: a missing key is one plugin misconfigured, not a dead process',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a boot whose key is present says nothing about it, and neither does one with injected plugins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-main-keyed-'));
  try {
    const databasePath = join(dir, 'pickarr.db');
    seedDatabase(databasePath, insertOwner);

    const { timers } = createFakeTimers();
    const keyed = await runMain(
      databasePath,
      { timers, createReadServer: async () => fakeServer(() => {}) },
      // An obviously synthetic placeholder, set through the store's own
      // environment link. The only thing asserted about it is that no line
      // mentions the variable at all.
      { [envNameFor(API_KEY_SECRET)]: 'placeholder-not-a-real-key' },
    );
    assert.equal(
      keyed.some((line) => line.includes(envNameFor(API_KEY_SECRET))),
      false,
      'a configured deployment gets no warning -- and no line naming the variable can carry its value',
    );

    // And a test that injects its own plugins never constructed the real
    // ones, so there is nothing for the key to be missing from.
    const injected = await runMain(databasePath, {
      plugins: [],
      timers,
      createReadServer: async () => fakeServer(() => {}),
    });
    assert.equal(
      injected.some((line) => line.includes('PICKARR_OPENMETADATA_KEY')),
      false,
      'no plugin asked for the key, so nothing warns about it',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shippedPlugins builds one plugin per media type, each with its own prefix', () => {
  const plugins = shippedPlugins({
    now: () => 0,
    resolveSecret: async () => 'test-key',
    baseUrl: 'https://openmetadata.test',
  });

  assert.deepEqual(plugins.map((plugin) => plugin.id), ['tv', 'movie', 'xxx']);
  assert.deepEqual(plugins.map((plugin) => plugin.mediaType), ['tv', 'movie', 'xxx']);
  // Migration 1 is the engine's state table; each plugin adds its own at 2.
  for (const plugin of plugins) {
    assert.deepEqual(plugin.migrations.map((migration) => migration.version), [1, 2]);
  }
});
