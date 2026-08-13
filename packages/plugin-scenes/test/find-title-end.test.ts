import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detachReleaseGroup, findTitleBoundary, findTitleEnd, tokensOf } from '../src/parse.ts';

/**
 * The title text the composed walk leaves behind, for readable assertions.
 * Exercises the real composition: a caller detaches a trailing release-group
 * tag first (as every real call site does — `findEncodeSuffixStart` returns
 * `null` for undetached tokens with one), then `findEncodeSuffixStart` finds
 * the boundary `findTitleEnd` walks back from, exactly as `findTitleBoundary`
 * does it.
 */
function titleOf(name: string, minIndex = 0): string {
  const detached = detachReleaseGroup(tokensOf(name), name);
  const boundary = findTitleBoundary(detached.tokens, minIndex);
  if (boundary === null) return 'REFUSED';
  return detached.tokens.slice(0, boundary.titleEnd).map((t) => t.text).join(' ');
}

test('the walk starts after the XXX marker, so it reaches what is behind it', () => {
  // Renamed from "crosses the XXX marker": under the new order the walk never
  // crosses XXX at all. `findEncodeSuffixStart` cuts at the marker itself, so
  // the vocabulary walk starts one token behind it and still reaches `42466`
  // and `Solo`, which is where most affected titles keep their junk.
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
  // No encode section at all, so findEncodeSuffixStart returns null and the
  // composed helper reports REFUSED — this fixture exercises findTitleEnd's
  // own floor behaviour directly instead.
  const tokens = tokensOf('Alex.Coal.Some.Title');
  assert.equal(findTitleEnd(tokens, 0, tokens.length), tokens.length);
});

test('minIndex stops the walk, so the title can never empty', () => {
  // Every token is a suffix token; minIndex is the only thing left.
  const tokens = tokensOf('Solo.Hardcore.Lesbian');
  assert.equal(findTitleEnd(tokens, 1, tokens.length), 1);
  assert.equal(findTitleEnd(tokens, 2, tokens.length), 2);
});

test('mid-title tags are untouched, because the walk only sees the end', () => {
  const tokens1 = tokensOf('Solo.Adventure.Begins');
  assert.equal(findTitleEnd(tokens1, 0, tokens1.length), tokens1.length);
  const tokens2 = tokensOf('The.Hardcore.Truth');
  assert.equal(findTitleEnd(tokens2, 0, tokens2.length), tokens2.length);
});

test('minIndex floor is never crossed, walking back from a given index', () => {
  // The walk's floor guarantee no longer needs a release-group fixture to
  // exercise it: findTitleEnd only ever crosses vocabulary tokens now, and a
  // release group is entirely findEncodeSuffixStart's business, reached via
  // detachReleaseGroup upstream rather than by this predicate. Ordinary
  // suffix vocabulary proves the same thing: minIndex stops the walk at
  // every floor, not just the one nearest the end.
  const tokens = tokensOf('Alex.Solo.Hardcore');
  assert.equal(findTitleEnd(tokens, 3, tokens.length), 3);
  assert.equal(findTitleEnd(tokens, 2, tokens.length), 2);
  assert.equal(findTitleEnd(tokens, 1, tokens.length), 1);
});

test('a name with only performer/title before a resolution anchor resolves correctly', () => {
  // The shortest case that exercises the full composition: findEncodeSuffixStart
  // finds `1080p` as a boundary anchor, and findTitleEnd walks back one token
  // from it to the floor. Release-group detachment is a separate concern,
  // covered by detachReleaseGroup and suffix-parse.test.ts, not by this file.
  assert.equal(titleOf('Name.1080p'), 'Name');
});
