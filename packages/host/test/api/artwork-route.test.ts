import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { migrateHost } from '../../src/db/migrate.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { readArtwork, sniffImageType } from '../../src/api/artwork-route.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

function seedMediaItem(raw: DatabaseSync): number {
  const info = raw.prepare(
    'INSERT INTO media_item (plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?)',
  ).run('alpha', 1, 1, 'A Movie');
  return Number(info.lastInsertRowid);
}

/**
 * Every artwork table shares the same shape for what this file needs:
 * `media_item_id`, `url`, `width`, `height`, `created_at` and the nullable
 * `path`. `width`/`height`/`created_at` are `NOT NULL` on all three tables
 * but irrelevant to serving bytes, so fixed dummy values stand in.
 */
function seedArtwork(
  raw: DatabaseSync,
  table: 'poster' | 'background' | 'logo',
  mediaItemId: number,
  url: string,
  path: string | null,
): number {
  const info = raw.prepare(
    `INSERT INTO ${table} (media_item_id, url, width, height, created_at, path) VALUES (?, ?, 100, 100, 1, ?)`,
  ).run(mediaItemId, url, path);
  return Number(info.lastInsertRowid);
}

/**
 * Records every path `readFile`/`stat` were asked for, and answers from a
 * map keyed on that path -- never a real filesystem. Both are async, per the
 * injected shape `readArtwork` takes: no test here touches `node:fs`.
 */
function fakeDeps(files: Record<string, { bytes: Uint8Array; mtimeMs: number; size: number }>) {
  const readFileCalls: string[] = [];
  const statCalls: string[] = [];
  return {
    readFileCalls,
    statCalls,
    deps: {
      readFile: async (path: string): Promise<Uint8Array> => {
        readFileCalls.push(path);
        const file = files[path];
        if (file === undefined) throw new Error('no such fake file');
        return file.bytes;
      },
      stat: async (path: string): Promise<{ mtimeMs: number; size: number }> => {
        statCalls.push(path);
        const file = files[path];
        if (file === undefined) throw new Error('no such fake file');
        return { mtimeMs: file.mtimeMs, size: file.size };
      },
    },
  };
}

// Magic bytes only -- `readArtwork` never measures an image (that is
// `ArtworkStore.put`'s job, on the way in); it only sniffs what it is handed.
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xaa, 0xbb, 0xcc]);

test('a png is served as image/png and a jpeg as image/jpeg from the same suffix', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', '/artwork/a.bin');

  const otherMediaItemId = seedMediaItem(raw);
  seedArtwork(raw, 'poster', otherMediaItemId, 'https://example.com/poster.jpg', '/artwork/b.bin');

  const { deps } = fakeDeps({
    '/artwork/a.bin': { bytes: PNG_BYTES, mtimeMs: 1000, size: PNG_BYTES.length },
    '/artwork/b.bin': { bytes: JPEG_BYTES, mtimeMs: 2000, size: JPEG_BYTES.length },
  });

  const png = await readArtwork(raw, 'poster', mediaItemId, deps);
  assert.equal(png.status, 200);
  assert.equal(png.headers['Content-Type'], 'image/png');
  assert.deepEqual(png.body, PNG_BYTES);

  const jpeg = await readArtwork(raw, 'poster', otherMediaItemId, deps);
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.headers['Content-Type'], 'image/jpeg');
  assert.deepEqual(jpeg.body, JPEG_BYTES);
});

test('an unrecognised body is served as application/octet-stream, not refused', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  seedArtwork(raw, 'background', mediaItemId, 'https://example.com/bg', '/artwork/c.bin');

  const odd = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04]);
  const { deps } = fakeDeps({
    '/artwork/c.bin': { bytes: odd, mtimeMs: 3000, size: odd.length },
  });

  const response = await readArtwork(raw, 'background', mediaItemId, deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(response.body, odd);
});

test('a media item with no artwork of that kind is 404', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  // A logo exists, but this asks for a poster -- must not fall back to it.
  seedArtwork(raw, 'logo', mediaItemId, 'https://example.com/logo.png', '/artwork/d.bin');

  const { deps } = fakeDeps({});
  const response = await readArtwork(raw, 'poster', mediaItemId, deps);
  assert.equal(response.status, 404);
  assert.equal(response.body, null);
});

test('a row whose path is null is 404, not a zero-length 200', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', null);

  const { deps, readFileCalls, statCalls } = fakeDeps({});
  const response = await readArtwork(raw, 'poster', mediaItemId, deps);
  assert.equal(response.status, 404);
  assert.equal(response.body, null);
  assert.notEqual(response.status, 200);
  // Recorded but never fetched: nothing on disk was ever consulted.
  assert.deepEqual(readFileCalls, []);
  assert.deepEqual(statCalls, []);
});

test('several posters for one media item serve the first-written one', async () => {
  // `UNIQUE (media_item_id, url)` permits any number of posters per media
  // item, so "which one" has to be answered by the query and not by SQLite.
  // The two urls are chosen so index order and id order disagree: `a-` sorts
  // before `z-`, and `media_item_id = ?` is served by that very unique index
  // -- so a query with no `ORDER BY` reads the rows in url order and hands
  // back the *second* row, and `ORDER BY id DESC` hands back the same wrong
  // one. Only lowest-id-wins serves the first-written row.
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  const firstId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/z-first.png', '/artwork/first.bin');
  const secondId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/a-second.jpg', '/artwork/second.bin');
  assert.equal(firstId < secondId, true, 'the first-written row must be the lower id for this fixture to mean anything');

  const { deps, statCalls } = fakeDeps({
    '/artwork/first.bin': { bytes: PNG_BYTES, mtimeMs: 1000, size: PNG_BYTES.length },
    '/artwork/second.bin': { bytes: JPEG_BYTES, mtimeMs: 2000, size: JPEG_BYTES.length },
  });

  const response = await readArtwork(raw, 'poster', mediaItemId, deps);
  assert.equal(response.status, 200);
  // By value, and by a content type only the first row's bytes can produce:
  // the second row is a jpeg, so a wrong pick cannot pass either assertion.
  assert.deepEqual(response.body, PNG_BYTES);
  assert.equal(response.headers['Content-Type'], 'image/png');
  // The other row's file was never even stat'ed, so the choice was made in
  // SQL rather than by reading both and preferring one.
  assert.deepEqual(statCalls, ['/artwork/first.bin']);

  // Stable across calls, which is what a cacheable response needs: the same
  // request twice cannot answer two different posters.
  const again = await readArtwork(raw, 'poster', mediaItemId, deps);
  assert.deepEqual(again.body, PNG_BYTES);
  assert.equal(again.headers.ETag, response.headers.ETag);
});

test('a null-path row does not shadow a later row of the same kind that has bytes', async () => {
  // Lowest-id-wins on its own composes with "a null `path` is 404" into a
  // permanent 404 for a media item that does have bytes: the null-path row
  // here is the *lower* id, so a query that did not skip it would pick it and
  // answer 404 for as long as both rows existed. `path` is nullable, so this
  // pair is a shape the tables permit even though no host writer produces it
  // -- and `PluginContext.db` hands a plugin the raw connection.
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  const nullId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/recorded.png', null);
  const fetchedId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/fetched.png', '/artwork/g.bin');
  assert.equal(nullId < fetchedId, true, 'the null-path row must be the lower id, or this proves nothing');

  const { deps, readFileCalls, statCalls } = fakeDeps({
    '/artwork/g.bin': { bytes: PNG_BYTES, mtimeMs: 6000, size: PNG_BYTES.length },
  });

  const response = await readArtwork(raw, 'poster', mediaItemId, deps);
  assert.equal(response.status, 200, 'the row with bytes is served, not the null-path row that precedes it');
  assert.deepEqual(response.body, PNG_BYTES);
  // The null-path row named no file, so nothing could have been looked up for
  // it -- only the fetched row's path was ever touched.
  assert.deepEqual(statCalls, ['/artwork/g.bin']);
  assert.deepEqual(readFileCalls, ['/artwork/g.bin']);
});

test('a matching If-None-Match gets 304 with no body', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', '/artwork/e.bin');

  const { deps, readFileCalls } = fakeDeps({
    '/artwork/e.bin': { bytes: PNG_BYTES, mtimeMs: 4000, size: PNG_BYTES.length },
  });

  const first = await readArtwork(raw, 'poster', mediaItemId, deps);
  assert.equal(first.status, 200);
  const etag = first.headers.ETag;
  assert.ok(etag !== undefined);

  const cached = await readArtwork(raw, 'poster', mediaItemId, deps, etag);
  assert.equal(cached.status, 304);
  assert.equal(cached.body, null);
  // A 304 needs no bytes at all -- confirms the file was read once, for the
  // first response, and not again to answer the second.
  assert.deepEqual(readFileCalls, ['/artwork/e.bin']);
});

test('the ETag is weak, because the path survives a content change', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', '/artwork/f.bin');

  const { deps } = fakeDeps({
    '/artwork/f.bin': { bytes: PNG_BYTES, mtimeMs: 5000, size: PNG_BYTES.length },
  });

  const response = await readArtwork(raw, 'poster', mediaItemId, deps);
  const etag = response.headers.ETag;
  assert.ok(etag !== undefined);
  // A strong ETag here would be a lie a cache would believe: the path is a
  // hash of (mediaItemId, url), not of the bytes, so it is unchanged by a
  // re-fetch that swaps the content underneath it -- exactly what happens if
  // this file is served again after the CDN's copy of the same url changed.
  assert.ok(etag.startsWith('W/'));
});

test('sniffImageType recognises gif, webp and avif, and falls through short files safely', () => {
  assert.equal(sniffImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');

  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(sniffImageType(webp), 'image/webp');

  const avif = Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
  assert.equal(sniffImageType(avif), 'image/avif');

  // A RIFF container that is not WEBP (too short for the second window, and
  // wrong even if it were long enough) must not throw and must not match.
  assert.equal(sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46])), 'application/octet-stream');
  // Two bytes: shorter than every signature's first window.
  assert.equal(sniffImageType(Uint8Array.from([0x00, 0x01])), 'application/octet-stream');
  // Empty: the degenerate case every `matches` length check must survive.
  assert.equal(sniffImageType(Uint8Array.from([])), 'application/octet-stream');
});
