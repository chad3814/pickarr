import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoResolutionOf } from '../src/quality.ts';
import { resolvedEnvelope, refusedEnvelope } from '../src/testing.ts';
import type { LookupEnvelope } from '../src/types.ts';

function withParsed(parsed: LookupEnvelope['parsed']): LookupEnvelope {
  return { ...refusedEnvelope({ lookupId: 'l', refusal: 'x' }), refusal: null, parsed };
}

test("reads parsed.quality.resolution, the shape the live service sends", () => {
  // Shape measured against openmetadata.nexus on 2026-09-30 (spec, "What the
  // service actually sends"); not in the OpenAPI document.
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: '2160p', source: 'WEB' } })), '2160p');
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: '1080P' } })), '1080p', 'normalized');
});

test('anything missing or malformed is null, never a throw', () => {
  assert.equal(videoResolutionOf(withParsed(null)), null, 'no parse');
  assert.equal(videoResolutionOf(withParsed({})), null, 'no quality');
  assert.equal(videoResolutionOf(withParsed({ quality: null })), null, 'quality null');
  assert.equal(videoResolutionOf(withParsed({ quality: 'high' })), null, 'quality not an object');
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: null, source: 'UHD' } })), null, "the service's own UHD answer");
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: 1080 } })), null, 'a number');
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: '../1080p' } })), null, 'a path');
  assert.equal(
    videoResolutionOf(resolvedEnvelope({ lookupId: 'l', media: { id: 'm', kind: 'movie', title: 't', releaseDate: null, year: null, provider: 'tmdb', providerRef: 'tmdb:movie:1', overview: null, details: {}, parents: [], people: [] } })),
    null,
    'the harness default carries no parse',
  );
});
