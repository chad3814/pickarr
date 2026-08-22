import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from '../temp-dir.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportPlan, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { importDownload, lstatOrNull, type ImportDeps } from '../../src/pipeline/import.ts';
import { trashFiles } from '../../src/pipeline/upgrade.ts';
import { getGroup } from '../../src/db/groups.ts';
import { getDownload } from '../../src/db/downloads.ts';
import {
  filesForGroup,
  liveFilesForGroup,
  liveFilesForOtherReleases,
} from '../../src/db/imported-files.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';

function registryFor(planImport: MediaTypePlugin['planImport'], root: string): PluginRegistry {
  const mediaPlugin: MediaTypePlugin = {
    id: 'test',
    displayName: 'Test',
    parse: () => null,
    score: () => 0,
    planImport,
  };
  return {
    byPackage: () => mediaPlugin,
    byId: () => mediaPlugin,
    libraryRoot: () => root,
    libraryRootById: () => root,
    all: () => [mediaPlugin],
  };
}

/**
 * Group already owns release 1; release 2 is the flagged upgrade.
 *
 * Two downloads exist: id 9, the earlier `initial` download that put release 1
 * in the library, and id 1, the in-flight `upgrade` download for release 2.
 * The superseded file's `imported_files` row belongs to download 9 — never to
 * download 1 — because that is the only shape production ever produces, and
 * conflating the two is exactly what let an upgrade trash its own output.
 */
function seedUpgrade(db: DatabaseSync, storagePath: string): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, upgrade_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{"title":"T","fields":[]}', 't', 'picked', 1, 2, 1, 9000)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1), (2, 1, 2, '{}', 200, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status,
                            storage_path, created_at, updated_at)
     VALUES (9, 1, 1, 'sab', 'nzo_1', 'initial', 'imported', '/old/complete', 1, 1),
            (1, 2, 1, 'sab', 'nzo_2', 'upgrade', 'completed', ?, 1, 1)`,
  ).run(storagePath);
}

function deps(
  db: DatabaseSync,
  registry: PluginRegistry,
  trashDir: string,
  overrides: Partial<ImportDeps> = {},
): ImportDeps {
  return { db, registry, importMode: 'move', trashDir, now: () => 2000, ...overrides };
}

test('an upgrade trashes the old file, writes the new one, and repoints the group', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'scene.mp4'), 'old-version');

    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'scene.mp4'), 'new-version');

    const db = openTestDatabase();
    seedUpgrade(db, downloadDir);
    // The old file is on record as the group's live import, from download 9.
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (9, 1, '/old/source', ?, 11, 1)`,
    ).run(join(library, 'scene.mp4'));

    const registry = registryFor(
      (): ImportPlan => ({
        files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'scene.mp4' }],
      }),
      library,
    );

    await importDownload(deps(db, registry, trash), getDownload(db, 1)!);

    assert.equal(await readFile(join(library, 'scene.mp4'), 'utf8'), 'new-version');

    const trashedGroupDir = join(trash, '1', '2000');
    assert.deepEqual(await readdir(trashedGroupDir), ['scene.mp4']);
    assert.equal(await readFile(join(trashedGroupDir, 'scene.mp4'), 'utf8'), 'old-version');

    const group = getGroup(db, 1)!;
    assert.equal(group.pickedReleaseId, 2);
    assert.equal(group.upgradeReleaseId, null);
    assert.equal(getDownload(db, 1)?.status, 'imported');

    const live = liveFilesForGroup(db, 1);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.destPath, join(library, 'scene.mp4'));
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('re-running the same upgrade import does not trash the files it just imported', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'scene.mp4'), 'old-version');

    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'scene.mp4'), 'new-version');

    const db = openTestDatabase();
    seedUpgrade(db, downloadDir);
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (9, 1, '/old/source', ?, 11, 1)`,
    ).run(join(library, 'scene.mp4'));

    const registry = registryFor(
      (): ImportPlan => ({
        files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'scene.mp4' }],
      }),
      library,
    );

    await importDownload(deps(db, registry, trash, { now: () => 2000 }), getDownload(db, 1)!);

    // A crash between the successful transfer and the status write. Boot
    // recovery puts an `importing` row back to `completed`, so the next tick
    // runs this exact same import a second time.
    db.prepare("UPDATE downloads SET status = 'completed' WHERE id = 1").run();

    await importDownload(deps(db, registry, trash, { now: () => 3000 }), getDownload(db, 1)!);

    // The second attempt is a no-op, not a self-destruct: the file this
    // download imported is still in the library, not in trash.
    assert.equal(await readFile(join(library, 'scene.mp4'), 'utf8'), 'new-version');
    assert.deepEqual(await readdir(join(trash, '1')), ['2000']);

    const live = liveFilesForGroup(db, 1);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.destPath, join(library, 'scene.mp4'));
    assert.equal(live[0]?.downloadId, 1);
    assert.equal(getDownload(db, 1)?.status, 'imported');
    assert.equal(getGroup(db, 1)?.pickedReleaseId, 2);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trash paths are namespaced so repeated upgrades cannot collide', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });

    const db = openTestDatabase();
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    seedUpgrade(db, downloadDir);

    for (const [stamp, contents] of [
      [2000, 'first'],
      [3000, 'second'],
    ] as const) {
      await writeFile(join(library, 'scene.mp4'), contents);
      await writeFile(join(downloadDir, 'scene.mp4'), 'replacement');
      db.prepare('DELETE FROM imported_files WHERE group_id = 1').run();
      db.prepare(
        `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
         VALUES (9, 1, '/old', ?, 5, 1)`,
      ).run(join(library, 'scene.mp4'));
      db.prepare("UPDATE downloads SET status = 'completed' WHERE id = 1").run();

      const registry = registryFor(
        (): ImportPlan => ({
          files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'scene.mp4' }],
        }),
        library,
      );
      await importDownload(deps(db, registry, trash, { now: () => stamp }), getDownload(db, 1)!);
    }

    assert.equal(await readFile(join(trash, '1', '2000', 'scene.mp4'), 'utf8'), 'first');
    assert.equal(await readFile(join(trash, '1', '3000', 'scene.mp4'), 'utf8'), 'second');
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failure after trashing reports where the old file went', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'scene.mp4'), 'old-version');

    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });

    const db = openTestDatabase();
    seedUpgrade(db, downloadDir);
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (9, 1, '/old', ?, 11, 1)`,
    ).run(join(library, 'scene.mp4'));

    // Plan a source that does not exist, so the transfer fails after trashing.
    const registry = registryFor(
      (): ImportPlan => ({
        files: [{ source: join(downloadDir, 'absent.mp4'), destination: 'scene.mp4' }],
      }),
      library,
    );

    await assert.rejects(
      importDownload(deps(db, registry, trash), getDownload(db, 1)!),
      (error: Error) => {
        assert.match(error.message, /previous files were moved to/);
        assert.match(error.message, /1[/\\]2000/);
        return true;
      },
    );

    assert.equal(await readFile(join(trash, '1', '2000', 'scene.mp4'), 'utf8'), 'old-version');
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an initial import trashes nothing and leaves the pointer alone', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'scene.mp4'), 'only-version');

    const db = openTestDatabase();
    seedUpgrade(db, downloadDir);
    db.prepare("UPDATE downloads SET kind = 'initial', release_id = 1 WHERE id = 1").run();

    const registry = registryFor(
      (): ImportPlan => ({
        files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'scene.mp4' }],
      }),
      library,
    );

    await importDownload(deps(db, registry, trash), getDownload(db, 1)!);

    assert.equal(
      await stat(trash).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(getGroup(db, 1)?.pickedReleaseId, 1);
    assert.equal(getGroup(db, 1)?.upgradeReleaseId, 2);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Direct unit tests against trashFiles ---
//
// The tests above exercise trashFiles only through importDownload, and
// only ever with one live file per group. These call it directly, so each
// can set up the exact row shape it needs without a full import plan. Each
// passes `liveFilesForGroup(db, 1, 1)` — 1 being the id of the download doing
// the importing (the in-flight upgrade) — as the row list; the rows below
// belong to download 9, so none of them is excluded and every one is a
// genuine trash candidate.

test('two live files sharing a basename in different library directories both survive in trash', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(join(library, 'A'), { recursive: true });
    await mkdir(join(library, 'B'), { recursive: true });
    await writeFile(join(library, 'A', 'scene.mp4'), 'FILE-A-CONTENT');
    await writeFile(join(library, 'B', 'scene.mp4'), 'FILE-B-CONTENT');

    const db = openTestDatabase();
    seedUpgrade(db, join(root, 'complete'));
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (9, 1, '/src/a', ?, 14, 1), (9, 1, '/src/b', ?, 14, 1)`,
    ).run(join(library, 'A', 'scene.mp4'), join(library, 'B', 'scene.mp4'));

    const libraryRootReal = await realpath(library);
    const trashedTo = await trashFiles(
      db,
      liveFilesForGroup(db, 1, 1),
      libraryRootReal,
      trash,
      1,
      5000,
    );
    if (trashedTo === null) throw new Error('expected files to be trashed');

    // Both files survive, each under its own path, not overwriting the other.
    assert.equal(await readFile(join(trashedTo, 'A', 'scene.mp4'), 'utf8'), 'FILE-A-CONTENT');
    assert.equal(await readFile(join(trashedTo, 'B', 'scene.mp4'), 'utf8'), 'FILE-B-CONTENT');

    // The database record for each row names the path it actually moved to.
    const rows = filesForGroup(db, 1);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.trashPath).toSorted(),
      [join(trashedTo, 'A', 'scene.mp4'), join(trashedTo, 'B', 'scene.mp4')].toSorted(),
    );
    assert.equal(liveFilesForGroup(db, 1).length, 0);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a refusal partway through trashing still names where earlier files in the same group went', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(join(library, 'A'), { recursive: true });
    // A directory sitting where a file is recorded — the second row, refused.
    await mkdir(join(library, 'B', 'scene.mp4'), { recursive: true });
    await writeFile(join(library, 'A', 'scene.mp4'), 'FILE-A-CONTENT');

    const db = openTestDatabase();
    seedUpgrade(db, join(root, 'complete'));
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (9, 1, '/src/a', ?, 14, 1), (9, 1, '/src/b', ?, 0, 1)`,
    ).run(join(library, 'A', 'scene.mp4'), join(library, 'B', 'scene.mp4'));

    const libraryRootReal = await realpath(library);

    await assert.rejects(
      trashFiles(db, liveFilesForGroup(db, 1, 1), libraryRootReal, trash, 1, 6000),
      (error: Error) => {
        assert.match(error.message, /not a regular file/);
        assert.match(error.message, /1[/\\]6000/);
        return true;
      },
    );

    // The first row's file was already moved before the second was refused.
    assert.equal(
      await readFile(join(trash, '1', '6000', 'A', 'scene.mp4'), 'utf8'),
      'FILE-A-CONTENT',
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live row whose file is already gone is trashed with no invented path', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });
    // library/scene.mp4 deliberately never created.

    const db = openTestDatabase();
    seedUpgrade(db, join(root, 'complete'));
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (9, 1, '/src', ?, 11, 1)`,
    ).run(join(library, 'scene.mp4'));

    const libraryRootReal = await realpath(library);
    const trashedTo = await trashFiles(
      db,
      liveFilesForGroup(db, 1, 1),
      libraryRootReal,
      trash,
      1,
      9000,
    );
    assert.notEqual(trashedTo, null);

    const [row] = filesForGroup(db, 1);
    assert.equal(row?.trashedAt, 9000);
    assert.equal(row?.trashPath, null);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live row pointing at a directory is refused rather than trashed', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(join(library, 'oops'), { recursive: true });

    const db = openTestDatabase();
    seedUpgrade(db, join(root, 'complete'));
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (9, 1, '/src', ?, 0, 1)`,
    ).run(join(library, 'oops'));

    const libraryRootReal = await realpath(library);

    await assert.rejects(
      trashFiles(db, liveFilesForGroup(db, 1, 1), libraryRootReal, trash, 1, 7000),
      /not a regular file/,
    );

    // Nothing was moved — the directory is exactly where it was.
    const stillThere = await stat(join(library, 'oops'));
    assert.equal(stillThere.isDirectory(), true);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live row that resolves outside the library root is refused rather than trashed', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'not-in-the-library');

    const db = openTestDatabase();
    seedUpgrade(db, join(root, 'complete'));
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (9, 1, '/src', ?, 19, 1)`,
    ).run(outside);

    const libraryRootReal = await realpath(library);

    await assert.rejects(
      trashFiles(db, liveFilesForGroup(db, 1, 1), libraryRootReal, trash, 1, 8000),
      /resolves outside the library root/,
    );

    assert.equal(await readFile(outside, 'utf8'), 'not-in-the-library');
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pickarr-upgrade-'));
}

// --- trashFiles takes rows, not a group+download pair to derive them from ---
//
// These exercise the call shape `liveFilesForOtherReleases` needs (Task 7):
// a caller hands trashFiles the exact rows it already decided are doomed,
// rather than trashFiles rederiving a list itself. Unlike seedUpgrade's group
// (one release still pending, one already picked), this fixture gives both
// releases a completed, already-imported download — the shape an identity
// merge acts on, where two releases each have their own import history and
// one is about to lose to the other.

/**
 * One group owning two releases, each with one completed download and one
 * `imported_files` row — release 1's row points at `keepPath`, release 2's at
 * `goPath`. Minimal fixture for `liveFilesForOtherReleases`/`trashFiles`
 * tests, which key off release ownership rather than the upgrade-in-flight
 * shape `seedUpgrade` sets up above.
 */
function seedTwoImportedFiles(db: DatabaseSync, keepPath: string, goPath: string): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, upgrade_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{"title":"T","fields":[]}', 't', 'picked', 1, NULL, 1, 9000)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1), (2, 1, 2, '{}', 200, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status,
                            storage_path, created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'nzo_1', 'initial', 'imported', '/old/complete1', 1, 1),
            (2, 2, 1, 'sab', 'nzo_2', 'initial', 'imported', '/old/complete2', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (1, 1, '/src/keep', ?, 4, 1), (2, 1, '/src/go', ?, 2, 1)`,
  ).run(keepPath, goPath);
}

test('trashFiles moves exactly the rows it is given and marks them trashed', async (t) => {
  const db = openTestDatabase();
  const root = await tempDir(t, 'pickarr-trash-');
  const libraryRoot = join(root, 'library');
  const trashDir = join(root, 'trash');
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(join(libraryRoot, 'keep.mp4'), 'keep');
  await writeFile(join(libraryRoot, 'go.mp4'), 'go');

  seedTwoImportedFiles(db, join(libraryRoot, 'keep.mp4'), join(libraryRoot, 'go.mp4'));
  const libraryRootReal = await realpath(libraryRoot);
  const doomed = liveFilesForOtherReleases(db, 1, 1);

  const destination = await trashFiles(db, doomed, libraryRootReal, trashDir, 1, 7000);

  assert.notEqual(destination, null);
  assert.equal(await lstatOrNull(join(libraryRoot, 'keep.mp4')) === null, false, 'keep.mp4 stays');
  assert.equal(await lstatOrNull(join(libraryRoot, 'go.mp4')), null, 'go.mp4 is gone');
  const rows = filesForGroup(db, 1);
  assert.equal(rows.find((row) => row.destPath.endsWith('keep.mp4'))?.trashedAt, null);
  assert.equal(rows.find((row) => row.destPath.endsWith('go.mp4'))?.trashedAt, 7000);
});

test('trashFiles given no rows creates no trash directory', async (t) => {
  const db = openTestDatabase();
  const root = await tempDir(t, 'pickarr-trash-');
  const trashDir = join(root, 'trash');

  const destination = await trashFiles(db, [], root, trashDir, 1, 7000);

  assert.equal(destination, null);
  assert.equal(await lstatOrNull(trashDir), null, 'nothing to trash means no directory');
});
