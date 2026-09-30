import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_PICK_REFUSALS } from '@pickarr/contract';
import { postPick, PICK_REFUSAL_MESSAGES } from '../../src/library/postPick.ts';
import { fetchStub, jsonResponse } from '../fetchStub.ts';

/**
 * No component is rendered in this file, so there is nothing to clean up --
 * but `globalThis.fetch` is replaced by nearly every test below and is
 * restored unconditionally, the way `AddDownloadClient.test.tsx` restores
 * it. A `.tsx` extension with no JSX in it because `npm run test:web`
 * globs `packages/web/test/**\/*.test.tsx` and would not run a `.ts` file.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * The two **refusal codes** tests below are `AddDownloadClient.test.tsx`'s
 * pair, applied to the third refusal list the moment it gains a client.
 * The drift they exist to catch has happened here before: the feeds slice
 * shipped its codes spelled twice and a host-side rename left all 100 web
 * tests green.
 *
 * **The expected list is spelled out rather than derived.** `CLAUDE.md`: an
 * expectation computed by the code under test cannot detect that code
 * changing. Deriving this from `REQUEST_PICK_REFUSALS` alone would make it
 * true under every rename, which is the one thing it exists to see -- so
 * it is asserted against both the contract's array and a literal list.
 */
test('the refusal codes the pick button has sentences for are exactly the codes the contract declares', () => {
  const spoken = Object.keys(PICK_REFUSAL_MESSAGES)
    .filter((key) => key !== 'offline' && key !== 'expired' && key !== 'unrecognised')
    .toSorted();

  assert.deepEqual(spoken, [...REQUEST_PICK_REFUSALS].toSorted(),
    'every code the host can send has a sentence here, and this client claims no code the host cannot send');

  assert.deepEqual(spoken, [
    'already-submitted',
    'client-type-mismatch',
    'no-client-of-type',
    'plugin-not-registered',
    'unknown-release',
  ]);
});

test('no pick refusal borrows another one\'s sentence', () => {
  const sentences = Object.values(PICK_REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length,
    'each outcome gets words of its own, so a refusal is legible without reading a code');
  assert.equal(sentences.length, 8, 'the contract\'s five, plus offline, expired and unrecognised');
});

test('postPick reports an accepted pick', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ accepted: true }, 202)));
  assert.deepEqual(await postPick(7), { accepted: true });
});

test('postPick branches on the refusal field, not the HTTP status', async () => {
  // A 409 carrying `already-submitted` and a 422 carrying `no-client-of-type`
  // both answer through the same field -- proven by driving both statuses
  // and reading back the same `refusal` key each time, never
  // `response.status`.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'already-submitted' }, 409)));
  assert.deepEqual(await postPick(7), { refusal: 'already-submitted' });

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'no-client-of-type' }, 422)));
  assert.deepEqual(await postPick(7), { refusal: 'no-client-of-type' });
});

test('postPick treats a status it has never seen as no evidence at all', async () => {
  // The same body, answered with a 202 -- the status the route only sends
  // for an accepted pick. A client reading the status would call this
  // accepted and leave the operator with a release nobody submitted.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-release' }, 202)));
  assert.deepEqual(await postPick(7), { refusal: 'unknown-release' });
});

test('postPick reads acceptance off the body, not off a 202 with nothing in it', async () => {
  // `{ accepted: true }` is the contract; a 202 carrying something else is
  // not an acceptance this client can claim.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({}, 202)));
  assert.deepEqual(await postPick(7), { refusal: 'unrecognised' });
});

test('postPick reports offline for a rejected fetch, never a server answer', async () => {
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await postPick(7), { refusal: 'offline' });
});

test('an unparseable body reads as offline, not as an unrecognised answer', async () => {
  // A gateway's HTML 502 -- the realistic producer, and the case that
  // decides which of the two catch-all outcomes an unparseable body gets.
  // Asserted here rather than left to the docblock because the two
  // outcomes are one `await` apart inside the same `try`, so moving
  // `response.json()` out of it is a one-line edit that silently switches
  // this to `unrecognised`.
  globalThis.fetch = fetchStub(() =>
    Promise.resolve(new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })),
  );
  assert.deepEqual(await postPick(7), { refusal: 'offline' });
  assert.ok(/could not reach/i.test(PICK_REFUSAL_MESSAGES.offline),
    'and that outcome is the sentence about reachability, not the one about versions');
});

test('postPick posts the release id to /api/picks with the session cookie, never a token it read itself', async () => {
  let seenUrl: string | undefined;
  let seenInit: RequestInit | undefined;
  globalThis.fetch = fetchStub((url, init) => {
    seenUrl = url;
    seenInit = init;
    return Promise.resolve(jsonResponse({ accepted: true }, 202));
  });
  await postPick(41);
  assert.equal(seenUrl, '/api/picks');
  assert.equal(seenInit?.method, 'POST');
  assert.equal(seenInit?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(seenInit?.body)), { rssItemId: 41 },
    'one field, the release id -- the whole of what the route\'s `isPickBody` accepts');
});

test('postPick never reads a server-authored message off the body', async () => {
  const authored = 'server-authored-detail-should-never-render-3e9a';
  globalThis.fetch = fetchStub(() =>
    Promise.resolve(jsonResponse({ refusal: 'client-type-mismatch', message: authored }, 422)));
  assert.deepEqual(await postPick(7), { refusal: 'client-type-mismatch' },
    'only the refusal code crosses, never any other field');
  assert.ok(!Object.values(PICK_REFUSAL_MESSAGES).some((sentence) => sentence.includes(authored)),
    'and nothing this client can render came from the host');
});

/**
 * A 401 is an expired session -- the most ordinary failure a real submit
 * meets, and one shape that carries no `refusal` key at all. It has its own
 * outcome (issue #94) rather than the version-skew catch-all below.
 */
test('postPick reports "expired" for a 401, not "unrecognised", and never throws', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await postPick(7), { refusal: 'expired' });
  assert.equal(PICK_REFUSAL_MESSAGES.expired, 'Your session expired. Sign in again.');
});

/**
 * The route's own envelope refusals, a 500, and a refusal code this build
 * has never heard of. Every one resolves rather than throws: a client is
 * routinely older than its host.
 */
test('postPick reports "unrecognised" for every answer it cannot read, never a throw', async () => {
  const unreadable: readonly { body: unknown; status: number }[] = [
    { body: { error: 'method not allowed' }, status: 405 },
    { body: { error: 'body too large' }, status: 413 },
    { body: { error: 'internal error' }, status: 500 },
    { body: { refusal: 'invalid-shape' }, status: 400 },
    { body: { refusal: 'malformed-body' }, status: 400 },
    { body: { refusal: 'a-code-from-a-newer-host' }, status: 422 },
    { body: null, status: 200 },
    { body: 'accepted', status: 202 },
  ];
  for (const { body, status } of unreadable) {
    globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse(body, status)));
    // eslint-disable-next-line no-await-in-loop -- one shared `globalThis.fetch`, so these cannot overlap
    assert.deepEqual(await postPick(7), { refusal: 'unrecognised' },
      `a ${String(status)} carrying ${JSON.stringify(body)} is an answer this client cannot read`);
  }
});
