import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOKUP_JSON_TOO_LARGE } from '@pickarr/contract';
import { envelopeSearchParts, unmatchedHaystack } from '../../src/library/unmatchedSearch.ts';

/** An envelope with every field the search reads, plus the ids and states it must not. */
const ENVELOPE = JSON.stringify({
  lookupId: 'lk_ABC123',
  state: 'done',
  partial: false,
  cached: true,
  confidence: 0.42,
  refusal: null,
  parsed: { title: 'Arrival', year: 2016, resolution: '1080p', group: null },
  media: {
    id: 'm1', kind: 'episode', title: 'Good News About Hell', releaseDate: '2022-02-18', year: 2022,
    provider: 'tmdb', providerRef: 'tmdb:95396:1:1', overview: 'An office.', details: {},
    parents: [{ id: 's1', kind: 'series', title: 'Severance', releaseDate: null, year: 2022, provider: 'tmdb', providerRef: 'tmdb:95396' }],
    people: [{ providerRef: 'p1', name: 'Adam Scott' }, { providerRef: 'p2', name: 'Britt Lower' }],
  },
  suggestions: { site: { name: 'Some Site', providerRef: 'site:1' }, performers: [{ name: 'Jane Doe', providerRef: 'perf:1' }] },
});

test('the envelope contributes the candidate, its year, its people, its parents, the suspected site and performers, and the parsed values', () => {
  assert.deepEqual(envelopeSearchParts(ENVELOPE), [
    'Good News About Hell', '2022', 'Adam Scott', 'Britt Lower', 'Severance', 'Some Site', 'Jane Doe', 'Arrival', '2016', '1080p',
  ]);
});

test('ids, provider names, states and the overview never contribute, so a term like tmdb or cached matches nothing', () => {
  const haystack = unmatchedHaystack('x.mkv', ENVELOPE);
  for (const absent of ['tmdb', 'lk_abc123', 'cached', 'done', 'an office', 'perf:1', 'site:1']) {
    assert.ok(!haystack.includes(absent), `${absent} must not be searchable`);
  }
});

test('the haystack is the filename and the parts, normalised and newline-joined like the catalog\'s', () => {
  assert.equal(unmatchedHaystack('Some.Release.mkv', undefined), 'some.release.mkv');
  assert.equal(
    unmatchedHaystack('Some.Release.mkv', JSON.stringify({ suggestions: { site: { name: '  Big   Site ' }, performers: [] } })),
    'some.release.mkv\nbig site',
  );
});

test('a body that is not an envelope, or the host\'s too-large marker, leaves the filename alone', () => {
  assert.deepEqual(envelopeSearchParts('not json'), []);
  assert.deepEqual(envelopeSearchParts('"a string"'), []);
  assert.deepEqual(envelopeSearchParts(LOOKUP_JSON_TOO_LARGE), []);
  assert.deepEqual(envelopeSearchParts(JSON.stringify({ media: 'nope', suggestions: 7, parsed: ['x'] })), [], 'wrong shapes are skipped field by field');
});
