/**
 * What each shipped plugin says its path shape may name.
 *
 * Here rather than in the three plugin packages because this is the one
 * place in the tree that can see all three at once, and the property that
 * matters most is a cross-plugin one: a copy-pasted list is the failure this
 * file exists to catch, and no test inside `plugin-tv` can observe that
 * `plugin-movie` declares the same thing.
 *
 * Every list is spelled out literally, in order, against the plugin the host
 * actually builds -- not derived from the plugin's own export and not
 * checked for length. A test that asserted `tokens.length > 0`, or compared
 * `plugin.tokens` to the constant the plugin itself exports, would pass
 * against any of the three lists pasted into any of the three plugins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaPlugin } from '@pickarr/contract';
import { shippedPlugins } from '../../src/main.ts';

const NOW = 1_700_000_000_000;

/** The three plugins exactly as `main` builds them, keyed by id. */
function shipped(): Map<string, MediaPlugin> {
  const plugins = shippedPlugins({
    now: () => NOW,
    resolveSecret: async () => { throw new Error('resolveSecret: not used by this test'); },
    baseUrl: 'https://lookup.example.test',
  });
  return new Map(plugins.map((plugin) => [plugin.id, plugin]));
}

/** The plugin with `id`, or a failure naming what was there instead. */
function pluginById(id: string): MediaPlugin {
  const plugins = shipped();
  const plugin = plugins.get(id);
  assert.ok(plugin !== undefined, `no shipped plugin has id "${id}"; found ${[...plugins.keys()].join(', ')}`);
  return plugin;
}

test('the television plugin declares the tokens a television path may name', () => {
  assert.deepEqual(pluginById('tv').tokens, [
    'series', 'season', 'episode', 'title', 'releaseDate', 'resolution', 'filename', 'ext',
  ]);
});

test('the film plugin declares the tokens a film path may name', () => {
  assert.deepEqual(pluginById('movie').tokens, [
    'title', 'year', 'releaseDate', 'collection', 'resolution', 'filename', 'ext',
  ]);
});

test('the xxx plugin declares the tokens an xxx path may name', () => {
  assert.deepEqual(pluginById('xxx').tokens, [
    'site', 'title', 'releaseDate', 'resolution', 'filename', 'ext',
  ]);
});

test('no two shipped plugins declare the same token list', () => {
  const plugins = [...shipped().values()];
  assert.equal(plugins.length, 3, 'three plugins ship; a fourth needs its own list asserted above');
  for (const a of plugins) {
    for (const b of plugins) {
      if (a.id === b.id) continue;
      assert.notDeepEqual(
        a.tokens,
        b.tokens,
        `"${a.id}" and "${b.id}" declare the same tokens, which is what a copy-paste looks like`,
      );
    }
  }
});

test('every shipped plugin declares the three tokens that come from the rss item and the source path', () => {
  // Design spec §3: `resolution`, `filename` and `ext` are not the plugin's
  // own -- they are read off `rss_item` and the path the download client
  // gave -- so a plugin missing one would be refusing a shape the host can
  // in fact resolve.
  for (const plugin of shipped().values()) {
    for (const shared of ['resolution', 'filename', 'ext']) {
      assert.ok(plugin.tokens.includes(shared), `"${plugin.id}" does not declare "${shared}"`);
    }
  }
});

test('no plugin declares a token twice', () => {
  for (const plugin of shipped().values()) {
    assert.equal(
      new Set(plugin.tokens).size,
      plugin.tokens.length,
      `"${plugin.id}" declares a token more than once`,
    );
  }
});
