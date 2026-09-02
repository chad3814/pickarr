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

/** Lets pending microtasks (including a queue's own `.then` chaining) run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('two requests to one hostname do not overlap', async () => {
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

test('requests to different hostnames do overlap', async () => {
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

test('a rejected request does not wedge its hostname queue', async () => {
  let calls = 0;
  const fetchFn: typeof globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network exploded');
    return new Response(JSON.stringify({ url: 'recovered' } satisfies Echo), { status: 200 });
  };
  const hostFetch = createHostFetch({ fetch: fetchFn });

  await assert.rejects(hostFetch.json<Echo>('http://a.example/one'), /network exploded/);

  // If the rejection above had wedged the host's queue, this would hang
  // forever rather than resolve.
  const second = await hostFetch.json<Echo>('http://a.example/two');
  assert.equal(second.url, 'recovered');
});

test('a non-2xx response rejects rather than returning a body', async () => {
  const fetchFn: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ url: 'unreachable' } satisfies Echo), { status: 404, statusText: 'Not Found' });
  const hostFetch = createHostFetch({ fetch: fetchFn });

  await assert.rejects(hostFetch.json<Echo>('http://a.example/missing'), /404/);
});

test('the queue is keyed by hostname, not by full url', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn });

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
