/**
 * `select`: which entries of a finished download a plugin copies (design
 * spec 2026-09-22 §3-§4). Pure, so every rule is pinned against literal
 * relative paths -- nothing here is computed by the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeMarker, isCandidate, select } from '../src/select.ts';
import type { Expectation } from '../src/select.ts';

const SINGLE: Expectation = { kind: 'single' };
const SEASON_1: Expectation = { kind: 'episodes', season: 1 };
const SERIES: Expectation = { kind: 'episodes', season: null };

function entries(...relativePaths: string[]): { relativePath: string }[] {
  return relativePaths.map((relativePath) => ({ relativePath }));
}

function chosen(result: ReturnType<typeof select<{ relativePath: string }>>): string[] {
  assert.ok('chosen' in result, `expected a selection, got ${JSON.stringify(result)}`);
  return result.chosen.map((entry) => entry.relativePath);
}

test('a candidate is a video extension, compared case-insensitively', () => {
  for (const name of ['a.mkv', 'a.MP4', 'a.m4v', 'a.avi', 'a.mov', 'a.wmv', 'a.mpg', 'a.mpeg',
    'a.ts', 'a.m2ts', 'a.webm', 'a.iso', 'MOVIE.ISO']) {
    assert.equal(isCandidate(name), true, name);
  }
  for (const name of ['a.nfo', 'a.srt', 'a.mds', 'a.mds.mds', 'a.jpg', 'mkv', 'a.mkv.part', '.mkv']) {
    assert.equal(isCandidate(name), false, name);
  }
});

test('anything with "sample" in its relative path is not a candidate, in any case', () => {
  assert.equal(isCandidate('Sample/film.mkv'), false);
  assert.equal(isCandidate('film.sample.mkv'), false);
  assert.equal(isCandidate('SAMPLE-film.mkv'), false);
  assert.equal(isCandidate('extras/Samples/x.mkv'), false);
});

test('the Swiss Family Robinson layout chooses exactly the iso', () => {
  const result = select(entries(
    'Swiss Family Robinson (1960) (USA).iso',
    'Swiss Family Robinson (1960) (USA).mds.mds',
  ), SINGLE);
  assert.deepEqual(chosen(result), ['Swiss Family Robinson (1960) (USA).iso']);
});

test('single: a film beside its sample is chosen', () => {
  assert.deepEqual(chosen(select(entries('film.mkv', 'Sample/sample.mkv', 'film.nfo'), SINGLE)), ['film.mkv']);
});

test('the download directory\'s own name is never consulted: it is not part of any relative path', () => {
  // A download at `/downloads/The.Sample.2019/` lists `film.mkv`, not
  // `The.Sample.2019/film.mkv` -- the host strips the root. Pinned so that
  // nobody "helpfully" passes the full path to isCandidate.
  assert.deepEqual(chosen(select(entries('film.mkv'), SINGLE)), ['film.mkv']);
});

test('a film whose own filename contains "sample" is excluded -- spec §3, literally', () => {
  // Scene releases usually name the file after the folder, so *The Sample
  // (2019)* delivered as `The.Sample.2019.mkv` finds no candidate. This is
  // what spec §3 says; it is pinned so that changing it is a decision.
  assert.deepEqual(select(entries('The.Sample.2019.mkv', 'The.Sample.2019.nfo'), SINGLE), { refusal: 'no-video-file' });
});

test('single: zero candidates refuses no-video-file', () => {
  assert.deepEqual(select(entries('a.nfo', 'b.srt'), SINGLE), { refusal: 'no-video-file' });
  assert.deepEqual(select(entries(), SINGLE), { refusal: 'no-video-file' });
});

test('single: two candidates refuses too-many-video-files rather than choosing by size', () => {
  assert.deepEqual(select(entries('a.mkv', 'b.mkv'), SINGLE), { refusal: 'too-many-video-files' });
});

test('episodeMarker reads SxxEyy and multi-episode forms, case-insensitively', () => {
  assert.deepEqual(episodeMarker('Show.S01E02.mkv'), { season: 1, episodes: [2] });
  assert.deepEqual(episodeMarker('show.s01e02.720p.mkv'), { season: 1, episodes: [2] });
  assert.deepEqual(episodeMarker('Show.S1E2.mkv'), { season: 1, episodes: [2] });
  assert.deepEqual(episodeMarker('Show.S01E01E02.mkv'), { season: 1, episodes: [1, 2] });
  assert.deepEqual(episodeMarker('Show.S01E01-E02.mkv'), { season: 1, episodes: [1, 2] });
  assert.deepEqual(episodeMarker('Show.S02E105.mkv'), { season: 2, episodes: [105] });
  assert.equal(episodeMarker('Show.Extras.mkv'), null);
});

test('episodes: every candidate is chosen, numbering need not be contiguous', () => {
  const result = select(entries('S1/Show.S01E01.mkv', 'S1/Show.S01E02.mkv', 'S1/Show.S01E05.mkv', 'Show.nfo'), SEASON_1);
  assert.deepEqual(chosen(result), ['S1/Show.S01E01.mkv', 'S1/Show.S01E02.mkv', 'S1/Show.S01E05.mkv']);
});

test('episodes: the marker is read from the filename, not from a directory', () => {
  assert.deepEqual(
    select(entries('Show.S01E01/extras.mkv'), SEASON_1),
    { refusal: 'episode-marker-missing' },
  );
});

test('episodes: a candidate with no marker refuses episode-marker-missing', () => {
  assert.deepEqual(
    select(entries('Show.S01E01.mkv', 'extras.mkv'), SEASON_1),
    { refusal: 'episode-marker-missing' },
  );
});

test('episodes: a repeated season/episode pair refuses episode-marker-duplicate', () => {
  assert.deepEqual(
    select(entries('Show.S01E02.720p.mkv', 'Show.S01E02.1080p.mkv'), SEASON_1),
    { refusal: 'episode-marker-duplicate' },
  );
  // A multi-episode file overlapping a single one is a duplicate too.
  assert.deepEqual(
    select(entries('Show.S01E01E02.mkv', 'Show.S01E02.mkv'), SEASON_1),
    { refusal: 'episode-marker-duplicate' },
  );
});

test('episodes: a season pack holding another season refuses too-many-video-files', () => {
  assert.deepEqual(
    select(entries('Show.S01E01.mkv', 'Show.S02E05.mkv'), SEASON_1),
    { refusal: 'too-many-video-files' },
  );
});

test('episodes: a series pack, or a season pack of unknown number, accepts any season', () => {
  const files = entries('Show.S01E01.mkv', 'Show.S02E01.mkv');
  assert.deepEqual(chosen(select(files, SERIES)), ['Show.S01E01.mkv', 'Show.S02E01.mkv']);
});

test('episodes: zero candidates refuses no-video-file', () => {
  assert.deepEqual(select(entries('Show.nfo', 'Sample/Show.S01E01.mkv'), SEASON_1), { refusal: 'no-video-file' });
});

test('episodes: refusals are checked in order -- missing before season before duplicate', () => {
  // All three problems at once: the first rule in spec order wins.
  assert.deepEqual(
    select(entries('extras.mkv', 'Show.S02E01.mkv', 'Show.S01E01.mkv', 'Show.S01E01.x.mkv'), SEASON_1),
    { refusal: 'episode-marker-missing' },
  );
  assert.deepEqual(
    select(entries('Show.S02E01.mkv', 'Show.S01E01.mkv', 'Show.S01E01.x.mkv'), SEASON_1),
    { refusal: 'too-many-video-files' },
  );
});

test('unmatched: every entry is chosen, sidecars and samples included', () => {
  const files = entries('film.iso', 'film.mds.mds', 'Sample/sample.mkv');
  assert.deepEqual(chosen(select(files, 'unmatched')), ['film.iso', 'film.mds.mds', 'Sample/sample.mkv']);
});

test('the chosen entries are the objects passed in, not copies', () => {
  const input = [{ relativePath: 'a.mkv', path: '/x/a.mkv', sizeBytes: 3 }];
  const result = select(input, SINGLE);
  assert.ok('chosen' in result);
  assert.equal(result.chosen[0], input[0]);
});
