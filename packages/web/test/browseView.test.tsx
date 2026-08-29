import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readView, writeView } from '../src/browseView.ts';

const KEY = 'pickarr.browseView';

afterEach(() => {
  localStorage.removeItem(KEY);
});

test('nothing stored reads as the card list', () => {
  assert.equal(readView(), 'list');
});

test('a stored view reads back', () => {
  writeView('split');
  assert.equal(readView(), 'split');
  writeView('list');
  assert.equal(readView(), 'list');
});

test('an unrecognised stored value reads as the card list', () => {
  // Covers a hand-edited key and one written by a future version. The
  // alternative is rendering a view name nothing matches.
  localStorage.setItem(KEY, 'masterdetail');
  assert.equal(readView(), 'list');
});

/**
 * Runs `body` against a `localStorage` whose every method throws, which is what
 * the guards in `browseView.ts` exist for.
 *
 * The global is replaced, rather than `localStorage.getItem` or
 * `Storage.prototype.getItem` patched, and neither of those is a stylistic
 * preference — both are inert here, which is how the two tests below came to
 * pass with both `try`/`catch` blocks deleted outright:
 *
 * - happy-dom's `localStorage` is a `Proxy` whose `set` trap treats any
 *   assignment to an existing member as a no-op, so `localStorage.getItem = fn`
 *   installs nothing at all.
 * - On the first read of each method name, happy-dom copies that method off
 *   `Storage.prototype` onto the instance as a bound own property and caches
 *   the fact (`ClassMethodBinder.bind`). Every later read finds the copy, so a
 *   prototype patch made after anything in the file has touched storage — the
 *   `afterEach` below, or any earlier test — is shadowed. Verified by mutation
 *   in both directions: with this helper the two tests fail without the
 *   guards and pass with them; with a prototype patch they passed either way.
 *
 * Replacing the global sidesteps the binder entirely: nothing is being patched
 * onto happy-dom's storage, it is simply not the object under test for the
 * duration. The descriptor is restored rather than a value reassigned, because
 * the global is an accessor.
 */
function withThrowingStorage(body: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  assert.ok(descriptor !== undefined, 'happy-dom registered a localStorage to replace');
  const throwing: Storage = {
    length: 0,
    clear() { throw new Error('SecurityError'); },
    getItem() { throw new Error('SecurityError'); },
    key() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
  };
  Object.defineProperty(globalThis, 'localStorage', { get: () => throwing, configurable: true });
  try {
    body();
  } finally {
    Object.defineProperty(globalThis, 'localStorage', descriptor);
  }
}

test('a localStorage that throws on read still gives a view', () => {
  // Not hypothetical: `theme.ts` documents that some privacy configurations
  // throw on access rather than returning null. An unguarded read would take
  // the route down.
  withThrowingStorage(() => {
    assert.equal(readView(), 'list');
  });
});

test('a localStorage that throws on write does not throw at the caller', () => {
  withThrowingStorage(() => {
    // Asserted rather than left to the test body: a bare call that throws also
    // fails the test, but says nothing about what was meant.
    assert.doesNotThrow(() => writeView('split'));
  });
});
