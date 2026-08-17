import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import type { PluginRegistry } from '../../src/plugins/registry.ts';
import type { ManualDeps, ManualResult } from '../../src/manual/operations.ts';

/**
 * Shared across `operations.test.ts`, `identity-plan.test.ts` and (Task 7) the
 * applier's own tests, so it lives here rather than in any one of them. Moved
 * out of `operations.test.ts` rather than duplicated: three copies of "what a
 * manual edit's dependencies look like" is exactly how the fixture and the
 * real `ManualDeps` shape drift apart unnoticed.
 */
export const NOW = 5000;

/**
 * A plugin whose identity is whatever `key` says and whose quality is a
 * resolution — no parsing, no site list, no field validation beyond the one
 * rule the 400 cases need. These tests are about core's rules for a manual
 * edit, not about any real plugin's idea of a release name.
 *
 * `key: '!'` is the one back door: it returns a `ParsedRelease` that
 * `validateParsed` must reject, which is the only way to reach that branch
 * from outside without a plugin that lies about its own contract.
 */
export const PLUGIN: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse: () => null,
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
  manualFields: () => [
    { name: 'key', label: 'Key', type: 'text', scope: 'identity', required: true },
    { name: 'title', label: 'Title', type: 'text', scope: 'identity' },
    { name: 'res', label: 'Resolution', type: 'text', scope: 'quality' },
  ],
  fromManualValues(values): { media: ParsedRelease } | { error: string } {
    const key = values['key'] ?? '';
    if (key === '') return { error: 'key is required' };
    if (key === 'THROW') throw new Error('boom');
    return {
      media: {
        identityKey: key === '!' ? '' : key,
        display: { title: values['title'] ?? key, fields: [] },
        quality: { resolution: Number(values['res'] ?? '0') },
      },
    };
  },
  toManualValues: (media) => ({
    key: media.identityKey,
    title: media.display.title,
    res: String(media.quality.resolution ?? ''),
  }),
};

/**
 * `libraryRoot` defaults to a fixed string because most callers never look at
 * it; Task 6 needs a real temp directory there, hence the parameter rather
 * than a second, near-identical fixture.
 */
export function registryFor(plugin: MediaTypePlugin, libraryRoot = '/library'): PluginRegistry {
  return {
    byPackage: () => plugin,
    byId: (id) => (id === plugin.id ? plugin : undefined),
    libraryRoot: () => libraryRoot,
    libraryRootById: () => libraryRoot,
    all: () => [plugin],
  };
}

/** Feed `f` is configured; every other feed id has been removed from config. */
export function makeDeps(
  db: DatabaseSync,
  plugin: MediaTypePlugin = PLUGIN,
  libraryRoot = '/library',
): ManualDeps {
  return {
    db,
    registry: registryFor(plugin, libraryRoot),
    pluginForFeed: (feedId) => (feedId === 'f' ? plugin : null),
    now: () => NOW,
    trashDir: '/trash',
  };
}

export function ok<T>(result: ManualResult<T>): T {
  assert.ok('ok' in result, `expected success, got ${JSON.stringify(result)}`);
  return result.ok;
}

export function failure<T>(result: ManualResult<T>): { error: string; status: number } {
  assert.ok(!('ok' in result), `expected failure, got ${JSON.stringify(result)}`);
  return result;
}

/**
 * A merge-ready pair, not just "two groups": group 1 (`k1`) is a *source* —
 * picked on release 1 (1080), with a `downloads` row recorded against it —
 * and group 2 (`k2`) is an unpicked *target* holding release 2 (2160). This is
 * the reported scenario in miniature: correcting group 1's key to `k2` must
 * merge it into group 2, carrying a download and a pick to reconcile.
 *
 * Named `seedMergePair` rather than `seedTwoGroups` deliberately.
 * `operations.test.ts` has its own, unrelated `seedTwoGroups` — a plain pair
 * used to exercise `editGroup`'s merge machinery, with its own calibrated
 * scores, titles and `list_rank_at` values that ~15 of that file's tests
 * assert against directly. The two seed different scenarios for different
 * purposes and are not interchangeable; do not "unify" them under one name
 * later — that would either silently change what one of the two test files is
 * asserting, or force a rewrite of tests that have nothing to do with this
 * fixture. This one (`seedMergePair`) is shared with `identity-plan.test.ts`
 * and, later, Task 7's applier tests, which is why it lives here.
 */
export function seedMergePair(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"A","fields":[]}', 'a', 'picked', 1,    100, 100),
            (2, 'test', 'k2', '{"title":"B","fields":[]}', 'b', 'new',    NULL, 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://i.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://i.invalid/2.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":1080}', 1080, 100),
            (2, 2, 2, '{"resolution":2160}', 2160, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
}

/**
 * A plugin that files a scene at `<key>/<resolution>.mp4`, so a key change
 * moves every file the group owns and a resolution difference keeps two
 * files apart. `PLUGIN` above deliberately files nothing (`planImport: () =>
 * null`), which is right for the tests that only care about identity
 * resolution — but the planner's file half needs a plugin that actually
 * places something, or every group under test has no `imported_files` rows
 * to plan against. Exported (not local to `identity-plan.test.ts`) because
 * Task 7's applier tests need the same plugin to exercise the same file
 * moves.
 */
export const FILING: MediaTypePlugin = {
  ...PLUGIN,
  planImport: (media, files) => {
    const file = files[0];
    if (file === undefined) return null;
    return {
      files: [
        {
          source: file.absolutePath,
          destination: `${media.identityKey}/${media.quality.resolution ?? 0}.mp4`,
        },
      ],
    };
  },
};

/**
 * `seedMergePair` plus one live imported file already on disk: group 1
 * picked on release 1 (1080p), with that release's file imported under
 * `k1/1080.mp4` in `libraryRoot`. Exported alongside `FILING` for the same
 * reason — Task 7's applier tests need a group with a real file to move, not
 * just a database row claiming one exists.
 */
export async function seedWithFile(db: DatabaseSync, libraryRoot: string): Promise<void> {
  seedMergePair(db);
  await mkdir(join(libraryRoot, 'k1'), { recursive: true });
  await writeFile(join(libraryRoot, 'k1', '1080.mp4'), 'data');
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (1, 1, 1, '/dl/a.mp4', ?, 4, 100)`,
  ).run(join(libraryRoot, 'k1', '1080.mp4'));
}

/**
 * `seedWithFile` plus a *second* release in group 1 — a 2160p one, with its
 * own download and its own live imported file, already on disk at
 * `k1/2160.mp4`. Group 1's pick is left on release 1 (1080p); this only adds
 * a second release and file alongside it.
 *
 * Exists because every other fixture gives a group exactly one live file, and
 * with one file its release's quality and the group's pick's quality are
 * necessarily the same value — nothing distinguishes "the planner read this
 * file's own release's quality" from "the planner read the pick's quality for
 * every file", which is exactly the bug the design's rationale for
 * `destinationFor` warns against (a merged group holding a 1080p and a 2160p
 * file at once, whose path template renders resolution). Two releases at two
 * qualities in one group is the minimum seed that can tell the two apart.
 * Exported alongside `seedWithFile` for the same reason — Task 7's applier
 * tests may need the same two-quality shape to exercise per-file behaviour.
 */
export async function seedWithTwoQualityFiles(
  db: DatabaseSync,
  libraryRoot: string,
): Promise<void> {
  await seedWithFile(db, libraryRoot);
  await writeFile(join(libraryRoot, 'k1', '2160.mp4'), 'data');
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (3, 'f', 'g3', 'T3', 'https://i.invalid/3.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (3, 1, 3, '{"resolution":2160}', 2160, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 3, 1, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 1, '/dl/c.mp4', ?, 4, 100)`,
  ).run(join(libraryRoot, 'k1', '2160.mp4'));
}
