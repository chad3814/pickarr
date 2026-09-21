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
import {
  MOVIE_TOKEN_NAMES,
  TOKEN_NAMES_BY_PLUGIN,
  TV_TOKEN_NAMES,
  XXX_TOKEN_NAMES,
} from '@pickarr/contract';
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
    'series', 'season', 'episode', 'title', 'releaseDate', 'filename', 'ext',
  ]);
});

test('the film plugin declares the tokens a film path may name', () => {
  assert.deepEqual(tokenNames(pluginById('movie')), [
    'title', 'year', 'releaseDate', 'collection', 'filename', 'ext',
  ]);
});

test('the xxx plugin declares the tokens an xxx path may name', () => {
  assert.deepEqual(tokenNames(pluginById('xxx')), [
    'site', 'title', 'releaseDate', 'filename', 'ext',
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

test('every shipped plugin declares the tokens that come from the shared row and the source path', () => {
  // Design spec §3's second group: `filename` and `ext` come from the path
  // the download client gave, and `title` and `releaseDate` from the shared
  // `media_item` row -- none of them from a plugin's own tables -- so a
  // plugin missing one would be refusing a shape the host can in fact
  // resolve.
  for (const plugin of shipped().values()) {
    for (const shared of ['title', 'releaseDate', 'filename', 'ext']) {
      assert.ok(tokenNames(plugin).includes(shared), `"${plugin.id}" does not declare "${shared}"`);
    }
  }
});

test('no plugin declares {resolution}, because nothing in 2.0 records one', () => {
  // Design spec §3 lists it; issue #98 removes it. `rss_item.resolution` is
  // the *lookup* state -- inserted as the literal `'pending'` by
  // `feeds/reader.ts` -- so interpolating it would name an episode
  // `The Bear - S03E01 resolved.mkv`, permanently (§10 puts re-importing
  // out of scope). It briefly shipped as a resolver answering `null`, which
  // is a token an operator can type and never get anything from.
  //
  // Asserted here rather than in a plugin package, because the property is
  // that *no* plugin has it -- which no test inside one plugin can see.
  for (const plugin of shipped().values()) {
    assert.ok(
      !tokenNames(plugin).includes('resolution'),
      `"${plugin.id}" declares "resolution", which resolves to nothing`,
    );
  }
});

test('the names the contract publishes are the names each plugin resolves', () => {
  // **The pair the compiler cannot lock.** `TokensFor<TvTokenName>` makes a
  // plugin's map exhaustive against the contract's list in both directions
  // -- measured: an extra key is TS2353 and a missing one TS2741 -- so this
  // is not re-checking that. What it checks is the two things the type
  // cannot see: that the plugin the host actually *builds* carries that map
  // (rather than some other one assembled at construction), and that
  // `TOKEN_NAMES_BY_PLUGIN` is keyed by the ids those plugins register
  // under. The second is genuinely unlockable -- `TV_PLUGIN_ID` lives in
  // `packages/plugin-tv` and `@pickarr/contract` must not import it -- and
  // a drift there leaves a settings screen offering tokens under a key
  // nothing matches.
  assert.deepEqual(tokenNames(pluginById('tv')), [...TV_TOKEN_NAMES]);
  assert.deepEqual(tokenNames(pluginById('movie')), [...MOVIE_TOKEN_NAMES]);
  assert.deepEqual(tokenNames(pluginById('xxx')), [...XXX_TOKEN_NAMES]);

  assert.deepEqual(
    Object.keys(TOKEN_NAMES_BY_PLUGIN).toSorted(),
    [...shipped().keys()].toSorted(),
    'the contract names a plugin the host does not ship, or misses one it does',
  );
  for (const [pluginId, names] of Object.entries(TOKEN_NAMES_BY_PLUGIN)) {
    assert.deepEqual(
      [...names],
      tokenNames(pluginById(pluginId)),
      `TOKEN_NAMES_BY_PLUGIN["${pluginId}"] is not what that plugin resolves`,
    );
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
