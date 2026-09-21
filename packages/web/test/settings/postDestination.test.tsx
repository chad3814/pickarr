import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DESTINATION_REFUSALS } from '@pickarr/contract';
import {
  putDestination,
  destinationSubmit,
  destinationRefusalMessage,
  DESTINATION_REFUSAL_MESSAGES,
} from '../../src/settings/postDestination.ts';
import { fetchStub, jsonResponse } from '../fetchStub.ts';

/**
 * No component is rendered in this file, so there is nothing to clean up --
 * but `globalThis.fetch` is replaced by nearly every test below and is
 * restored unconditionally, exactly as `postMapping.test.tsx` restores it. A
 * `.tsx` extension with no JSX in it because `npm run test:web` globs
 * `packages/web/test/**\/*.test.tsx` and would not run a `.ts` file at all.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A root and a shape that are never the subject of a test -- only the answer is. */
const ANY_INPUT = { root: '/media/tv', shape: '{series}/{title}.{ext}' };

/**
 * `postMapping.test.tsx`'s pair, applied to the fifth refusal list the
 * moment it gains a client.
 *
 * **The expected list is spelled out rather than derived.** `CLAUDE.md`: an
 * expectation computed by the code under test cannot detect that code
 * changing. Deriving this from `DESTINATION_REFUSALS` alone would make it
 * true under every rename, which is the one thing it exists to see. There
 * are **ten**, not the five design spec §3 and §6 name between them:
 * `media/destinations.ts` validates a shape by resolving it, which makes
 * four structural failures reachable on save, and it refuses a root that is
 * not the directory it resolves to, which makes a fifth.
 */
test('the refusal codes this screen has sentences for are exactly the ten the contract declares', () => {
  const spoken = Object.keys(DESTINATION_REFUSAL_MESSAGES)
    .filter((key) => key !== 'offline' && key !== 'unrecognised')
    .toSorted();

  assert.deepEqual(spoken, [...DESTINATION_REFUSALS].toSorted(),
    'every code the host can send has a sentence here, and this client claims no code the host cannot send');

  assert.deepEqual(spoken, [
    'backslash-in-shape',
    'empty-filename',
    'empty-path',
    'escaping-path',
    'escaping-shape',
    'malformed-shape',
    'not-absolute-root',
    'unknown-plugin',
    'unknown-token',
    'unusable-root',
  ]);
});

test('no destination refusal borrows another one\'s sentence', () => {
  const sentences = Object.values(DESTINATION_REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length,
    'each outcome gets words of its own, so a refusal is legible without reading a code');
  assert.equal(sentences.length, 12, 'the contract\'s ten, plus offline and unrecognised');
});

/**
 * The two escape refusals are about **different fields** -- which is the
 * whole reason `packages/contract/src/destinations.ts` renamed one of them --
 * so the two sentences have to name different fields. Equality is already
 * refused above; this is the sharper claim that each says which input it is
 * about.
 */
test('the shape\'s escape refusal and the unmatched folder\'s name different fields', () => {
  const shape = DESTINATION_REFUSAL_MESSAGES['escaping-shape'];
  const dir = DESTINATION_REFUSAL_MESSAGES['escaping-path'];
  assert.ok(shape.includes('path shape'), 'the shape\'s sentence names the shape field');
  assert.ok(!shape.includes('unmatched'), 'and does not send the operator to the other field');
  assert.ok(dir.includes('unmatched folder'), 'the unmatched folder\'s sentence names that field');
  assert.ok(!dir.includes('path shape'), 'and does not send the operator to the other field');
});

/**
 * Design spec §3: an unknown token is "refused, naming it". The host does
 * -- `DestinationRefusalBody.token` -- and for a whole slice this client
 * discarded the field and told the operator outright that Pickarr "does not
 * say which one it refused". These three pin the repair from both ends: the
 * name reaches the sentence, the sentence stops disclaiming, and the
 * fallback for a token the host would not repeat is still there.
 */
test('a named token reaches the sentence the operator reads', () => {
  const named = destinationRefusalMessage({ refusal: 'unknown-token', token: 'seasn' });

  assert.ok(named.includes('{seasn}'),
    'the host named the token and this client has to say which one it was');
  assert.notEqual(named, DESTINATION_REFUSAL_MESSAGES['unknown-token'],
    'naming it has to change the sentence, or reading `token` changed nothing');
});

test('an unknown-token the host would not name falls back to the fixed sentence', () => {
  // `ECHOABLE_TOKEN` in `host/src/media/destinations.ts` repeats a name
  // only when it matches the class a declared token is in, so
  // `token: null` on an `unknown-token` is a real answer rather than a
  // missing one -- as is an older host that sends no field at all.
  assert.equal(
    destinationRefusalMessage({ refusal: 'unknown-token', token: null }),
    DESTINATION_REFUSAL_MESSAGES['unknown-token'],
  );
});

test('no destination sentence tells the operator that Pickarr cannot name the token', () => {
  // The shipped sentence said this for a whole slice while the name was in
  // the response body. A literal, because the claim was prose rather than
  // a code and only its words can pin it.
  for (const [code, sentence] of Object.entries(DESTINATION_REFUSAL_MESSAGES)) {
    assert.ok(!sentence.includes('does not say which'),
      `"${code}" still disclaims a name the wire carries`);
  }
  assert.ok(DESTINATION_REFUSAL_MESSAGES['unknown-token'].includes('{token}'),
    'the fallback still points at the list of tokens on screen');
});

test('every other refusal ignores token, so no sentence is composed from a field that is not about it', () => {
  // `token` is `null` for every code but `unknown-token`, but the wire is
  // not a promise -- a host that sent one anyway must not change what a
  // `not-absolute-root` reads as.
  assert.equal(
    destinationRefusalMessage({ refusal: 'not-absolute-root', token: 'series' }),
    DESTINATION_REFUSAL_MESSAGES['not-absolute-root'],
  );
});

test('putDestination reports the id of an accepted destination', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ id: 4 }, 200)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { id: 4 });
});

test('putDestination addresses the plugin it was given, with PUT and the session cookie', async () => {
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  globalThis.fetch = fetchStub((url, init) => {
    seen = { url, init };
    return Promise.resolve(jsonResponse({ id: 1 }, 200));
  });

  await putDestination('movie', { root: '/media/films', shape: '{title}.{ext}' });

  assert.equal(seen?.url, '/api/destinations/movie');
  assert.equal(seen?.init?.method, 'PUT');
  assert.equal(seen?.init?.credentials, 'same-origin',
    'the browser\'s own cookie goes, and nothing here reads, stores or forwards the token');
});

test('an unmatched folder left unset crosses the wire as no field at all, not as an empty string', async () => {
  // `api/server.ts`'s `destinationBodyFrom` reads an absent `unmatchedDir`
  // as "the host's own default" (design spec §6's `_unmatched`) and an
  // empty string as `empty-path`. Sending `''` for a field the operator
  // left blank would turn the documented default into a refusal.
  let body: unknown;
  globalThis.fetch = fetchStub((_url, init) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(jsonResponse({ id: 1 }, 200));
  });

  await putDestination('tv', { root: '/media/tv', shape: '{title}.{ext}' });

  assert.deepEqual(body, { root: '/media/tv', shape: '{title}.{ext}' });
});

test('an unmatched folder that was set crosses the wire exactly as typed', async () => {
  let body: unknown;
  globalThis.fetch = fetchStub((_url, init) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(jsonResponse({ id: 1 }, 200));
  });

  await putDestination('tv', { root: '/media/tv', shape: '{title}.{ext}', unmatchedDir: '_pickarr/unmatched' });

  assert.deepEqual(body, { root: '/media/tv', shape: '{title}.{ext}', unmatchedDir: '_pickarr/unmatched' });
});

test('putDestination branches on the refusal field, not the HTTP status', async () => {
  // `unknown-plugin` is a 404 and the other nine are 422s
  // (`statusForDestinationRefusal`), and both read back through the same
  // field -- proven by driving both statuses and never reading
  // `response.status`.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-plugin', token: null }, 404)));
  assert.deepEqual(await putDestination('book', ANY_INPUT), { refusal: 'unknown-plugin', token: null });

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-token', token: null }, 422)));
  assert.deepEqual(await putDestination('movie', ANY_INPUT), { refusal: 'unknown-token', token: null });

  // The one shape that would fool a status branch outright: a refusal
  // answered with a 200.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'escaping-path', token: null }, 200)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'escaping-path', token: null });
});

test('every one of the ten codes survives the trip back unchanged', async () => {
  for (const refusal of DESTINATION_REFUSALS) {
    globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal, token: null }, 422)));
    // eslint-disable-next-line no-await-in-loop -- one shared `globalThis.fetch`: two of these in flight at once would answer each other's request.
    assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal, token: null },
      `${refusal} is read back as itself`);
  }
});

test('the token the host named survives the trip back, and a token that is not a string does not', async () => {
  // The whole of what `putDestination` has to do with the second field:
  // carry a string through, and answer `null` for anything else a body
  // might hold under that key. A client that dropped it would redden the
  // first of these and pass the second, which is why both are here.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-token', token: 'seasn' }, 422)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'unknown-token', token: 'seasn' });

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-token', token: 7 }, 422)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'unknown-token', token: null });

  // An older host that never learnt to send the field at all.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-token' }, 422)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'unknown-token', token: null });
});

test('a 200 carrying no id is not an acceptance this client will claim', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({}, 200)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'unrecognised', token: null });
});

test('a bare { error } with no refusal key -- the expired session -- reads as unrecognised', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'unrecognised', token: null });
});

test('invalid-shape, the envelope refusal no contract module declares, reads as unrecognised', async () => {
  // `api/server.ts` answers `{ refusal: 'invalid-shape' }` for a body that
  // is not a destination at all. It is deliberately not in
  // `DESTINATION_REFUSALS`, so this client has no sentence for it and must
  // not invent one.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'invalid-shape' }, 400)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'unrecognised', token: null });
});

test('a refusal code this build has never heard of reads as unrecognised', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'root-does-not-exist' }, 422)));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'unrecognised', token: null });
});

test('putDestination reports offline for a rejected fetch, never a server answer', async () => {
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'offline', token: null });
});

test('an unparseable body reads as offline, not as an unrecognised answer', async () => {
  // A gateway's HTML 502 -- the realistic producer, and the reason
  // `response.json()` stays inside the same `try` as the `fetch`.
  globalThis.fetch = fetchStub(() =>
    Promise.resolve(new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })),
  );
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'offline', token: null });
});

test('putDestination never throws, however the network misbehaves', async () => {
  // A `fetch` that throws synchronously rather than rejecting -- the shape
  // a rejected promise would not catch if the call were outside the `try`.
  globalThis.fetch = fetchStub(() => {
    throw new TypeError('Failed to fetch');
  });
  assert.deepEqual(await putDestination('tv', ANY_INPUT), { refusal: 'offline', token: null },
    'the caller invokes this as `void handleSubmit(event)`, so a rejection here is swallowed and the form wedges');
});

test('destinationSubmit is the real write, not a stub left behind', () => {
  assert.equal(destinationSubmit, putDestination);
});
