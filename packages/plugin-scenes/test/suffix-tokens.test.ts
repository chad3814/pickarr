import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isContentTypeTerm, isLanguageTerm, isNumericIdToken } from '../src/parse.ts';

test('content types match in any case', () => {
  for (const t of ['solo', 'SOLO', 'Solo', 'hardcore', 'Hardcore', 'lesbian', 'LESBIAN']) {
    assert.ok(isContentTypeTerm(t), t);
  }
  assert.ok(!isContentTypeTerm('soloist'));
  assert.ok(!isContentTypeTerm('anal'));
});

test('languages match in any case, including the corpus spelling', () => {
  // `Orgia Balorda iTALiAN` is a real corpus title. A rule matching only
  // uppercase passes every other language assertion and fails this one.
  assert.ok(isLanguageTerm('iTALiAN'));
  assert.ok(isLanguageTerm('DUTCH'));
  assert.ok(isLanguageTerm('japanese'));
  assert.ok(isLanguageTerm('JAP'));
  assert.ok(!isLanguageTerm('dutchess'));
  assert.ok(!isLanguageTerm('SUB'), 'SUB is about a language, not one');
});

test('a numeric id is 250 or more', () => {
  assert.ok(isNumericIdToken('42466', 'solo'));
  assert.ok(isNumericIdToken('250', 'x'));
  assert.ok(!isNumericIdToken('249', 'x'));
  assert.ok(!isNumericIdToken('2', 'x'), 'a sequel number is a title word');
  assert.ok(!isNumericIdToken('4', 'x'));
});

test('a padded id is still an id', () => {
  // `Michala 0279` — leading zeros are id-shaped, and Number('0279') is 279.
  assert.ok(isNumericIdToken('0279', 'michala'));
});

test('a year is not an id', () => {
  // `Gianna Dior TOTM March 2020` and `Jordan Maxx ... Carried Away 2021`.
  assert.ok(!isNumericIdToken('2020', 'march'));
  assert.ok(!isNumericIdToken('2021', 'away'));
  assert.ok(!isNumericIdToken('1900', 'x'));
  assert.ok(!isNumericIdToken('2099', 'x'));
  assert.ok(isNumericIdToken('2100', 'x'), 'past the year range it is an id again');
  assert.ok(isNumericIdToken('1899', 'x'), 'below the year range too');
});

test('a number after an ordinal word belongs to the title', () => {
  // `Violet Voss Episode 466`. Without this, episode 466 and episode 467
  // both key as `violet-voss-episode` and collide.
  assert.ok(!isNumericIdToken('466', 'Episode'));
  assert.ok(!isNumericIdToken('466', 'episode'));
  assert.ok(!isNumericIdToken('3', 'part'));
  assert.ok(!isNumericIdToken('900', 'vol'));
  assert.ok(!isNumericIdToken('900', 'scene'));
  assert.ok(isNumericIdToken('466', 'voss'), 'an ordinary word does not protect it');
});

test('a non-numeric token is never an id', () => {
  assert.ok(!isNumericIdToken('1080p', 'x'));
  assert.ok(!isNumericIdToken('4K', 'x'));
  assert.ok(!isNumericIdToken('E1178', 'x'));
  assert.ok(!isNumericIdToken('', 'x'));
});
