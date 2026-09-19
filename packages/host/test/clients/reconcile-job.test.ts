import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createHost, HOST_PLUGIN_ID } from '../../src/host.ts';
import type { Host } from '../../src/host.ts';
import { scheduleKnownDownloadClients } from '../../src/main.ts';
import { buildReconcileAdapter, createReconcileHandler, RECONCILE_INTERVAL_S } from '../../src/clients/reconcile-job.ts';
import { readClientConfig } from '../../src/clients/config.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import type { Secrets } from '../../src/secrets/instance.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';
import type { Timers } from '../../src/jobs/dispatcher.ts';
import type { DownloadClients, JobQueue, PluginContext } from '@pickarr/contract';

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

/** No test here attaches artwork, so this directory is never created or read. */
const unusedArtworkDir = '/nonexistent/pickarr-reconcile-job-test-artwork-unused';

/**
 * The `secret` name every seeded client row carries, and the api key behind
 * it. A row holds the name; `makeSecrets` puts the value in the `secret`
 * table, which is where `readClientConfig` resolves it from. The value is a
 * fixed fake, so nothing real can reach a failure diff.
 */
const CLIENT_API_KEY_SECRET = '00000000-0000-4000-8000-000000000001';
const CLIENT_API_KEY = 'test-key';

/**
 * A real secrets subsystem over this database, with the seeded clients' api
 * key already saved. `baseDir` does not exist, so the chain's file link finds
 * nothing and every value comes from the `secret` table.
 */
function makeSecrets(raw: DatabaseSync): Secrets {
  const secrets = createSecrets({ raw, baseDir: '/nonexistent/pickarr-reconcile-job-test-secrets' });
  secrets.saveSecret(CLIENT_API_KEY_SECRET, CLIENT_API_KEY);
  return secrets;
}

/**
 * A `QueuedFetch` double whose `json` is whatever the test supplies, the
 * same shape `sabnzbd.test.ts`'s own `fakeQueuedFetch` builds.
 */
function fakeQueuedFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>): QueuedFetch {
  return {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      const body: unknown = await handler(url, init);
      return body as T;
    },
    bytes(): Promise<Uint8Array> {
      throw new Error('bytes is not used by these tests');
    },
    text(): Promise<string> {
      throw new Error('text is not used by these tests');
    },
  };
}

function isQueueRequest(url: string): boolean {
  return url.includes('mode=queue');
}

/**
 * A SABnzbd-shaped `QueuedFetch`, answering `queue` with `queueSlots` and
 * `history` with `historySlots` -- everything `createSabnzbdClient`'s own
 * `snapshot()` needs, and nothing this module's handler could tell apart
 * from a real installation reporting the same two lists.
 */
function sabnzbdFetch(opts: {
  queueSlots?: readonly Record<string, unknown>[];
  historySlots?: readonly Record<string, unknown>[];
}): QueuedFetch {
  const queueSlots = opts.queueSlots ?? [];
  const historySlots = opts.historySlots ?? [];
  return fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) {
      return { queue: { noofslots: queueSlots.length, slots: queueSlots } };
    }
    return { history: { noofslots: historySlots.length, slots: historySlots } };
  });
}

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
 * same fake `host.test.ts` and `main.test.ts` each build for their own use
 * -- duplicated here rather than imported, since no file in this package
 * shares a test-support module with another.
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
    setInterval() {
      return ++nextHandle;
    },
    clearInterval() {},
  };
  return { timers, setTimeoutCalls };
}

/** Fires the most recently armed timer, then waits for the dispatched job (and anything it enqueues) to finish. Mirrors `host.test.ts`'s own `runDue`. */
async function runDue(host: Host, setTimeoutCalls: TimerCall[]): Promise<void> {
  const fire = setTimeoutCalls.at(-1)?.fn;
  assert.ok(fire, 'no timer was armed for a due job');
  fire();
  await host.idle();
}

function setup(overrides?: { fetch?: QueuedFetch; now?: () => number }) {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const { timers, setTimeoutCalls } = createFakeTimers();
  const host = createHost({
    raw,
    db,
    fetch: overrides?.fetch ?? unusedFetch,
    downloads: () => unusedDownloads,
    secrets: makeSecrets(raw),
    now: overrides?.now ?? (() => 1000),
    artworkDir: unusedArtworkDir,
    timers,
  });
  return { raw, host, setTimeoutCalls };
}

/** Inserts one sabnzbd `download_client` row and returns its id. */
function insertClient(raw: DatabaseSync, overrides: {
  name?: string;
  category?: string;
  type?: string;
  implementation?: string;
} = {}): number {
  const name = overrides.name ?? 'Client';
  const category = overrides.category ?? 'movies';
  const type = overrides.type ?? 'nzb';
  const implementation = overrides.implementation ?? 'sabnzbd';
  raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key_secret_name, username, password_secret_name,
       category, import_mode, created_at, updated_at)
    VALUES (?, ?, ?, 'https://client.example.com', ?, NULL, NULL, ?, 'copy', 1, 1)
  `).run(name, type, implementation, CLIENT_API_KEY_SECRET, category);
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(name);
  return Number((inserted as { id: unknown }).id);
}

/** Inserts one `rss_feed` and one `rss_item` row and returns the item's id -- the foreign key `nzb_download` requires. */
function seedRssItem(raw: DatabaseSync, name: string): number {
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', ?, ?, 1, 1)
  `).run(name, `https://example.test/${name}`);
  const feedId = Number((raw.prepare('SELECT id FROM rss_feed WHERE name = ?').get(name) as { id: unknown }).id);
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, ?, ?, 1, 1, 'nzb', 'pending')
  `).run(feedId, `${name}.mkv`, `https://example.test/${name}.mkv`);
  return Number(result.lastInsertRowid);
}

/** Inserts one `nzb_download` row and returns its id. */
function insertNzbRow(
  raw: DatabaseSync,
  params: { rssItemId: number; downloadClientId: number; clientRef?: string | null; status?: string },
): number {
  const status = params.status ?? 'submitted';
  const result = raw.prepare(`
    INSERT INTO nzb_download (rss_item_id, download_client_id, client_ref, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run(params.rssItemId, params.downloadClientId, params.clientRef ?? null, status);
  return Number(result.lastInsertRowid);
}

/** Reads one raw column back off `nzb_download`, for assertions that must not trust the module under test. */
function readNzbColumn(raw: DatabaseSync, id: number, column: string): unknown {
  const row = raw.prepare(`SELECT ${column} FROM nzb_download WHERE id = ?`).get(id) as Record<string, unknown>;
  return row[column];
}

/** Every `reconcile` job row the host currently holds, with its payload's `clientId` parsed out for filtering. */
function reconcileJobRows(raw: DatabaseSync): { id: number; clientId: number; state: string; runAt: number; attempts: number }[] {
  return raw.prepare(`
    SELECT id, payload_json, state, run_at, attempts FROM jobs WHERE plugin_id = ? AND kind = 'reconcile'
  `).all(HOST_PLUGIN_ID).map((row) => {
    const payload = JSON.parse(String((row as { payload_json: unknown }).payload_json)) as { clientId: unknown };
    return {
      id: Number((row as { id: unknown }).id),
      clientId: Number(payload.clientId),
      state: String((row as { state: unknown }).state),
      runAt: Number((row as { run_at: unknown }).run_at),
      attempts: Number((row as { attempts: unknown }).attempts),
    };
  });
}

test('a tick advances a row and re-enqueues itself', async () => {
  const clock = createClock(1000);
  const fetch = sabnzbdFetch({
    queueSlots: [{ nzo_id: 'ref-1', filename: 'x.mkv', percentage: '10', cat: 'movies' }],
  });
  const { raw, host, setTimeoutCalls } = setup({ fetch, now: clock.now });

  const clientId = insertClient(raw);
  const rssItemId = seedRssItem(raw, 'x');
  const rowId = insertNzbRow(raw, { rssItemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'submitted' });

  await host.scheduleReconcile(clientId, 1000);

  // Advance the clock between scheduling and running, the same way
  // `host.test.ts`'s own poll-reschedule test does: asserting against the
  // clock's value AT EXECUTION is what proves the reschedule is computed
  // from "now", not from a stale value.
  clock.set(5000);
  host.start();
  await runDue(host, setTimeoutCalls);

  assert.equal(
    readNzbColumn(raw, rowId, 'status'),
    'downloading',
    'the row must advance from submitted to downloading once the client reports it in its queue',
  );

  const ready = reconcileJobRows(raw).filter((r) => r.clientId === clientId && r.state === 'ready');
  assert.equal(ready.length, 1, 'exactly one rescheduled reconcile job must remain for this client');
  assert.equal(
    ready[0]?.runAt,
    5000 + RECONCILE_INTERVAL_S * 1000,
    'run_at must be execution-time now() plus the reconcile interval',
  );
});

test('a tick whose snapshot throws does not re-enqueue, and lets the dispatcher retry the same row', async () => {
  // A qBittorrent client, not SABnzbd: `createSabnzbdClient`'s own
  // `snapshot()` deliberately swallows a failed queue or history request
  // into an incomplete snapshot rather than throwing (`sabnzbd.ts`'s
  // `fetchHistoryPages`), precisely so a transient failure never crashes
  // the walk. qBittorrent's `snapshot()` has no such catch -- `guardAuthFailure`
  // rethrows anything that is not a 401/403 -- so a plain network failure
  // here reaches this handler as a real rejection, which is what this test
  // needs to exist at all.
  const fetch: QueuedFetch = {
    json: async () => { throw new Error('qbittorrent unreachable'); },
    bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
    text: async () => { throw new Error('fetch.text: not used by this test'); },
  };
  const { raw, host, setTimeoutCalls } = setup({ fetch });

  const clientId = insertClient(raw, { type: 'torrent', implementation: 'qbittorrent' });
  await host.scheduleReconcile(clientId);

  host.start();
  await runDue(host, setTimeoutCalls);

  const rows = reconcileJobRows(raw).filter((r) => r.clientId === clientId);
  // Exactly the original job: a reschedule computed before the throw (rather
  // than after a successful tick) would leave a second row behind here --
  // the same double-cycle `host.ts`'s own `pollHandler` refuses to create.
  assert.equal(rows.length, 1, 'a failed tick must not also have scheduled a next one');
  assert.equal(rows[0]?.state, 'ready', 'a first failure must retry through the dispatcher\'s own backoff, not dead-letter');
  assert.equal(rows[0]?.attempts, 1);
  // 2000 is now (1000) plus 1000 -- `backoffMs(1)` from `../src/jobs/backoff.ts`
  // -- hardcoded rather than computed by calling that function, the same
  // reasoning `host.test.ts`'s own throwing-poll test gives.
  assert.equal(rows[0]?.runAt, 2000, 'run_at must be the failure time plus the first backoff step');
});

test('scheduling is idempotent per client', async () => {
  const { raw, host } = setup();
  const clientId = insertClient(raw);

  const first = await host.scheduleReconcile(clientId);
  const second = await host.scheduleReconcile(clientId);

  assert.equal(second, first, 'the second call must report the existing job, not create a new one');
  const rows = reconcileJobRows(raw).filter((r) => r.clientId === clientId);
  assert.equal(rows.length, 1, 'exactly one reconcile job must exist for this client after two scheduleReconcile calls');
});

test('a client whose row is gone does not re-enqueue', async () => {
  const { raw, host, setTimeoutCalls } = setup();

  const clientId = insertClient(raw);
  await host.scheduleReconcile(clientId);
  raw.prepare('DELETE FROM download_client WHERE id = ?').run(clientId);

  // `fetch` is `unusedFetch` here (`setup`'s own default): a correct
  // implementation reads the client row before doing any work and never
  // reaches the network at all for a client that is gone.
  host.start();
  await runDue(host, setTimeoutCalls);

  const rows = reconcileJobRows(raw).filter((r) => r.clientId === clientId);
  assert.equal(rows.length, 1, 'no new job was created for a deleted client');
  assert.equal(rows[0]?.state, 'done', 'the job must succeed quietly, not dead-letter or retry against a row that is gone');
});

/** A `Host` whose every method fails loudly if a test never meant to reach it. Mirrors `main.test.ts`'s own `fakeHost`. */
function fakeHost(overrides: Partial<Host>): Host {
  return {
    register: () => { throw new Error('register: not used by this test'); },
    notifyNewRssItems: async () => { throw new Error('notifyNewRssItems: not used by this test'); },
    requestDownload: async () => { throw new Error('requestDownload: not used by this test'); },
    deliverToPlugin: async () => { throw new Error('deliverToPlugin: not used by this test'); },
    schedulePoll: () => { throw new Error('schedulePoll: not used by this test'); },
    scheduleReconcile: async () => { throw new Error('scheduleReconcile: not used by this test'); },
    addFeed: async () => { throw new Error('addFeed: not used by this test'); },
    addDownloadClient: async () => { throw new Error('addDownloadClient: not used by this test'); },
    start: () => { throw new Error('start: not used by this test'); },
    stop: () => { throw new Error('stop: not used by this test'); },
    idle: async () => { throw new Error('idle: not used by this test'); },
    ...overrides,
  };
}

test('main schedules one reconcile job per configured client', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const scheduled: number[] = [];
  const host = fakeHost({
    scheduleReconcile: async (clientId) => {
      scheduled.push(clientId);
      return clientId;
    },
  });

  assert.deepEqual(
    await scheduleKnownDownloadClients(host, raw),
    [],
    'a database with no download clients schedules nothing, and does not throw',
  );
  assert.deepEqual(scheduled, []);

  const idA = insertClient(raw, { name: 'A' });
  const idB = insertClient(raw, { name: 'B' });

  const result = await scheduleKnownDownloadClients(host, raw);

  assert.deepEqual(result, [idA, idB], 'returns every download client id it scheduled');
  assert.deepEqual(scheduled, [idA, idB], 'called scheduleReconcile once per download client row');
});

// --- The reclaim capability's own seam -------------------------------------
//
// `buildReconcileAdapter` is where a client kind becomes a reclaim
// capability or does not, and until these tests it was the one link in that
// chain nothing asserted. `qbittorrent.test.ts` proves
// `createQbittorrentClient` returns no `remove`; `deliver.test.ts` proves
// reclaim skips a `DeliverDeps` without one. Neither said what this
// composition does in between, so a `remove` added to the torrent branch --
// which would delete torrents, stopping the seed and abandoning the ratio
// that this slice's design forbids losing -- changed no test's outcome at
// all. The type now refuses to compile with one; these pin the behaviour
// either side of it.

/** Inserts one `rss_feed`/`rss_item` pair for a torrent download and returns the item's id. */
function seedTorrentRssItem(raw: DatabaseSync, name: string): number {
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', ?, ?, 1, 1)
  `).run(name, `https://example.test/${name}`);
  const feedId = Number((raw.prepare('SELECT id FROM rss_feed WHERE name = ?').get(name) as { id: unknown }).id);
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, ?, ?, 1, 1, 'torrent', '1080p')
  `).run(feedId, `${name}.mkv`, `https://example.test/${name}.mkv`);
  return Number(result.lastInsertRowid);
}

/** Inserts one `torrent_download` row, `delivered` and unreclaimed unless told otherwise, and returns its id. */
function insertTorrentRow(
  raw: DatabaseSync,
  params: {
    rssItemId: number;
    downloadClientId: number;
    clientRef?: string | null;
    status?: string;
    deliveredAt?: number | null;
  },
): number {
  const result = raw.prepare(`
    INSERT INTO torrent_download
      (rss_item_id, download_client_id, client_ref, status, delivered_at, reclaimed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, 1, 1)
  `).run(
    params.rssItemId,
    params.downloadClientId,
    params.clientRef ?? null,
    params.status ?? 'delivered',
    params.deliveredAt ?? 800,
  );
  return Number(result.lastInsertRowid);
}

/** Reads one raw column back off `torrent_download`, for assertions that must not trust the module under test. */
function readTorrentColumn(raw: DatabaseSync, id: number, column: string): unknown {
  const row = raw.prepare(`SELECT ${column} FROM torrent_download WHERE id = ?`).get(id) as Record<string, unknown>;
  return row[column];
}

test('the adapter built for a torrent client carries no reclaim capability at all', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const clientId = insertClient(raw, { name: 'Torrents', type: 'torrent', implementation: 'qbittorrent' });

  // The real config path, not a hand-written literal: `readClientConfig` is
  // what decides `kind`, and the point of this test is what
  // `buildReconcileAdapter` does with the kind a real row produces.
  const config = await readClientConfig(raw, clientId, makeSecrets(raw));
  assert.equal(config.kind, 'qbittorrent-bearer', 'a torrent row with an api key must read as the bearer kind');

  const adapter = buildReconcileAdapter(config, unusedFetch);

  assert.equal(adapter.transport, 'torrent');
  // `hasOwn`, not `adapter.remove === undefined`: the property must be
  // absent, not present and undefined -- `deliverCompleted` reads
  // "`deps.remove` is present", and `exactOptionalPropertyTypes` makes those
  // two different facts.
  assert.equal(
    Object.hasOwn(adapter, 'remove'),
    false,
    'a torrent adapter must have no remove property -- qBittorrent has no delete that keeps the seed alive',
  );
});

test('the adapter built for an nzb client does carry one', async () => {
  // The other side of the same seam: without this, deleting the `remove`
  // from the nzb branch would pass the test above and reclaim nothing,
  // forever, with SABnzbd's history and its files growing for the lifetime
  // of the installation.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const clientId = insertClient(raw, { name: 'Nzbs' });

  const config = await readClientConfig(raw, clientId, makeSecrets(raw));
  assert.equal(config.kind, 'sabnzbd');

  const adapter = buildReconcileAdapter(config, unusedFetch);

  assert.equal(adapter.transport, 'nzb');
  assert.equal(Object.hasOwn(adapter, 'remove'), true, 'an nzb adapter must be able to reclaim');
});

test('a torrent client run through the whole handler reclaims nothing', async () => {
  // The composition end to end, not the seam: a `delivered` torrent whose
  // `reclaimed_at` is null is exactly the row a reclaim pass would act on,
  // and this asserts the whole handler leaves it alone. A `remove` on the
  // torrent branch would stamp it here.
  const requestedUrls: string[] = [];
  const fetch = fakeQueuedFetch(async (url) => {
    requestedUrls.push(url);
    // qBittorrent's `/torrents/info` answers with an array; an empty one is
    // a client holding nothing, which is what makes this row's survival
    // about reclaim rather than about the walk.
    return [];
  });
  const { raw, host, setTimeoutCalls } = setup({ fetch, now: () => 900 });

  const clientId = insertClient(raw, { name: 'Torrents', type: 'torrent', implementation: 'qbittorrent' });
  const itemId = seedTorrentRssItem(raw, 'torrented');
  const rowId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'hash-1' });

  await host.scheduleReconcile(clientId);
  host.start();
  await runDue(host, setTimeoutCalls);

  assert.equal(
    readTorrentColumn(raw, rowId, 'reclaimed_at'),
    null,
    'a torrent must never be reclaimed -- the stamp is what proves a delete was called and confirmed',
  );
  assert.equal(readTorrentColumn(raw, rowId, 'status'), 'delivered', 'the row is otherwise untouched');
  assert.deepEqual(
    requestedUrls,
    ['https://client.example.com/api/v2/torrents/info'],
    'the tick asks the client what it holds and nothing else -- no delete url of any shape',
  );
});

test('an nzb client run through the whole handler does reclaim, on the same row shape', async () => {
  // The control for the test above. Both rows are `delivered` with a null
  // `reclaimed_at`; the only difference is the client's transport, so this
  // is what makes "reclaims nothing" a statement about torrents rather than
  // about the handler never reclaiming anything at all.
  const deleteUrls: string[] = [];
  const fetch = fakeQueuedFetch(async (url) => {
    if (url.includes('name=delete')) {
      deleteUrls.push(url);
      return { status: true };
    }
    if (isQueueRequest(url)) return { queue: { noofslots: 0, slots: [] } };
    return { history: { noofslots: 0, slots: [] } };
  });
  const { raw, host, setTimeoutCalls } = setup({ fetch, now: () => 900 });

  const clientId = insertClient(raw, { name: 'Nzbs' });
  const itemId = seedRssItem(raw, 'nzbed');
  const rowId = insertNzbRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'nzo-1' });
  raw.prepare("UPDATE nzb_download SET status = 'delivered', delivered_at = 800 WHERE id = ?").run(rowId);

  await host.scheduleReconcile(clientId);
  host.start();
  await runDue(host, setTimeoutCalls);

  assert.equal(readNzbColumn(raw, rowId, 'reclaimed_at'), 900, 'the nzb row is reclaimed at the tick\'s own now()');
  assert.equal(deleteUrls.length, 1, 'exactly one delete, for the one unreclaimed delivered row');
  assert.match(deleteUrls[0] ?? '', /value=nzo-1/, 'the delete names this row\'s own client ref');
});

// --- The tick's own summary line -------------------------------------------
//
// `walkSnapshot` and `deliverCompleted` both return counts, and both returns
// were discarded: every counter in this slice was computed on every tick and
// visible only to a test. `reclaimFailures` in particular was added because
// "a client refusing every delete looks identical to a client with nothing
// left to reclaim if all you have is `reclaimed: 0`" -- and nobody outside a
// test had `reclaimed: 0` either. These drive the handler directly rather
// than through `createHost`, because `hostLog` writes to `console` and the
// point is to assert the line's *values*, not that something was printed.

/** One `deps.log` call, as `captureLog` below records it. */
interface LoggedLine {
  message: string;
  detail: Readonly<Record<string, unknown>> | undefined;
}

/** A `log` that records every call, and the array it records into. */
function captureLog(): {
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  lines: LoggedLine[];
} {
  const lines: LoggedLine[] = [];
  return {
    log: (message, detail) => { lines.push({ message, detail }); },
    lines,
  };
}

/** A `MediaWriter` method that fails loudly, naming itself, if a test ever reaches it. */
function unusedMediaCall(name: string): () => never {
  return () => { throw new Error(`ctx.media.${name}: not used by this test`); };
}

/** The same, for `ctx.read` -- whose methods return promises, so these reject rather than throw synchronously. */
function unusedReadCall(name: string): () => Promise<never> {
  return async () => { throw new Error(`ctx.read.${name}: not used by this test`); };
}

/**
 * A `PluginContext` whose every member fails loudly except `jobs`, which is
 * all this handler actually uses -- it passes `ctx.jobs` to
 * `scheduleReconcile` and touches nothing else on the context. The same
 * "fails loudly if a test never meant to reach it" shape as `unusedFetch`
 * and `unusedDownloads` above.
 */
function fakeContext(jobs: JobQueue): PluginContext {
  return {
    db: undefined,
    media: {
      createMediaItem: unusedMediaCall('createMediaItem'),
      updateMediaItem: unusedMediaCall('updateMediaItem'),
      claimProviderRef: unusedMediaCall('claimProviderRef'),
      relinkRssItem: unusedMediaCall('relinkRssItem'),
      dropMediaItem: unusedMediaCall('dropMediaItem'),
      attachPoster: unusedMediaCall('attachPoster'),
      attachBackground: unusedMediaCall('attachBackground'),
      attachLogo: unusedMediaCall('attachLogo'),
      upsertPerson: unusedMediaCall('upsertPerson'),
      attachRole: unusedMediaCall('attachRole'),
      setResolution: unusedMediaCall('setResolution'),
    },
    read: {
      mediaItem: unusedReadCall('mediaItem'),
      mediaItemByProviderRef: unusedReadCall('mediaItemByProviderRef'),
      rssItemsFor: unusedReadCall('rssItemsFor'),
      downloadsFor: unusedReadCall('downloadsFor'),
    },
    jobs,
    fetch: {
      json: async () => { throw new Error('ctx.fetch.json: not used by this test'); },
      bytes: async () => { throw new Error('ctx.fetch.bytes: not used by this test'); },
    },
    downloads: unusedDownloads,
    log: () => { throw new Error('ctx.log: not used by this test -- the handler logs through its own deps.log'); },
  };
}

/** A `JobQueue` that hands back a fixed id and records nothing -- the reschedule is not what these tests are about. */
const countingJobs: JobQueue = { enqueue: async () => 1 };

/** Runs the reconcile handler once, outside the dispatcher, and returns whatever it logged. */
async function runHandlerOnce(
  raw: DatabaseSync,
  clientId: number,
  fetch: QueuedFetch,
  now = 900,
): Promise<LoggedLine[]> {
  const { log, lines } = captureLog();
  const handler = createReconcileHandler({
    raw,
    fetch,
    secrets: makeSecrets(raw),
    now: () => now,
    log,
    deliver: async () => { throw new Error('deliver: not used by this test'); },
  });
  await handler(
    { id: 7, kind: 'reconcile', payload: { clientId }, attempts: 1 },
    fakeContext(countingJobs),
  );
  return lines;
}

/** The one `reconcile tick` line in `lines`, or `undefined` when the tick logged no summary at all. */
function summaryLine(lines: readonly LoggedLine[]): LoggedLine | undefined {
  const summaries = lines.filter((line) => line.message === 'reconcile tick');
  assert.ok(summaries.length <= 1, 'a tick must log at most one summary line');
  return summaries[0];
}

test('a tick logs one summary line carrying its non-zero counters by value', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const clientId = insertClient(raw);
  const itemId = seedRssItem(raw, 'x');
  insertNzbRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'submitted' });

  const lines = await runHandlerOnce(raw, clientId, sabnzbdFetch({
    queueSlots: [
      // Advances the row above: submitted -> downloading, `advanced: 1`.
      { nzo_id: 'ref-1', filename: 'x.mkv', percentage: '10', cat: 'movies' },
      // Matches no row of ours: `untracked: 1`.
      { nzo_id: 'ref-2', filename: 'someone-elses.mkv', percentage: '50', cat: 'movies' },
    ],
  }));

  assert.deepEqual(
    summaryLine(lines),
    { message: 'reconcile tick', detail: { clientId, advanced: 1, untracked: 1 } },
    'the summary must name the client and carry each non-zero counter at its actual value',
  );
});

test('a tick that did nothing logs no summary at all', async () => {
  // The other half of the choice `logTickSummary` argues: a settled client
  // ticks once a minute forever, and a line printed on every one of those
  // ticks is a line an operator learns to skip past.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const clientId = insertClient(raw);

  const lines = await runHandlerOnce(raw, clientId, sabnzbdFetch({}));

  assert.equal(summaryLine(lines), undefined, 'an empty client with no rows must produce no summary line');
});

test('the summary carries the delivery pass\'s own counters, not only the walk\'s', async () => {
  // `deliverCompleted`'s result was discarded separately from
  // `walkSnapshot`'s, so this pins that both halves reach the same line. A
  // `completed` row the client reported no path for is the cheapest
  // delivery counter to produce: it needs no plugin, no stat and no
  // filesystem.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const clientId = insertClient(raw);
  const itemId = seedRssItem(raw, 'y');
  const rowId = insertNzbRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-9' });
  raw.prepare("UPDATE nzb_download SET status = 'completed', storage_path = NULL WHERE id = ?").run(rowId);

  const lines = await runHandlerOnce(raw, clientId, sabnzbdFetch({}));

  assert.deepEqual(
    summaryLine(lines),
    // `absent: 1` travels with it: a complete snapshot that does not
    // account for this row's ref is exactly the absence observation the
    // sweep records, and the summary reports it rather than choosing which
    // of the two facts an operator wanted.
    { message: 'reconcile tick', detail: { clientId, absent: 1, undeliverable: 1 } },
    'a counter from the delivery pass must reach the same line as the walk\'s own',
  );
});
