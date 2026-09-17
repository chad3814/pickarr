import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LIGHT_QUERY,
  STORAGE_KEY,
  applyTheme,
  readPreference,
  resolve,
  systemPrefersLight,
  writePreference,
} from '../src/theme.ts';

// A `.tsx` test rather than `.ts`, unlike `format.test.ts` and
// `requeryMetadata.test.ts` beside it: this one drives `localStorage`,
// `matchMedia` and `document.documentElement`, so it has to run in the web
// suite where `test/setup.ts` has registered happy-dom. The extension is the
// only thing that decides which suite claims a file — see `package.json`'s
// `test:server` and `test:web` globs — and there is no JSX in here.

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

test('resolution is pure over the preference and what the OS says', () => {
  // An explicit preference ignores the OS in both directions.
  assert.equal(resolve('dark', true), 'dark');
  assert.equal(resolve('light', false), 'light');
  // Only `system` consults it.
  assert.equal(resolve('system', true), 'light');
  assert.equal(resolve('system', false), 'dark');
});

test('nothing stored reads as system', () => {
  assert.equal(readPreference(), 'system');
});

test('a stored preference is read back, and anything else is system', () => {
  localStorage.setItem('pickarr.theme', 'light');
  assert.equal(readPreference(), 'light');
  localStorage.setItem('pickarr.theme', 'dark');
  assert.equal(readPreference(), 'dark');
  // A value from a future version, or a hand-edited one, must not be trusted
  // into `data-theme` — it would select neither palette block.
  localStorage.setItem('pickarr.theme', 'sepia');
  assert.equal(readPreference(), 'system');
});

test('choosing system removes the key rather than storing a sentinel', () => {
  writePreference('dark');
  assert.equal(localStorage.getItem('pickarr.theme'), 'dark');
  writePreference('system');
  // A browser with nothing stored and one explicitly set to Auto are the same
  // state, so there is one code path for "no preference" rather than two.
  assert.equal(localStorage.getItem('pickarr.theme'), null);
});

test('a storage that throws degrades to system instead of propagating', () => {
  const original = Storage.prototype.getItem;
  const originalSet = Storage.prototype.setItem;
  Storage.prototype.getItem = () => {
    throw new Error('storage disabled');
  };
  Storage.prototype.setItem = () => {
    throw new Error('storage disabled');
  };
  try {
    assert.equal(readPreference(), 'system');
    // The write must not throw either: a browser refusing storage still gets a
    // themed session, it just forgets the choice.
    assert.doesNotThrow(() => writePreference('dark'));
  } finally {
    Storage.prototype.getItem = original;
    Storage.prototype.setItem = originalSet;
  }
});

test('applying a theme sets the attribute the palettes are keyed on', () => {
  applyTheme('light');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  applyTheme('dark');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});

test('the OS reading comes from the media query the palettes name', () => {
  assert.equal(LIGHT_QUERY, '(prefers-color-scheme: light)');
  // happy-dom answers this; the assertion is that we ask, and get a boolean,
  // not which way its default falls.
  assert.equal(typeof systemPrefersLight(), 'boolean');
  assert.equal(systemPrefersLight(), window.matchMedia(LIGHT_QUERY).matches);
});

test('the two contract values are pinned literally, not read off the module', () => {
  // Spelled out rather than compared to the module's own exports, because the
  // point is that these exact strings cannot change silently. `LIGHT_QUERY`
  // has to keep naming the query `tokens.css`'s palettes are keyed on, and
  // renaming `STORAGE_KEY` would not fail anything at runtime -- it would
  // quietly discard the stored preference of every existing browser, which is
  // the sort of defect that only shows up as "it forgot my theme".
  assert.equal(STORAGE_KEY, 'pickarr.theme');
  assert.equal(LIGHT_QUERY, '(prefers-color-scheme: light)');
});

test("index.html's pre-paint script still copies this module's contract", async () => {
  // `index.html` reimplements three lines of `theme.ts` in an inline,
  // synchronous script, because it has to beat first paint and importing the
  // module would make it a second module graph fetched before paint -- the
  // very thing it exists to avoid. Its own comment calls the duplication
  // deliberate and says the two values are "stated in one place and copied
  // here knowingly".
  //
  // Nothing enforced that. This does: the assertion reads the *module's*
  // values and looks for them in the html, so changing either constant fails
  // here until the copy is updated too. It cannot catch a semantic divergence
  // in the resolution logic -- only that the contract strings agree -- and
  // that is the half that silently loses a user's stored preference.
  const html = await readFile(join(import.meta.dirname, '..', 'index.html'), 'utf8');
  assert.ok(
    html.includes(`'${STORAGE_KEY}'`),
    'the pre-paint script must read the same storage key this module writes',
  );
  assert.ok(
    html.includes(`'${LIGHT_QUERY}'`),
    'the pre-paint script must ask the same media query this module asks',
  );
});
