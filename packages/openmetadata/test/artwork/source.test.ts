import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderImage } from '../../src/artwork/source.ts';
import { bestImage, createArtworkSources, rankImages } from '../../src/artwork/source.ts';

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

test('rankImages returns the whole list in bestImage’s order', () => {
  // One image per tier and score, given scrambled; the expected order is
  // spelled literally: configured language, then neutral, then foreign, a
  // higher score first within a tier, and url ascending on a full tie.
  const images: readonly ProviderImage[] = [
    { url: 'https://example.test/foreign-high.jpg', language: 'ja', score: 9 },
    { url: 'https://example.test/neutral-low.jpg', language: null, score: 1 },
    { url: 'https://example.test/match-low-b.jpg', language: 'en', score: 1 },
    { url: 'https://example.test/neutral-high.jpg', language: null, score: 8 },
    { url: 'https://example.test/match-high.jpg', language: 'en', score: 7 },
    { url: 'https://example.test/match-low-a.jpg', language: 'en', score: 1 },
  ];
  assert.deepEqual(rankImages(images, 'en').map((image) => image.url), [
    'https://example.test/match-high.jpg',
    'https://example.test/match-low-a.jpg',
    'https://example.test/match-low-b.jpg',
    'https://example.test/neutral-high.jpg',
    'https://example.test/neutral-low.jpg',
    'https://example.test/foreign-high.jpg',
  ]);
  assert.equal(images[0]?.url, 'https://example.test/foreign-high.jpg', 'the input is not reordered');
  assert.deepEqual(rankImages([], 'en'), []);
});

test('bestImage is the first of rankImages', () => {
  const images: readonly ProviderImage[] = [
    { url: 'https://example.test/b.jpg', language: 'en', score: 5 },
    { url: 'https://example.test/c.jpg', language: null, score: 9 },
    { url: 'https://example.test/a.jpg', language: 'en', score: 5 },
  ];
  assert.equal(bestImage(images, 'en'), rankImages(images, 'en')[0]);
  assert.equal(bestImage(images, 'en')?.url, 'https://example.test/a.jpg');
});

test('rankImages is stable on a full tie', () => {
  // Same url, language and score: only identity tells them apart, and the
  // provider's order must survive.
  const first: ProviderImage = { url: 'https://example.test/same.jpg', language: 'en', score: 5 };
  const second: ProviderImage = { url: 'https://example.test/same.jpg', language: 'en', score: 5 };
  const ranked = rankImages([first, second], 'en');
  assert.equal(ranked[0], first);
  assert.equal(ranked[1], second);
});

test('createArtworkSources registers every provider openmetadata emits', () => {
  // The registry is the only place that answers "which providers have
  // artwork", and its first consumer (`artwork/job.ts`) silently gives an
  // item nothing when the answer is wrong. Every key is spelled literally
  // here rather than derived from the map, so a rename on either side is a
  // failure rather than a tautology.
  //
  // **This test asserted two keys and a size of 2 while production was
  // logging "no source is registered" for a third.** A test can only
  // pin the registry against the list someone wrote down; that the list
  // matches what the service actually emits is not a property this file
  // can check, and it was wrong for `tvdb` until a real deployment said
  // so. Treat the count as "no provider was added without updating this
  // line", never as evidence that the set is complete.
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
  assert.deepEqual([...sources.keys()].toSorted(), ['tmdb', 'tpdb', 'tvdb']);
  assert.ok(sources.get('tmdb'), 'tmdb has a source');
  assert.ok(sources.get('tpdb'), 'tpdb has a source');
  assert.ok(sources.get('tvdb'), 'tvdb has a source');
  assert.equal(sources.size, 3);
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
  // `imdb` is the stand-in here precisely because `tvdb` used to be, and
  // `tvdb` turned out to be a provider the service really emits. This
  // asserts the lookup's *behaviour* for an unregistered key -- `undefined`
  // rather than a throw, which is what lets `job.ts` log once and move on
  // -- and asserts nothing about which providers exist.
  assert.equal(sources.get('imdb'), undefined);
});
