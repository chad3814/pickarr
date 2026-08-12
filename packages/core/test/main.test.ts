import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import type { PluginRegistry } from '../src/plugins/registry.ts';
import { entryFromArgv, pluginById, resolveArtworkDir } from '../src/main.ts';

const MAIN_TS_PATH = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/**
 * Swaps `process.argv[1]` for the duration of `fn`, restoring the real argv
 * afterwards regardless of outcome — `entryFromArgv` reads it directly
 * (that's the whole point: it is `main.ts`'s view of what Node was actually
 * asked to run), so there is no way to exercise it without touching the
 * real global.
 */
async function withArgv1<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const original = process.argv;
  process.argv = value === undefined ? [original[0] ?? 'node'] : [original[0] ?? 'node', value];
  try {
    return await fn();
  } finally {
    process.argv = original;
  }
}

const PLUGIN_ID = 'scenes-v1';
const PACKAGE_NAME = '@pickarr/plugin-scenes';

const fakePlugin: MediaTypePlugin = {
  id: PLUGIN_ID,
  displayName: 'Scenes',
  parse: () => null,
  score: () => 0,
  planImport: () => null,
};

/**
 * Mirrors the real registry from plugins/registry.ts exactly: `byId` looks up
 * by the plugin's own id, `byPackage` looks up by config package name and
 * throws on anything else — the same "unknown key throws" shape that would
 * make a `byPackage`-wired `pluginFor` fail loudly on every group whose
 * `media_groups.plugin` column holds an id rather than a package name.
 */
function fakeRegistry(): PluginRegistry {
  return {
    byPackage(packageName) {
      if (packageName === PACKAGE_NAME) return fakePlugin;
      throw new Error(`No plugin registered for package ${packageName}`);
    },
    byId: (id) => (id === PLUGIN_ID ? fakePlugin : undefined),
    libraryRoot: () => '/media',
    libraryRootById: () => '/media',
    all: () => [fakePlugin],
  };
}

// `media_groups.plugin` holds `plugin.id` (commit.ts writes `plugin: plugin.id`),
// never the package name — so a group whose row holds a real plugin id must
// reach its plugin through `pluginById`. This is the one test that would have
// caught task 10's documented defect (wiring `pluginFor` to `byPackage`
// instead): see the "break on purpose" note in the task report.
test('pluginById resolves a group by plugin id, not by package name', () => {
  const resolve = pluginById(fakeRegistry());
  assert.equal(resolve(PLUGIN_ID), fakePlugin);
});

test('pluginById returns null for an id no longer configured', () => {
  const resolve = pluginById(fakeRegistry());
  assert.equal(resolve('some-removed-plugin'), null);
});

test('resolveArtworkDir defaults to an artwork/ directory beside the database', () => {
  assert.equal(resolveArtworkDir('/config/pickarr.db', undefined), '/config/artwork');
});

test('resolveArtworkDir keeps an explicitly configured directory', () => {
  assert.equal(resolveArtworkDir('/config/pickarr.db', '/mnt/posters'), '/mnt/posters');
});

// `import.meta.url` is already realpathed by the ESM loader; `argv[1]` is
// not. A naive string comparison of the two would say "not the entry point"
// for `node /some/link/main.js` where the link points at this file — the
// worst failure mode here, since the process still boots and exits cleanly
// having started nothing. This is the case that actually matters.
test('entryFromArgv is true when argv[1] reaches this module through a symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-entrypoint-'));
  try {
    const link = join(dir, 'main.ts');
    await symlink(MAIN_TS_PATH, link);
    await withArgv1(link, () => {
      assert.equal(entryFromArgv(), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('entryFromArgv is true when argv[1] is this module directly', async () => {
  await withArgv1(MAIN_TS_PATH, () => {
    assert.equal(entryFromArgv(), true);
  });
});

test('entryFromArgv is false for a real file that is not this module', async () => {
  await withArgv1(fileURLToPath(import.meta.url), () => {
    assert.equal(entryFromArgv(), false);
  });
});

test('entryFromArgv is false, not throwing, when argv[1] does not exist', async () => {
  await withArgv1('/no/such/path/main.js', () => {
    assert.equal(entryFromArgv(), false);
  });
});

test('entryFromArgv is false when argv[1] is absent', async () => {
  await withArgv1(undefined, () => {
    assert.equal(entryFromArgv(), false);
  });
});
