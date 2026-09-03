import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostFetch } from '../../src/fetch/queue.ts';

/**
 * A shape `json<T>` can decode straight off a stubbed `Response`: every fake
 * response body in this file is `{ url: <the url the fetch was made with> }`,
 * so a test can prove which request actually ran by reading the body back.
 */
interface Echo {
  url: string;
}

/**
 * A stand-in for `globalThis.fetch` whose calls hang until the test releases
 * them, so concurrency can be observed directly (as a count of calls
 * in flight) rather than inferred from timing. `activeNow`/`maxActive` are
 * read by the tests that assert on overlap; `releaseNext` lets a test
 * control call order without caring which promise object came back from
 * `createHostFetch`.
 */
function trackingFetch() {
  let active = 0;
  let max = 0;
  const pending: Array<() => void> = [];

  const fetchFn: typeof globalThis.fetch = async (input) => {
    active += 1;
    max = Math.max(max, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active -= 1;
    return new Response(JSON.stringify({ url: String(input) } satisfies Echo), { status: 200 });
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

test('two requests to one hostname do not overlap at the default limit of one', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn });

  const first = hostFetch.json<Echo>('http://a.example/one');
  const second = hostFetch.json<Echo>('http://a.example/two');

  await tick();
  assert.equal(track.activeNow(), 1, 'a second request to the same host must not have started');

  track.releaseNext();
  const firstResult = await first;
  assert.equal(firstResult.url, 'http://a.example/one');

  await tick();
  assert.equal(track.activeNow(), 1, 'the second request only starts once the first has finished');
  track.releaseNext();
  const secondResult = await second;
  assert.equal(secondResult.url, 'http://a.example/two');

  assert.equal(track.maxActive(), 1, 'at most one request to this host was ever in flight at once');
});

test('a rejected request still releases its slot, so the next request to that hostname runs', async () => {
  // The wedge this guards: if the slot is released only on success, one
  // rejection stops that hostname forever and nothing reports it.
  let calls = 0;
  const fetchFn: typeof globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network exploded');
    return new Response(JSON.stringify({ url: 'recovered' } satisfies Echo), { status: 200 });
  };
  const hostFetch = createHostFetch({ fetch: fetchFn });

  await assert.rejects(hostFetch.json<Echo>('http://a.example/one'), /network exploded/);

  // The rejection above must have released the slot: a *subsequent* request
  // to the *same* hostname has to actually run, not merely fail to hang. If
  // the slot never freed, this call would wait forever on a promise nothing
  // will settle -- awaiting only the rejection above would miss that.
  const second = await hostFetch.json<Echo>('http://a.example/two');
  assert.equal(second.url, 'recovered');
  assert.equal(calls, 2, 'the second call to the same hostname actually reached fetch');
});

test('a per-host limit of two lets two run at once and makes a third wait', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn, limits: { default: 1, perHost: { 'a.example': 2 } } });

  const first = hostFetch.json<Echo>('http://a.example/one');
  const second = hostFetch.json<Echo>('http://a.example/two');
  const third = hostFetch.json<Echo>('http://a.example/three');

  await tick();
  assert.equal(track.activeNow(), 2, 'two requests to a host with a limit of two must run at once');

  track.releaseNext();
  const firstResult = await first;
  assert.equal(firstResult.url, 'http://a.example/one');

  await tick();
  assert.equal(track.activeNow(), 2, 'the third request starts as soon as a slot frees, not before');

  track.releaseNext();
  track.releaseNext();
  const [secondResult, thirdResult] = await Promise.all([second, third]);
  assert.equal(secondResult.url, 'http://a.example/two');
  assert.equal(thirdResult.url, 'http://a.example/three');

  assert.equal(track.maxActive(), 2, 'never more than the configured limit ran at once');
});

test('a hostname with no entry takes the default limit', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({
    fetch: track.fetchFn,
    limits: { default: 1, perHost: { 'other.example': 5 } },
  });

  const first = hostFetch.json<Echo>('http://a.example/one');
  const second = hostFetch.json<Echo>('http://a.example/two');

  await tick();
  assert.equal(track.activeNow(), 1, 'a.example has no entry in perHost, so it falls back to the default of one');

  track.releaseNext();
  await first;
  await tick();
  track.releaseNext();
  await second;

  assert.equal(track.maxActive(), 1);
});

test('a non-2xx response rejects rather than returning a body', async () => {
  const fetchFn: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ url: 'unreachable' } satisfies Echo), { status: 404, statusText: 'Not Found' });
  const hostFetch = createHostFetch({ fetch: fetchFn });

  await assert.rejects(hostFetch.json<Echo>('http://a.example/missing'), /404/);
});

test('the limit is keyed by hostname, so two hosts proceed in parallel', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn });

  const a = hostFetch.json<Echo>('http://a.example/one');
  const b = hostFetch.json<Echo>('http://b.example/one');

  await tick();
  assert.equal(track.activeNow(), 2, 'requests to different hosts must run concurrently');

  track.releaseNext();
  track.releaseNext();
  const [resultA, resultB] = await Promise.all([a, b]);
  assert.equal(resultA.url, 'http://a.example/one');
  assert.equal(resultB.url, 'http://b.example/one');
});

test('text shares its hostname queue with json and bytes, so a feed is paced like any other call to that host', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn });

  const first = hostFetch.json<Echo>('http://a.example/feed.json');
  const second = hostFetch.text('http://a.example/feed.xml');

  await tick();
  assert.equal(track.activeNow(), 1, 'a text request to a hostname already at its limit must wait its turn');

  track.releaseNext();
  await first;

  await tick();
  assert.equal(track.activeNow(), 1, 'the text request only starts once the json request has finished');
  track.releaseNext();
  const secondResult = await second;
  assert.equal(secondResult, JSON.stringify({ url: 'http://a.example/feed.xml' } satisfies Echo));

  assert.equal(track.maxActive(), 1, 'json and text to the same host never ran at once');
});

test('the hostname comes from the url, so a caller cannot opt out of its limit', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn });

  // Nothing in `json`/`bytes` accepts a key other than the url itself, so
  // two different paths on one host still land on the same queue and share
  // its limit -- there is no parameter a caller could pass to escape it.
  const first = hostFetch.bytes('http://a.example/one');
  const second = hostFetch.bytes('http://a.example/two');

  await tick();
  assert.equal(track.activeNow(), 1, 'two different paths on one host must still serialise');

  track.releaseNext();
  const firstBytes = await first;
  const firstEcho = JSON.parse(new TextDecoder().decode(firstBytes)) as Echo;
  assert.equal(firstEcho.url, 'http://a.example/one');

  await tick();
  assert.equal(track.activeNow(), 1, 'the second path only starts once the first has finished');
  track.releaseNext();
  const secondBytes = await second;
  const secondEcho = JSON.parse(new TextDecoder().decode(secondBytes)) as Echo;
  assert.equal(secondEcho.url, 'http://a.example/two');

  assert.equal(track.maxActive(), 1);
});

/**
 * `createHostFetch` never calls this in the validation tests below --
 * construction either throws before any request is made, or succeeds and
 * no request is issued -- so it only has to satisfy the type, not do
 * anything real.
 */
const unusedFetch: typeof globalThis.fetch = async () => new Response('{}');

test('a default limit of 0 throws at construction, naming "default" and the value', () => {
  assert.throws(
    () => createHostFetch({ fetch: unusedFetch, limits: { default: 0 } }),
    /'default'.*\b0\b/,
  );
});

test('a perHost limit of 0 throws at construction, naming the hostname and the value', () => {
  assert.throws(
    () => createHostFetch({ fetch: unusedFetch, limits: { default: 1, perHost: { 'a.example': 0 } } }),
    /'a\.example'.*\b0\b/,
  );
});

test('a negative limit throws at construction', () => {
  assert.throws(
    () => createHostFetch({ fetch: unusedFetch, limits: { default: -1 } }),
    /'default'.*-1/,
  );
});

test('a valid perHost limit of 1 and a large value both construct without throwing', () => {
  assert.doesNotThrow(() =>
    createHostFetch({ fetch: unusedFetch, limits: { default: 1, perHost: { 'a.example': 1, 'b.example': 1000 } } }),
  );
});
