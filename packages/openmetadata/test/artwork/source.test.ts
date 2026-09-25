import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderImage } from '../../src/artwork/source.ts';
import { bestImage, createArtworkSources } from '../../src/artwork/source.ts';

test('the highest score wins', () => {
  // Urls are deliberately the *reverse* of alphabetical order versus score,
  // so that a mutant which drops the score comparison and falls through to
  // the url tiebreak picks the wrong one instead of passing by coincidence.
  const images: readonly ProviderImage[] = [
    { url: 'https://example.test/a-low-score.jpg', language: 'en', score: 1 },
    { url: 'https://example.test/z-high-score.jpg', language: 'en', score: 9 },
  ];
  assert.equal(bestImage(images, 'en')?.url, 'https://example.test/z-high-score.jpg');
});

test('the configured language beats a higher-scoring foreign image', () => {
  // A poster in a language the operator does not read is worse than a
  // lower-scored one they do, however the provider votes.
  const images: readonly ProviderImage[] = [
    { url: 'https://example.test/foreign-high.jpg', language: 'ja', score: 9 },
    { url: 'https://example.test/match-low.jpg', language: 'en', score: 1 },
  ];
  assert.equal(bestImage(images, 'en')?.url, 'https://example.test/match-low.jpg');
});

test('a language-neutral image beats a foreign one, and loses to a matching one', () => {
  // `iso_639_1: null` is a textless image -- usually the best poster there
  // is, and the reason the order is match > neutral > foreign rather than
  // match > everything.
  const images: readonly ProviderImage[] = [
    { url: 'https://example.test/foreign.jpg', language: 'ja', score: 9 },
    { url: 'https://example.test/neutral.jpg', language: null, score: 1 },
  ];
  assert.equal(bestImage(images, 'en')?.url, 'https://example.test/neutral.jpg');

  const withMatch: readonly ProviderImage[] = [
    { url: 'https://example.test/neutral2.jpg', language: null, score: 9 },
    { url: 'https://example.test/match.jpg', language: 'en', score: 1 },
  ];
  assert.equal(bestImage(withMatch, 'en')?.url, 'https://example.test/match.jpg');
});

test('an empty list answers undefined rather than throwing', () => {
  // A provider with no artwork for an item is ordinary, not an error.
  assert.equal(bestImage([], 'en'), undefined);
});

test('ties break on score, then stably', () => {
  // Two images, same language, same score, and deliberately given in the
  // *reverse* of their expected answer: if the comparator fell back on
  // input order (relying on the runtime's own sort stability) rather than
  // comparing `url` itself, this would still happen to pass by preserving
  // the order they were given in. Feeding them b-before-a means only an
  // explicit url tiebreak lands on `a.jpg`.
  const images: readonly ProviderImage[] = [
    { url: 'https://example.test/b.jpg', language: 'en', score: 5 },
    { url: 'https://example.test/a.jpg', language: 'en', score: 5 },
  ];
  assert.equal(bestImage(images, 'en')?.url, 'https://example.test/a.jpg');
});

test('createArtworkSources registers both providers openmetadata emits', () => {
  // The registry is the only place that answers "which providers have
  // artwork", and its first consumer (`artwork/job.ts`) silently gives an
  // item nothing when the answer is wrong. Both keys are spelled literally
  // here rather than derived from the map, so a rename on either side is a
  // failure rather than a tautology.
  const sources = createArtworkSources({
    fetch: {
      json: async () => {
        throw new Error('not used by this test: building a source makes no request');
      },
      bytes: async () => {
        throw new Error('not used by this test: building a source makes no request');
      },
    },
    resolveSecret: async () => 'unused',
  });
  assert.deepEqual([...sources.keys()].toSorted(), ['tmdb', 'tpdb']);
  assert.ok(sources.get('tmdb'), 'tmdb has a source');
  assert.ok(sources.get('tpdb'), 'tpdb has a source');
  // Nothing else: a third key would be a provider nobody verified against a
  // live API, which is exactly what the seam's docblock refuses.
  assert.equal(sources.size, 2);
});

test('a provider openmetadata does not emit has no source, and asking is not an error', () => {
  const sources = createArtworkSources({
    fetch: {
      json: async () => {
        throw new Error('not used by this test');
      },
      bytes: async () => {
        throw new Error('not used by this test');
      },
    },
    resolveSecret: async () => 'unused',
  });
  assert.equal(sources.get('tvdb'), undefined);
});
