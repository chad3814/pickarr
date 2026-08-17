import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGE_TERMS,
  isContentTypeTerm,
  isLanguageTerm,
  isNumericIdToken,
  isTitleSuffixToken,
} from '../src/parse.ts';

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

test('membership in LANGUAGE_TERMS is not on its own enough to be a suffix', () => {
  // `isLanguageTerm` still answers "is this a language"; the walk asks a
  // narrower question. Both spellings are members; only one is a tag.
  assert.ok(isLanguageTerm('Dutch') && isLanguageTerm('DUTCH'));
  assert.equal(isTitleSuffixToken('DUTCH', 'Britney'), true);
  assert.equal(isTitleSuffixToken('Dutch', 'Britney'), false);
});

/**
 * The expectations are spelled out from the rule, not derived from the code
 * under test: for every member, shouted is a tag and title case after a plain
 * word is not. `britney` is that plain word deliberately — `Britney Dutch` is
 * the performer the gate exists for.
 */
test('casing decides for every language term, in both directions', () => {
  for (const term of LANGUAGE_TERMS) {
    const titleCase = term.charAt(0) + term.slice(1).toLowerCase();
    assert.equal(isTitleSuffixToken(term, 'britney'), true, `${term} shouted is a tag`);
    assert.equal(isTitleSuffixToken(term, undefined), true, `${term} needs no help`);
    assert.equal(
      isTitleSuffixToken(titleCase, 'britney'),
      false,
      `${titleCase} after a plain word is a title word`,
    );
    assert.equal(
      isTitleSuffixToken(titleCase, undefined),
      false,
      `${titleCase} with nothing before it is a title word`,
    );
    assert.equal(
      isTitleSuffixToken(titleCase, 'Hardcore'),
      true,
      `${titleCase} after a tag is part of the tag run`,
    );
  }
});

test('clause 2 reads the previous token on its own merits only', () => {
  // A title-case language is not a tag, so it cannot make the token behind it
  // one either: in `Britney.Dutch.French` both words stay. Only a token that
  // would be a suffix unaided — a content type, a shouted language, an id —
  // opens a tag run.
  assert.equal(isTitleSuffixToken('French', 'Dutch'), false);
  assert.equal(isTitleSuffixToken('French', 'DUTCH'), true);
  assert.equal(isTitleSuffixToken('French', 'Solo'), true);
  assert.equal(isTitleSuffixToken('French', '42466'), true);
  assert.equal(isTitleSuffixToken('French', '4'), false, 'a sequel number is a title word');
});

test('the casing rule does not reach content types', () => {
  // `Hardcore`, `Solo` and `Lesbian` are title case in the very releases this
  // trimming exists to fix, so casing carries no signal for them.
  for (const term of ['HARDCORE', 'Hardcore', 'hardcore', 'SOLO', 'Solo', 'solo',
                      'LESBIAN', 'Lesbian', 'lesbian']) {
    assert.equal(isTitleSuffixToken(term, 'britney'), true, term);
  }
});

test('the corpus spelling iTALiAN is a tag, which all-caps would have missed', () => {
  // `CentoxCento...Orgia.Balorda.iTALiAN...`. This is why the test is "a
  // capital after the first character" and not "all caps".
  assert.equal(isTitleSuffixToken('iTALiAN', 'balorda'), true);
});
