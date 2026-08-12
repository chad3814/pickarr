import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePoster, MAX_POSTER_BYTES } from '../../src/media/artwork.ts';

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

/**
 * Builds a `Response` whose body is delivered as several separate chunks
 * rather than all at once, with the source stream instrumented so a test can
 * tell whether it was drained to completion or cancelled partway through.
 *
 * `state.chunksYielded` is the count of chunks the *source* actually produced
 * — not the count `cachePoster` chose to read — so it only rises below the
 * full chunk count when the reader was cancelled before pulling the rest.
 * That is what distinguishes a streaming implementation from one that reads
 * the whole body regardless of size: a buffering implementation drains every
 * chunk before it ever inspects the total.
 */
function chunkedResponse(
  chunks: readonly Uint8Array[],
  contentType: string,
  extraHeaders: Record<string, string> = {},
): { response: Response; state: { chunksYielded: number; cancelled: boolean } } {
  const state = { chunksYielded: 0, cancelled: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      index += 1;
      state.chunksYielded = index;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': contentType, ...extraHeaders },
  });
  return { response, state };
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

test('a streamed oversize body is cancelled before it is fully read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const chunkSize = 1024 * 1024; // 1 MiB
  const totalChunks = 10; // 10 MiB total; the cap is 5 MiB
  const chunks = Array.from({ length: totalChunks }, () => new Uint8Array(chunkSize));
  const { response, state } = chunkedResponse(chunks, 'image/png');

  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(response), log() {} },
    7,
    'https://example.test/p.png',
  );

  assert.equal(name, null);
  assert.deepEqual(await readdir(dir), [], 'no temp file survives the abort');
  assert.ok(
    state.chunksYielded < totalChunks,
    `reading was not aborted early: pulled ${state.chunksYielded} of ${totalChunks} chunks`,
  );
  assert.equal(state.cancelled, true, 'the reader must be cancelled, not drained to completion');
});

test('a body exactly at the cap is accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const exact = new Uint8Array(MAX_POSTER_BYTES);
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(imageResponse(exact, 'image/png')), log() {} },
    7,
    'https://example.test/p.png',
  );
  assert.equal(name, '7.png', 'reaching the cap exactly must not be treated as exceeding it');
  const stored = await readFile(join(dir, '7.png'));
  assert.equal(stored.byteLength, MAX_POSTER_BYTES);
});

test('a lying Content-Length does not exempt an oversize body from the running-total check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const chunkSize = 1024 * 1024;
  const totalChunks = 10; // 10 MiB actual body, cap is 5 MiB
  const chunks = Array.from({ length: totalChunks }, () => new Uint8Array(chunkSize));
  const { response } = chunkedResponse(chunks, 'image/png', { 'content-length': '10' });

  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(response), log() {} },
    7,
    'https://example.test/p.png',
  );

  assert.equal(name, null, 'a small declared Content-Length must not bypass the actual byte count');
  assert.deepEqual(await readdir(dir), []);
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
