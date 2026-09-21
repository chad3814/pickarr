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
 *
 * **`MediaPlugin.tokens` is a map of resolvers, so "declared but not
 * resolved" has no test here and cannot have one.** It was the gap this
 * slice inherited -- a plugin could name `{season}` and never answer for it,
 * the shape validating on save and producing a hole at import -- and it is
 * closed by the type rather than by an assertion: the key and the function
 * are one entry, so there is no way to write the first without the second.
 * The final test below is what remains worth asserting, and it is a
 * different property: that the host reads *names* off that map wherever it
 * used to read a list.
 *
 * **"No plugin declares a token twice" went the same way**, and its test is
 * gone rather than rewritten: an object cannot hold one key twice, so the
 * assertion became one about `Object.keys` rather than about any plugin.
 * A duplicate key in a literal is a lint error (`no-dupe-keys`) at the site
 * that wrote it.
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

/**
 * What a plugin's shape may name, in declaration order.
 *
 * `Object.keys`, which is what `host.ts`'s `tokensFor` hands
 * `saveDestination` -- so the order asserted below is the order an operator
 * sees, and a plugin that reordered its own map is a visible change here.
 */
function tokenNames(plugin: MediaPlugin): string[] {
  return Object.keys(plugin.tokens);
}

test('the television plugin declares the tokens a television path may name', () => {
  assert.deepEqual(tokenNames(pluginById('tv')), [
    'series', 'season', 'episode', 'title', 'releaseDate', 'resolution', 'filename', 'ext',
  ]);
});

test('the film plugin declares the tokens a film path may name', () => {
  assert.deepEqual(tokenNames(pluginById('movie')), [
    'title', 'year', 'releaseDate', 'collection', 'resolution', 'filename', 'ext',
  ]);
});

test('the xxx plugin declares the tokens an xxx path may name', () => {
  assert.deepEqual(tokenNames(pluginById('xxx')), [
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
        tokenNames(a),
        tokenNames(b),
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
      assert.ok(tokenNames(plugin).includes(shared), `"${plugin.id}" does not declare "${shared}"`);
    }
  }
});

test('every declared token is a function, so the names the host validates against are the ones the plugin answers', () => {
  // Not the closed gap restated -- the type already forbids a key with no
  // function. This is about the *other* end: `host.ts` hands
  // `saveDestination` `Object.keys(plugin.tokens)`, so anything a plugin
  // put on that object which is not a resolver would be offered to an
  // operator as a token and then resolve to nothing. A plugin assembling
  // its map by spreading something wider -- a config object, a partially
  // built record -- is how that happens, and it is not a type error at the
  // point it is read.
  for (const plugin of shipped().values()) {
    for (const [name, resolver] of Object.entries(plugin.tokens)) {
      assert.equal(typeof resolver, 'function', `"${plugin.id}" declares "${name}" as something other than a resolver`);
    }
  }
});
