import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MetadataCandidate, MetadataQuery } from '@pickarr/plugin-api';
import { confirmSceneMetadata } from '../src/metadata.ts';

const NAUGHTY = { siteUuid: 'site-uuid', siteId: 1, siteName: 'Naughty Office' };

function candidate(over: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return {
    sourceUuid: 'scene-1', title: 'Smokin Hot Brunette', date: '2021-11-15',
    performers: [], durationSeconds: 1000, synopsis: null, posterUrl: null, slug: null,
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
  assert.equal(
    verdict.nearMisses[0]?.reason,
    'lost tiebreak',
    'a decided tiebreak loser is not the same thing as an ambiguous one',
  );
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
  assert.equal(verdict.nearMisses[0]?.reason, 'lost tiebreak');
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

// --- Review findings on the code above: these pin the fixes, not the brief. ---

test('two dateless candidates sharing a title key confirm nothing', () => {
  const query: MetadataQuery = { queries: ['Emma G'], siteName: 'Naughty Office' };
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'old', title: 'Emma G', date: null }),
      candidate({ sourceUuid: 'new', title: 'emma-g!', date: null }),
    ],
    query,
  );
  assert.equal(
    verdict.confirmed,
    null,
    'confirming the first would be guessing by array position, with no date to catch it',
  );
  assert.equal(verdict.nearMisses.length, 2);
  assert.ok(
    verdict.nearMisses.every((m) => m.reason === 'ambiguous: 2 candidates share this title'),
  );
});

test('an empty query cannot be satisfied by an equally empty title', () => {
  const emptyQueries = confirmSceneMetadata(
    [candidate({ title: '', date: null })],
    { queries: [], siteName: 'Naughty Office' },
  );
  assert.equal(emptyQueries.confirmed, null, "'' must never equal '' as evidence");

  const emptyStringQuery = confirmSceneMetadata(
    [candidate({ title: '???', date: null })],
    { queries: [''], siteName: 'Naughty Office' },
  );
  assert.equal(emptyStringQuery.confirmed, null, 'punctuation-only text is also an unusable key');
});

test('punctuation-only site names do not match each other', () => {
  const verdict = confirmSceneMetadata(
    [candidate({ siteName: '---' })],
    { queries: ['Smokin Hot Brunette'], siteName: '!!!', date: '2021-11-15' },
  );
  assert.equal(verdict.confirmed, null);
  assert.equal(verdict.nearMisses[0]?.reason, 'site differed');
});

test('a truncated date is not silently completed to the first of the month', () => {
  const verdict = confirmSceneMetadata(
    [candidate({ date: '2021-11' })],
    { queries: ['x'], siteName: 'Naughty Office', date: '2021-11-01' },
  );
  assert.equal(verdict.confirmed, null, '"2021-11" must not parse as "2021-11-01"');
  assert.equal(verdict.nearMisses[0]?.reason, 'date outside window');
});

test('an overflowing date is not silently rolled into the next month', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'fabricated', date: '2021-02-30', title: 'Something Else' }),
      candidate({ sourceUuid: 'genuine', date: '2021-03-01', title: 'Smokin Hot Brunette' }),
    ],
    { queries: ['Smokin Hot Brunette'], siteName: 'Naughty Office', date: '2021-03-02' },
  );
  assert.equal(
    verdict.confirmed?.sourceUuid,
    'genuine',
    '"2021-02-30" must not roll into 2021-03-02 and fabricate an exact match',
  );
});
