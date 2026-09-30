import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { removeFeed, setFeedDisabled, removalMessage, FEED_REFUSAL_MESSAGES } from '../../src/settings/postFeedRemoval.ts';
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

test('removeFeed reports a deletion and a disable, each off the body', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ outcome: 'deleted' }, 200)));
  assert.deepEqual(await removeFeed(4), { outcome: 'deleted' });
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ outcome: 'disabled', items: 3 }, 200)));
  assert.deepEqual(await removeFeed(4), { outcome: 'disabled', items: 3 });
});

test('removeFeed sends DELETE to the feed and setFeedDisabled a JSON PATCH, both with the session cookie', async () => {
  const seen: [string, RequestInit | undefined][] = [];
  globalThis.fetch = fetchStub((url, init) => {
    seen.push([url, init]);
    return Promise.resolve(jsonResponse({ outcome: 'deleted' }, 200));
  });
  await removeFeed(4);
  await setFeedDisabled(4, true);
  assert.equal(seen[0]?.[0], '/api/feeds/4');
  assert.equal(seen[0]?.[1]?.method, 'DELETE');
  assert.equal(seen[0]?.[1]?.credentials, 'same-origin');
  assert.equal(seen[1]?.[0], '/api/feeds/4');
  assert.equal(seen[1]?.[1]?.method, 'PATCH');
  assert.equal(seen[1]?.[1]?.body, '{"disabled":true}');
});

test('unknown-feed is read off the body on either route', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-feed' }, 404)));
  assert.deepEqual(await removeFeed(4), { outcome: 'refused', refusal: 'unknown-feed' });
  assert.deepEqual(await setFeedDisabled(4, false), { outcome: 'refused', refusal: 'unknown-feed' });
});

test('a 401 -- the expired session -- reads as expired on both routes, not as unexpected', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await removeFeed(4), { outcome: 'refused', refusal: 'expired' });
  assert.deepEqual(await setFeedDisabled(4, true), { outcome: 'refused', refusal: 'expired' });
  assert.equal(removalMessage({ outcome: 'refused', refusal: 'expired' }), 'Your session expired. Sign in again.');
});

test('setFeedDisabled reports the state it asked for once the host accepts', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ outcome: 'disabled' }, 200)));
  assert.deepEqual(await setFeedDisabled(4, true), { outcome: 'disabled' });
  assert.deepEqual(await setFeedDisabled(4, false), { outcome: 'enabled' });
});

test('a rejected fetch reads as unreachable; an answer this page cannot read as unexpected', async () => {
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await removeFeed(4), { outcome: 'refused', refusal: 'unreachable' });
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'internal' }, 500)));
  assert.deepEqual(await removeFeed(4), { outcome: 'refused', refusal: 'unexpected' });
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ outcome: 'vanished' }, 200)));
  assert.deepEqual(await removeFeed(4), { outcome: 'refused', refusal: 'unexpected' });
});

test('no feed-removal outcome borrows another one\'s sentence', () => {
  const sentences = Object.values(FEED_REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length);
  assert.deepEqual(Object.keys(FEED_REFUSAL_MESSAGES).toSorted(), ['expired', 'unexpected', 'unknown-feed', 'unreachable']);
});
