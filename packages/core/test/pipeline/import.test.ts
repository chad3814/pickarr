import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportPlan, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { importDownload, type ImportDeps } from '../../src/pipeline/import.ts';
import { getDownload } from '../../src/db/downloads.ts';
import { liveFilesForGroup } from '../../src/db/imported-files.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pickarr-import-'));
}

function plugin(planImport: MediaTypePlugin['planImport']): MediaTypePlugin {
  return { id: 'test', displayName: 'Test', parse: () => null, score: () => 0, planImport };
}

function registryFor(mediaPlugin: MediaTypePlugin, libraryRoot: string): PluginRegistry {
  return {
    byPackage: () => mediaPlugin,
    byId: () => mediaPlugin,
    libraryRoot: () => libraryRoot,
    libraryRootById: () => libraryRoot,
    all: () => [mediaPlugin],
  };
}

function seed(db: DatabaseSync, storagePath: string, kind: 'initial' | 'upgrade' = 'initial'): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'T', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{"title":"T","fields":[]}', 't', 'picked', 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status,
                            storage_path, created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'nzo_1', ?, 'completed', ?, 1, 1)`,
  ).run(kind, storagePath);
}

function deps(
  db: DatabaseSync,
  registry: PluginRegistry,
  trashDir: string,
  overrides: Partial<ImportDeps> = {},
): ImportDeps {
  return { db, registry, importMode: 'move', trashDir, now: () => 2000, ...overrides };
}

test('imports the planned file and records it', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete', 'Release');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'scene.mp4'), 'video-bytes');

    const library = join(root, 'library');
    const db = openTestDatabase();
    seed(db, downloadDir);

    const registry = registryFor(
      plugin((): ImportPlan => ({
        files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'Site/scene.mp4' }],
      })),
      library,
    );

    await importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!);

    assert.equal(await readFile(join(library, 'Site', 'scene.mp4'), 'utf8'), 'video-bytes');
    assert.equal(getDownload(db, 1)?.status, 'imported');
    const recorded = liveFilesForGroup(db, 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.destPath, join(library, 'Site', 'scene.mp4'));
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('move removes the source, copy leaves it', async () => {
  for (const mode of ['move', 'copy'] as const) {
    const root = await tempDir();
    try {
      const downloadDir = join(root, 'complete');
      await mkdir(downloadDir, { recursive: true });
      const source = join(downloadDir, 'scene.mp4');
      await writeFile(source, 'x');

      const library = join(root, 'library');
      const db = openTestDatabase();
      seed(db, downloadDir);
      const registry = registryFor(
        plugin((): ImportPlan => ({ files: [{ source, destination: 'scene.mp4' }] })),
        library,
      );

      await importDownload(
        deps(db, registry, join(root, 'trash'), { importMode: mode }),
        getDownload(db, 1)!,
      );

      const sourceExists = await stat(source).then(
        () => true,
        () => false,
      );
      assert.equal(sourceExists, mode === 'copy', `mode ${mode}`);
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a cross-device rename falls back to copy-then-unlink', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    const source = join(downloadDir, 'scene.mp4');
    await writeFile(source, 'payload');

    const library = join(root, 'library');
    const db = openTestDatabase();
    seed(db, downloadDir);
    const registry = registryFor(
      plugin((): ImportPlan => ({ files: [{ source, destination: 'scene.mp4' }] })),
      library,
    );

    await importDownload(
      deps(db, registry, join(root, 'trash'), {
        rename: async () => {
          const error: NodeJS.ErrnoException = new Error('cross-device link');
          error.code = 'EXDEV';
          throw error;
        },
      }),
      getDownload(db, 1)!,
    );

    assert.equal(await readFile(join(library, 'scene.mp4'), 'utf8'), 'payload');
    assert.equal(
      await stat(source).then(
        () => true,
        () => false,
      ),
      false,
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a destination escaping the library root is rejected', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    const source = join(downloadDir, 'scene.mp4');
    await writeFile(source, 'x');

    const db = openTestDatabase();
    seed(db, downloadDir);
    const registry = registryFor(
      plugin((): ImportPlan => ({ files: [{ source, destination: '../../etc/evil' }] })),
      join(root, 'library'),
    );

    await assert.rejects(
      importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!),
      /escapes the library root/,
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no importable files fails with a named reason', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    const db = openTestDatabase();
    seed(db, downloadDir);
    const registry = registryFor(plugin(() => null), join(root, 'library'));

    await assert.rejects(
      importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!),
      /no-importable-files/,
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retry after a partial import skips files already in place', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'a.mp4'), 'a');
    await writeFile(join(downloadDir, 'b.mp4'), 'b');

    const library = join(root, 'library');
    // Simulate the first attempt having moved a.mp4 and crashed before b.mp4.
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'a.mp4'), 'a');
    await rm(join(downloadDir, 'a.mp4'));

    const db = openTestDatabase();
    seed(db, downloadDir);
    const registry = registryFor(
      plugin((): ImportPlan => ({
        files: [
          { source: join(downloadDir, 'a.mp4'), destination: 'a.mp4' },
          { source: join(downloadDir, 'b.mp4'), destination: 'b.mp4' },
        ],
      })),
      library,
    );

    await importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!);

    assert.equal(getDownload(db, 1)?.status, 'imported');
    assert.equal(liveFilesForGroup(db, 1).length, 2);
    assert.equal(await readFile(join(library, 'b.mp4'), 'utf8'), 'b');
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the file listing reaches the plugin with sizes and relative paths', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(join(downloadDir, 'nested'), { recursive: true });
    await writeFile(join(downloadDir, 'nested', 'scene.mp4'), 'abcdef');

    const db = openTestDatabase();
    seed(db, downloadDir);

    let seenRelative = '';
    let seenSize = 0;
    const registry = registryFor(
      plugin((_media, files): ImportPlan | null => {
        seenRelative = files[0]?.relativePath ?? '';
        seenSize = files[0]?.sizeBytes ?? 0;
        return { files: [{ source: files[0]!.absolutePath, destination: 'scene.mp4' }] };
      }),
      join(root, 'library'),
    );

    await importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!);

    assert.equal(seenRelative, join('nested', 'scene.mp4'));
    assert.equal(seenSize, 6);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
