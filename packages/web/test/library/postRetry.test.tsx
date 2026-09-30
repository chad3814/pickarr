import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { postRetry, RETRY_REFUSAL_MESSAGES } from '../../src/library/postRetry.ts';
import { fetchStub, jsonResponse } from '../fetchStub.ts';

/**
 * No component is rendered here; `globalThis.fetch` is restored
 * unconditionally in `afterEach`. A `.tsx` extension with no JSX in it
 * because `npm run test:web` globs `*.test.tsx` only.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('postRetry reports an accepted retry, posting to the release path with the session cookie and no body', async () => {
  const seen: [string, RequestInit | undefined][] = [];
  globalThis.fetch = fetchStub((url, init) => {
    seen.push([url, init]);
    return Promise.resolve(jsonResponse({ accepted: true }, 202));
  });
  assert.deepEqual(await postRetry(9), { accepted: true });
  assert.equal(seen[0]?.[0], '/api/unmatched/9/retry');
  assert.equal(seen[0]?.[1]?.method, 'POST');
  assert.equal(seen[0]?.[1]?.credentials, 'same-origin');
  assert.equal(seen[0]?.[1]?.body, undefined);
});

test('postRetry reads its refusals off the body', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'already-matched' }, 409)));
  assert.deepEqual(await postRetry(9), { refusal: 'already-matched' });
});

test('a 401 -- the expired session -- reads as expired, not as the version-skew catch-all', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await postRetry(9), { refusal: 'expired' });
  assert.equal(RETRY_REFUSAL_MESSAGES.expired, 'Your session expired. Sign in again.');
});

test('a bare { error } on any other status reads as unrecognised', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'internal' }, 500)));
  assert.deepEqual(await postRetry(9), { refusal: 'unrecognised' });
});

test('a rejected fetch and an unparseable body both read as offline', async () => {
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await postRetry(9), { refusal: 'offline' });
  globalThis.fetch = fetchStub(() => Promise.resolve(new Response('<html>502</html>', { status: 502 })));
  assert.deepEqual(await postRetry(9), { refusal: 'offline' });
});

test('no retry outcome borrows another one\'s sentence', () => {
  const sentences = Object.values(RETRY_REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length);
  assert.deepEqual(Object.keys(RETRY_REFUSAL_MESSAGES).toSorted(),
    ['already-matched', 'expired', 'offline', 'plugin-not-registered', 'unknown-release', 'unrecognised']);
});
