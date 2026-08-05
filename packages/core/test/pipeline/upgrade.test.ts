import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportPlan, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { importDownload, type ImportDeps } from '../../src/pipeline/import.ts';
import { getGroup } from '../../src/db/groups.ts';
import { getDownload } from '../../src/db/downloads.ts';
import { liveFilesForGroup } from '../../src/db/imported-files.ts';
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

/** Group already owns release 1; release 2 is the flagged upgrade. */
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
     VALUES (1, 2, 1, 'sab', 'nzo_2', 'upgrade', 'completed', ?, 1, 1)`,
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
    // The old file is on record as the group's live import.
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (1, 1, '/old/source', ?, 11, 1)`,
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
         VALUES (1, 1, '/old', ?, 5, 1)`,
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
       VALUES (1, 1, '/old', ?, 11, 1)`,
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

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pickarr-upgrade-'));
}
