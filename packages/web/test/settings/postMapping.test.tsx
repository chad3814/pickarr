import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAPPING_REFUSALS } from '@pickarr/contract';
import {
  postMapping,
  patchMapping,
  deleteMapping,
  mappingSubmit,
  MAPPING_REFUSAL_MESSAGES,
} from '../../src/settings/postMapping.ts';
import { fetchStub, jsonResponse } from '../fetchStub.ts';

/**
 * No component is rendered in this file, so there is nothing to clean up --
 * but `globalThis.fetch` is replaced by nearly every test below and is
 * restored unconditionally, the way `postPick.test.tsx` restores it. A
 * `.tsx` extension with no JSX in it because `npm run test:web` globs
 * `packages/web/test/**\/*.test.tsx` and would not run a `.ts` file.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * The two **refusal codes** tests below are `postPick.test.tsx`'s pair,
 * applied to the fourth refusal list the moment it gains a client. The
 * drift they exist to catch has happened here before: the feeds slice
 * shipped its codes spelled twice and a host-side rename left every web
 * test green, and the download-clients review found the same list
 * hand-copied again.
 *
 * **The expected list is spelled out rather than derived.** `CLAUDE.md`: an
 * expectation computed by the code under test cannot detect that code
 * changing. Deriving this from `MAPPING_REFUSALS` alone would make it true
 * under every rename, which is the one thing it exists to see.
 */
test('the refusal codes the mapping controls have sentences for are exactly the codes the contract declares', () => {
  const spoken = Object.keys(MAPPING_REFUSAL_MESSAGES)
    .filter((key) => key !== 'offline' && key !== 'unrecognised')
    .toSorted();

  assert.deepEqual(spoken, [...MAPPING_REFUSALS].toSorted(),
    'every code the host can send has a sentence here, and this client claims no code the host cannot send');

  assert.deepEqual(spoken, [
    'duplicate-from-path',
    'empty-path',
    'unknown-client',
    'unknown-mapping',
  ]);
});

test('no mapping refusal borrows another one\'s sentence', () => {
  const sentences = Object.values(MAPPING_REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length,
    'each outcome gets words of its own, so a refusal is legible without reading a code');
  assert.equal(sentences.length, 6, 'the contract\'s four, plus offline and unrecognised');
});

test('postMapping reports the id of an accepted mapping', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ id: 12 }, 201)));
  assert.deepEqual(await postMapping({ downloadClientId: 3, fromPath: '/downloads', toPath: '/media' }), { id: 12 });
});

test('postMapping branches on the refusal field, not the HTTP status', async () => {
  // A 409 carrying `duplicate-from-path` and a 422 carrying `empty-path`
  // both answer through the same field -- proven by driving both statuses
  // and reading back the same `refusal` key each time, never
  // `response.status`.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'duplicate-from-path' }, 409)));
  assert.deepEqual(await postMapping({ downloadClientId: 3, fromPath: '/a', toPath: '/b' }),
    { refusal: 'duplicate-from-path' });

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'empty-path' }, 422)));
  assert.deepEqual(await postMapping({ downloadClientId: 3, fromPath: '', toPath: '/b' }),
    { refusal: 'empty-path' });

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-client' }, 404)));
  assert.deepEqual(await postMapping({ downloadClientId: 9, fromPath: '/a', toPath: '/b' }),
    { refusal: 'unknown-client' });
});

test('a 201 carrying no id is not an acceptance this client will claim', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({}, 201)));
  assert.deepEqual(await postMapping({ downloadClientId: 3, fromPath: '/a', toPath: '/b' }),
    { refusal: 'unrecognised' });
});

test('a bare { error } with no refusal key -- the expired session -- reads as unrecognised, not as a refusal', async () => {
  // The most ordinary real failure there is, and the one shape that must
  // not wedge anything: 401, 405, 413 and 500 all answer `{ error }` and
  // none of them carries a `refusal`.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await postMapping({ downloadClientId: 3, fromPath: '/a', toPath: '/b' }),
    { refusal: 'unrecognised' });
});

test('a refusal code this build has never heard of reads as unrecognised', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'path-too-long' }, 422)));
  assert.deepEqual(await postMapping({ downloadClientId: 3, fromPath: '/a', toPath: '/b' }),
    { refusal: 'unrecognised' });
});

test('postMapping reports offline for a rejected fetch, never a server answer', async () => {
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await postMapping({ downloadClientId: 3, fromPath: '/a', toPath: '/b' }),
    { refusal: 'offline' });
});

test('an unparseable body reads as offline, not as an unrecognised answer', async () => {
  // A gateway's HTML 502 -- the realistic producer. Asserted here rather
  // than left to the docblock because the two outcomes are one `await`
  // apart inside the same `try`, so moving `response.json()` out of it is a
  // one-line edit that silently switches this to `unrecognised`.
  globalThis.fetch = fetchStub(() =>
    Promise.resolve(new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })),
  );
  assert.deepEqual(await postMapping({ downloadClientId: 3, fromPath: '/a', toPath: '/b' }),
    { refusal: 'offline' });
  assert.ok(/could not reach/i.test(MAPPING_REFUSAL_MESSAGES.offline),
    'and that outcome is the sentence about reachability, not the one about versions');
});

test('postMapping posts the mapping to /api/mappings with the session cookie, never a token it read itself', async () => {
  let seenUrl: string | undefined;
  let seenInit: RequestInit | undefined;
  globalThis.fetch = fetchStub((url, init) => {
    seenUrl = url;
    seenInit = init;
    return Promise.resolve(jsonResponse({ id: 1 }, 201));
  });
  await postMapping({ downloadClientId: 3, fromPath: 'D:\\Downloads', toPath: '/media' });

  assert.equal(seenUrl, '/api/mappings');
  assert.equal(seenInit?.method, 'POST');
  assert.equal(seenInit?.credentials, 'same-origin',
    'the browser attaches whatever session cookie it already holds; this client reads no token');
  assert.equal(seenInit?.body,
    JSON.stringify({ downloadClientId: 3, fromPath: 'D:\\Downloads', toPath: '/media' }),
    'the paths cross the wire exactly as typed -- no normalisation, no slash-flipping (design spec §7)');
  assert.ok(!/authorization/i.test(JSON.stringify(seenInit?.headers ?? {})),
    'no authorization header: this client never reads, stores or forwards a token');
});

test('patchMapping addresses the mapping by id and reports the id back', async () => {
  let seenUrl: string | undefined;
  let seenInit: RequestInit | undefined;
  globalThis.fetch = fetchStub((url, init) => {
    seenUrl = url;
    seenInit = init;
    return Promise.resolve(jsonResponse({ id: 41 }, 200));
  });
  assert.deepEqual(await patchMapping(41, { fromPath: 'D:\\Downloads', toPath: '/media' }), { id: 41 });

  assert.equal(seenUrl, '/api/mappings/41');
  assert.equal(seenInit?.method, 'PATCH');
  assert.equal(seenInit?.credentials, 'same-origin');
  assert.equal(seenInit?.body, JSON.stringify({ fromPath: 'D:\\Downloads', toPath: '/media' }),
    'both paths, and no downloadClientId: a mapping never moves between clients (api/server.ts\'s isMappingEditBody)');
});

test('patchMapping reads its refusals off the body too', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-mapping' }, 404)));
  assert.deepEqual(await patchMapping(41, { fromPath: '/a', toPath: '/b' }), { refusal: 'unknown-mapping' });

  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await patchMapping(41, { fromPath: '/a', toPath: '/b' }), { refusal: 'offline' });
});

test('deleteMapping reads the 204 the route answers, which carries no body to read', async () => {
  // `DELETE /api/mappings/:id` answers `NO_CONTENT` -- a status and nothing
  // else (`api/server.ts`). There is no `{ removed: true }` on the wire to
  // branch on, so this is the one place in this module that reads
  // `response.status`; see the function's own docblock.
  let seenUrl: string | undefined;
  let seenInit: RequestInit | undefined;
  globalThis.fetch = fetchStub((url, init) => {
    seenUrl = url;
    seenInit = init;
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  assert.deepEqual(await deleteMapping(41), { removed: true });

  assert.equal(seenUrl, '/api/mappings/41');
  assert.equal(seenInit?.method, 'DELETE');
  assert.equal(seenInit?.credentials, 'same-origin');
});

test('a successful delete is not mistaken for an unreadable body', async () => {
  // The trap this exists for: a 204 has no body, so an unconditional
  // `response.json()` rejects and the removal that just succeeded reads as
  // `offline`. The operator would then be told to check their connection
  // about a mapping the host has already dropped.
  globalThis.fetch = fetchStub(() => Promise.resolve(new Response(null, { status: 204 })));
  const outcome = await deleteMapping(41);
  assert.ok('removed' in outcome, 'the 204 is a removal, not a refusal');
});

test('deleteMapping reads a refusal off the body it does get', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-mapping' }, 404)));
  assert.deepEqual(await deleteMapping(41), { refusal: 'unknown-mapping' });
});

test('deleteMapping reports offline for a rejected fetch and for bytes it cannot parse', async () => {
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await deleteMapping(41), { refusal: 'offline' });

  globalThis.fetch = fetchStub(() =>
    Promise.resolve(new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } })),
  );
  assert.deepEqual(await deleteMapping(41), { refusal: 'offline' });
});

test('a 401 on the delete path reads as unrecognised, and never as a removal', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await deleteMapping(41), { refusal: 'unrecognised' });
});

test('none of the three ever throws, whatever fetch does', async () => {
  // The defect this inherits a guard against: a sibling that threw had its
  // rejection swallowed by `void handleSubmit(event)`, the pending flag
  // never cleared, and the form wedged on five of six server answers.
  globalThis.fetch = fetchStub(() => Promise.reject(new Error('DNS is on fire')));
  await assert.doesNotReject(() => postMapping({ downloadClientId: 1, fromPath: '/a', toPath: '/b' }));
  await assert.doesNotReject(() => patchMapping(1, { fromPath: '/a', toPath: '/b' }));
  await assert.doesNotReject(() => deleteMapping(1));
});

test('mappingSubmit is the three real functions, wired as one injectable value', async () => {
  // `ClientMappings` takes one `submit` prop carrying all three verbs, and
  // this is the only production implementation of it. Pinned by driving
  // each member rather than by identity comparison, so a member wired to
  // the wrong verb is visible.
  const calls: string[] = [];
  globalThis.fetch = fetchStub((url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return Promise.resolve(init?.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse({ id: 5 }, 200));
  });

  await mappingSubmit.add({ downloadClientId: 1, fromPath: '/a', toPath: '/b' });
  await mappingSubmit.edit(5, { fromPath: '/a', toPath: '/b' });
  await mappingSubmit.remove(5);

  assert.deepEqual(calls, ['POST /api/mappings', 'PATCH /api/mappings/5', 'DELETE /api/mappings/5']);
});
