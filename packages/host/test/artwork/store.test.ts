import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtworkStore } from '../../src/artwork/store.ts';
import { gifBytes } from '../support/gif.ts';

/**
 * A minimal, valid GIF: `image-size` reads width and height straight out of
 * the logical screen descriptor (bytes 6-9), with no CRC or pixel data
 * needed -- probed directly against `image-size` before this file was
 * written. Far cheaper than constructing a PNG, which does need a valid CRC
 * per chunk.
 */

/**
 * A minimal, valid BMP -- a different format from `gifBytes`, so the two
 * together give bytes `image-size` reports as two different `type`s for the
 * "reused type changes" test below. Just the 14-byte file header plus the
 * 40-byte BITMAPINFOHEADER; no pixel data needed for `image-size` to read
 * width and height.
 */
function bmpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set(new TextEncoder().encode('BM'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(10, 54, true); // data offset
  view.setUint32(14, 40, true); // header size (BITMAPINFOHEADER)
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  return bytes;
}

/** One entry per call to the log function a store under test was built with. */
interface LoggedCall {
  message: string;
  detail: Readonly<Record<string, unknown>> | undefined;
}

/** A fresh directory per test, removed afterward so no test leaves files behind. */
async function withTempDir(run: (dir: string, logs: LoggedCall[]) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-artwork-store-'));
  const logs: LoggedCall[] = [];
  try {
    await run(dir, logs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function store(dir: string, logs: LoggedCall[]) {
  return createArtworkStore(dir, (message, detail) => logs.push({ message, detail }));
}

test('putting an image writes a file and returns its measured dimensions', async () => {
  await withTempDir(async (dir, logs) => {
    const result = await store(dir, logs).put(1, 'https://images.test/poster.gif', gifBytes(300, 450));

    assert.equal(result.width, 300);
    assert.equal(result.height, 450);
    assert.ok(result.path.startsWith(dir), 'the file must live inside the store\'s directory');

    const files = await readdir(dir);
    assert.equal(files.length, 1, 'exactly one file must have been written');
  });
});

test('putting the same url twice writes one file at the same path', async () => {
  await withTempDir(async (dir, logs) => {
    const s = store(dir, logs);
    const url = 'https://images.test/poster.gif';

    const first = await s.put(1, url, gifBytes(300, 450));
    // Idempotency: the path is derived from (mediaItemId, url), so a re-run
    // overwrites rather than accumulating a second file for the same source.
    const second = await s.put(1, url, gifBytes(600, 900));

    assert.equal(second.path, first.path, 'the same (mediaItemId, url) must resolve to the same path');
    assert.equal(second.width, 600, 'the second write must win: this is a re-fetch, not a no-op');

    const files = await readdir(dir);
    assert.equal(files.length, 1, 'a re-attach of the same url must not accumulate a second file');
  });
});

test('the same url for two different media items writes two files at two different paths', async () => {
  await withTempDir(async (dir, logs) => {
    const s = store(dir, logs);
    // A series poster, or a studio placeholder, can legitimately back two
    // media items at once. Keying the path on the url alone would collide
    // the two onto one file -- the exact bug this test guards against: a
    // path must match the `UNIQUE (media_item_id, url)` index it backs, not
    // just half of it.
    const url = 'https://images.test/shared-poster.gif';

    const forA = await s.put(1, url, gifBytes(300, 450));
    const forB = await s.put(2, url, gifBytes(300, 450));

    assert.notEqual(forA.path, forB.path, 'two different media items sharing a url must not share a path');

    const files = await readdir(dir);
    assert.equal(files.length, 2, 'two media items sharing a url must produce two files, not one');
  });
});

test('re-attaching a url whose bytes now report a different type reuses the same path', async () => {
  await withTempDir(async (dir, logs) => {
    const s = store(dir, logs);
    const url = 'https://images.test/reformatted.img';

    // The same url, re-fetched, now serves a different image format (a CDN
    // switching from gif to bmp, say). The path must be a pure function of
    // (mediaItemId, url) alone -- not of the measured type -- or this would
    // write a second path and orphan the first.
    const first = await s.put(1, url, gifBytes(300, 450));
    const second = await s.put(1, url, bmpBytes(600, 900));

    assert.equal(second.path, first.path, 'a changed type must not change the path');
    assert.equal(second.width, 600, 'the new bytes must still be the ones measured and stored');

    const files = await readdir(dir);
    assert.equal(files.length, 1, 'the old file must not be left behind as an orphan');
  });
});

test('bytes that are not an image are refused rather than stored', async () => {
  await withTempDir(async (dir, logs) => {
    const s = store(dir, logs);
    // An html error page served with status 200, or a truncated download --
    // 1.x guessed dimensions for bytes like these and needed a repair script
    // to fix the rows that produced. Refusing means the job that fetched
    // this retries instead of caching the mistake.
    const html = new TextEncoder().encode('<html><body>not found</body></html>');

    await assert.rejects(() => s.put(1, 'https://images.test/error-page.gif', html));

    const files = await readdir(dir).catch(() => []);
    assert.equal(files.length, 0, 'a refused put must not leave a file behind');
  });
});

test('a non-ENOENT unlink failure is logged rather than silently discarded', async () => {
  await withTempDir(async (dir, logs) => {
    const s = store(dir, logs);
    // A directory in place of the "file" `remove` is asked to unlink: a
    // real, deterministic way to provoke an unlink failure that is not
    // ENOENT (EPERM on macOS, EISDIR on Linux) without mocking `node:fs`.
    const notAFile = join(dir, 'not-a-file');
    await mkdir(notAFile);

    await s.remove(notAFile);

    assert.equal(logs.length, 1, 'a non-ENOENT unlink failure must be logged exactly once');
    assert.match(logs[0]?.message ?? '', /could not remove/);
    assert.equal(logs[0]?.detail?.['path'], notAFile);
  });
});

test('removing a file that is already gone is not logged', async () => {
  await withTempDir(async (dir, logs) => {
    const s = store(dir, logs);
    // Idempotent removal: a file already gone is what a second `remove` of
    // the same path looks like, and is not an anomaly worth logging.
    await s.remove(join(dir, 'never-existed.bin'));

    assert.equal(logs.length, 0, 'a missing file must not be logged, only a real removal failure');
  });
});
