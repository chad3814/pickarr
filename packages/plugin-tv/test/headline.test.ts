import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TvRead } from '@pickarr/contract';
import { tvHeadline } from '../src/headline.ts';

function tv(over: Partial<TvRead>): TvRead {
  return { mediaItemId: 1, kind: 'episode', seriesTitle: 'Jo Jo’s Bizarre Adventure', seriesRef: 'r', seasonNumber: null, episodeNumber: null, ...over };
}

test('an episode with a season reads series, SxxEyy, then its own title', () => {
  const line = tvHeadline(tv({ seasonNumber: 2, episodeNumber: 47 }), "Dio's World(3)");
  assert.equal(line, "Jo Jo’s Bizarre Adventure S02E47 Dio's World(3)");
});

test('an episode with no season drops S and keeps E', () => {
  const line = tvHeadline(tv({ episodeNumber: 47 }), "Dio's World(3)");
  assert.equal(line, "Jo Jo’s Bizarre Adventure E47 Dio's World(3)");
});

test('a season pack has no episode number to show', () => {
  const line = tvHeadline(tv({ kind: 'season', seasonNumber: 2 }), 'Season 2');
  assert.equal(line, 'Jo Jo’s Bizarre Adventure S02 Season 2');
});

test('a series pack does not say its own name twice', () => {
  // `media_item.title` is the lookup document's `media.title`
  // (`openmetadata/src/engine.ts:141`), which for a series pack is the
  // series name. Without the equality check this reads the series title
  // twice, which is the case this rule exists for.
  const line = tvHeadline(tv({ kind: 'series' }), 'Jo Jo’s Bizarre Adventure');
  assert.equal(line, 'Jo Jo’s Bizarre Adventure');
});

test('numbers past two digits are padded, not truncated', () => {
  const line = tvHeadline(tv({ seasonNumber: 2, episodeNumber: 147 }), 'x');
  assert.equal(line, 'Jo Jo’s Bizarre Adventure S02E147 x');
});

test('a series row that carries season/episode numbers still renders them -- the rule reads the numbers, not kind', () => {
  // Nothing above pins this: every `kind: 'series'` fixture here has both
  // numbers `null`, so a branch reading `kind` instead of the numbers
  // (`if (kind === 'series') return seriesTitle`) would agree with every
  // one of them and still pass. A `kind: 'series'` row with numbers set is
  // data that should not occur, but `tvHeadline`'s own docblock is explicit
  // that the numbers are the one rule, not `kind` -- so a row where the two
  // disagree still has to render the numbers.
  const line = tvHeadline(tv({ kind: 'series', seasonNumber: 2, episodeNumber: 47 }), 'Special Edition');
  assert.equal(line, 'Jo Jo’s Bizarre Adventure S02E47 Special Edition');
});
