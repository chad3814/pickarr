import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTitleEnd, tokensOf } from '../src/parse.ts';

/** The title text the walk leaves behind, for readable assertions. */
function titleOf(name: string, minIndex = 0): string {
  const tokens = tokensOf(name);
  const end = findTitleEnd(tokens, minIndex);
  return tokens.slice(0, end).map((t) => t.text).join(' ');
}

test('the walk crosses the XXX marker to reach what is behind it', () => {
  // The whole change depends on this: XXX is neither an encode token nor a
  // boundary anchor, so a walk that stopped there would never see `42466` or
  // `Solo`, which is where most affected titles keep their junk.
  assert.equal(titleOf('Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB'), 'Suki Sin');
});

test('it crosses a content-type tag', () => {
  assert.equal(titleOf('Remido.Solo.XXX.1080p.MP4-WRB'), 'Remido');
});

test('it crosses a language tag, in the corpus spelling', () => {
  assert.equal(titleOf('Orgia.Balorda.iTALiAN.XXX.1080p'), 'Orgia Balorda');
  assert.equal(titleOf('Maria.Gail.GERMAN.XXX.1080p'), 'Maria Gail');
});

test('it crosses a language tag then stops at a sequel number', () => {
  // `Minori Kamiyama Rispetto 1 JAP`: JAP goes, the 1 stays.
  assert.equal(titleOf('Minori.Kamiyama.Rispetto.1.JAP.XXX.1080p'),
    'Minori Kamiyama Rispetto 1');
});

test('a kept token blocks the walk from reaching suffix tokens behind it', () => {
  // `Hiyori JAPANESE 2` — the 2 stops the walk, so JAPANESE survives. This is
  // the trailing-run limit, recorded deliberately: skipping a kept token to
  // strip something behind it is how words go missing from the middle of a
  // title, and 9 corpus titles have a content-type tag mid-title.
  assert.equal(titleOf('Hiyori.JAPANESE.2.XXX.1080p'), 'Hiyori JAPANESE 2');
});

test('a title word ends the walk immediately', () => {
  assert.equal(titleOf('Alex.Coal.Some.Title'), 'Alex Coal Some Title');
});

test('minIndex stops the walk, so the title can never empty', () => {
  // Every token is a suffix token; minIndex is the only thing left.
  assert.equal(titleOf('Solo.Hardcore.Lesbian', 1), 'Solo');
  assert.equal(titleOf('Solo.Hardcore.Lesbian', 2), 'Solo Hardcore');
});

test('mid-title tags are untouched, because the walk only sees the end', () => {
  assert.equal(titleOf('Solo.Adventure.Begins'), 'Solo Adventure Begins');
  assert.equal(titleOf('The.Hardcore.Truth'), 'The Hardcore Truth');
});

test('minIndex floor is never crossed, even with a release group', () => {
  // Ensure the floor holds when a group tag would be removed. findTitleEnd must
  // return minIndex, not fall below it, because the caller passes the result as
  // the floor to findEncodeSuffixStart.
  const tokens = tokensOf('Alex.FLAC.WRB');
  assert.equal(findTitleEnd(tokens, 3), 3);
  assert.equal(findTitleEnd(tokens, 2), 2);
  assert.equal(findTitleEnd(tokens, 1), 1);
});

test('a name whose entire tail is a group tag after an encode token resolves correctly', () => {
  // Edge case: only performer/title before encode section. The group is
  // recognized, removed, and the walk continues through the encode.
  assert.equal(titleOf('Name.MP4-WRB'), 'Name');
});
