/**
 * `pluginLabels.ts`: the one map `packages/web` spells a plugin's display
 * name in, and the fallback for a plugin it does not name.
 *
 * **The labels are spelled out here rather than derived.** `CLAUDE.md`: an
 * expectation computed by the code under test cannot detect that code
 * changing. `Destinations.test.tsx` addresses every row through
 * `pluginLabel(...)`, which is right for a helper that only has to find the
 * row -- but it means that file would stay wholly green if this map
 * returned `'x'` for everything. Somewhere has to write the strings down,
 * and this is it.
 *
 * **The fallback needs a call site as well as a unit test**, for the reason
 * `CLAUDE.md` records about a migration's duplicate-version guard: pinning
 * a pure function does not pin that anyone calls it. The drivable one is
 * `Destinations.test.tsx`'s `a plugin this package has no label for is
 * headed by its own id`, which renders a fourth plugin. The nav in
 * `Shell.tsx` cannot reach the fallback -- it passes a `Category`, and all
 * three are mapped.
 *
 * A `.tsx` extension with no JSX in it because `npm run test:web` globs
 * `packages/web/test/**\/*.test.tsx` and would not run a `.ts` file at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_LABELS, pluginLabel } from '../src/pluginLabels.ts';

test('the three shipped plugins have the labels the nav and the settings rows both show', () => {
  assert.equal(pluginLabel('tv'), 'TV');
  assert.equal(pluginLabel('movie'), 'Movies');
  assert.equal(pluginLabel('xxx'), 'XXX');
  assert.deepEqual(Object.keys(PLUGIN_LABELS).toSorted(), ['movie', 'tv', 'xxx'],
    'a fourth entry here is a fourth display name two screens will show, so it is worth noticing');
});

test('a plugin the map does not name reads as its own id, not as undefined', () => {
  // `Settings.tsx` builds its rows from `@pickarr/contract`'s
  // `TOKEN_NAMES_BY_PLUGIN`, so a fourth plugin added there gets a
  // destinations row with no edit to this file. Without the `??` the
  // heading renders nothing at all and the row has no accessible name --
  // which is a blank `<h3>`, not a visible id.
  assert.equal(pluginLabel('book'), 'book');
  assert.equal(pluginLabel('audio_book'), 'audio_book');
  // The lookup is by own property, so a name off `Object.prototype` is not
  // a label. This is not hypothetical: `api/server.ts`'s plugin-id pattern
  // is `/^[a-z][a-z0-9_]{0,31}$/`, which `constructor` matches, and a bare
  // index returned `Object` itself -- not `undefined`, so `??` never
  // fired, and React throws on a function child.
  assert.equal(pluginLabel('constructor'), 'constructor');
  assert.equal(pluginLabel('toString'), 'toString');
  assert.equal(pluginLabel('hasownproperty'), 'hasownproperty');
});
