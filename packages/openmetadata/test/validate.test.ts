import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBatchResponse, readEnvelope } from '../src/validate.ts';

/** The smallest envelope the service can answer with: unresolved, nothing filled in. */
function unresolved(): Record<string, unknown> {
  return {
    lookupId: '11111111-1111-1111-1111-111111111111',
    state: 'unresolved',
    partial: false,
    cached: false,
    confidence: null,
    refusal: null,
    parsed: null,
    media: null,
    suggestions: null,
  };
}

function resolved(): Record<string, unknown> {
  return {
    ...unresolved(),
    state: 'resolved',
    confidence: 0.91,
    media: {
      id: '22222222-2222-2222-2222-222222222222',
      kind: 'movie',
      title: 'Dune: Part Two',
      releaseDate: '2024-03-01',
      year: 2024,
      provider: 'tmdb',
      providerRef: 'tmdb:movie:693134',
      overview: 'Paul unites with the Fremen.',
      details: { runtimeMinutes: 166, imdbId: 'tt15239678', tagline: null, collectionName: 'Dune' },
      parents: [],
      people: [{
        providerRef: 'tmdb:person:1',
        name: 'Timothée Chalamet',
        role: 'cast',
        characterName: 'Paul Atreides',
        billingOrder: 0,
      }],
    },
  };
}

test('reads a minimal unresolved envelope', () => {
  const envelope = readEnvelope(unresolved());
  assert.equal(envelope.state, 'unresolved');
  assert.equal(envelope.media, null);
  assert.equal(envelope.suggestions, null);
});

test('reads a resolved envelope, keeping every details key', () => {
  const envelope = readEnvelope(resolved());
  assert.equal(envelope.media?.kind, 'movie');
  assert.equal(envelope.media?.providerRef, 'tmdb:movie:693134');
  assert.deepEqual(envelope.media?.details, {
    runtimeMinutes: 166,
    imdbId: 'tt15239678',
    tagline: null,
    collectionName: 'Dune',
  });
  assert.equal(envelope.media?.people[0]?.role, 'cast');
});

test('keeps a details key the document never mentions', () => {
  const body = resolved();
  const media = body['media'];
  assert.ok(media !== null && typeof media === 'object');
  Object.assign(media, { details: { runtimeMinutes: 166, somethingNew: 'kept' } });
  assert.equal(readEnvelope(body).media?.details['somethingNew'], 'kept');
});

test('names the field that is wrong', () => {
  assert.throws(() => readEnvelope({ ...unresolved(), state: 'maybe' }), /state/);
  assert.throws(() => readEnvelope({ ...unresolved(), partial: 'no' }), /partial/);
  assert.throws(() => readEnvelope({ ...unresolved(), confidence: 'high' }), /confidence/);
  assert.throws(() => readEnvelope(null), /envelope/);
});

test('rejects a details value that is neither string, number nor null', () => {
  const body = resolved();
  const media = body['media'];
  assert.ok(media !== null && typeof media === 'object');
  Object.assign(media, { details: { nested: { no: true } } });
  assert.throws(() => readEnvelope(body), /details/);
});

test('reads a batch response and keeps each entry status', () => {
  const body = readBatchResponse({ results: [{ ...unresolved(), status: 200 }] });
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0]?.status, 200);
});

test('rejects a batch response whose results are not an array', () => {
  assert.throws(() => readBatchResponse({ results: {} }), /results/);
});
