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

test('a localStorage that throws on read still gives a view', () => {
  // Not hypothetical: `theme.ts` documents that some privacy configurations
  // throw on access rather than returning null. An unguarded read would take
  // the route down.
  const original = localStorage.getItem;
  localStorage.getItem = () => { throw new Error('SecurityError'); };
  try {
    assert.equal(readView(), 'list');
  } finally {
    localStorage.getItem = original;
  }
});

test('a localStorage that throws on write does not throw at the caller', () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('SecurityError'); };
  try {
    writeView('split');
  } finally {
    localStorage.setItem = original;
  }
});
