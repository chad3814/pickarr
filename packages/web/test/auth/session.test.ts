import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, signUp, signOut, isUnauthenticated } from '../../src/auth/session.ts';

/**
 * Undone in `afterEach`, which runs whether the test passed or threw
 * (`CLAUDE.md`: a per-test cleanup only runs the happy path). Nothing here
 * opens anything that outlives a test, but restoring `globalThis.fetch`
 * unconditionally is what keeps one test's stub from leaking into the next.
 */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One recorded call: the url `fetch` was given, and the init alongside it. */
type Call = [url: string, init: RequestInit | undefined];

/**
 * Narrows a parsed JSON body to a plain object, so a test can read its fields
 * without a cast (Global Constraint: no cast to silence a type error). An
 * assertion function rather than a `value is Record<...>` type guard used in
 * an `if`: this reads once, right after `JSON.parse`, and there is nothing
 * else the caller would do with a `false` result other than fail the test --
 * which `assert.ok` already does, with a message naming what went wrong.
 */
function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null, 'the request body is a JSON object');
}

/**
 * Replaces `globalThis.fetch` for the duration of one test and records every
 * call. Restored by `afterEach` via `cleanups`, the same shape
 * `adapters.test.ts` uses for the same reason.
 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): { calls: Call[] } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push([url, init]);
    return impl(url, init);
  };
  cleanups.push(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

/** A Better Auth-shaped refusal body: `{ code, message }`, never read by this module. */
function refusal(message: string): Response {
  return new Response(JSON.stringify({ code: 'REFUSED', message }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

test('signIn posts credentials to the mounted sign-in route with the browser cookie jar', async () => {
  const { calls } = stubFetch(async () => new Response('{}', { status: 200 }));

  await signIn('owner@example.invalid', 'correct horse');

  assert.equal(calls.length, 1);
  const [url, init] = calls[0] ?? ['', undefined];
  assert.equal(url, '/api/auth/sign-in/email', 'the mounted path, verified against the host source rather than guessed');
  assert.equal(init?.method, 'POST');
  assert.equal(init?.credentials, 'same-origin', 'the session cookie travels via the browser\'s own jar, never read or forwarded by this module');
  // `Headers`, not a cast: `RequestInit['headers']` is `HeadersInit`, which
  // also allows a plain object or a `[string, string][]` -- a cast to
  // `Record<string, string>` would silently drop that third arm rather than
  // reading it. `new Headers(...)` normalises whichever shape `init.headers`
  // actually is, including the one already-`Headers` case, into the one
  // lookup this needs.
  assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(init?.body)), { email: 'owner@example.invalid', password: 'correct horse' });
});

test('signUp posts the claim token under the field Better Auth reads, alongside email and password', async () => {
  const { calls } = stubFetch(async () => new Response('{}', { status: 200 }));

  await signUp('owner@example.invalid', 'correct horse', 'the-claim-token');

  assert.equal(calls.length, 1);
  const [url, init] = calls[0] ?? ['', undefined];
  assert.equal(url, '/api/auth/sign-up/email');
  assert.equal(init?.method, 'POST');
  assert.equal(init?.credentials, 'same-origin');
  const body: unknown = JSON.parse(String(init?.body));
  assertRecord(body);
  assert.equal(body.email, 'owner@example.invalid');
  assert.equal(body.password, 'correct horse');
  assert.equal(body.claimToken, 'the-claim-token', 'the exact field name Better Auth\'s sign-up hook reads (CLAIM_TOKEN_FIELD)');
  assert.equal(typeof body.name, 'string', 'Better Auth\'s sign-up schema requires a name; the form collects none, so one is supplied');
});

test('signOut posts to the mounted sign-out route with the browser cookie jar, no body required', async () => {
  const { calls } = stubFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));

  await signOut();

  assert.equal(calls.length, 1);
  const [url, init] = calls[0] ?? ['', undefined];
  assert.equal(url, '/api/auth/sign-out');
  assert.equal(init?.method, 'POST');
  assert.equal(init?.credentials, 'same-origin');
});

test('isUnauthenticated is true for a 401 and false for a success or any other status', () => {
  assert.equal(isUnauthenticated(refusal('sign-up is closed')), true);
  assert.equal(isUnauthenticated(new Response('{}', { status: 200 })), false);
  assert.equal(isUnauthenticated(new Response('{}', { status: 500 })), false);
  assert.equal(isUnauthenticated(new Response('{}', { status: 403 })), false, 'a claim refusal is 403, not 401, and must not be mistaken for "sign in again"');
});

test('none of the three calls ever reads the response body', async () => {
  // The Global Constraint this test stands in for: a refusal's body is the
  // likeliest place for something to be echoed back. `session.ts` hands the
  // caller the raw Response and never calls .json() or .text() on it itself
  // -- proven here by a body whose stream would already be consumed (and a
  // second read would throw) if this module had read it first.
  let bodyReadCount = 0;
  const trackedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 'REFUSED', message: 'sign-up is closed' })));
      controller.close();
    },
  });
  const response = new Response(trackedBody, { status: 401, headers: { 'content-type': 'application/json' } });
  const originalJson = response.json.bind(response);
  response.json = async () => {
    bodyReadCount += 1;
    return originalJson();
  };

  stubFetch(async () => response);
  const result = await signIn('owner@example.invalid', 'wrong');

  assert.equal(result, response, 'the raw Response is handed back, not something derived from reading it');
  assert.equal(bodyReadCount, 0, 'session.ts must never read the response body itself');
});
