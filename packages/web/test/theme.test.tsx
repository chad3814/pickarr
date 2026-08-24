import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_QUERY,
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
