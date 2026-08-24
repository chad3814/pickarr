import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQbittorrentClient,
  resetQbittorrentWarningsForTests,
} from '../../src/clients/qbittorrent.ts';
import type { FetchLike } from '../../src/clients/types.ts';
import type { QbittorrentClientConfig } from '../../src/config/schema.ts';
import { assertNoLeak } from './no-leak.ts';

// Shaped like a real WebAPI key — `qbt_` and 28 alphanumerics — because the
// config schema refuses anything else, so a shorter fixture would exercise a
// client that cannot actually be configured.
const KEY = `qbt_${'a'.repeat(28)}`;

// The cookie path's secret. Named rather than inlined so a leak assertion and
// the config that produced it cannot drift apart.
const PASSWORD = 'hunter2';

function config(over: Partial<QbittorrentClientConfig> = {}): QbittorrentClientConfig {
  return {
    id: 'qb', type: 'qbittorrent', url: 'http://qb.test',
    category: 'pickarr', importMode: 'copy', pathMappings: [],
    ...over,
  };
}

/**
 * A `fetchImpl` that fails the way an instrumented or proxying wrapper does:
 * by quoting the request it was handed — headers and body — in the error it
 * throws. Nothing the client sends is safe to echo, which is the point.
 */
const echoingFetch: FetchLike = async (url, init) => {
  const headers = [...new Headers(init?.headers)].map(([k, v]) => `${k}: ${v}`).join('; ');
  throw new Error(`ECONNRESET on ${url} [${headers}] body=${String(init?.body ?? '')}`);
};

interface Call { url: string; init: RequestInit | undefined; }

function recorder(handler: (url: string) => Response): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url); },
  };
}

test('an api key rides in a bearer header and no login is issued', async () => {
  const { calls, fetchImpl } = recorder(() => new Response('[]', { status: 200 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await client.snapshot();

  assert.equal(calls.length, 1, 'no auth/login request');
  assert.ok(!calls[0]!.url.includes('auth/login'));
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
});

test('username and password log in once and reuse the cookie', async () => {
  const { calls, fetchImpl } = recorder((url) =>
    url.includes('auth/login')
      ? new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc123; path=/' } })
      : new Response('[]', { status: 200 }));
  const client = createQbittorrentClient(config({ username: 'admin', password: PASSWORD }), fetchImpl);

  await client.snapshot();
  await client.snapshot();

  assert.equal(calls.filter((c) => c.url.includes('auth/login')).length, 1);
  const headers = new Headers(calls[2]!.init?.headers);
  assert.equal(headers.get('cookie'), 'SID=abc123');
});

test('the login posts the credentials as a form body', async () => {
  const { calls, fetchImpl } = recorder((url) =>
    url.includes('auth/login')
      ? new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc123; path=/' } })
      : new Response('[]', { status: 200 }));
  const client = createQbittorrentClient(config({ username: 'admin', password: PASSWORD }), fetchImpl);

  await client.snapshot();

  const login = calls[0]!;
  assert.equal(login.init?.method, 'POST');
  const body = new URLSearchParams(String(login.init?.body));
  assert.equal(body.get('username'), 'admin');
  assert.equal(body.get('password'), PASSWORD);
});

test('a login that answers no SID cookie is refused rather than retried forever', async () => {
  // How qBittorrent reports a wrong username or password: HTTP 200 with the
  // body `Fails.` and no cookie. Treating that as a success would send an
  // uncredentialed request and report whatever the server said about it.
  const { calls, fetchImpl } = recorder(() => new Response('Fails.', { status: 200 }));
  const client = createQbittorrentClient(config({ username: 'admin', password: PASSWORD }), fetchImpl);

  await assert.rejects(client.snapshot(), /SID/);
  assert.equal(calls.length, 1, 'the unauthenticated request must not be sent');
});

test('a 403 on the cookie path re-logs in once and retries', async () => {
  let served = 0;
  const { calls, fetchImpl } = recorder((url) => {
    if (url.includes('auth/login')) {
      return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=fresh; path=/' } });
    }
    served += 1;
    return served === 1 ? new Response('', { status: 403 }) : new Response('[]', { status: 200 });
  });
  const client = createQbittorrentClient(config({ username: 'admin', password: PASSWORD }), fetchImpl);

  await client.snapshot();

  assert.equal(calls.filter((c) => c.url.includes('auth/login')).length, 2);
  assert.equal(new Headers(calls[3]!.init?.headers).get('cookie'), 'SID=fresh', 'the retry uses the new cookie');
});

test('a second 403 fails rather than looping', async () => {
  const { fetchImpl } = recorder((url) =>
    url.includes('auth/login')
      ? new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=x; path=/' } })
      : new Response('', { status: 403 }));
  const client = createQbittorrentClient(config({ username: 'admin', password: PASSWORD }), fetchImpl);

  await assert.rejects(client.snapshot(), /403/);
});

test('a 403 with an api key names the version requirement', async () => {
  const { fetchImpl } = recorder(() => new Response('', { status: 403 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await assert.rejects(client.snapshot(), /5\.2\.0/);
});

test('an api key never triggers a login, not even after a 403', async () => {
  // The key path has no re-login branch at all, because an api key cannot call
  // the auth endpoints: a retry would be one wasted request that can only ever
  // fail, and the 403 it hides is the one that names the version requirement.
  const { calls, fetchImpl } = recorder(() => new Response('', { status: 403 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await assert.rejects(client.snapshot());

  assert.equal(calls.filter((c) => c.url.includes('auth/login')).length, 0);
  assert.equal(calls.length, 1, 'no retry either');
});

test('no credential appears in a thrown error', async () => {
  const { fetchImpl } = recorder(() => new Response('', { status: 500 }));
  const cases = [
    { client: config({ apiKey: KEY }), secret: KEY },
    { client: config({ username: 'admin', password: PASSWORD }), secret: PASSWORD },
  ];
  for (const { client: cfg, secret } of cases) {
    const client = createQbittorrentClient(cfg, fetchImpl);
    const error = await client.snapshot().then(() => null, (e: Error) => e);
    assert.ok(error);
    assertNoLeak(error, secret);
  }
});

test('a fetch that quotes the request it failed on still cannot leak the credential', async () => {
  // The case the HTTP-status test above cannot reach, and the only one that
  // discriminates: `fetchImpl` is an injectable seam, and an instrumented or
  // proxying wrapper routinely puts the request it was given into the error it
  // throws. Here the credential is in a header (api key) and a form body
  // (password) rather than the query string, so there is no delimiter to
  // redact around — the client's only defence is to put no part of a foreign
  // error into its own.
  const cases = [
    { client: config({ apiKey: KEY }), secret: KEY },
    { client: config({ username: 'admin', password: PASSWORD }), secret: PASSWORD },
  ];
  for (const { client: cfg, secret } of cases) {
    const client = createQbittorrentClient(cfg, echoingFetch);
    const error = await client.snapshot().then(() => null, (e: Error) => e);
    assert.ok(error);
    assertNoLeak(error, secret);
  }
});

test('addUrl posts the four fields and resolves the hash from the tag lookup', async () => {
  const { calls, fetchImpl } = recorder((url) =>
    url.includes('torrents/info')
      ? new Response(JSON.stringify([{ hash: 'HASH1' }]), { status: 200 })
      : new Response('Ok.', { status: 200 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  const ref = await client.addUrl('magnet:?xt=1', 'Scene [pickarr-abc12345-7]', 'pickarr-abc12345-7');

  assert.equal(ref, 'HASH1');
  const body = new URLSearchParams(String(calls[0]!.init?.body));
  assert.equal(body.get('urls'), 'magnet:?xt=1');
  assert.equal(body.get('category'), 'pickarr');
  // These two are asserted separately and by name: swapping them would still
  // return a hash and still pass a test that only checked the answer.
  assert.equal(body.get('rename'), 'Scene [pickarr-abc12345-7]');
  assert.equal(body.get('tags'), 'pickarr-abc12345-7');
  assert.ok(calls[1]!.url.includes('tag=pickarr-abc12345-7'));
});

test('addUrl throws naming the label when the lookup finds nothing', async () => {
  const { fetchImpl } = recorder((url) =>
    url.includes('torrents/info')
      ? new Response('[]', { status: 200 })
      : new Response('Ok.', { status: 200 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await assert.rejects(client.addUrl('magnet:?xt=1', 'n', 'pickarr-abc12345-7'), /pickarr-abc12345-7/);
});

test('addUrl throws rather than choosing when the lookup finds two', async () => {
  const { fetchImpl } = recorder((url) =>
    url.includes('torrents/info')
      ? new Response(JSON.stringify([{ hash: 'A' }, { hash: 'B' }]), { status: 200 })
      : new Response('Ok.', { status: 200 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await assert.rejects(client.addUrl('magnet:?xt=1', 'n', 'pickarr-abc12345-7'), /pickarr-abc12345-7/);
});

const QUEUE_STATES = ['downloading', 'metaDL', 'stalledDL', 'queuedDL', 'forcedDL',
  'allocating', 'checkingDL', 'checkingResumeData', 'moving', 'pausedDL', 'stoppedDL'];
const DONE_STATES = ['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP',
  'pausedUP', 'stoppedUP'];
const FAILED_STATES = ['error', 'missingFiles'];

function torrent(state: string) {
  return {
    hash: 'H', name: 'N', category: 'pickarr', state,
    progress: 0.5, content_path: '/downloads/N',
  };
}

test('every documented state lands where the table says', async () => {
  for (const state of QUEUE_STATES) {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify([torrent(state)])));
    const snap = await createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).snapshot();
    assert.equal(snap.queue.length, 1, state);
    assert.equal(snap.history.length, 0, state);
  }
  for (const state of DONE_STATES) {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify([torrent(state)])));
    const snap = await createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).snapshot();
    assert.equal(snap.history[0]?.outcome, 'completed', state);
  }
  for (const state of FAILED_STATES) {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify([torrent(state)])));
    const snap = await createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).snapshot();
    assert.equal(snap.history[0]?.outcome, 'failed', state);
  }
});

test('an unrecognised state reads as queue and warns once', async () => {
  resetQbittorrentWarningsForTests();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: string[]) => { warnings.push(args.join(' ')); };
  try {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify([torrent('teleporting')])));
    const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);
    const first = await client.snapshot();
    await client.snapshot();
    assert.equal(first.queue.length, 1, 'unrecognised is queue, never failed');
    assert.equal(warnings.filter((w) => w.includes('teleporting')).length, 1);
  } finally {
    console.warn = original;
  }
});

test('progress becomes a whole percentage, and content_path is mapped', async () => {
  const { fetchImpl } = recorder(() =>
    new Response(JSON.stringify([{ ...torrent('downloading'), progress: 0.5 }])));
  const client = createQbittorrentClient(
    config({ apiKey: KEY, pathMappings: [{ from: '/downloads', to: '/mnt/dl' }] }),
    fetchImpl,
  );

  const snap = await client.snapshot();

  // 0.5, not 0 — the interface wants 0-100 (sabnzbd.ts parses an int, and
  // Downloads.tsx renders `{percentage}%`), and qBittorrent reports 0-1.
  assert.equal(snap.queue[0]?.percentage, 50);
  assert.equal(client.mapPath('/downloads/N'), '/mnt/dl/N');
});

test('an empty category is normalised to null, a real one passes through', async () => {
  const { fetchImpl } = recorder(() =>
    new Response(JSON.stringify([{ ...torrent('downloading'), category: '' }])));
  const snap = await createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).snapshot();
  assert.equal(snap.queue[0]?.category, null);

  // Without this, a stub that maps every category to null (rather than only
  // the empty one) would pass the assertion above and silently drop every
  // real category the server ever reports.
  const { fetchImpl: withCategory } = recorder(() =>
    new Response(JSON.stringify([torrent('downloading')])));
  const withReal = await createQbittorrentClient(config({ apiKey: KEY }), withCategory).snapshot();
  assert.equal(withReal.queue[0]?.category, 'pickarr');
});

test('remove is not implemented', () => {
  const { fetchImpl } = recorder(() => new Response('[]'));
  assert.equal(createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).remove, undefined);
});
