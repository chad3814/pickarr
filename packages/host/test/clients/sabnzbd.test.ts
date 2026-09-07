import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SabnzbdConfig } from '../../src/clients/config.ts';
import { createSabnzbdClient } from '../../src/clients/sabnzbd.ts';
import { createHostFetch } from '../../src/fetch/queue.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';

function makeConfig(overrides: Partial<SabnzbdConfig> = {}): SabnzbdConfig {
  return {
    kind: 'sabnzbd',
    id: 1,
    baseUrl: 'https://sab.example.com',
    apiKey: 'test-key',
    category: 'tv',
    ...overrides,
  };
}

/**
 * A `QueuedFetch` double whose `json` is whatever the test supplies. The
 * `unknown` -> `T` step mirrors `createHostFetch`'s own `json` (`queue.ts`):
 * the cast is the caller's assertion about the shape it asked for, not a
 * licence to convert between unrelated types, and it is confined to this
 * one line rather than spread through every test.
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

test('submitting returns the first nzo id as the reference', async () => {
  const config = makeConfig({ id: 7 });
  const fetch = fakeQueuedFetch(async () => ({
    status: true,
    nzo_ids: ['SABnzbd_nzo_abc123', 'SABnzbd_nzo_should_be_ignored'],
  }));
  const client = createSabnzbdClient(config, fetch);

  const result = await client.submit('http://example.com/one.nzb', 'One Show');

  assert.deepEqual(result, { ref: 'SABnzbd_nzo_abc123' });
});

test('an empty nzo_ids array is a failure, not an empty reference', async () => {
  // A submission with no id is unrecognisable later -- nothing could ever
  // match a downloads row back to a job in SABnzbd's queue or history.
  // Writing '' as the ref would not fail loudly here; it would instead
  // record a row that looks submitted and can never be reconciled.
  const config = makeConfig({ id: 9 });
  const fetch = fakeQueuedFetch(async () => ({ status: true, nzo_ids: [] }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('no nzo id back')
      && err.message.includes('9'),
  );
});

test('a rejection answered with HTTP 200 is still a failure', async () => {
  // SABnzbd refuses a submission with a 200 and `status: false` -- nothing in
  // the transport sees a problem, so this adapter is the only place it can
  // become one. Before this check the body had no `nzo_ids` at all and the
  // adapter died on a bare `TypeError` reading index 0 of undefined, which
  // names neither the client nor the reason.
  const config = makeConfig({ id: 11 });
  const fetch = fakeQueuedFetch(async () => ({ status: false, error: 'API Key Incorrect' }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('rejected the submission')
      && err.message.includes('API Key Incorrect')
      && err.message.includes('11'),
  );
});

test("a rejection reason quoting the request back has the api key stripped from it", async () => {
  // SABnzbd's `error` text routinely quotes the request it rejected, and that
  // request's query string is ours -- api key included. The reason is passed
  // through the same redaction a url would get, so echoing SABnzbd's wording
  // does not become a way to launder the key into a log.
  const config = makeConfig({ id: 12, apiKey: 'not-a-real-key' });
  const fetch = fakeQueuedFetch(async (url) => ({
    status: false,
    error: `could not process ${url}`,
  }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('rejected the submission')
      && !err.message.includes('not-a-real-key')
      && err.message.includes('apikey=***'),
  );
});

test('a rejection with no reason still names the client', async () => {
  const config = makeConfig({ id: 13 });
  const fetch = fakeQueuedFetch(async () => ({ status: false }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('no reason given')
      && err.message.includes('13'),
  );
});

test('an empty-string nzo id is refused like a missing one', async () => {
  // `''` is not a reference to anything; 1.x rejects it for the same reason.
  const config = makeConfig({ id: 14 });
  const fetch = fakeQueuedFetch(async () => ({ status: true, nzo_ids: [''] }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error && err.message.includes('no nzo id back'),
  );
});

test('the api key travels in the query and never in an error message', async () => {
  const config = makeConfig({ apiKey: 'not-a-real-key' });
  let capturedUrl = '';
  const fetch = fakeQueuedFetch(async (url) => {
    capturedUrl = url;
    // Empty on purpose: this exercises this module's own error path (the
    // "no nzo id" refusal), which is the one error this adapter builds
    // itself rather than getting from `createHostFetch`'s already-redacted
    // failure paths.
    return { status: true, nzo_ids: [] };
  });
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('no nzo id back')
      && !err.message.includes('not-a-real-key'),
  );

  assert.ok(
    capturedUrl.includes('apikey=not-a-real-key'),
    'the api key must actually have been sent in the query',
  );
});

test('the category and display name are sent as the client sees them', async () => {
  const config = makeConfig({
    baseUrl: 'https://sab.example.com', apiKey: 'not-a-real-key', category: 'tv-shows',
  });
  let capturedUrl = '';
  const fetch = fakeQueuedFetch(async (url) => {
    capturedUrl = url;
    return { status: true, nzo_ids: ['SABnzbd_nzo_1'] };
  });
  const client = createSabnzbdClient(config, fetch);

  await client.submit('https://example.com/nzb/123.nzb', 'Show Name');

  assert.equal(
    capturedUrl,
    'https://sab.example.com/api?mode=addurl&name=https%3A%2F%2Fexample.com%2Fnzb%2F123.nzb'
    + '&cat=tv-shows&nzbname=Show+Name&apikey=not-a-real-key&output=json',
  );
});

/**
 * A stand-in for `globalThis.fetch` whose calls hang until the test releases
 * them, so concurrency can be observed directly (as a count of calls in
 * flight) rather than inferred from timing. Same shape as
 * `fetch/queue.test.ts`'s own `trackingFetch`, with a response body this
 * adapter can actually parse a reference out of.
 */
function trackingFetch() {
  let active = 0;
  let max = 0;
  const pending: Array<() => void> = [];

  const fetchFn: typeof globalThis.fetch = async () => {
    active += 1;
    max = Math.max(max, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active -= 1;
    return new Response(JSON.stringify({ status: true, nzo_ids: ['SABnzbd_nzo_queued'] }), { status: 200 });
  };

  return {
    fetchFn,
    activeNow: () => active,
    maxActive: () => max,
    releaseNext: () => {
      const next = pending.shift();
      assert.ok(next, 'releaseNext called with nothing pending');
      next();
    },
  };
}

/** Lets pending microtasks (including a queue's own wake-up chaining) run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('the request goes through the queue, so a second call to the same host waits', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn });
  const config = makeConfig({ baseUrl: 'http://sab.example', apiKey: 'queue-key' });
  const client = createSabnzbdClient(config, hostFetch);

  const first = client.submit('http://example.com/one.nzb', 'One');
  const second = client.submit('http://example.com/two.nzb', 'Two');

  await tick();
  assert.equal(track.activeNow(), 1, 'a second submission to the same host must not have started');

  track.releaseNext();
  await first;

  await tick();
  assert.equal(track.activeNow(), 1, 'the second submission only starts once the first has finished');
  track.releaseNext();
  await second;

  assert.equal(track.maxActive(), 1, 'at most one submission to this host was ever in flight at once');
});
