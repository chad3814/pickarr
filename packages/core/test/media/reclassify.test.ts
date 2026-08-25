import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { getGroupMetadata, rowsWithArtwork, setArtworkPair } from '../../src/db/metadata.ts';
import { reclassifyArtwork } from '../../src/media/reclassify.ts';

/** A minimal but valid baseline JPEG carrying the given dimensions in its SOF0 marker. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes: number[] = [0xff, 0xd8]; // SOI
  const app0 = [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]; // "JFIF\0" + version/units/density/thumbnail
  const app0Length = app0.length + 2;
  bytes.push(0xff, 0xe0, (app0Length >> 8) & 0xff, app0Length & 0xff, ...app0);
  const sof = [
    8, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    1, // number of components
    1, 0x11, 0, // component id, sampling factors, quantization table
  ];
  const sofLength = sof.length + 2;
  bytes.push(0xff, 0xc0, (sofLength >> 8) & 0xff, sofLength & 0xff, ...sof);
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

/** A `jpeg` a test intends to measure as landscape — guarded so a mislabelled call fails loudly rather than silently testing the wrong shape. */
function landscapeJpeg(width: number, height: number): Uint8Array {
  if (width <= height) throw new Error(`landscapeJpeg(${width}, ${height}) is not landscape`);
  return jpeg(width, height);
}

/** A `jpeg` a test intends to measure as portrait (or square). Same guard as `landscapeJpeg`, mirrored. */
function portraitJpeg(width: number, height: number): Uint8Array {
  if (width > height) throw new Error(`portraitJpeg(${width}, ${height}) is not portrait`);
  return jpeg(width, height);
}

/** Whether a cached file is still on disk — the only way to see the unlink from outside. */
async function exists(dir: string, name: string): Promise<boolean> {
  try {
    await access(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** Every test gets its own temp artwork directory and removes it on the way out. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'reclassify-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface SeedOptions {
  groupId: number;
  posterPath?: string | null;
  backgroundPath?: string | null;
  /** Bytes to write at `posterPath`/`backgroundPath`, or `null` for a row whose file is missing. */
  bytes: Uint8Array | null;
}

/** Every directory `seed` hands out, removed once by the module-level `after` below. */
const seededDirs: string[] = [];
after(async () => {
  await Promise.all(seededDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A confirmed group whose metadata holds the given poster/background paths,
 * with a cached file underneath each non-null one — or no file at all, for a
 * row that claims a path nothing backs.
 */
async function seed(options: SeedOptions): Promise<{ db: DatabaseSync; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'reclassify-db-'));
  seededDirs.push(dir);
  const db = openTestDatabase();
  const posterPath = options.posterPath ?? null;
  const backgroundPath = options.backgroundPath ?? null;
  const posterUrl = posterPath === null ? null : `https://cdn.example/poster/${posterPath}`;
  const backgroundUrl = backgroundPath === null ? null : `https://cdn.example/background/${backgroundPath}`;

  db.prepare(
    `INSERT INTO media_groups
       (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (?, '@pickarr/plugin-scenes', ?, '{}', '', 0, 0)`,
  ).run(options.groupId, `key-${options.groupId}`);
  db.prepare(
    `INSERT INTO group_metadata
       (group_id, state, source, title, poster_url, poster_path,
        background_url, background_path, fetched_at)
     VALUES (?, 'confirmed', 'theporndb', 'A Scene', ?, ?, ?, ?, 1000)`,
  ).run(options.groupId, posterUrl, posterPath, backgroundUrl, backgroundPath);

  if (options.bytes !== null) {
    if (posterPath !== null) await writeFile(join(dir, posterPath), options.bytes);
    if (backgroundPath !== null) await writeFile(join(dir, backgroundPath), options.bytes);
  }

  return { db, dir };
}

test('a poster column holding a landscape image is moved to the background column', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: '1.jpg', bytes: landscapeJpeg(1279, 719) });
  const report = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
  assert.deepEqual(report, { examined: 1, moved: 1, cleared: 0, unreadable: 0 });
  const row = getGroupMetadata(db, 1);
  assert.equal(row?.posterPath, null);
  assert.equal(row?.backgroundPath, '1.jpg');
  // The url travels with the path, or the row would name one image and serve another.
  assert.equal(row?.posterUrl, null);
  assert.equal(row?.backgroundUrl, 'https://cdn.example/poster/1.jpg');
});

test('a correctly-filed image is left alone, so the script is a no-op once clean', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: '1.jpg', bytes: portraitJpeg(800, 1200) });
  assert.deepEqual(
    await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} }),
    { examined: 1, moved: 0, cleared: 0, unreadable: 0 },
  );
  const row = getGroupMetadata(db, 1);
  assert.equal(row?.posterPath, '1.jpg');
  assert.equal(row?.backgroundPath, null);
});

test('dry-run reports what it would move and changes nothing', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: '1.jpg', bytes: landscapeJpeg(1279, 719) });
  assert.deepEqual(
    await reclassifyArtwork({ db, dir, dryRun: true, log: () => {} }),
    { examined: 1, moved: 1, cleared: 0, unreadable: 0 },
  );
  const row = getGroupMetadata(db, 1);
  assert.equal(row?.posterPath, '1.jpg');
  assert.equal(row?.posterUrl, 'https://cdn.example/poster/1.jpg');
  assert.equal(row?.backgroundPath, null);
});

test('a row whose file is missing is counted, not crashed on', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: 'gone.jpg', bytes: null });
  assert.deepEqual(
    await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} }),
    { examined: 1, moved: 0, cleared: 0, unreadable: 1 },
  );
  assert.equal(getGroupMetadata(db, 1)?.posterPath, 'gone.jpg');
});

test('bytes that are not a readable image are counted as unreadable, not crashed on', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene', 'https://cdn.example/1.jpg', '1.jpg', 1000)`,
    ).run();
    await writeFile(join(dir, '1.jpg'), 'not an image');

    assert.deepEqual(
      await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} }),
      { examined: 1, moved: 0, cleared: 0, unreadable: 1 },
    );
    assert.equal(getGroupMetadata(db, 1)?.posterPath, '1.jpg');
  });
});

test('a background column holding a portrait image is moved to the poster column', async () => {
  const { db, dir } = await seed({ groupId: 1, backgroundPath: '1.jpg', bytes: portraitJpeg(800, 1200) });
  const report = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
  assert.deepEqual(report, { examined: 1, moved: 1, cleared: 0, unreadable: 0 });
  const row = getGroupMetadata(db, 1);
  assert.equal(row?.backgroundPath, null);
  assert.equal(row?.backgroundUrl, null);
  assert.equal(row?.posterPath, '1.jpg');
  assert.equal(row?.posterUrl, 'https://cdn.example/background/1.jpg');
});

test('a mismatching poster is cleared, not moved, when the background slot already holds a correct image', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/wide.jpg', 'wide.jpg',
               'https://cdn.example/bg.jpg', 'bg.jpg', 1000)`,
    ).run();
    // The poster slot holds a landscape image (a mismatch); the background
    // slot already holds a correct, distinct landscape image of its own.
    await writeFile(join(dir, 'wide.jpg'), landscapeJpeg(1279, 719));
    await writeFile(join(dir, 'bg.jpg'), landscapeJpeg(1920, 1080));

    const report = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
    assert.deepEqual(report, { examined: 2, moved: 0, cleared: 1, unreadable: 0 });

    const row = getGroupMetadata(db, 1);
    assert.equal(row?.posterPath, null);
    assert.equal(row?.posterUrl, null);
    // The background that was already correct must be untouched, byte for byte.
    assert.equal(row?.backgroundPath, 'bg.jpg');
    assert.equal(row?.backgroundUrl, 'https://cdn.example/bg.jpg');

    // Nulling the column is only half of discarding the image. Leaving the
    // bytes behind would put a file in the artwork directory that no row names
    // and nothing can tell from a live one.
    assert.equal(await exists(dir, 'wide.jpg'), false, 'the cleared image is deleted, not orphaned');
    assert.equal(await exists(dir, 'bg.jpg'), true, "the destination's own file is left alone");
  });
});

test('a mismatching background is cleared, not moved, when the poster slot already holds a correct image', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/p.jpg', 'p.jpg',
               'https://cdn.example/tall.jpg', 'tall.jpg', 1000)`,
    ).run();
    // The background slot holds a portrait image (a mismatch); the poster
    // slot already holds a correct, distinct portrait image of its own.
    await writeFile(join(dir, 'p.jpg'), portraitJpeg(600, 900));
    await writeFile(join(dir, 'tall.jpg'), portraitJpeg(800, 1200));

    const report = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
    assert.deepEqual(report, { examined: 2, moved: 0, cleared: 1, unreadable: 0 });

    const row = getGroupMetadata(db, 1);
    assert.equal(row?.backgroundPath, null);
    assert.equal(row?.backgroundUrl, null);
    // The poster that was already correct must be untouched, byte for byte.
    assert.equal(row?.posterPath, 'p.jpg');
    assert.equal(row?.posterUrl, 'https://cdn.example/p.jpg');

    assert.equal(await exists(dir, 'tall.jpg'), false, 'the cleared image is deleted, not orphaned');
    assert.equal(await exists(dir, 'p.jpg'), true, "the destination's own file is left alone");
  });
});

test('a mismatching slot cleared under --dry-run keeps its file, as it keeps its row', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/wide.jpg', 'wide.jpg',
               'https://cdn.example/bg.jpg', 'bg.jpg', 1000)`,
    ).run();
    await writeFile(join(dir, 'wide.jpg'), landscapeJpeg(1279, 719));
    await writeFile(join(dir, 'bg.jpg'), landscapeJpeg(1920, 1080));

    const report = await reclassifyArtwork({ db, dir, dryRun: true, log: () => {} });
    assert.deepEqual(report, { examined: 2, moved: 0, cleared: 1, unreadable: 0 });

    // The row is the easy half. The file is the half a dry run could quietly
    // get wrong, since a deleted image is the one thing a re-run cannot undo.
    assert.equal(getGroupMetadata(db, 1)?.posterPath, 'wide.jpg');
    assert.equal(await exists(dir, 'wide.jpg'), true, 'dry-run deletes nothing');
    assert.equal(await exists(dir, 'bg.jpg'), true);
  });
});

test('a cleared file that will not delete is reported as a leak, and the next row is still processed', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    for (const groupId of [1, 2]) {
      db.prepare(
        `INSERT INTO media_groups
           (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
         VALUES (?, '@pickarr/plugin-scenes', ?, '{}', '', 0, 0)`,
      ).run(groupId, `key-${groupId}`);
    }
    // Group 1 clears (its background slot is filled); group 2, examined after
    // it, is an ordinary move that must not be lost to group 1's failure.
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/wide.jpg', 'wide.jpg',
               'https://cdn.example/bg.jpg', 'bg.jpg', 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path, fetched_at)
       VALUES (2, 'confirmed', 'theporndb', 'B Scene', 'https://cdn.example/2.jpg', '2.jpg', 1000)`,
    ).run();
    await writeFile(join(dir, 'wide.jpg'), landscapeJpeg(1279, 719));
    await writeFile(join(dir, 'bg.jpg'), landscapeJpeg(1920, 1080));
    await writeFile(join(dir, '2.jpg'), landscapeJpeg(1279, 719));

    const lines: string[] = [];
    const report = await reclassifyArtwork({
      db,
      dir,
      dryRun: false,
      log: (message) => lines.push(message),
      rm: () => Promise.reject(new Error('EACCES')),
    });

    assert.deepEqual(report, { examined: 3, moved: 1, cleared: 1, unreadable: 0 });
    // The row was reclassified correctly regardless: a file that would not
    // delete is a lesser, separate problem, and the log says which it is.
    assert.equal(getGroupMetadata(db, 1)?.posterPath, null);
    assert.equal(getGroupMetadata(db, 1)?.backgroundPath, 'bg.jpg');
    assert.equal(await exists(dir, 'wide.jpg'), true, 'the failed unlink really did leave the file');
    assert.match(
      lines.join('\n'),
      /group 1: reclassified, but wide\.jpg could not be deleted and is now unreferenced: EACCES/,
    );

    // The whole point: one unwritable file must not abort a backfill.
    assert.equal(getGroupMetadata(db, 2)?.posterPath, null);
    assert.equal(getGroupMetadata(db, 2)?.backgroundPath, '2.jpg');
  });
});

test('a database write that fails leaves the file it would have orphaned in place', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/wide.jpg', 'wide.jpg',
               'https://cdn.example/bg.jpg', 'bg.jpg', 1000)`,
    ).run();
    await writeFile(join(dir, 'wide.jpg'), landscapeJpeg(1279, 719));
    await writeFile(join(dir, 'bg.jpg'), landscapeJpeg(1920, 1080));
    // Refuses the one UPDATE `setArtworkPair` is about to attempt, which is the
    // only way to reach the ordering from outside: a trigger, rather than a
    // stubbed writer, so the failure is a real failure of the real statement.
    db.exec(
      `CREATE TRIGGER refuse_writes BEFORE UPDATE ON group_metadata
       BEGIN SELECT RAISE(ABORT, 'no writes'); END`,
    );

    await assert.rejects(
      reclassifyArtwork({ db, dir, dryRun: false, log: () => {} }),
      /no writes/,
    );

    // This is the asymmetry the order is chosen for. A file with no row is
    // recoverable — re-run and it is deleted properly. A row naming a file that
    // is gone is not recoverable by anything.
    assert.equal(await exists(dir, 'wide.jpg'), true, 'nothing is deleted until the row is written');
    assert.equal(getGroupMetadata(db, 1)?.posterPath, 'wide.jpg');
  });
});

test('a slot cleared while the surviving slot names the same file keeps that file', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    // Both columns name one file. Clearing the poster column is exactly what
    // protects the image the background column is serving, so deleting it
    // would be the clear destroying what it set out to save.
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/poster/shared.jpg', 'shared.jpg',
               'https://cdn.example/background/shared.jpg', 'shared.jpg', 1000)`,
    ).run();
    await writeFile(join(dir, 'shared.jpg'), landscapeJpeg(1279, 719));

    const lines: string[] = [];
    const report = await reclassifyArtwork({
      db,
      dir,
      dryRun: false,
      log: (message) => lines.push(message),
    });
    assert.deepEqual(report, { examined: 2, moved: 0, cleared: 1, unreadable: 0 });

    const row = getGroupMetadata(db, 1);
    assert.equal(row?.posterPath, null);
    assert.equal(row?.backgroundPath, 'shared.jpg');
    assert.equal(await exists(dir, 'shared.jpg'), true, 'the surviving slot is still serving it');
    assert.match(lines.join('\n'), /its file kept, because the surviving slot names that file too/);
  });
});

test('a move leaves the file it relocates on disk, since the row still names it', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: '1.jpg', bytes: landscapeJpeg(1279, 719) });
  assert.deepEqual(
    await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} }),
    { examined: 1, moved: 1, cleared: 0, unreadable: 0 },
  );
  assert.equal(getGroupMetadata(db, 1)?.backgroundPath, '1.jpg');
  assert.equal(await exists(dir, '1.jpg'), true, 'a move deletes nothing — the path just changed column');
});

test('a mismatching poster is cleared, not moved, when the background slot holds only a url and no cached file', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/wide.jpg', 'wide.jpg',
               'https://cdn.example/known-but-uncached.jpg', NULL, 1000)`,
    ).run();
    await writeFile(join(dir, 'wide.jpg'), landscapeJpeg(1279, 719));

    // background_path is NULL, so nothing under it is measured — but
    // background_url is not, which is enough to count the slot as occupied.
    const lines: string[] = [];
    const report = await reclassifyArtwork({
      db,
      dir,
      dryRun: false,
      log: (message) => lines.push(message),
    });
    assert.deepEqual(report, { examined: 1, moved: 0, cleared: 1, unreadable: 0 });

    const row = getGroupMetadata(db, 1);
    assert.equal(row?.posterPath, null);
    assert.equal(row?.posterUrl, null);
    assert.equal(row?.backgroundPath, null);
    assert.equal(row?.backgroundUrl, 'https://cdn.example/known-but-uncached.jpg');

    // Occupied is `url OR path`, so this row is cleared — but the destination
    // holds no cached bytes at all, which makes the cleared file the only
    // readable image the group has. A url whose fetch failed once and is never
    // retried (`worthReasking` re-asks only `state = 'none'`) is an ordinary way
    // to arrive here, so deleting would throw away the last usable image over a
    // transient download failure.
    assert.equal(
      await exists(dir, 'wide.jpg'),
      true,
      'the cleared file is kept when the destination has no image of its own',
    );
    assert.match(lines.join('\n'), /its file kept, because the surviving slot has no usable image of its own/);
  });
});

test('a cleared file is kept when the destination names a file that is missing from disk', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/wide.jpg', 'wide.jpg',
               'https://cdn.example/gone.jpg', 'gone.jpg', 1000)`,
    ).run();
    // The destination names a file, so the slot is occupied and the row is
    // cleared — but the file is not there to be measured, so the destination
    // serves nothing and the cleared image is all the row has.
    await writeFile(join(dir, 'wide.jpg'), landscapeJpeg(1279, 719));

    const report = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
    assert.deepEqual(report, { examined: 2, moved: 0, cleared: 1, unreadable: 1 });

    const row = getGroupMetadata(db, 1);
    assert.equal(row?.posterPath, null);
    assert.equal(row?.backgroundPath, 'gone.jpg');
    assert.equal(
      await exists(dir, 'wide.jpg'),
      true,
      "the cleared file is kept when the destination's own file is missing",
    );
  });
});

test('a cleared file is kept when the destination names a file that cannot be measured', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/wide.jpg', 'wide.jpg',
               'https://cdn.example/broken.jpg', 'broken.jpg', 1000)`,
    ).run();
    await writeFile(join(dir, 'wide.jpg'), landscapeJpeg(1279, 719));
    // Bytes `classifyArtwork` cannot measure: the destination file exists but is
    // no more usable than a missing one, and this module's own rule is that a
    // failed measurement is never grounds to act.
    await writeFile(join(dir, 'broken.jpg'), 'not an image');

    const report = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
    assert.deepEqual(report, { examined: 2, moved: 0, cleared: 1, unreadable: 1 });

    const row = getGroupMetadata(db, 1);
    assert.equal(row?.posterPath, null);
    assert.equal(row?.backgroundPath, 'broken.jpg');
    assert.equal(
      await exists(dir, 'wide.jpg'),
      true,
      "the cleared file is kept when the destination's own file cannot be measured",
    );
  });
});

test('a poster and a background swapped with each other are each moved to the right slot', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO media_groups
         (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO group_metadata
         (group_id, state, source, title, poster_url, poster_path,
          background_url, background_path, fetched_at)
       VALUES (1, 'confirmed', 'theporndb', 'A Scene',
               'https://cdn.example/wide.jpg', 'wide.jpg',
               'https://cdn.example/tall.jpg', 'tall.jpg', 1000)`,
    ).run();
    await writeFile(join(dir, 'wide.jpg'), landscapeJpeg(1279, 719));
    await writeFile(join(dir, 'tall.jpg'), portraitJpeg(800, 1200));

    const report = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
    assert.deepEqual(report, { examined: 2, moved: 2, cleared: 0, unreadable: 0 });

    const row = getGroupMetadata(db, 1);
    assert.equal(row?.posterPath, 'tall.jpg');
    assert.equal(row?.posterUrl, 'https://cdn.example/tall.jpg');
    assert.equal(row?.backgroundPath, 'wide.jpg');
    assert.equal(row?.backgroundUrl, 'https://cdn.example/wide.jpg');

    // A swap exchanges two paths, so both are still referenced afterwards and
    // neither is an orphan.
    assert.equal(await exists(dir, 'wide.jpg'), true, 'a swap deletes nothing');
    assert.equal(await exists(dir, 'tall.jpg'), true, 'a swap deletes nothing');
  });
});

test('running twice moves a row once and leaves the second run a no-op', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: '1.jpg', bytes: landscapeJpeg(1279, 719) });
  const first = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
  assert.deepEqual(first, { examined: 1, moved: 1, cleared: 0, unreadable: 0 });

  const second = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
  assert.deepEqual(second, { examined: 1, moved: 0, cleared: 0, unreadable: 0 }, 'safe to run twice');
});

test('multiple rows are examined and reported together', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    for (const [groupId, path, bytes] of [
      [1, '1.jpg', landscapeJpeg(1279, 719)],
      [2, '2.jpg', portraitJpeg(800, 1200)],
      [3, '3.jpg', null],
    ] as const) {
      db.prepare(
        `INSERT INTO media_groups
           (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
         VALUES (?, '@pickarr/plugin-scenes', ?, '{}', '', 0, 0)`,
      ).run(groupId, `key-${groupId}`);
      db.prepare(
        `INSERT INTO group_metadata
           (group_id, state, source, title, poster_url, poster_path, fetched_at)
         VALUES (?, 'confirmed', 'theporndb', 'A Scene', ?, ?, 1000)`,
      ).run(groupId, `https://cdn.example/${path}`, path);
      if (bytes !== null) await writeFile(join(dir, path), bytes);
    }

    assert.deepEqual(
      await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} }),
      { examined: 3, moved: 1, cleared: 0, unreadable: 1 },
    );
  });
});

// --- The queries underneath ---------------------------------------------------

test('rowsWithArtwork finds every row holding at least one cached image, in id order', () => {
  const db = openTestDatabase();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0),
            (2, '@pickarr/plugin-scenes', 'key-2', '{}', '', 0, 0),
            (3, '@pickarr/plugin-scenes', 'key-3', '{}', '', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO group_metadata (group_id, state, source, title, poster_url, poster_path, fetched_at)
     VALUES (1, 'confirmed', 'theporndb', 'A', 'https://cdn.example/1.jpg', '1.jpg', 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO group_metadata (group_id, state, source, title, fetched_at)
     VALUES (2, 'none', 'theporndb', NULL, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO group_metadata
       (group_id, state, source, title, background_url, background_path, fetched_at)
     VALUES (3, 'confirmed', 'theporndb', 'C', 'https://cdn.example/3.jpg', '3.jpg', 1000)`,
  ).run();

  assert.deepEqual(rowsWithArtwork(db), [
    { groupId: 1, posterUrl: 'https://cdn.example/1.jpg', posterPath: '1.jpg', backgroundUrl: null, backgroundPath: null },
    { groupId: 3, posterUrl: null, posterPath: null, backgroundUrl: 'https://cdn.example/3.jpg', backgroundPath: '3.jpg' },
  ]);
});

test('setArtworkPair writes both slots at once, replacing whatever each held', () => {
  const db = openTestDatabase();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, '@pickarr/plugin-scenes', 'key-1', '{}', '', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO group_metadata (group_id, state, source, title, poster_url, poster_path, fetched_at)
     VALUES (1, 'confirmed', 'theporndb', 'A', 'https://cdn.example/1.jpg', '1.jpg', 1000)`,
  ).run();

  setArtworkPair(db, 1, {
    posterUrl: null,
    posterPath: null,
    backgroundUrl: 'https://cdn.example/1.jpg',
    backgroundPath: '1.jpg',
  });

  const row = getGroupMetadata(db, 1);
  assert.equal(row?.posterUrl, null);
  assert.equal(row?.posterPath, null);
  assert.equal(row?.backgroundUrl, 'https://cdn.example/1.jpg');
  assert.equal(row?.backgroundPath, '1.jpg');
});
