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
