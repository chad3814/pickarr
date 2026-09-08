import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createHost, HOST_PLUGIN_ID } from '../../src/host.ts';
import type { Host } from '../../src/host.ts';
import { scheduleKnownDownloadClients } from '../../src/main.ts';
import { RECONCILE_INTERVAL_S } from '../../src/clients/reconcile-job.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';
import type { Timers } from '../../src/jobs/dispatcher.ts';
import type { DownloadClients } from '@pickarr/contract';

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
    downloads: unusedDownloads,
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
      (name, type, implementation, url, api_key, username, password, category, import_mode, created_at, updated_at)
    VALUES (?, ?, ?, 'https://client.example.com', 'test-key', NULL, NULL, ?, 'copy', 1, 1)
  `).run(name, type, implementation, category);
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
