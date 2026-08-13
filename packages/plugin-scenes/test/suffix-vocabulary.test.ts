import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_TERMS, NON_GROUP_EDIT_TERMS, NON_GROUP_TERMS } from '../src/parse.ts';

/**
 * Every term the single undivided set held before the split. Spelled out as a
 * literal rather than computed from the halves: computing it from the code
 * under test is how a dropped term goes unnoticed.
 */
const BEFORE_THE_SPLIT = [
  'ENGLISH', 'FRENCH', 'GERMAN', 'SPANISH', 'ITALIAN', 'RUSSIAN',
  'ENG', 'FRA', 'GER', 'ESP', 'ITA', 'RUS', 'JAP', 'JPN',
  'SUB', 'SUBS', 'SUBBED', 'DUBBED', 'UNCUT', 'UNRATED', 'EXTENDED', 'DIRECTORS',
  'UNCENSORED', 'DIRECTORSCUT', 'COMPILATION', 'REMUX', 'PART', 'PT', 'CD', 'DISC',
  'SCENE', 'FULL', 'HQ', 'LQ',
];

test('the split keeps every term the union had before it', () => {
  for (const term of BEFORE_THE_SPLIT) {
    assert.ok(NON_GROUP_TERMS.has(term), `${term} fell out of NON_GROUP_TERMS`);
  }
});

test('DUTCH and JAPANESE are the only additions, and they are languages', () => {
  // Additions, asserted separately from the preservation test above so that a
  // future addition cannot hide inside it.
  assert.ok(NON_GROUP_TERMS.has('DUTCH'));
  assert.ok(NON_GROUP_TERMS.has('JAPANESE'));
  assert.ok(LANGUAGE_TERMS.has('DUTCH'));
  assert.ok(LANGUAGE_TERMS.has('JAPANESE'));
  assert.equal(NON_GROUP_TERMS.size, BEFORE_THE_SPLIT.length + 2);
});

test('the two halves are disjoint and cover the union', () => {
  for (const term of LANGUAGE_TERMS) assert.ok(!NON_GROUP_EDIT_TERMS.has(term), term);
  for (const term of NON_GROUP_EDIT_TERMS) assert.ok(!LANGUAGE_TERMS.has(term), term);
  assert.equal(NON_GROUP_TERMS.size, LANGUAGE_TERMS.size + NON_GROUP_EDIT_TERMS.size);
});

test('terms that can be title words stay out of the language half', () => {
  // The corpus has `Leona Mia Beauty In Full`, `Alaina Dawson Compilation` and
  // `Jessica Jans Bonus Scene` — real titles ending in these words. Only the
  // language half is ever dropped from a title, so these must not be in it.
  for (const term of ['FULL', 'COMPILATION', 'SCENE', 'PART', 'UNCUT', 'EXTENDED']) {
    assert.ok(!LANGUAGE_TERMS.has(term), `${term} must not be droppable from a title`);
  }
});
