import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { getGroupMetadata, postersMatching, setBackgroundImage } from '../../src/db/metadata.ts';
import { BACKGROUND_CROP_MARKER } from '../../src/clients/theporndb.ts';
import {
  postersNeedingRepair,
  repairBackgroundPosters,
} from '../../src/media/repair-posters.ts';
import type { FetchImpl } from '../../src/clients/theporndb.ts';

const CROP =
  'https://thumb.theporndb.net/6lTbCMl9aBGSuDkuuUA3ucoAKyU=/800x1200/smart/' +
  'filters:sharpen():watermark(sites%2F4b%2Flogo%2Fcreampieangels-logo.png,-10,-10,25,50)/' +
  'scene%2Ff9%2F84%2F16%2Fabc%2Fbackground%2Fbg-a-scene.jpg';

const BACKGROUND = 'https://cdn.theporndb.net/scene/f9/84/16/abc/background/bg-a-scene.jpg';

const REAL_POSTER = 'https://cdn.theporndb.net/scene/e2/b4/poster/c/poster-large.jpg';

/** Every test gets its own temp artwork directory and removes it on the way out. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'repair-posters-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A group with metadata already answered and a poster url of the caller's choosing. */
function seedPoster(
  db: DatabaseSync,
  groupId: number,
  posterUrl: string,
  posterPath: string | null,
): void {
  db.prepare(
    `INSERT INTO media_groups
       (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (?, '@pickarr/plugin-scenes', ?, '{}', '', 0, 0)`,
  ).run(groupId, `key-${groupId}`);
  db.prepare(
    `INSERT INTO group_metadata
       (group_id, state, source, title, poster_url, poster_path, fetched_at)
     VALUES (?, 'confirmed', 'theporndb', 'A Scene', ?, ?, 1000)`,
  ).run(groupId, posterUrl, posterPath);
}

function imageFetch(contentType: string, bytes = 'new-background-bytes'): FetchImpl & { urls: string[] } {
  const urls: string[] = [];
  const impl: FetchImpl = async (url) => {
    urls.push(url);
    return new Response(new TextEncoder().encode(bytes), {
      status: 200,
      headers: { 'content-type': contentType },
    });
  };
  return Object.assign(impl, { urls });
}

test('a cached crop is replaced by its background, file and url together', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    seedPoster(db, 7, CROP, '7.jpg');
    await writeFile(join(dir, '7.jpg'), 'the-old-crop-bytes');

    const fetchImpl = imageFetch('image/jpeg');
    const logs: string[] = [];
    const result = await repairBackgroundPosters({
      db,
      artwork: { dir, fetchImpl, log: (m) => logs.push(m) },
      log: (m) => logs.push(m),
    });

    assert.deepEqual(result, { looked: 1, repaired: 1, failed: 0 });
    assert.deepEqual(fetchImpl.urls, [BACKGROUND], 'the background, decoded from the crop url');

    const metadata = getGroupMetadata(db, 7);
    assert.equal(metadata?.backgroundUrl, BACKGROUND);
    assert.equal(metadata?.backgroundPath, '7.jpg');
    // The crop this replaces was never a real poster, so nothing is left behind
    // under the poster columns once the recovered background takes its place.
    assert.equal(metadata?.posterUrl, null);
    assert.equal(metadata?.posterPath, null);
    assert.equal(
      await readFile(join(dir, '7.jpg'), 'utf8'),
      'new-background-bytes',
      'the existing file is overwritten in place, so the background route never 404s',
    );
  });
});

test('a background of a different type replaces the stale file rather than orphaning it', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    seedPoster(db, 7, CROP, '7.jpg');
    await writeFile(join(dir, '7.jpg'), 'the-old-crop-bytes');

    const result = await repairBackgroundPosters({
      db,
      artwork: { dir, fetchImpl: imageFetch('image/webp'), log: () => undefined },
      log: () => undefined,
    });

    assert.equal(result.repaired, 1);
    const metadata = getGroupMetadata(db, 7);
    assert.equal(metadata?.backgroundPath, '7.webp');
    assert.equal(metadata?.posterPath, null);
    assert.deepEqual(await readdir(dir), ['7.webp'], 'the superseded 7.jpg is gone');
  });
});

test('a failed download leaves the row and its file untouched, for a later run', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    seedPoster(db, 7, CROP, '7.jpg');
    await writeFile(join(dir, '7.jpg'), 'the-old-crop-bytes');

    const result = await repairBackgroundPosters({
      db,
      artwork: {
        dir,
        fetchImpl: async () => new Response('nope', { status: 500 }),
        log: () => undefined,
      },
      log: () => undefined,
    });

    assert.deepEqual(result, { looked: 1, repaired: 0, failed: 1 });
    const metadata = getGroupMetadata(db, 7);
    assert.equal(metadata?.posterUrl, CROP, 'still recognisable to the next run');
    assert.equal(metadata?.posterPath, '7.jpg');
    assert.equal(await readFile(join(dir, '7.jpg'), 'utf8'), 'the-old-crop-bytes');
  });
});

test('a crop whose url will not decode is reported and skipped, never blanked', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    const undecodable = `https://thumb.theporndb.net/h=${BACKGROUND_CROP_MARKER}%zz.jpg`;
    seedPoster(db, 7, undecodable, '7.jpg');

    const fetchImpl = imageFetch('image/jpeg');
    const logs: string[] = [];
    const result = await repairBackgroundPosters({
      db,
      artwork: { dir, fetchImpl, log: (m) => logs.push(m) },
      log: (m) => logs.push(m),
    });

    assert.deepEqual(result, { looked: 1, repaired: 0, failed: 1 });
    assert.deepEqual(fetchImpl.urls, [], 'nothing to fetch, so nothing was fetched');
    assert.equal(getGroupMetadata(db, 7)?.posterUrl, undecodable);
    assert.ok(logs.some((line) => line.includes('group 7')), logs.join('\n'));
  });
});

test('genuine posters are not touched, and a second run finds nothing left to do', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    seedPoster(db, 1, REAL_POSTER, '1.jpg');
    seedPoster(db, 2, CROP, '2.jpg');
    seedPoster(db, 3, REAL_POSTER, null);

    const deps = {
      db,
      artwork: { dir, fetchImpl: imageFetch('image/jpeg'), log: () => undefined },
      log: () => undefined,
    };

    assert.deepEqual(postersNeedingRepair(db).map((row) => row.groupId), [2]);

    const first = await repairBackgroundPosters(deps);
    assert.deepEqual(first, { looked: 1, repaired: 1, failed: 0 });
    assert.equal(getGroupMetadata(db, 1)?.posterUrl, REAL_POSTER, 'a genuine poster is left as a poster');
    const repaired = getGroupMetadata(db, 2);
    assert.equal(repaired?.backgroundUrl, BACKGROUND);
    assert.equal(repaired?.posterUrl, null);

    const second = await repairBackgroundPosters(deps);
    assert.deepEqual(second, { looked: 0, repaired: 0, failed: 0 }, 'safe to run twice');
  });
});

test('a row whose image was never cached is still repaired', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    seedPoster(db, 7, CROP, null);

    const result = await repairBackgroundPosters({
      db,
      artwork: { dir, fetchImpl: imageFetch('image/jpeg'), log: () => undefined },
      log: () => undefined,
    });

    assert.equal(result.repaired, 1);
    const metadata = getGroupMetadata(db, 7);
    assert.equal(metadata?.backgroundPath, '7.jpg');
    assert.equal(metadata?.posterPath, null);
  });
});

// --- The queries underneath ---------------------------------------------------

test('postersMatching finds only rows containing the fragment, in id order', () => {
  const db = openTestDatabase();
  seedPoster(db, 3, CROP, '3.jpg');
  seedPoster(db, 1, REAL_POSTER, '1.jpg');
  seedPoster(db, 2, CROP, null);

  assert.deepEqual(postersMatching(db, BACKGROUND_CROP_MARKER), [
    { groupId: 2, posterUrl: CROP, posterPath: null },
    { groupId: 3, posterUrl: CROP, posterPath: '3.jpg' },
  ]);
  assert.deepEqual(postersMatching(db, 'nothing-matches-this'), []);
});

test('setBackgroundImage moves the url and the path together, and clears the poster pair', () => {
  const db = openTestDatabase();
  seedPoster(db, 7, CROP, '7.jpg');

  setBackgroundImage(db, 7, BACKGROUND, '7.webp');

  const metadata = getGroupMetadata(db, 7);
  assert.equal(metadata?.backgroundUrl, BACKGROUND);
  assert.equal(metadata?.backgroundPath, '7.webp');
  assert.equal(metadata?.posterUrl, null);
  assert.equal(metadata?.posterPath, null);
  assert.deepEqual(postersMatching(db, BACKGROUND_CROP_MARKER), [], 'no longer needs repair');
});
