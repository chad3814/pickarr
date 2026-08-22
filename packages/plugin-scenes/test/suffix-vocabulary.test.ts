import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEncodeToken, LANGUAGE_TERMS, NON_GROUP_EDIT_TERMS, NON_GROUP_TERMS } from '../src/parse.ts';

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

test('four languages are the only additions, and they are all languages', () => {
  // Additions, asserted separately from the preservation test above so that a
  // future addition cannot hide inside it. `POLISH` and `CZECH` joined
  // `DUTCH` and `JAPANESE` once the corpus was measured for them: POLISH is
  // title-final in all 3 of its occurrences, CZECH in 2 of 3.
  for (const term of ['DUTCH', 'JAPANESE', 'POLISH', 'CZECH']) {
    assert.ok(NON_GROUP_TERMS.has(term), term);
    assert.ok(LANGUAGE_TERMS.has(term), term);
  }
  assert.equal(NON_GROUP_TERMS.size, BEFORE_THE_SPLIT.length + 4);
});

test('THAI and ARABIC are kept out, because in this corpus they are performer names', () => {
  // `May Thai` and the `Thai` of `Tuk Brilliant Thai` are both title-final, so
  // admitting `THAI` truncates two real titles; `Sarah Arabic` appears in three
  // scenes and is a performer wherever it appears. Being a language is not on
  // its own a reason to be droppable — the measurement is.
  for (const term of ['THAI', 'ARABIC']) {
    assert.ok(!LANGUAGE_TERMS.has(term), `${term} must not be droppable from a title`);
    assert.ok(!NON_GROUP_TERMS.has(term), term);
  }
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

test('both spellings of a remaster are encode tokens, and neither is in the non-group half', () => {
  // Spelled out as two literals rather than one, because one is exactly what
  // let the last regression through: the corpus carries `REMASTERED` and
  // nothing carries `REMASTER`, so a single-spelling test passed while the
  // shorter form was refusing whole names.
  for (const term of ['REMASTER', 'REMASTERED']) {
    assert.ok(isEncodeToken(term), `${term} should be encode vocabulary`);
    assert.ok(!NON_GROUP_TERMS.has(term), `${term} must not be a non-group term as well`);
  }
});
