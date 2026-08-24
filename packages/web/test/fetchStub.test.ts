import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fetchStub, jsonResponse } from './fetchStub.ts';

// A `.ts` test rather than `.tsx`, so it runs in the server suite alongside
// `requeryMetadata.test.ts`: the helper it covers is imported from both suites
// and needs no DOM.

test('a string input reaches the handler unchanged', async () => {
  const stub = fetchStub(async (url) => jsonResponse({ url }));
  const seen = await (await stub('/api/z')).json();
  assert.deepEqual(seen, { url: '/api/z' });
});

test('a URL input reaches the handler as its href', async () => {
  const stub = fetchStub(async (url) => jsonResponse({ url }));
  const seen = await (await stub(new URL('http://test.invalid/api/x'))).json();
  assert.deepEqual(seen, { url: 'http://test.invalid/api/x' });
});

test('a Request input reaches the handler as its url, not [object Request]', async () => {
  // The shape a `String(input)` widening gets wrong. `packages/web/src` only
  // ever passes a string, so nothing else in the suite would notice.
  const stub = fetchStub(async (url) => jsonResponse({ url }));
  const seen = await (await stub(new Request('http://test.invalid/api/y'))).json();
  assert.deepEqual(seen, { url: 'http://test.invalid/api/y' });
});

test('init is handed through to the handler', async () => {
  const stub = fetchStub(async (_url, init) => jsonResponse({ body: String(init?.body) }));
  const seen = await (await stub('/api/z', { body: 'x' })).json();
  assert.deepEqual(seen, { body: 'x' });
});

test('a json response carries the status and content type', async () => {
  const defaulted = jsonResponse({ a: 1 });
  assert.equal(defaulted.status, 200);
  assert.equal(defaulted.headers.get('content-type'), 'application/json');
  assert.deepEqual(await defaulted.json(), { a: 1 });

  const failed = jsonResponse({ a: 1 }, 500);
  assert.equal(failed.status, 500);
});

/**
 * The enforcement this change ships. `.oxlintrc.json` bans `any` but has no
 * equivalent for `unknown`, so nothing else stops the double cast coming back
 * the next time somebody needs a `fetch` stub.
 */
test('no test under packages/web/test asserts a fetch stub through unknown', async () => {
  // Built at runtime so the guard does not match its own source.
  const banned = ['as unknown as', 'typeof fetch'].join(' ');
  const dir = import.meta.dirname;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const sources = entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
  const contents = await Promise.all(sources.map((path) => readFile(join(dir, path), 'utf8')));
  const offenders = sources.filter((_path, index) => contents[index]?.includes(banned));
  assert.deepEqual(
    offenders,
    [],
    `use fetchStub() instead of "${banned}" in: ${offenders.join(', ')}`,
  );
});
