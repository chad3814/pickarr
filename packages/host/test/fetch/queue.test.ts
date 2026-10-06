import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostFetch, FetchFailedError } from '../../src/fetch/queue.ts';

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

/**
 * The two resolver functions `createHostFetch` now takes, built from the
 * static shape the tests used to pass. Static here on purpose: these tests
 * are about the queue, and `settings.test.ts` is about where numbers come
 * from.
 */
function policy(opts: {
  limits?: { default: number; perHost?: Record<string, number> };
  timeouts?: { default: number; perHost?: Record<string, number> };
}): { limitFor: (hostname: string) => number; timeoutFor: (hostname: string) => number } {
  return {
    limitFor: (hostname) => opts.limits?.perHost?.[hostname] ?? opts.limits?.default ?? 1,
    timeoutFor: (hostname) => opts.timeouts?.perHost?.[hostname] ?? opts.timeouts?.default ?? 30_000,
  };
}

/**
 * A stand-in `fetch` that always answers 401, for the tests that check what
 * a caller can learn from a rejected request's `status`. Module scope,
 * rather than declared inside its test: it captures nothing from either
 * test that uses it.
 */
const unauthorizedFetch: typeof globalThis.fetch = async () => new Response('', { status: 401, statusText: 'Unauthorized' });

test('two requests to one hostname do not overlap at the default limit of one', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn, ...policy({}) });

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
  const hostFetch = createHostFetch({ fetch: fetchFn, ...policy({}) });

  await assert.rejects(hostFetch.json<Echo>('http://a.example/one'), /network exploded/);

  // The rejection above must have released the slot: a *subsequent* request
  // to the *same* hostname has to actually run, not merely fail to hang. If
  // the slot never freed, this call would wait forever on a promise nothing
  // will settle -- awaiting only the rejection above would miss that.
  const second = await hostFetch.json<Echo>('http://a.example/two');
  assert.equal(second.url, 'recovered');
  assert.equal(calls, 2, 'the second call to the same hostname actually reached fetch');
});

test('a request that never settles times out, rejects, and releases its hostname slot', async () => {
  // The wedge this guards: a hung request holds its hostname's only slot,
  // and with it one of the dispatcher's concurrency slots, so nothing else
  // for that hostname -- or in that slot -- ever runs again for as long as
  // the process is up. `Host.stop()` no longer waits on it, so this does not
  // keep `SIGTERM` from ending the process, only from ever using that slot
  // again. `timeoutMs` is small only so the test need not wait the shipped
  // thirty seconds.
  let calls = 0;
  const fetchFn: typeof globalThis.fetch = async (input) => {
    calls += 1;
    // The first call ignores the signal entirely and never settles -- the
    // exact behaviour a real unresponsive host produces, and the case a
    // signal alone would not save this from.
    if (calls === 1) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ url: String(input) } satisfies Echo), { status: 200 });
  };
  const hostFetch = createHostFetch({ fetch: fetchFn, ...policy({ timeouts: { default: 20 } }) });

  await assert.rejects(
    hostFetch.text('http://a.example/hangs'),
    /timed out after 20ms/,
    'a hung request must reject on the timeout, not hang forever',
  );

  // And the rejection has to have run `enqueue`'s release: a *later* request
  // to the *same* hostname has to actually reach fetch, not queue behind a
  // slot nothing will ever grant.
  const second = await hostFetch.json<Echo>('http://a.example/after');
  assert.equal(second.url, 'http://a.example/after');
  assert.equal(calls, 2, 'the next request to the same hostname actually reached fetch');
});

test('a request spends its budget while waiting for its hostname slot, not only while running', async () => {
  // The half of the wedge that lives in the queue rather than in the request.
  // Both requests are asked for in the same tick; the first ignores its
  // signal and never settles, so it holds the sole slot for the whole
  // forty-millisecond budget. The second is woken the instant the first's
  // own race gives the slot up.
  //
  // The second's fetch answers in twenty milliseconds. That is the
  // discriminator, and this test asserts the OPPOSITE of what it asserted
  // before the timeout moved inside the queued task: the second request now
  // starts its own forty-millisecond window on being woken and resolves at
  // roughly sixty milliseconds, having waited untimed.
  //
  // That is the intended meaning. A per-hostname ceiling is a statement
  // about how long that service takes to answer, and the far end has no
  // idea how long this process left the request in a queue. What the change
  // gives up is this function bounding total wall clock: that is now the
  // caller's signal's job, and `run-job.ts`'s `JOB_TIMEOUT_MS` is the
  // ceiling that actually does it, deliberately set above the largest
  // per-hostname timeout. The next test pins the half of that which lives
  // here.
  let calls = 0;
  const fetchFn: typeof globalThis.fetch = async (input) => {
    calls += 1;
    if (calls === 1) return new Promise<Response>(() => {});
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    return new Response(JSON.stringify({ url: String(input) } satisfies Echo), { status: 200 });
  };
  const hostFetch = createHostFetch({ fetch: fetchFn, ...policy({ timeouts: { default: 40 } }) });

  const first = hostFetch.json<Echo>('http://a.example/hangs');
  const second = hostFetch.json<Echo>('http://a.example/queued-behind-it');

  await assert.rejects(first, /timed out after 40ms/);
  const answered = await second;
  assert.equal(
    answered.url,
    'http://a.example/queued-behind-it',
    'a request gets its full budget from the moment its slot is granted, not from when it was asked for',
  );
  assert.equal(calls, 2, 'the woken request reached fetch');
});

test('a caller that aborted while queued is not spent on a real request', async () => {
  // The replacement for the `timeout.aborted` short-circuit that the move
  // made dead code. A request whose job already gave up must not, on
  // finally reaching the front of the queue, issue a fetch nobody will read
  // -- and must not make everything behind it wait while it does.
  //
  // `calls` is the assertion that matters: 1, not 2. The mutation this
  // catches is deleting the short-circuit, which leaves the second request
  // issuing a real fetch against an aborted job.
  let calls = 0;
  const fetchFn: typeof globalThis.fetch = async (input) => {
    calls += 1;
    if (calls === 1) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ url: String(input) } satisfies Echo), { status: 200 });
  };
  const hostFetch = createHostFetch({ fetch: fetchFn, ...policy({ timeouts: { default: 40 } }) });

  const controller = new AbortController();
  const first = hostFetch.json<Echo>('http://a.example/hangs');
  const second = hostFetch.json<Echo>('http://a.example/gives-up', { signal: controller.signal });
  await tick();
  controller.abort();

  await assert.rejects(first, /timed out after 40ms/);
  await assert.rejects(second, /abandoned: the caller aborted while it waited for a slot/);
  assert.equal(calls, 1, 'the abandoned request never reached fetch');
});

test('a perHost timeout applies to its own hostname and leaves every other one on the default', async () => {
  // The whole point of the per-hostname shape: the lookup service is
  // allowed minutes, and a tracker is still cut off in milliseconds. One
  // global number cannot express both.
  const fetchFn: typeof globalThis.fetch = async (input) => {
    if (String(input).includes('slow.example')) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
      return new Response(JSON.stringify({ url: String(input) } satisfies Echo), { status: 200 });
    }
    return new Promise<Response>(() => {});
  };
  const hostFetch = createHostFetch({
    fetch: fetchFn,
    ...policy({ timeouts: { default: 20, perHost: { 'slow.example': 5_000 } } }),
  });

  const generous = await hostFetch.json<Echo>('http://slow.example/takes-40ms');
  assert.equal(generous.url, 'http://slow.example/takes-40ms', 'its own entry gave it room the default would not have');

  await assert.rejects(
    hostFetch.json<Echo>('http://other.example/hangs'),
    /timed out after 20ms/,
    'a hostname with no entry of its own is still on the default',
  );
});

test('a response whose body never completes times out too, and releases its hostname slot', async () => {
  // The other half of the same wedge, and the one a race around `fetch`
  // alone does not cover: the headers arrive promptly, so the response
  // resolves and any timeout that only wrapped `fetch` has already settled
  // successfully -- and then the body read hangs forever, holding the
  // hostname slot and a dispatcher concurrency slot with it. The body read
  // has to be inside the timeout window, which is why `timed` calls `read`
  // inside the race rather than after it.
  let calls = 0;
  const fetchFn: typeof globalThis.fetch = async (input) => {
    calls += 1;
    // A stream that is never enqueued to and never closed, and a signal this
    // fake deliberately ignores -- a real stalled server, minus the socket.
    if (calls === 1) return new Response(new ReadableStream({ start() {} }));
    return new Response(JSON.stringify({ url: String(input) } satisfies Echo), { status: 200 });
  };
  const hostFetch = createHostFetch({ fetch: fetchFn, ...policy({ timeouts: { default: 20 } }) });

  await assert.rejects(
    hostFetch.text('http://a.example/stalls'),
    /timed out after 20ms/,
    'a response whose body never completes must reject on the timeout, not hang reading it',
  );

  // And the slot has to be free again: the release runs off the rejection,
  // so a timeout that never rejects is also a timeout that never releases.
  const second = await hostFetch.json<Echo>('http://a.example/after');
  assert.equal(second.url, 'http://a.example/after');
  assert.equal(calls, 2, 'the next request to the same hostname actually reached fetch');
});

test('a caller\'s own abort signal is composed with the timeout, not replaced by it', async () => {
  // `text`/`json`/`bytes` all take a `RequestInit`, so a caller may already
  // have a signal of its own. Overwriting it with the timeout's would make
  // the caller's abort silently do nothing.
  const seen: Array<AbortSignal | null | undefined> = [];
  const fetchFn: typeof globalThis.fetch = async (_input, init) => {
    seen.push(init?.signal);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by the caller')); }, { once: true });
    });
  };
  const hostFetch = createHostFetch({ fetch: fetchFn, ...policy({ timeouts: { default: 30_000 } }) });

  const controller = new AbortController();
  const pending = hostFetch.text('http://a.example/slow', { signal: controller.signal });
  await tick();
  const handed = seen[0];
  assert.ok(handed !== undefined && handed !== null, 'fetch was handed a signal');
  assert.equal(handed.aborted, false, 'nothing has aborted yet');

  controller.abort();
  await assert.rejects(pending, /aborted by the caller/, 'the caller\'s abort still reaches fetch');
});

test('a per-host limit of two lets two run at once and makes a third wait', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn, ...policy({ limits: { default: 1, perHost: { 'a.example': 2 } } }) });

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
    ...policy({ limits: { default: 1, perHost: { 'other.example': 5 } } }),
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
  const hostFetch = createHostFetch({ fetch: fetchFn, ...policy({}) });

  await assert.rejects(hostFetch.json<Echo>('http://a.example/missing'), /404/);
});

test('a non-2xx response carries the numeric status, not just prose about it', async () => {
  // An adapter that needs to tell 401/403 apart from any other failure (a
  // bearer-auth qBittorrent client, say) must not have to pattern-match this
  // module's own message text to do it -- that breaks the moment the message
  // is reworded, as it already was once when redaction went in.
  const hostFetch = createHostFetch({ fetch: unauthorizedFetch, ...policy({}) });

  await assert.rejects(
    hostFetch.json('http://a.example/secure'),
    (error: unknown) => {
      assert.ok(error instanceof FetchFailedError);
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test('the queue names a failing url without its credential', async () => {
  // The regression test for the live leak: SABnzbd's api key travels as
  // `?apikey=`, so a failing request against a url bearing one must not put
  // that key -- or the string it was set to -- into the error message. The
  // parameter's name staying visible (as `apikey=***`) is fine and expected;
  // only the value itself, `not-a-real-key`, must be gone.
  const secret = 'not-a-real-key';
  const hostFetch = createHostFetch({
    ...policy({}),
    fetch: async () => new Response('', { status: 401, statusText: 'Unauthorized' }),
  });

  await assert.rejects(
    hostFetch.json(`http://a.example/api?apikey=${secret}&mode=addurl`),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        !error.message.includes(secret),
        `error message must not contain the credential value, got: ${error.message}`,
      );
      assert.match(error.message, /apikey=\*\*\*/, 'the parameter name should stay visible, with its value redacted');
      return true;
    },
  );
});

test('the limit is keyed by hostname, so two hosts proceed in parallel', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn, ...policy({}) });

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
  const hostFetch = createHostFetch({ fetch: track.fetchFn, ...policy({}) });

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
  const hostFetch = createHostFetch({ fetch: track.fetchFn, ...policy({}) });

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
 * For the tests below that build a `createHostFetch` and never issue a
 * request through it, so it only has to satisfy the type, not do anything
 * real.
 */
const unusedFetch: typeof globalThis.fetch = async () => new Response('{}');

test('snapshot shows waiting and in-flight requests by method and redacted target, and empties when they settle', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const changes: number[] = [];
  const fetch = createHostFetch({
    fetch: async () => {
      await gate;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    ...policy({ limits: { default: 1 } }),
    onChange: () => { changes.push(1); },
  });
  const first = fetch.json('https://sab.example:8080/api?mode=queue&apikey=SECRETKEY', { method: 'GET' });
  const second = fetch.json('https://sab.example:8080/api?mode=history&apikey=SECRETKEY', { method: 'GET' });
  await tick();
  const [host] = fetch.snapshot();
  assert.ok(host);
  assert.equal(host.hostname, 'sab.example');
  assert.equal(host.limit, 1);
  assert.deepEqual(host.inFlight, [{ method: 'GET', target: 'https://sab.example:8080/api' }]);
  assert.deepEqual(host.waiting, [{ method: 'GET', target: 'https://sab.example:8080/api' }]);
  assert.ok(!JSON.stringify(fetch.snapshot()).includes('SECRETKEY'), 'the key is nowhere in the snapshot');
  assert.ok(changes.length >= 2, 'onChange fired for each enqueue');
  release?.();
  await Promise.all([first, second]);
  assert.deepEqual(fetch.snapshot(), [], 'settled requests leave the snapshot');
});

test('a passkey in the path is masked in the target', async () => {
  let release: (() => void) | undefined;
  const fetch = createHostFetch({
    ...policy({}),
    fetch: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response('x');
    },
  });
  const pending = fetch.text('https://tracker.example/announce/0123456789abcdef0123456789abcdef/download?id=1');
  await tick();
  const target = fetch.snapshot()[0]?.inFlight[0]?.target ?? '';
  // `redactSecrets` masks this path as two runs (digits, then the rest); the
  // exact split is its business, so pin only that the passkey is gone and the
  // rest of the target, with no query string, survives.
  assert.match(target, /^https:\/\/tracker\.example\/announce\/012\*{5}.*\/download$/);
  assert.ok(!/[0-9a-f]{8}/.test(target), `no run of 8 hex characters survives: ${target}`);
  release?.();
  await pending;
});

test('the target drops userinfo and the fragment as well as the query, and still masks a passkey in the path', async () => {
  let release: (() => void) | undefined;
  const fetch = createHostFetch({
    ...policy({}),
    fetch: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response('x');
    },
  });
  const pending = fetch.text('https://admin:hunter2@qbit.local:8080/announce/0123456789abcdef0123456789abcdef/x?k=1#frag');
  await tick();
  const target = fetch.snapshot()[0]?.inFlight[0]?.target ?? '';
  assert.match(target, /^https:\/\/qbit\.local:8080\/announce\/012\*{5}.*\/x$/);
  assert.ok(!target.includes('admin'), `no username: ${target}`);
  assert.ok(!target.includes('hunter2'), `no password: ${target}`);
  assert.ok(!target.includes('@'), `no userinfo: ${target}`);
  assert.ok(!target.includes('#') && !target.includes('frag'), `no fragment: ${target}`);
  assert.ok(!/[0-9a-f]{8}/.test(target), `no run of 8 hex characters survives: ${target}`);
  release?.();
  await pending;
});

test('failed requests leave the snapshot; hosts sort by name and a missing method reads as GET', async () => {
  const releases: Array<() => void> = [];
  const changes: number[] = [];
  const fetch = createHostFetch({
    ...policy({}),
    fetch: async () => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return new Response('nope', { status: 500, statusText: 'Server Error' });
    },
    onChange: () => { changes.push(1); },
  });
  const failures = [
    assert.rejects(fetch.text('https://b.example/y'), FetchFailedError),
    assert.rejects(fetch.text('https://a.example/x', { method: 'POST' }), FetchFailedError),
  ];
  await tick();
  assert.deepEqual(
    fetch.snapshot().map((host) => [host.hostname, host.inFlight.map((r) => r.method)]),
    [['a.example', ['POST']], ['b.example', ['GET']]],
  );
  for (const release of releases) release();
  await Promise.all(failures);
  assert.deepEqual(fetch.snapshot(), [], 'a failed request leaves the snapshot');
  assert.equal(changes.length, 6, 'enqueue, start and settle each notify, for both requests');
});

test('an unparseable url rejects before anything is queued, so the snapshot stays empty', async () => {
  const fetch = createHostFetch({ fetch: unusedFetch, ...policy({}) });
  await assert.rejects(fetch.text('not a url'));
  assert.deepEqual(fetch.snapshot(), []);
});

test('timeoutFor is read when a request starts, so a change made while it waits applies to it', async () => {
  // `AbortSignal.timeout` is real here; the numbers are small.
  let timeoutMs = 10_000;
  const track = trackingFetch();
  const hostFetch = createHostFetch({
    fetch: track.fetchFn,
    limitFor: () => 1,
    timeoutFor: () => timeoutMs,
  });
  const first = hostFetch.json<Echo>('https://a.example/1');
  const second = hostFetch.json<Echo>('https://a.example/2');
  await tick();
  timeoutMs = 20; // tightened while `second` waits for the one slot
  track.releaseNext();
  await first;
  await assert.rejects(second, /timed out after 20ms/, 'the second read the new ceiling when it started');
});

test('limitFor is re-read on every enqueue and applied to the hostname\'s queue', async () => {
  let limit = 1;
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn, limitFor: () => limit, timeoutFor: () => 30_000 });
  const a = hostFetch.json<Echo>('https://a.example/1');
  const b = hostFetch.json<Echo>('https://a.example/2');
  await tick();
  assert.equal(track.activeNow(), 1);

  limit = 3;
  const c = hostFetch.json<Echo>('https://a.example/3');
  await tick();
  assert.equal(track.activeNow(), 3, 'the third enqueue raised the limit and released the waiter too');
  assert.equal(hostFetch.snapshot()[0]?.limit, 3);

  track.releaseNext(); track.releaseNext(); track.releaseNext();
  await Promise.all([a, b, c]);
});

test('seen lists every hostname that has had a request, in first-seen order', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn, limitFor: () => 2, timeoutFor: () => 30_000 });
  assert.deepEqual(hostFetch.seen(), []);
  const a = hostFetch.json<Echo>('https://b.example/1');
  const b = hostFetch.json<Echo>('https://a.example/1');
  await tick();
  assert.deepEqual(hostFetch.seen(), ['b.example', 'a.example']);
  track.releaseNext(); track.releaseNext();
  await Promise.all([a, b]);
  assert.deepEqual(hostFetch.seen(), ['b.example', 'a.example'], 'completion removes nothing');
});
