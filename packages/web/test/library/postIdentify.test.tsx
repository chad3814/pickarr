import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTIFY_RELEASE_REFUSALS, type IdentifyRequest } from '@pickarr/contract';
import { IDENTIFY_REFUSAL_MESSAGES } from '@pickarr/plugin-ui';
import { postIdentify } from '../../src/library/postIdentify.ts';
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

const REQUESTS: readonly IdentifyRequest[] = [
  { mode: 'requery' },
  { mode: 'name', name: 'Dune Part Two' },
  { mode: 'media-item', mediaItemId: 4 },
];

test('postIdentify posts each request body, serialised exactly, to the release path with the session cookie', async () => {
  for (const request of REQUESTS) {
    const seen: [string, RequestInit | undefined][] = [];
    globalThis.fetch = fetchStub((url, init) => {
      seen.push([url, init]);
      return Promise.resolve(jsonResponse({ accepted: true }, 202));
    });
    await postIdentify(9, request);
    assert.equal(seen[0]?.[0], '/api/releases/9/identify');
    assert.equal(seen[0]?.[1]?.method, 'POST');
    assert.equal(seen[0]?.[1]?.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(String(seen[0]?.[1]?.body)), request);
  }
});

test('a 202 { accepted: true } reads as accepted', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ accepted: true }, 202)));
  assert.deepEqual(await postIdentify(9, { mode: 'requery' }), { accepted: true });
});

test('a 200 { outcome: linked } reads as linked, carrying the media item id', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ outcome: 'linked', mediaItemId: 4 }, 200)));
  assert.deepEqual(await postIdentify(9, { mode: 'media-item', mediaItemId: 4 }), { outcome: 'linked', mediaItemId: 4 });
});

test('a linked answer with no numeric media item id is unrecognised', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ outcome: 'linked' }, 200)));
  assert.deepEqual(await postIdentify(9, { mode: 'media-item', mediaItemId: 4 }), { refusal: 'unrecognised' });
});

test('every refusal code the contract lists is read off the body', async () => {
  for (const code of IDENTIFY_RELEASE_REFUSALS) {
    globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: code }, 422)));
    assert.deepEqual(await postIdentify(9, { mode: 'requery' }), { refusal: code });
  }
});

test('a refusal code this build does not know reads as unrecognised', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'from-the-future' }, 422)));
  assert.deepEqual(await postIdentify(9, { mode: 'requery' }), { refusal: 'unrecognised' });
});

test('a 401 reads as expired, a rejected fetch as offline, a bare { error } as unrecognised', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await postIdentify(9, { mode: 'requery' }), { refusal: 'expired' });
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await postIdentify(9, { mode: 'requery' }), { refusal: 'offline' });
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'internal' }, 500)));
  assert.deepEqual(await postIdentify(9, { mode: 'requery' }), { refusal: 'unrecognised' });
});

test('every identify sentence is distinct and every contract code has one', () => {
  const sentences = Object.values(IDENTIFY_REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length);
  for (const code of IDENTIFY_RELEASE_REFUSALS) {
    assert.ok(code in IDENTIFY_REFUSAL_MESSAGES, code);
  }
});
