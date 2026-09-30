import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendJson } from '../../src/auth/sendJson.ts';
import { subscribeSessionExpired, SESSION_EXPIRED_MESSAGE } from '../../src/auth/sessionExpired.ts';
import { fetchStub, jsonResponse } from '../fetchStub.ts';

/**
 * No component is rendered here. `globalThis.fetch` and every session-expired
 * subscription a test registers are undone in `afterEach`, which runs whether
 * the test passed or threw (`CLAUDE.md`): the signal is module-level, so a
 * listener left behind by one test would count the next test's 401s. A
 * `.tsx` extension with no JSX in it because `npm run test:web` globs
 * `*.test.tsx` only.
 */
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Counts how many times the session-expired signal fires during one test. */
function countExpired(): { readonly count: () => number } {
  let fired = 0;
  cleanups.push(subscribeSessionExpired(() => { fired += 1; }));
  return { count: () => fired };
}

test('a 401 answers expired, not an answer to read, and fires the session-expired signal exactly once', async () => {
  const expired = countExpired();
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));

  assert.deepEqual(await sendJson('/api/feeds', { method: 'POST', body: { a: 1 } }), { outcome: 'expired' });
  assert.equal(expired.count(), 1, 'the shell is told once, so it can send the operator back to sign-in');
});

test('a 401 whose body cannot be parsed is still expired: the status is the whole of the evidence', async () => {
  const expired = countExpired();
  globalThis.fetch = fetchStub(() => Promise.resolve(new Response('<html>nope</html>', { status: 401 })));

  assert.deepEqual(await sendJson('/api/picks', { method: 'POST' }), { outcome: 'expired' });
  assert.equal(expired.count(), 1);
});

test('a rejected fetch answers offline and fires nothing', async () => {
  const expired = countExpired();
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch https://pickarr.invalid/api/feeds')));

  assert.deepEqual(await sendJson('/api/feeds', { method: 'POST', body: {} }), { outcome: 'offline' });
  assert.equal(expired.count(), 0, 'no answer is not an expired session');
});

test('a JSON answer is handed back with its status and body, whatever the status', async () => {
  const expired = countExpired();
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ id: 42 }, 201)));
  assert.deepEqual(await sendJson('/api/feeds', { method: 'POST', body: {} }),
    { outcome: 'answered', status: 201, body: { id: 42 } });

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'duplicate-url' }, 409)));
  assert.deepEqual(await sendJson('/api/feeds', { method: 'POST', body: {} }),
    { outcome: 'answered', status: 409, body: { refusal: 'duplicate-url' } });

  assert.equal(expired.count(), 0);
});

test('an unparseable body answers offline -- what every post* helper did with one before this module existed', async () => {
  globalThis.fetch = fetchStub(() =>
    Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
  assert.deepEqual(await sendJson('/api/picks', { method: 'POST', body: {} }), { outcome: 'offline' });

  globalThis.fetch = fetchStub(() => Promise.resolve(new Response('not json', { status: 200 })));
  assert.deepEqual(await sendJson('/api/picks', { method: 'POST', body: {} }), { outcome: 'offline' });
});

test('a 204 carries no body by definition, so it is an answer with none rather than an unreadable one', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(new Response(null, { status: 204 })));
  assert.deepEqual(await sendJson('/api/mappings/4', { method: 'DELETE' }),
    { outcome: 'answered', status: 204, body: undefined });
});

test('a body is sent as JSON with its content type; no body sends neither; the session cookie rides along either way', async () => {
  const seen: (RequestInit | undefined)[] = [];
  globalThis.fetch = fetchStub((_url, init) => {
    seen.push(init);
    return Promise.resolve(jsonResponse({}, 200));
  });

  await sendJson('/api/feeds/3', { method: 'PATCH', body: { disabled: true } });
  await sendJson('/api/unmatched/3/retry', { method: 'POST' });

  const [withBody, withoutBody] = seen;
  assert.equal(withBody?.method, 'PATCH');
  assert.equal(withBody?.credentials, 'same-origin');
  assert.deepEqual(withBody?.headers, { 'content-type': 'application/json' });
  assert.equal(withBody?.body, '{"disabled":true}');

  assert.equal(withoutBody?.method, 'POST');
  assert.equal(withoutBody?.credentials, 'same-origin');
  assert.equal(withoutBody?.headers, undefined, 'no content-type claims a body that is not there');
  assert.equal(withoutBody?.body, undefined);
});

test('sendJson never throws, even when fetch throws synchronously', async () => {
  globalThis.fetch = () => {
    throw new Error('DNS is on fire');
  };
  assert.deepEqual(await sendJson('/api/feeds', { method: 'POST', body: {} }), { outcome: 'offline' });
});

test('a subscriber that unsubscribes twice detaches only itself', async () => {
  // `store/notify.ts`'s idempotent-unsubscribe defect, reproduced against
  // this registry: a second call must not detach a listener added since.
  const first = subscribeSessionExpired(() => {});
  first();
  const later = countExpired();
  first();

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  await sendJson('/api/picks', { method: 'POST' });
  assert.equal(later.count(), 1, 'the later subscriber still hears the signal');
});

test('the shared sentence is spelled literally once, here', () => {
  assert.equal(SESSION_EXPIRED_MESSAGE, 'Your session expired. Sign in again.');
});
