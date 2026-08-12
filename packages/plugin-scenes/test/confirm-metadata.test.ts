import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MetadataCandidate, MetadataQuery } from '@pickarr/plugin-api';
import { confirmSceneMetadata } from '../src/metadata.ts';

const NAUGHTY = { siteUuid: 'site-uuid', siteId: 1, siteName: 'Naughty Office' };

function candidate(over: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return {
    sourceUuid: 'scene-1', title: 'Smokin Hot Brunette', date: '2021-11-15',
    performers: ['Silvia Saige'], durationSeconds: 1000, synopsis: null, posterUrl: null,
    ...NAUGHTY, ...over,
  };
}

const DATED: MetadataQuery = {
  queries: ['Smokin Hot Brunette'], siteName: 'Naughty Office', date: '2021-11-15',
};

test('an exact site and date confirms', () => {
  const verdict = confirmSceneMetadata([candidate()], DATED);
  assert.equal(verdict.confirmed?.sourceUuid, 'scene-1');
  assert.equal(verdict.nearMisses.length, 0);
});

test('a date inside the window confirms; one outside does not', () => {
  const inside = confirmSceneMetadata([candidate({ date: '2021-11-17' })], DATED);
  assert.equal(inside.confirmed?.sourceUuid, 'scene-1');

  const outside = confirmSceneMetadata([candidate({ date: '2021-11-18' })], DATED);
  assert.equal(outside.confirmed, null);
  assert.equal(outside.nearMisses[0]?.reason, 'date outside window');
});

test('a different site is rejected however well the title matches', () => {
  const verdict = confirmSceneMetadata(
    [candidate({ siteUuid: 'other', siteId: 2, siteName: 'Elsewhere' })],
    DATED,
  );
  assert.equal(verdict.confirmed, null);
  assert.equal(verdict.nearMisses[0]?.reason, 'site differed');
});

test('site names match on the comparison key, not on spelling', () => {
  const verdict = confirmSceneMetadata(
    [candidate({ siteUuid: null, siteId: null, siteName: 'naughty-office' })],
    { queries: ['x'], siteName: 'Naughty Office', date: '2021-11-15' },
  );
  assert.equal(verdict.confirmed?.sourceUuid, 'scene-1');
});

test('an exact date beats a nearer-titled neighbour inside the window', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'neighbour', date: '2021-11-14', title: 'Smokin Hot Brunette' }),
      candidate({ sourceUuid: 'exact', date: '2021-11-15', title: 'Something Else' }),
    ],
    DATED,
  );
  assert.equal(verdict.confirmed?.sourceUuid, 'exact');
  assert.equal(verdict.nearMisses.length, 1, 'the loser is still recorded');
});

test('with no exact date the closest wins', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'far', date: '2021-11-17' }),
      candidate({ sourceUuid: 'near', date: '2021-11-16' }),
    ],
    DATED,
  );
  assert.equal(verdict.confirmed?.sourceUuid, 'near');
});

test('equally close candidates are broken by title', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'wrong-title', date: '2021-11-14', title: 'Another Thing' }),
      candidate({ sourceUuid: 'right-title', date: '2021-11-16', title: 'Smokin Hot Brunette' }),
    ],
    DATED,
  );
  assert.equal(verdict.confirmed?.sourceUuid, 'right-title');
});

test('two indistinguishable candidates confirm nothing', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'a', date: '2021-11-14', title: 'Neither Matches' }),
      candidate({ sourceUuid: 'b', date: '2021-11-16', title: 'Nor Does This' }),
    ],
    DATED,
  );
  assert.equal(verdict.confirmed, null, 'a daily-publishing site must not be guessed at');
  assert.equal(verdict.nearMisses.length, 2);
  assert.ok(verdict.nearMisses.every((m) => m.reason.startsWith('ambiguous: 2 candidates')));
});

test('a dateless group needs the title to match exactly', () => {
  const query: MetadataQuery = { queries: ['Emma G'], siteName: 'Naughty Office' };
  const matching = confirmSceneMetadata([candidate({ title: 'Emma G', date: null })], query);
  assert.equal(matching.confirmed?.sourceUuid, 'scene-1');

  const not = confirmSceneMetadata([candidate({ title: 'Emma H', date: null })], query);
  assert.equal(not.confirmed, null);
  assert.equal(not.nearMisses[0]?.reason, 'title differed');
});

test('a candidate with no date cannot satisfy a dated query', () => {
  const verdict = confirmSceneMetadata([candidate({ date: null })], DATED);
  assert.equal(verdict.confirmed, null);
  assert.equal(verdict.nearMisses[0]?.reason, 'date outside window');
});

test('no candidates is a clean negative, not an error', () => {
  const verdict = confirmSceneMetadata([], DATED);
  assert.equal(verdict.confirmed, null);
  assert.equal(verdict.nearMisses.length, 0);
});
