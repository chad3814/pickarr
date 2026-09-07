import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createDownloadClients } from '../../src/clients/downloads.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/** A no-op log, for tests that have nothing to assert about it. */
function noLog(): void {}

/**
 * A `QueuedFetch` double whose `json`/`text` are whichever handlers a test
 * supplies; whichever one is omitted still exists, but throws loudly if
 * anything under test ever reaches it -- the same idiom `sabnzbd.test.ts`
 * and `qbittorrent.test.ts` use.
 */
function fakeFetch(handlers: {
  json?: (url: string, init?: RequestInit) => Promise<unknown>;
  text?: (url: string, init?: RequestInit) => Promise<string>;
}): QueuedFetch {
  return {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      if (!handlers.json) throw new Error('fakeFetch: json is not used by this test');
      const body = await handlers.json(url, init);
      return body as T;
    },
    bytes(): Promise<Uint8Array> {
      throw new Error('fakeFetch: bytes is not used by this test');
    },
    async text(url: string, init?: RequestInit): Promise<string> {
      if (!handlers.text) throw new Error('fakeFetch: text is not used by this test');
      return handlers.text(url, init);
    },
  };
}

/**
 * Inserts one `download_client` row and returns its id. Mirrors
 * `config.test.ts`'s own `seedClient`, plus `baseUrl` -- every column
 * `readClientConfig` or `selectClientForFeed` might read is a parameter,
 * defaulted to a shape that would otherwise pass every check.
 */
function seedClient(raw: DatabaseSync, overrides: {
  name?: string;
  type?: string;
  implementation?: string;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  category?: string;
  baseUrl?: string;
} = {}): number {
  const row = {
    name: 'Client',
    type: 'torrent',
    implementation: 'qbittorrent',
    apiKey: null,
    username: null,
    password: null,
    category: 'movies',
    baseUrl: 'https://client.example.com',
    ...overrides,
  };
  raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key, username, password, category, import_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'copy', 1, 1)
  `).run(row.name, row.type, row.implementation, row.baseUrl, row.apiKey, row.username, row.password, row.category);
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(row.name);
  return Number((inserted as { id: unknown }).id);
}

/** Inserts one `rss_feed` row and returns its id. */
function seedFeed(raw: DatabaseSync, overrides: {
  name?: string;
  downloadType?: string;
  downloadClientId?: number | null;
} = {}): number {
  const row = { name: 'Feed', downloadType: 'torrent', downloadClientId: null, ...overrides };
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, download_client_id, download_type, created_at, updated_at)
    VALUES ('alpha', ?, ?, ?, ?, 1, 1)
  `).run(row.name, `https://example.test/${row.name}`, row.downloadClientId, row.downloadType);
  const inserted = raw.prepare('SELECT id FROM rss_feed WHERE name = ?').get(row.name);
  return Number((inserted as { id: unknown }).id);
}

/** Inserts one `rss_item` row and returns its id. */
function seedRssItem(raw: DatabaseSync, feedId: number, overrides: {
  link?: string;
  filename?: string;
  downloadType?: string;
} = {}): number {
  const row = { link: 'https://example.test/file', filename: 'Some File', downloadType: 'torrent', ...overrides };
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, ?, ?, 1, 1, ?, 'pending')
  `).run(feedId, row.filename, row.link, row.downloadType);
  return Number(result.lastInsertRowid);
}

const MAGNET = 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=Some.Show';
const MAGNET_HASH = '0123456789abcdef0123456789abcdef01234567';

test('a submitted torrent gets a row with its infohash and the returned ref', async () => {
  const raw = setup();
  const clientId = seedClient(raw, { name: 'QBT', apiKey: 'key-1', category: 'movies' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId, { link: MAGNET, filename: 'Some Show' });

  const fetch = fakeFetch({ text: async () => 'Ok.' });
  const clients = createDownloadClients({ raw, fetch, now: () => 5000, log: noLog });

  const ref = await clients.submit({ rssItemId: itemId, downloadClientId: clientId });

  assert.equal(ref, MAGNET_HASH);
  const row = raw.prepare(
    'SELECT infohash, client_ref, status FROM torrent_download WHERE rss_item_id = ?',
  ).get(itemId);
  assert.deepEqual({ ...row }, { infohash: MAGNET_HASH, client_ref: MAGNET_HASH, status: 'submitted' });
});

test('the row exists before the client is called', async () => {
  const raw = setup();
  const clientId = seedClient(raw, {
    name: 'SAB', type: 'nzb', implementation: 'sabnzbd', apiKey: 'key-2', category: 'tv',
  });
  const feedId = seedFeed(raw, { downloadType: 'nzb', downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId, { link: 'https://example.test/one.nzb', filename: 'One Show', downloadType: 'nzb' });

  let sawSubmittingRow = false;
  const fetch = fakeFetch({
    json: async () => {
      // Asserted from inside the fake adapter's own transport, at the
      // moment it is called: this is what makes a crash mid-submit
      // recoverable -- the row must already be there, reading
      // `submitting`, before the client ever sees the request.
      const row = raw.prepare(
        'SELECT status FROM nzb_download WHERE rss_item_id = ? AND download_client_id = ?',
      ).get(itemId, clientId);
      sawSubmittingRow = row !== undefined && (row as { status: unknown }).status === 'submitting';
      return { status: true, nzo_ids: ['SABnzbd_nzo_xyz'] };
    },
  });
  const clients = createDownloadClients({ raw, fetch, now: () => 1000, log: noLog });

  await clients.submit({ rssItemId: itemId, downloadClientId: clientId });

  assert.equal(sawSubmittingRow, true, 'the row must exist and read submitting before the adapter is called');
});

test('an unresolved torrent url leaves the row submitting with no error', async () => {
  const raw = setup();
  const clientId = seedClient(raw, { name: 'QBT2', apiKey: 'key-3', category: 'movies' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId, { link: 'https://example.test/one.torrent', filename: 'One Movie' });

  const fetch = fakeFetch({
    text: async () => 'Ok.',
    // The lookup finds nothing yet: the add has not registered with the
    // server, which is not a failure -- see `findRegisteredRef`.
    json: async () => [],
  });
  const clients = createDownloadClients({ raw, fetch, now: () => 2000, log: noLog });

  const ref = await clients.submit({ rssItemId: itemId, downloadClientId: clientId });

  assert.equal(ref, null);
  const row = raw.prepare(
    'SELECT status, client_ref, last_error FROM torrent_download WHERE rss_item_id = ?',
  ).get(itemId);
  assert.deepEqual({ ...row }, { status: 'submitting', client_ref: null, last_error: null });
});

test('a client that throws leaves the row failed with a redacted error', async () => {
  const raw = setup();
  const clientId = seedClient(raw, {
    name: 'SAB2', type: 'nzb', implementation: 'sabnzbd', apiKey: 'key-4', category: 'tv',
  });
  const feedId = seedFeed(raw, { downloadType: 'nzb', downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId, { link: 'https://example.test/two.nzb', filename: 'Two Show', downloadType: 'nzb' });

  const secret = 'super-secret-value';
  const fetch = fakeFetch({
    // Thrown directly by the transport, not by the adapter's own (already
    // redacting) error paths -- this is what a raw network failure carrying
    // a url with an api key in its query looks like, and it is
    // `createDownloadClients`'s own job to redact it before it reaches
    // `last_error`.
    json: async () => {
      throw new Error(`network hiccup fetching https://sab.example.com/api?mode=addurl&apikey=${secret}&output=json`);
    },
  });
  const clients = createDownloadClients({ raw, fetch, now: () => 3000, log: noLog });

  await assert.rejects(
    clients.submit({ rssItemId: itemId, downloadClientId: clientId }),
    (err: unknown) => err instanceof Error && err.message.includes('network hiccup'),
  );

  const row = raw.prepare(
    'SELECT status, last_error FROM nzb_download WHERE rss_item_id = ?',
  ).get(itemId) as { status: unknown; last_error: unknown };
  assert.equal(row.status, 'failed');
  assert.equal(typeof row.last_error, 'string');
  assert.ok(!(row.last_error as string).includes(secret), 'the secret must not appear in last_error');
});

test('a submission naming a client the feed does not use is refused', async () => {
  const raw = setup();
  const clientA = seedClient(raw, { name: 'ClientA', apiKey: 'key-5a', category: 'movies' });
  const clientB = seedClient(raw, { name: 'ClientB', apiKey: 'key-5b', category: 'movies' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: clientA });
  const itemId = seedRssItem(raw, feedId, { link: 'https://example.test/x.torrent', filename: 'X' });

  // No handler wired for either transport: a refused submission must never
  // reach the network at all.
  const fetch = fakeFetch({});
  const clients = createDownloadClients({ raw, fetch, now: () => 4000, log: noLog });

  await assert.rejects(
    clients.submit({ rssItemId: itemId, downloadClientId: clientB }),
    (err: unknown) => err instanceof Error
      && err.message.includes(`client ${clientB}`)
      && err.message.includes(`client ${clientA}`)
      && err.message.includes(`feed ${feedId}`),
  );

  const row = raw.prepare('SELECT COUNT(*) AS n FROM torrent_download WHERE rss_item_id = ?').get(itemId);
  assert.equal(Number((row as { n: unknown }).n), 0, 'a refused submission must write no row');
});

test('an nzb feed writes to nzb_download and never to torrent_download', async () => {
  const raw = setup();
  const clientId = seedClient(raw, {
    name: 'SAB3', type: 'nzb', implementation: 'sabnzbd', apiKey: 'key-6', category: 'tv',
  });
  const feedId = seedFeed(raw, { downloadType: 'nzb', downloadClientId: clientId });
  // The item's own `download_type` is stamped 'torrent' -- diverging from
  // both the feed's and the client's -- to prove the table choice comes
  // from the client's own resolved kind, never from a download_type column
  // that happens to agree with it today.
  const itemId = seedRssItem(raw, feedId, {
    link: 'https://example.test/three.nzb', filename: 'Three Show', downloadType: 'torrent',
  });

  const fetch = fakeFetch({ json: async () => ({ status: true, nzo_ids: ['SABnzbd_nzo_three'] }) });
  const clients = createDownloadClients({ raw, fetch, now: () => 6000, log: noLog });

  const ref = await clients.submit({ rssItemId: itemId, downloadClientId: clientId });

  assert.equal(ref, 'SABnzbd_nzo_three');
  const nzbCount = raw.prepare('SELECT COUNT(*) AS n FROM nzb_download WHERE rss_item_id = ?').get(itemId);
  const torrentCount = raw.prepare('SELECT COUNT(*) AS n FROM torrent_download WHERE rss_item_id = ?').get(itemId);
  assert.equal(Number((nzbCount as { n: unknown }).n), 1);
  assert.equal(Number((torrentCount as { n: unknown }).n), 0);
});

test('a late update cannot overwrite a row that is no longer submitting', async () => {
  const raw = setup();
  const clientId = seedClient(raw, {
    name: 'SAB4', type: 'nzb', implementation: 'sabnzbd', apiKey: 'key-7', category: 'tv',
  });
  const feedId = seedFeed(raw, { downloadType: 'nzb', downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId, { link: 'https://example.test/four.nzb', filename: 'Four Show', downloadType: 'nzb' });

  const fetch = fakeFetch({
    json: async () => {
      // Simulates a newer attempt deciding this row before this (older,
      // slower) attempt's own response arrives -- the previous slice's
      // blocking bug, reproduced here on purpose: the guard checked the
      // row's state but not which attempt owned it.
      raw.prepare(`
        UPDATE nzb_download SET status = 'failed', last_error = 'preempted-by-newer-attempt', updated_at = 999
        WHERE rss_item_id = ?
      `).run(itemId);
      return { status: true, nzo_ids: ['SABnzbd_nzo_four'] };
    },
  });
  const clients = createDownloadClients({ raw, fetch, now: () => 7000, log: noLog });

  await clients.submit({ rssItemId: itemId, downloadClientId: clientId });

  const row = raw.prepare(
    'SELECT status, last_error, client_ref FROM nzb_download WHERE rss_item_id = ?',
  ).get(itemId);
  assert.deepEqual({ ...row }, { status: 'failed', last_error: 'preempted-by-newer-attempt', client_ref: null });
});
