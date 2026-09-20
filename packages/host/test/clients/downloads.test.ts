import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createDownloadClients } from '../../src/clients/downloads.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import type { Secrets } from '../../src/secrets/instance.ts';
import { writeSecretValue } from '../../src/secrets/store.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/** A no-op log, for tests that have nothing to assert about it. */
function noLog(): void {}

/**
 * The `chooseIndex` every test below but one passes. Each of those seeds a
 * feed that names its own client, so `selectClientForFeed` settles without
 * a draw and reaching a chooser would mean the named client was ignored --
 * which this turns into a failure rather than a coincidence.
 */
function refuseToChoose(): never {
  throw new Error('the chooser was consulted for a feed that names its own client');
}

/**
 * The secrets subsystem these tests resolve credentials through. `baseDir`
 * does not exist, so the chain's file link finds nothing and every value
 * comes from the `secret` table `seedClient` wrote it to.
 */
function makeSecrets(raw: DatabaseSync): Secrets {
  return createSecrets({ raw, baseDir: '/nonexistent/pickarr-downloads-test-secrets' });
}

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
 * The `secret` name a seeded credential is stored under, derived from the
 * client's own name so two clients in one test never collide. Lowercased and
 * stripped to what `SECRET_NAME` admits.
 */
function secretNameFor(clientName: string, kind: 'api-key' | 'password'): string {
  return `${clientName.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${kind}`;
}

/**
 * Inserts one `download_client` row and returns its id. Mirrors
 * `config.test.ts`'s own `insertClient`, plus `baseUrl` -- every column
 * `readClientConfig` or `selectClientForFeed` might read is a parameter,
 * defaulted to a shape that would otherwise pass every check.
 *
 * `apiKey` and `password` are still the *values* a test names, because what
 * each test cares about is the credential its adapter ends up sending. Since
 * migration 14 the row holds only a name, so the value goes into `secret`
 * here and the name goes into the row -- `makeSecrets` is what turns one
 * back into the other.
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
    apiKey: null as string | null,
    username: null as string | null,
    password: null as string | null,
    category: 'movies',
    baseUrl: 'https://client.example.com',
    ...overrides,
  };
  let apiKeySecretName: string | null = null;
  if (row.apiKey !== null && row.apiKey !== '') {
    apiKeySecretName = secretNameFor(row.name, 'api-key');
    writeSecretValue(raw, apiKeySecretName, row.apiKey, 1);
  }
  let passwordSecretName: string | null = null;
  if (row.password !== null && row.password !== '') {
    passwordSecretName = secretNameFor(row.name, 'password');
    writeSecretValue(raw, passwordSecretName, row.password, 1);
  }
  raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key_secret_name, username, password_secret_name,
       category, import_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'copy', 1, 1)
  `).run(
    row.name, row.type, row.implementation, row.baseUrl,
    apiKeySecretName, row.username, passwordSecretName, row.category,
  );
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
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 5000, chooseIndex: refuseToChoose, log: noLog });

  const ref = await clients.submit({ rssItemId: itemId });

  assert.equal(ref, MAGNET_HASH);
  const row = raw.prepare(
    'SELECT infohash, client_ref, status FROM torrent_download WHERE rss_item_id = ?',
  ).get(itemId);
  assert.deepEqual({ ...row }, { infohash: MAGNET_HASH, client_ref: MAGNET_HASH, status: 'submitted' });
});

test('a second release resolving to a ref the client already holds gets a message naming the item and client', async () => {
  // The second submission's row hits the partial unique index on
  // (download_client_id, client_ref) once the same magnet's ref is written
  // against a client that already holds it. Left unhandled, `last_error`
  // would read SQLite's raw `UNIQUE constraint failed: ...` message,
  // naming neither the item nor the client.
  //
  // **Two rss_items carrying the same magnet, and this test used to use
  // one.** Since migration 18 the same release picked twice never reaches
  // the client at all -- the release-level index refuses the insert, which
  // is `pick.test.ts`'s territory now. What still reaches this index is
  // two *different* releases that resolve to one reference, which a feed
  // republishing an item under a new guid produces. That shape is the only
  // remaining route to `AlreadySubmittedError`, and it is the shape the
  // class's docblock now claims, so it is the shape this test builds.
  const raw = setup();
  const clientId = seedClient(raw, { name: 'QBTResubmit', apiKey: 'key-1b', category: 'movies' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId, { link: MAGNET, filename: 'Some Show' });
  const twinId = seedRssItem(raw, feedId, { link: MAGNET, filename: 'Some Show' });

  const fetch = fakeFetch({ text: async () => 'Ok.' });
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 5500, chooseIndex: refuseToChoose, log: noLog });

  const firstRef = await clients.submit({ rssItemId: itemId });
  assert.equal(firstRef, MAGNET_HASH);

  await assert.rejects(
    clients.submit({ rssItemId: twinId }),
    (err: unknown) => err instanceof Error
      && err.message.includes(`rss item ${twinId}`)
      && err.message.includes(`download client ${clientId}`)
      && !err.message.includes('UNIQUE constraint failed'),
  );

  const rows = raw.prepare(
    'SELECT rss_item_id, status, last_error FROM torrent_download ORDER BY id',
  ).all() as Array<{ rss_item_id: unknown; status: unknown; last_error: unknown }>;
  assert.equal(rows.length, 2, 'the second release must have inserted its own row');
  assert.equal(rows[1]?.rss_item_id, twinId);
  assert.equal(rows[1]?.status, 'failed');
  assert.ok(typeof rows[1]?.last_error === 'string' && (rows[1].last_error as string).includes(`rss item ${twinId}`));
  // The first row must be untouched. A collision is the *second* attempt's
  // failure, and the download the first attempt really did register is still
  // registered -- so a resubmit that rewrote or cleared row one would lose
  // the only record of the reference the client actually holds.
  assert.equal(rows[0]?.rss_item_id, itemId);
  assert.equal(rows[0]?.status, 'submitted', 'the original row must survive a colliding resubmit');
  assert.equal(rows[0]?.last_error, null, 'the original row must not inherit the resubmit\'s error');
});

test('a release that already has a live download is refused before the client is called', async () => {
  // The release-level index, at the layer that catches it -- `pick.test.ts`
  // drives the same condition through a host and reads the refusal code off
  // the far end. Both belong: this one is what proves no request was made
  // and no second row exists, which a refusal code alone does not say.
  const raw = setup();
  const clientId = seedClient(raw, { name: 'QBTLive', apiKey: 'key-1c', category: 'movies' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId, { link: MAGNET, filename: 'Some Show' });

  let calls = 0;
  const fetch = fakeFetch({ text: async () => { calls += 1; return 'Ok.'; } });
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 5500, chooseIndex: refuseToChoose, log: noLog });

  await clients.submit({ rssItemId: itemId });
  assert.equal(calls, 1, 'the first submission reached the client');

  await assert.rejects(
    clients.submit({ rssItemId: itemId }),
    (err: unknown) => err instanceof Error
      && err.name === 'ReleaseAlreadyPickedError'
      && err.message.includes(`rss item ${itemId}`)
      && !err.message.includes('UNIQUE constraint failed'),
  );

  assert.equal(calls, 1, 'and the second never did -- the insert refused it first');
  const rows = raw.prepare('SELECT status FROM torrent_download WHERE rss_item_id = ?')
    .all(itemId).map((row) => String((row as { status: unknown }).status));
  assert.deepEqual(rows, ['submitted'], 'no second row was written, not even a failed one');
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
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 1000, chooseIndex: refuseToChoose, log: noLog });

  await clients.submit({ rssItemId: itemId });

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
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 2000, chooseIndex: refuseToChoose, log: noLog });

  const ref = await clients.submit({ rssItemId: itemId });

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
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 3000, chooseIndex: refuseToChoose, log: noLog });

  await assert.rejects(
    clients.submit({ rssItemId: itemId }),
    (err: unknown) => err instanceof Error && err.message.includes('network hiccup'),
  );

  const row = raw.prepare(
    'SELECT status, last_error FROM nzb_download WHERE rss_item_id = ?',
  ).get(itemId) as { status: unknown; last_error: unknown };
  assert.equal(row.status, 'failed');
  assert.equal(typeof row.last_error, 'string');
  assert.ok(!(row.last_error as string).includes(secret), 'the secret must not appear in last_error');
});

test('a feed that names one of two clients of its type is submitted to that one', async () => {
  // What is left of the test that used to stand here. That one submitted
  // client B against a feed naming client A and asserted the refusal; the
  // submission cannot name a client at all now, so there is no
  // disagreement to have. What still needs pinning through the real
  // `submit` -- rather than only through `selectClientForFeed` -- is that a
  // named client wins when a second of its type is sitting right there, and
  // that reaching it took no draw.
  const raw = setup();
  const named = seedClient(raw, { name: 'ClientA', apiKey: 'key-5a', category: 'movies' });
  const other = seedClient(raw, { name: 'ClientB', apiKey: 'key-5b', category: 'movies' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: named });
  const itemId = seedRssItem(raw, feedId, { link: MAGNET, filename: 'X' });

  const fetch = fakeFetch({ text: async () => 'Ok.' });
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 4000, chooseIndex: refuseToChoose, log: noLog });

  await clients.submit({ rssItemId: itemId });

  const row = raw.prepare(
    'SELECT download_client_id FROM torrent_download WHERE rss_item_id = ?',
  ).get(itemId) as { download_client_id: unknown };
  assert.equal(Number(row.download_client_id), named);
  assert.notEqual(Number(row.download_client_id), other);
});

test('a download_client type/implementation mismatch is refused before any request is made', async () => {
  // `readClientConfig` and `selectClientForFeed` are each tested elsewhere
  // against a bare `DatabaseSync`, which cannot issue a request at all --
  // a guarantee by construction there, but not a test that drives a
  // mismatch through `createDownloadClients` itself with a fetch double
  // that would notice a request if one were made. This client's own type
  // ('nzb') and implementation ('qbittorrent') disagree; the feed names it
  // explicitly and shares its type, so `selectClientForFeed` accepts the
  // choice and `readClientConfig` is the one that refuses.
  const raw = setup();
  const clientId = seedClient(raw, {
    name: 'Mismatched', type: 'nzb', implementation: 'qbittorrent', apiKey: 'key-8', category: 'movies',
  });
  const feedId = seedFeed(raw, { downloadType: 'nzb', downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId, { link: 'https://example.test/y.torrent', filename: 'Y', downloadType: 'nzb' });

  let requests = 0;
  const fetch = fakeFetch({
    json: async () => { requests += 1; throw new Error('must not be called'); },
    text: async () => { requests += 1; throw new Error('must not be called'); },
  });
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 4500, chooseIndex: refuseToChoose, log: noLog });

  await assert.rejects(
    clients.submit({ rssItemId: itemId }),
    (err: unknown) => err instanceof Error
      && err.message.includes(`client ${clientId}`)
      && err.message.includes('qbittorrent')
      && err.message.includes('cannot work'),
  );

  assert.equal(requests, 0, 'a type mismatch must be refused before any request is made');
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
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 6000, chooseIndex: refuseToChoose, log: noLog });

  const ref = await clients.submit({ rssItemId: itemId });

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
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 7000, chooseIndex: refuseToChoose, log: noLog });

  await clients.submit({ rssItemId: itemId });

  const row = raw.prepare(
    'SELECT status, last_error, client_ref FROM nzb_download WHERE rss_item_id = ?',
  ).get(itemId);
  assert.deepEqual({ ...row }, { status: 'failed', last_error: 'preempted-by-newer-attempt', client_ref: null });
});

test('a submission on a feed naming no client goes to the sole client of its type', async () => {
  // The case that failed for every feed created through the settings UI:
  // `AddFeedInput` has no download client field, so `download_client_id` is
  // NULL, and the plugin that used to read it had nothing to send. The
  // policy that answers here is the same one every other path already used.
  const raw = setup();
  const clientId = seedClient(raw, { name: 'SoleQBT', apiKey: 'key-9', category: 'movies' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: null });
  const itemId = seedRssItem(raw, feedId, { link: MAGNET, filename: 'Sole Show' });

  const fetch = fakeFetch({ text: async () => 'Ok.' });
  const clients = createDownloadClients({ raw, fetch, secrets: makeSecrets(raw), now: () => 8000, chooseIndex: refuseToChoose, log: noLog });

  const ref = await clients.submit({ rssItemId: itemId });

  assert.equal(ref, MAGNET_HASH);
  const row = raw.prepare(
    'SELECT download_client_id, status FROM torrent_download WHERE rss_item_id = ?',
  ).get(itemId);
  assert.deepEqual({ ...row }, { download_client_id: clientId, status: 'submitted' });
});

test('a submission on a feed naming no client, where two match, takes the chooser\'s answer', async () => {
  // What proves `chooseIndex` is threaded from here through to
  // `selectClientForFeed` rather than stopping at this module's own deps.
  // Index 1 of two ids in ascending order is the second, spelled out
  // literally: an implementation that dropped the chooser and kept the
  // lowest id would write `first` and this would see it.
  const raw = setup();
  const first = seedClient(raw, {
    name: 'FirstQBT', apiKey: 'key-10a', category: 'movies', baseUrl: 'https://first.example.test',
  });
  const second = seedClient(raw, {
    name: 'SecondQBT', apiKey: 'key-10b', category: 'movies', baseUrl: 'https://second.example.test',
  });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: null });
  const itemId = seedRssItem(raw, feedId, { link: MAGNET, filename: 'Chosen Show' });

  const fetch = fakeFetch({ text: async () => 'Ok.' });
  const clients = createDownloadClients({
    raw, fetch, secrets: makeSecrets(raw), now: () => 8500, chooseIndex: () => 1, log: noLog,
  });

  await clients.submit({ rssItemId: itemId });

  const row = raw.prepare(
    'SELECT download_client_id FROM torrent_download WHERE rss_item_id = ?',
  ).get(itemId) as { download_client_id: unknown };
  assert.equal(Number(row.download_client_id), second);
  assert.notEqual(Number(row.download_client_id), first);
});
