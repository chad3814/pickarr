import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePoster, MAX_POSTER_BYTES } from '../../src/media/artwork.ts';

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

test('a jpeg is stored under the group id with the type-derived extension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1, 2, 3]), 'image/jpeg')), log() {} },
    7,
    'https://example.test/whatever.php',
  );
  assert.equal(name, '7.jpg', 'the extension comes from the content type, never the URL');
  assert.deepEqual([...(await readFile(join(dir, '7.jpg')))], [1, 2, 3]);
});

test('a non-image content type is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1]), 'text/html')), log() {} },
    7,
    'https://example.test/p.jpg',
  );
  assert.equal(name, null);
  assert.deepEqual(await readdir(dir), []);
});

test('a response past the byte cap is abandoned and leaves nothing behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const huge = new Uint8Array(MAX_POSTER_BYTES + 1);
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(imageResponse(huge, 'image/png')), log() {} },
    7,
    'https://example.test/p.png',
  );
  assert.equal(name, null);
  assert.deepEqual(await readdir(dir), [], 'no temp file survives the abort');
});

test('a fetch failure is reported, not thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const logged: string[] = [];
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.reject(new Error('offline')), log: (m) => logged.push(m) },
    7,
    'https://example.test/p.jpg',
  );
  assert.equal(name, null, 'a poster failure must not fail the metadata answer');
  assert.equal(logged.length, 1);
});
