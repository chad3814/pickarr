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
