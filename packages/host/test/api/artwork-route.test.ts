import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { migrateHost } from '../../src/db/migrate.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { ARTWORK_QUERY, readArtwork, sniffImageType } from '../../src/api/artwork-route.ts';

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

function seedPerson(raw: DatabaseSync): number {
  const info = raw.prepare(
    'INSERT INTO person (name, provider_ref, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run('An Actor', `person-ref-${Math.random()}`, 1, 1);
  return Number(info.lastInsertRowid);
}

/**
 * `person_image`'s own seed, kept separate from `seedArtwork` rather than
 * widened into it: its owner column is `person_id`, not `media_item_id`, so
 * a shared helper would need a column-name parameter for one caller out of
 * four -- more indirection than the one extra function costs.
 */
function seedPersonImage(raw: DatabaseSync, personId: number, url: string, path: string | null): number {
  const info = raw.prepare(
    'INSERT INTO person_image (person_id, url, width, height, created_at, path) VALUES (?, ?, 100, 100, 1, ?)',
  ).run(personId, url, path);
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
  const pngId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', '/artwork/a.bin');

  const otherMediaItemId = seedMediaItem(raw);
  const jpegId = seedArtwork(raw, 'poster', otherMediaItemId, 'https://example.com/poster.jpg', '/artwork/b.bin');

  const { deps } = fakeDeps({
    '/artwork/a.bin': { bytes: PNG_BYTES, mtimeMs: 1000, size: PNG_BYTES.length },
    '/artwork/b.bin': { bytes: JPEG_BYTES, mtimeMs: 2000, size: JPEG_BYTES.length },
  });

  const png = await readArtwork(raw, 'poster', pngId, deps);
  assert.equal(png.status, 200);
  assert.equal(png.headers['Content-Type'], 'image/png');
  assert.deepEqual(png.body, PNG_BYTES);

  const jpeg = await readArtwork(raw, 'poster', jpegId, deps);
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.headers['Content-Type'], 'image/jpeg');
  assert.deepEqual(jpeg.body, JPEG_BYTES);
});

test('an unrecognised body is served as application/octet-stream, not refused', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  const backgroundId = seedArtwork(raw, 'background', mediaItemId, 'https://example.com/bg', '/artwork/c.bin');

  const odd = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04]);
  const { deps } = fakeDeps({
    '/artwork/c.bin': { bytes: odd, mtimeMs: 3000, size: odd.length },
  });

  const response = await readArtwork(raw, 'background', backgroundId, deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(response.body, odd);
});

test('a person\'s picture is served by its person_image row id, not the person id', async () => {
  const raw = setup();
  // Three tables' ids that can collide: the poster, the person and the
  // person_image row are each some table's `INTEGER PRIMARY KEY`. A second
  // picture is seeded first so the row id (2) differs from the person id
  // (1), and a poster shares the row id: asking for the person's picture
  // must reach `person_image` and neither the person id nor the poster.
  const mediaItemId = seedMediaItem(raw);
  const personId = seedPerson(raw);
  const otherPersonId = seedPerson(raw);
  seedPersonImage(raw, otherPersonId, 'https://example.com/other.png', '/artwork/other.bin');
  const imageId = seedPersonImage(raw, personId, 'https://example.com/headshot.png', '/artwork/headshot.bin');
  seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster-1.png', '/artwork/poster-1.bin');
  const posterId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', '/artwork/poster.bin');
  assert.equal(imageId, posterId, 'the fixture only proves the point if the two row ids coincide');
  assert.notEqual(imageId, personId, 'and the picture\'s row id is not its owner\'s id');

  const { deps, readFileCalls } = fakeDeps({
    '/artwork/headshot.bin': { bytes: PNG_BYTES, mtimeMs: 7000, size: PNG_BYTES.length },
    '/artwork/poster.bin': { bytes: JPEG_BYTES, mtimeMs: 8000, size: JPEG_BYTES.length },
    '/artwork/other.bin': { bytes: JPEG_BYTES, mtimeMs: 9000, size: JPEG_BYTES.length },
  });

  const response = await readArtwork(raw, 'person', imageId, deps);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, PNG_BYTES, 'the picture\'s own row, not the same-id poster');
  assert.deepEqual(readFileCalls, ['/artwork/headshot.bin']);
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
  const posterId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', null);

  const { deps, readFileCalls, statCalls } = fakeDeps({});
  const response = await readArtwork(raw, 'poster', posterId, deps);
  assert.equal(response.status, 404);
  assert.equal(response.body, null);
  assert.notEqual(response.status, 200);
  // Recorded but never fetched: nothing on disk was ever consulted.
  assert.deepEqual(readFileCalls, []);
  assert.deepEqual(statCalls, []);
});

test('each kind is served by its own row id, and another row of the same owner is not touched', async () => {
  // Two posters for one media item, with the url order and the id order
  // disagreeing, so only the row id can pick the answer.
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  const firstId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/z-first.png', '/artwork/first.bin');
  const secondId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/a-second.jpg', '/artwork/second.bin');
  assert.notEqual(firstId, secondId);

  const { deps, statCalls } = fakeDeps({
    '/artwork/first.bin': { bytes: PNG_BYTES, mtimeMs: 1000, size: PNG_BYTES.length },
    '/artwork/second.bin': { bytes: JPEG_BYTES, mtimeMs: 2000, size: JPEG_BYTES.length },
  });

  const response = await readArtwork(raw, 'poster', secondId, deps);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, JPEG_BYTES);
  assert.equal(response.headers['Content-Type'], 'image/jpeg');
  assert.deepEqual(statCalls, ['/artwork/second.bin'], 'the owner\'s other poster was never touched');

  const first = await readArtwork(raw, 'poster', firstId, deps);
  assert.deepEqual(first.body, PNG_BYTES);
});

test('an unknown row id is 404', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', '/artwork/a.bin');
  const { deps, statCalls } = fakeDeps({});
  for (const kind of ['poster', 'background', 'logo', 'person'] as const) {
    const response = await readArtwork(raw, kind, 9999, deps);
    assert.equal(response.status, 404, kind);
  }
  assert.deepEqual(statCalls, []);
});

test('a row whose path is null is 404 by its own id, for every kind, while a sibling serves', async () => {
  // `path` is nullable on all four tables and `PluginContext.db` hands a
  // plugin the raw connection, so a null-path row is a shape the tables
  // permit. Each is asked for by its own id; the `AND path IS NOT NULL` in
  // every query is what keeps it from reaching `stat`.
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  const personId = seedPerson(raw);
  const nullIds = {
    poster: seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/np.png', null),
    background: seedArtwork(raw, 'background', mediaItemId, 'https://example.com/nb.png', null),
    logo: seedArtwork(raw, 'logo', mediaItemId, 'https://example.com/nl.png', null),
    person: seedPersonImage(raw, personId, 'https://example.com/ni.png', null),
  };
  const fetchedId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/fetched.png', '/artwork/g.bin');
  const { deps, readFileCalls, statCalls } = fakeDeps({
    '/artwork/g.bin': { bytes: PNG_BYTES, mtimeMs: 6000, size: PNG_BYTES.length },
  });

  for (const [kind, id] of Object.entries(nullIds)) {
    const response = await readArtwork(raw, kind as keyof typeof nullIds, id, deps);
    assert.equal(response.status, 404, kind);
  }
  assert.deepEqual(statCalls, []);
  assert.deepEqual(readFileCalls, []);

  const served = await readArtwork(raw, 'poster', fetchedId, deps);
  assert.equal(served.status, 200);
});

test('a matching If-None-Match gets 304 with no body', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  const posterId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', '/artwork/e.bin');

  const { deps, readFileCalls } = fakeDeps({
    '/artwork/e.bin': { bytes: PNG_BYTES, mtimeMs: 4000, size: PNG_BYTES.length },
  });

  const first = await readArtwork(raw, 'poster', posterId, deps);
  assert.equal(first.status, 200);
  const etag = first.headers.ETag;
  assert.ok(etag !== undefined);

  const cached = await readArtwork(raw, 'poster', posterId, deps, etag);
  assert.equal(cached.status, 304);
  assert.equal(cached.body, null);
  // A 304 needs no bytes at all -- confirms the file was read once, for the
  // first response, and not again to answer the second.
  assert.deepEqual(readFileCalls, ['/artwork/e.bin']);
});

test('the ETag is weak, because the path survives a content change', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw);
  const posterId = seedArtwork(raw, 'poster', mediaItemId, 'https://example.com/poster.png', '/artwork/f.bin');

  const { deps } = fakeDeps({
    '/artwork/f.bin': { bytes: PNG_BYTES, mtimeMs: 5000, size: PNG_BYTES.length },
  });

  const response = await readArtwork(raw, 'poster', posterId, deps);
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

/**
 * Every artwork query is keyed by the row's own id, so every one seeks the
 * primary key and none sorts. The assertion names the step SQLite reports
 * rather than the word `SEARCH` alone, because a `SCAN` of the table would
 * answer the same questions while reading it end to end.
 */
test('every artwork query seeks its table by primary key and none sorts', () => {
  const raw = setup();

  const tables: Record<keyof typeof ARTWORK_QUERY, string> = {
    poster: 'poster',
    background: 'background',
    logo: 'logo',
    person: 'person_image',
  };

  assert.deepEqual(
    Object.keys(tables).toSorted(),
    Object.keys(ARTWORK_QUERY).toSorted(),
    'every artwork query needs a plan expectation, and every expectation an artwork query',
  );

  for (const [kind, table] of Object.entries(tables)) {
    const sql = ARTWORK_QUERY[kind as keyof typeof ARTWORK_QUERY];
    const steps = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1)
      .map((step) => String((step as { detail: unknown }).detail));
    const plan = steps.join('\n');

    assert.ok(
      plan.includes(`SEARCH ${table} USING INTEGER PRIMARY KEY (rowid=?)`),
      `${kind} must seek the primary key\n${plan}`,
    );
    assert.ok(!plan.includes(`SCAN ${table}`), `${kind} must not be scanned end to end\n${plan}`);
    assert.equal(steps.filter((step) => step.includes('USE TEMP B-TREE')).length, 0, `${kind} must not sort\n${plan}`);
  }
});
