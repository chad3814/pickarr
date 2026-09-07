import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QbittorrentBearerConfig } from '../../src/clients/config.ts';
import { createQbittorrentClient, infohashFromMagnet } from '../../src/clients/qbittorrent.ts';
import { FetchFailedError } from '../../src/fetch/queue.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';

function makeConfig(overrides: Partial<QbittorrentBearerConfig> = {}): QbittorrentBearerConfig {
  return {
    kind: 'qbittorrent-bearer',
    id: 1,
    baseUrl: 'https://qbt.example.com',
    apiKey: 'test-key',
    category: 'tv',
    ...overrides,
  };
}

/**
 * A `QueuedFetch` double whose `text` is whatever the test supplies --
 * `submit` uses only `text`, since `/torrents/add` answers with a bare body
 * ("Ok."), not JSON. Same shape as `sabnzbd.test.ts`'s `fakeQueuedFetch`.
 */
function fakeQueuedFetch(handler: (url: string, init?: RequestInit) => Promise<string>): QueuedFetch {
  return {
    json<T>(): Promise<T> {
      throw new Error('json is not used by these tests');
    },
    bytes(): Promise<Uint8Array> {
      throw new Error('bytes is not used by these tests');
    },
    text(url: string, init?: RequestInit): Promise<string> {
      return handler(url, init);
    },
  };
}

const MAGNET = 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=Some.Show.S01E01';

test('a magnet link yields its infohash without any lookup', async () => {
  const config = makeConfig({ id: 5, baseUrl: 'https://qbt.example.com', apiKey: 'not-a-real-key', category: 'movies' });
  let calls = 0;
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetch = fakeQueuedFetch(async (url, init) => {
    calls += 1;
    capturedUrl = url;
    capturedInit = init;
    return 'Ok.';
  });
  const client = createQbittorrentClient(config, fetch);

  const result = await client.submit(MAGNET, 'Some Show');

  // Exactly one request: two would mean a lookup ran, and a magnet needs
  // none -- the link already carries qBittorrent's own reference.
  assert.equal(calls, 1, 'exactly one request should have been made; two would mean a lookup ran');
  assert.deepEqual(result, { ref: '0123456789abcdef0123456789abcdef01234567' });
  assert.equal(capturedUrl, 'https://qbt.example.com/api/v2/torrents/add');
  assert.equal(capturedInit?.method, 'POST');
  assert.deepEqual(capturedInit?.headers, { Authorization: 'Bearer not-a-real-key' });
  const body = capturedInit?.body;
  assert.ok(body instanceof URLSearchParams, 'body must be a URLSearchParams instance');
  assert.equal(
    body.toString(),
    'urls=magnet%3A%3Fxt%3Durn%3Abtih%3A0123456789ABCDEF0123456789ABCDEF01234567%26dn%3DSome.Show.S01E01'
    + '&category=movies&rename=Some+Show',
  );
});

test('an infohash is read case-insensitively and stored lowercase', async () => {
  // A magnet may spell the hash in either case. Two spellings of one hash
  // would be two distinct values to the unique index on
  // (download_client_id, client_ref), so the same torrent could be recorded
  // twice.
  const config = makeConfig({ id: 6 });
  const fetch = fakeQueuedFetch(async () => 'Ok.');
  const client = createQbittorrentClient(config, fetch);

  const upper = 'magnet:?xt=urn:btih:AABBCCDDEEFF00112233445566778899AABBCCDD&dn=Upper';
  const lower = 'magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=Lower';

  const resultUpper = await client.submit(upper, 'Upper');
  const resultLower = await client.submit(lower, 'Lower');

  assert.deepEqual(resultUpper, { ref: 'aabbccddeeff00112233445566778899aabbccdd' });
  assert.deepEqual(resultLower, { ref: 'aabbccddeeff00112233445566778899aabbccdd' });
});

test('a link that is not a magnet yields null from infohashFromMagnet', () => {
  assert.equal(infohashFromMagnet('https://example.com/some.torrent'), null);
  // A base32 btih (32 characters drawn from the base32 alphabet, not 40 hex
  // characters) is not a v1 hex magnet.
  assert.equal(
    infohashFromMagnet('magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&dn=Base32'),
    null,
  );
  // A v2 magnet (btmh) is not a v1 hex magnet either.
  assert.equal(
    infohashFromMagnet(
      'magnet:?xt=urn:btmh:1220caf1e1c30e81cb361b9ee167c4aa64228a7fa4fa9695de1528f6cae184963501&dn=V2',
    ),
    null,
  );
  assert.equal(infohashFromMagnet('not a magnet at all'), null);
});

test('a rejected bearer header names the minimum version', async () => {
  const config = makeConfig({ id: 8 });
  const fetch = fakeQueuedFetch(async () => {
    throw new FetchFailedError('fetch https://qbt.example.com/api/v2/torrents/add failed: 401 Unauthorized', 401);
  });
  const client = createQbittorrentClient(config, fetch);

  await assert.rejects(
    client.submit(MAGNET, 'Some Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('5.2.0')
      && err.message.includes('8')
      && err.message.includes('401'),
  );
});

test('the bearer token never appears in an error message', async () => {
  const config = makeConfig({ id: 9, apiKey: 'not-a-real-key' });
  const fetch = fakeQueuedFetch(async () => {
    throw new FetchFailedError('fetch https://qbt.example.com/api/v2/torrents/add failed: 403 Forbidden', 403);
  });
  const client = createQbittorrentClient(config, fetch);

  await assert.rejects(
    client.submit(MAGNET, 'Some Show'),
    (err: unknown) => err instanceof Error
      && !err.message.includes('not-a-real-key')
      && err.message.includes('5.2.0'),
  );
});

const TORRENT_URL = 'https://example.com/some.torrent';

/**
 * A `QueuedFetch` double covering both `text` (the add's bare-body answer)
 * and `json` (the `.torrent` path's lookup answer) -- everything `submit`
 * can call once a link is not a magnet. `calls` records every request in
 * order, the way a test proving "exactly one request means no lookup ran"
 * needs a count for. The `unknown` -> `T` step in `json` mirrors
 * `createHostFetch`'s own (`queue.ts`): the cast is this double's assertion
 * about the shape the test handed it, not a licence to convert between
 * unrelated types.
 */
function fakeQbittorrentFetch(handlers: {
  text: (url: string, init?: RequestInit) => Promise<string>;
  json: (url: string, init?: RequestInit) => Promise<unknown>;
}): { fetch: QueuedFetch; calls: Array<{ kind: 'text' | 'json'; url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ kind: 'text' | 'json'; url: string; init: RequestInit | undefined }> = [];
  const fetch: QueuedFetch = {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      calls.push({ kind: 'json', url, init });
      const body: unknown = await handlers.json(url, init);
      return body as T;
    },
    bytes(): Promise<Uint8Array> {
      throw new Error('bytes is not used by these tests');
    },
    async text(url: string, init?: RequestInit): Promise<string> {
      calls.push({ kind: 'text', url, init });
      return handlers.text(url, init);
    },
  };
  return { fetch, calls };
}

test('a torrent url is added and its hash found by category', async () => {
  const config = makeConfig({ id: 10, category: 'movies' });
  const { fetch, calls } = fakeQbittorrentFetch({
    text: async () => 'Ok.',
    json: async () => [
      { hash: 'DEADBEEF00112233445566778899AABBCCDDEEFF', name: 'Some Movie', category: 'movies' },
    ],
  });
  const client = createQbittorrentClient(config, fetch);

  const result = await client.submit(TORRENT_URL, 'Some Movie');

  assert.deepEqual(result, { ref: 'deadbeef00112233445566778899aabbccddeeff' });
  assert.equal(calls.length, 2, 'the add and the lookup should each run exactly once');
  assert.equal(calls[0]?.kind, 'text');
  assert.equal(calls[0]?.url, 'https://qbt.example.com/api/v2/torrents/add');
  assert.equal(calls[1]?.kind, 'json');
  assert.equal(calls[1]?.url, 'https://qbt.example.com/api/v2/torrents/info?category=movies');
  assert.deepEqual(calls[1]?.init?.headers, { Authorization: 'Bearer test-key' });
});

test('an empty lookup leaves the reference unresolved rather than failing', async () => {
  const config = makeConfig({ id: 11, category: 'movies' });
  const { fetch } = fakeQbittorrentFetch({
    text: async () => 'Ok.',
    json: async () => [],
  });
  const client = createQbittorrentClient(config, fetch);

  let threw = false;
  let result: { ref: string | null } | undefined;
  try {
    result = await client.submit(TORRENT_URL, 'Some Movie');
  } catch {
    threw = true;
  }

  // Success, not merely "did not reject": a function that resolved with
  // `{ ref: undefined }` or nothing at all would also fail to throw.
  assert.equal(threw, false, 'an empty lookup must not be recorded as an error');
  assert.deepEqual(result, { ref: null });
});

test('an all-zero infohash is treated as unresolved, not as a reference', async () => {
  const config = makeConfig({ id: 12, category: 'movies' });
  const { fetch } = fakeQbittorrentFetch({
    text: async () => 'Ok.',
    json: async () => [
      { hash: '0000000000000000000000000000000000000000', name: 'Some Movie', category: 'movies' },
    ],
  });
  const client = createQbittorrentClient(config, fetch);

  let threw = false;
  let result: { ref: string | null } | undefined;
  try {
    result = await client.submit(TORRENT_URL, 'Some Movie');
  } catch {
    threw = true;
  }

  assert.equal(threw, false, 'an all-zero hash must not be recorded as an error');
  assert.deepEqual(result, { ref: null });
});

test('a lookup matches on category so another client\'s torrents are ignored', async () => {
  const config = makeConfig({ id: 13, category: 'tv' });
  const { fetch } = fakeQbittorrentFetch({
    text: async () => 'Ok.',
    // A server that ignores the `?category=tv` filter it was sent --
    // proving the match still enforces category client-side, not only by
    // trusting the query string to have done it.
    json: async () => [
      { hash: 'FFEEDDCCBBAA00998877665544332211FFEEDDC', name: 'Some Movie', category: 'movies' },
    ],
  });
  const client = createQbittorrentClient(config, fetch);

  const result = await client.submit(TORRENT_URL, 'Some Movie');

  assert.deepEqual(result, { ref: null }, 'a torrent in a foreign category must not be adopted');
});

test('a lookup matches on name too, so a same-category torrent with a different name is ignored', async () => {
  // Two torrents share one category; only one carries the name this
  // submission used. Category alone cannot tell them apart -- a category
  // holds many torrents at once -- so dropping the name comparison would
  // adopt whichever of the two the lookup happened to list first.
  const config = makeConfig({ id: 14, category: 'tv' });
  const { fetch } = fakeQbittorrentFetch({
    text: async () => 'Ok.',
    json: async () => [
      { hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name: 'Someone Elses Show', category: 'tv' },
      { hash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', name: 'Our Show', category: 'tv' },
    ],
  });
  const client = createQbittorrentClient(config, fetch);

  const result = await client.submit(TORRENT_URL, 'Our Show');

  assert.deepEqual(result, { ref: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
});

/**
 * One case of "a category of ... means no category" below, pulled out so
 * both spellings can run through `Promise.all` rather than a loop awaiting
 * each in turn -- an `await` inside a `for` loop is exactly what
 * `no-await-in-loop` flags, and there is no sequencing between the two
 * cases for a loop to buy here.
 */
async function assertBlankCategorySendsNoFilter(configured: string): Promise<void> {
  const config = makeConfig({ id: 15, category: configured });
  const { fetch, calls } = fakeQbittorrentFetch({
    text: async () => 'Ok.',
    json: async () => [
      { hash: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', name: 'Some Movie', category: '' },
    ],
  });
  const client = createQbittorrentClient(config, fetch);

  const result = await client.submit(TORRENT_URL, 'Some Movie');

  assert.deepEqual(result, { ref: 'cccccccccccccccccccccccccccccccccccccccc' });
  assert.equal(
    calls[1]?.url,
    'https://qbt.example.com/api/v2/torrents/info',
    `configured category ${JSON.stringify(configured)} must not be sent as a literal filter`,
  );
}

test('a category of "" or the literal text \'None\' means no category, not a category so named', async () => {
  // Both a blank category and the literal text 'None' mean "no category
  // assigned" (design spec §8). Neither should be sent as a `?category=`
  // filter -- doing so would ask the server for torrents in a category
  // literally named "None" or "" instead of torrents that have none.
  await Promise.all(['', 'None'].map((configured) => assertBlankCategorySendsNoFilter(configured)));
});
