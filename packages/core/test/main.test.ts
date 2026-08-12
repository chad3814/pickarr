import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import type { PluginRegistry } from '../src/plugins/registry.ts';
import { pluginById } from '../src/main.ts';

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
