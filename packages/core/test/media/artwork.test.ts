import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheImage, MAX_IMAGE_BYTES, IMAGE_TIMEOUT_MS, performerArtworkKey } from '../../src/media/artwork.ts';

/**
 * Node's test runner has supported mocking `AbortSignal.timeout` for a
 * while, but `@types/node@24`'s `MockTimersOptions['apis']` has not caught
 * up to it — confirmed against the actual runtime this repo targets, which
 * does honour it. Only the argument is widened (via `unknown`, since the
 * literal union types don't otherwise overlap) — `enable` is still called as
 * a method on `t.mock.timers`, not detached from it, since detaching it
 * loses the `this` its implementation relies on.
 */
type TimerApis = Parameters<TestContext['mock']['timers']['enable']>[0];

function enableAbortTimeoutMock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['AbortSignal.timeout'] } as unknown as TimerApis);
}

/**
 * Every test gets its own `mkdtemp` directory and removes it on the way out,
 * regardless of pass/fail — otherwise repeated runs leak directories into the
 * OS temp folder indefinitely, one of them holding a full 5 MiB poster.
 */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

/**
 * Builds a `Response` whose body is delivered as several separate chunks
 * rather than all at once, with the source stream instrumented so a test can
 * tell whether it was drained to completion or cancelled partway through.
 *
 * `state.chunksYielded` is the count of chunks the *source* actually produced
 * — not the count `cacheImage` chose to read — so it only rises below the
 * full chunk count when the reader was cancelled before pulling the rest.
 * That is what distinguishes a streaming implementation from one that reads
 * the whole body regardless of size: a buffering implementation drains every
 * chunk before it ever inspects the total.
 */
function chunkedResponse(
  chunks: readonly Uint8Array[],
  contentType: string,
  extraHeaders: Record<string, string> = {},
  status = 200,
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
    status,
    headers: { 'content-type': contentType, ...extraHeaders },
  });
  return { response, state };
}

test('a cached image is named from the key it was given', async () => {
  await withTempDir(async (dir) => {
    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1, 2, 3]), 'image/png')), log() {} },
      'performer-face-7',
      'https://example.invalid/a.png',
    );
    // The extension comes from the validated content type, never the URL.
    assert.equal(name, 'performer-face-7.png');
  });
});

test('a key is never taken from provider input', () => {
  // Not a behavioural test of cacheImage — a guard on its callers. Both
  // compose the key from integers of our own, so no separator can reach it.
  // If this ever needs relaxing, the sanitising argument `cacheImage`
  // deliberately avoided has to be made explicitly instead.
  assert.equal(performerArtworkKey(7, 'face'), 'performer-face-7');
  assert.equal(performerArtworkKey(7, 'image'), 'performer-image-7');
});

test('a jpeg is stored under the group id with the type-derived extension', async () => {
  await withTempDir(async (dir) => {
    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1, 2, 3]), 'image/jpeg')), log() {} },
      '7',
      'https://example.test/whatever.php',
    );
    assert.equal(name, '7.jpg', 'the extension comes from the content type, never the URL');
    assert.deepEqual([...(await readFile(join(dir, '7.jpg')))], [1, 2, 3]);
  });
});

test('a non-image content type is refused', async () => {
  await withTempDir(async (dir) => {
    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1]), 'text/html')), log() {} },
      '7',
      'https://example.test/p.jpg',
    );
    assert.equal(name, null);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('a content type is matched case-insensitively', async () => {
  await withTempDir(async (dir) => {
    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1, 2, 3]), 'IMAGE/JPEG')), log() {} },
      '7',
      'https://example.test/p.jpg',
    );
    assert.equal(name, '7.jpg', 'RFC 9110 media types are case-insensitive');
  });
});

test('a content type with a parameter is still matched', async () => {
  await withTempDir(async (dir) => {
    const name = await cacheImage(
      {
        dir,
        fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1, 2, 3]), 'image/jpeg; charset=utf-8')),
        log() {},
      },
      '7',
      'https://example.test/p.jpg',
    );
    assert.equal(name, '7.jpg');
  });
});

test('a response past the byte cap is abandoned and leaves nothing behind', async () => {
  await withTempDir(async (dir) => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(imageResponse(huge, 'image/png')), log() {} },
      '7',
      'https://example.test/p.png',
    );
    assert.equal(name, null);
    assert.deepEqual(await readdir(dir), [], 'no temp file survives the abort');
  });
});

test('a streamed oversize body is cancelled before it is fully read', async () => {
  await withTempDir(async (dir) => {
    const chunkSize = 1024 * 1024; // 1 MiB
    const totalChunks = 10; // 10 MiB total; the cap is 5 MiB
    const chunks = Array.from({ length: totalChunks }, () => new Uint8Array(chunkSize));
    const { response, state } = chunkedResponse(chunks, 'image/png');

    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(response), log() {} },
      '7',
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
});

test('a body exactly at the cap is accepted', async () => {
  await withTempDir(async (dir) => {
    const exact = new Uint8Array(MAX_IMAGE_BYTES);
    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(imageResponse(exact, 'image/png')), log() {} },
      '7',
      'https://example.test/p.png',
    );
    assert.equal(name, '7.png', 'reaching the cap exactly must not be treated as exceeding it');
    const stored = await readFile(join(dir, '7.png'));
    assert.equal(stored.byteLength, MAX_IMAGE_BYTES);
  });
});

test('a lying Content-Length does not exempt an oversize body from the running-total check', async () => {
  await withTempDir(async (dir) => {
    const chunkSize = 1024 * 1024;
    const totalChunks = 10; // 10 MiB actual body, cap is 5 MiB
    const chunks = Array.from({ length: totalChunks }, () => new Uint8Array(chunkSize));
    const { response } = chunkedResponse(chunks, 'image/png', { 'content-length': '10' });

    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(response), log() {} },
      '7',
      'https://example.test/p.png',
    );

    assert.equal(name, null, 'a small declared Content-Length must not bypass the actual byte count');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('the response body is cancelled, not left dangling, on a non-ok status', async () => {
  await withTempDir(async (dir) => {
    const { response, state } = chunkedResponse([new Uint8Array([1, 2, 3])], 'image/jpeg', {}, 404);
    const name = await cacheImage({ dir, fetchImpl: () => Promise.resolve(response), log() {} }, '7', 'https://example.test/p.jpg');
    assert.equal(name, null);
    assert.equal(state.cancelled, true, 'a rejected response must not pin the underlying connection open');
  });
});

test('the response body is cancelled, not left dangling, on a refused content type', async () => {
  await withTempDir(async (dir) => {
    const { response, state } = chunkedResponse([new Uint8Array([1, 2, 3])], 'text/html');
    const name = await cacheImage({ dir, fetchImpl: () => Promise.resolve(response), log() {} }, '7', 'https://example.test/p.jpg');
    assert.equal(name, null);
    assert.equal(state.cancelled, true, 'a refused content type must not pin the underlying connection open');
  });
});

test('the response body is cancelled, not left dangling, when Content-Length already exceeds the cap', async () => {
  await withTempDir(async (dir) => {
    const { response, state } = chunkedResponse([new Uint8Array([1, 2, 3])], 'image/png', {
      'content-length': String(MAX_IMAGE_BYTES + 1),
    });
    const name = await cacheImage({ dir, fetchImpl: () => Promise.resolve(response), log() {} }, '7', 'https://example.test/p.png');
    assert.equal(name, null);
    assert.equal(
      state.cancelled,
      true,
      'the Content-Length pre-check exists to avoid reading a response, so it must not itself leak the connection',
    );
  });
});

test('two concurrent downloads for the same group do not interleave', async () => {
  await withTempDir(async (dir) => {
    const jpegBytes = new Uint8Array([1, 2, 3]);
    const pngBytes = new Uint8Array([4, 5, 6, 7, 8]);

    const [jpegName, pngName] = await Promise.all([
      cacheImage(
        { dir, fetchImpl: () => Promise.resolve(imageResponse(jpegBytes, 'image/jpeg')), log() {} },
        '7',
        'https://example.test/a.jpg',
      ),
      cacheImage(
        { dir, fetchImpl: () => Promise.resolve(imageResponse(pngBytes, 'image/png')), log() {} },
        '7',
        'https://example.test/b.png',
      ),
    ]);

    assert.equal(jpegName, '7.jpg');
    assert.equal(pngName, '7.png');
    assert.deepEqual(
      [...(await readFile(join(dir, '7.jpg')))],
      [1, 2, 3],
      'the jpeg write must survive a concurrent png write for the same group',
    );
    assert.deepEqual(
      [...(await readFile(join(dir, '7.png')))],
      [4, 5, 6, 7, 8],
      'the png write must survive a concurrent jpeg write for the same group',
    );
  });
});

test('a write or rename failure still removes the temp file', async () => {
  await withTempDir(async (dir) => {
    // Block the rename target with a directory, so `rename` fails after
    // `writeFile` has already succeeded against the (uniquely-named) temp
    // path — the case the plain "abort" tests never exercise, since nothing
    // is written on those paths at all.
    await mkdir(join(dir, '7.jpg'));

    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1, 2, 3]), 'image/jpeg')), log() {} },
      '7',
      'https://example.test/p.jpg',
    );

    assert.equal(name, null);
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['7.jpg'], 'only the pre-existing blocking directory remains; the temp file was cleaned up');
  });
});

test('the temp file is removed before the logger runs, so a throwing logger cannot orphan it', async () => {
  await withTempDir(async (dir) => {
    // Force the catch path with something to clean up: block the rename
    // target so writeFile succeeds against the temp path and rename fails.
    await mkdir(join(dir, '7.jpg'));

    let thrown: unknown;
    try {
      await cacheImage(
        {
          dir,
          fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1, 2, 3]), 'image/jpeg')),
          log: () => {
            throw new Error('logger is broken');
          },
        },
        '7',
        'https://example.test/p.jpg',
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown, 'a broken logger dependency is expected to still surface — this is not what "never throws" promises');
    const entries = await readdir(dir);
    assert.deepEqual(
      entries,
      ['7.jpg'],
      'the temp file must already be gone by the time the logger runs, even though the logger itself then throws',
    );
  });
});

test('a fetch failure is reported, not thrown', async () => {
  await withTempDir(async (dir) => {
    const logged: string[] = [];
    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.reject(new Error('offline')), log: (m) => logged.push(m) },
      '7',
      'https://example.test/p.jpg',
    );
    assert.equal(name, null, 'a poster failure must not fail the metadata answer');
    assert.equal(logged.length, 1);
  });
});

test('a fetch rejection with a non-Error value is reported, not thrown', async () => {
  await withTempDir(async (dir) => {
    const logged: string[] = [];
    // Nothing requires a rejected promise to carry an Error — this must not
    // crash on a cast that assumes it does.
    const name = await cacheImage(
      { dir, fetchImpl: () => Promise.reject(null), log: (m) => logged.push(m) },
      '7',
      'https://example.test/p.jpg',
    );
    assert.equal(name, null, 'a poster failure must not fail the metadata answer, whatever shape it takes');
    assert.equal(logged.length, 1);
    assert.deepEqual(await readdir(dir), []);
  });
});

// --- Timeout -------------------------------------------------------------
//
// A host that accepts the connection and then sends nothing must not hang
// this call forever — see the comment on IMAGE_TIMEOUT_MS. `fetchImpl`
// below never settles and never looks at its `init.signal`, the worst case:
// a caller that is not even aware a timeout exists. A passing test here
// proves the deadline is enforced by `cacheImage` itself. Node's fake
// timers stand in for real time so this resolves instantly, and the
// explicit per-test `timeout` bounds the test in case the deadline is not
// actually enforced and the promise never settles.

test(
  'a poster fetch that never gets a response is abandoned, not hung forever',
  { timeout: 2_000 },
  async (t) => {
    await withTempDir(async (dir) => {
      enableAbortTimeoutMock(t);
      const logged: string[] = [];

      const pending = cacheImage(
        { dir, fetchImpl: () => new Promise(() => undefined), log: (m) => logged.push(m) },
        '7',
        'https://example.test/p.jpg',
      );
      t.mock.timers.tick(IMAGE_TIMEOUT_MS);
      const name = await pending;

      assert.equal(
        name,
        null,
        'a stalled connection must not hang the metadata pass; it is a poster failure like any other',
      );
      assert.equal(logged.length, 1);
      assert.deepEqual(await readdir(dir), []);
    });
  },
);
