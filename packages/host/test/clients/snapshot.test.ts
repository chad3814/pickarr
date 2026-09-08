import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClientCategory } from '../../src/clients/snapshot.ts';

test("both '' and the literal 'None' read as no category", () => {
  assert.equal(normalizeClientCategory(''), null);
  assert.equal(normalizeClientCategory('None'), null);
});

test('an absent category reads as no category rather than throwing', () => {
  assert.equal(normalizeClientCategory(undefined), null);
  assert.equal(normalizeClientCategory(null), null);
});

test('a real category is returned unchanged', () => {
  assert.equal(normalizeClientCategory('tv'), 'tv');
  // Including one that merely contains "None", e.g. 'None-Of-The-Above'.
  assert.equal(normalizeClientCategory('None-Of-The-Above'), 'None-Of-The-Above');
});
