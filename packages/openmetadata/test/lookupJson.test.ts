import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupJsonFor } from '../src/lookupJson.ts';
import { LOOKUP_JSON_CAP_BYTES, LOOKUP_JSON_TOO_LARGE } from '@pickarr/contract';
import type { LookupEnvelope } from '../src/types.ts';

function envelope(over: Partial<LookupEnvelope> = {}): LookupEnvelope {
  return {
    lookupId: 'lk_01HTEST',
    state: 'unresolved',
    partial: false,
    cached: false,
    confidence: null,
    refusal: null,
    parsed: null,
    media: null,
    suggestions: null,
    ...over,
  };
}

test('the envelope is serialised as readable JSON', () => {
  const json = lookupJsonFor(envelope({ confidence: 0.25 }));
  const back: unknown = JSON.parse(json);
  assert.deepEqual(back, {
    lookupId: 'lk_01HTEST',
    state: 'unresolved',
    partial: false,
    cached: false,
    confidence: 0.25,
    refusal: null,
    parsed: null,
    suggestions: null,
  });
});

test('media is never stored, however large the answer', () => {
  // Belt and braces: `media` is null on both branches that call this, so
  // this cannot fire today. It is the one field that would make the column
  // unbounded if a later branch started writing, and a test is cheaper
  // than noticing that in a replica.
  const withMedia = envelope({
    media: { title: 'A Film', people: [] } as unknown as LookupEnvelope['media'],
  });
  const back: unknown = JSON.parse(lookupJsonFor(withMedia));
  assert.ok(typeof back === 'object' && back !== null && !('media' in back),
    'media is dropped rather than serialised');
});

test('an oversized envelope is replaced by a marker, not truncated', () => {
  // Truncated JSON does not parse, so a card would have to render a broken
  // string or guess. A marker is a value the client can recognise and
  // explain. The cap protects every client's replica from one pathological
  // response.
  const huge = envelope({ parsed: { blob: 'x'.repeat(LOOKUP_JSON_CAP_BYTES * 2) } });
  assert.equal(lookupJsonFor(huge), LOOKUP_JSON_TOO_LARGE);
});

test('an envelope exactly at the cap is kept', () => {
  // The boundary, spelled out: `>` and `>=` are one character apart and
  // only a test built to land exactly on the boundary tells them apart.
  // Padding is computed from a measurement, not guessed: serialise with an
  // empty `parsed.blob` first, then add exactly as many ASCII characters
  // as the cap has bytes remaining. A plain ASCII character costs exactly
  // one byte in UTF-8 and needs no JSON escaping (unlike `"`, `\` or a
  // control character), so each one added lengthens the serialised output
  // by exactly one byte -- this arithmetic cannot drift.
  const emptyLength = Buffer.byteLength(lookupJsonFor(envelope({ parsed: { blob: '' } })), 'utf8');
  const padding = LOOKUP_JSON_CAP_BYTES - emptyLength;
  const atCap = envelope({ parsed: { blob: 'x'.repeat(padding) } });
  const json = lookupJsonFor(atCap);
  assert.equal(Buffer.byteLength(json, 'utf8'), LOOKUP_JSON_CAP_BYTES);
  assert.notEqual(json, LOOKUP_JSON_TOO_LARGE);
});

test('an envelope one byte over the cap is replaced by the marker', () => {
  // Same measurement as above, with one more byte of padding: this is the
  // other side of the boundary `>` and `>=` disagree on.
  const emptyLength = Buffer.byteLength(lookupJsonFor(envelope({ parsed: { blob: '' } })), 'utf8');
  const padding = LOOKUP_JSON_CAP_BYTES - emptyLength + 1;
  const overCap = envelope({ parsed: { blob: 'x'.repeat(padding) } });
  assert.equal(lookupJsonFor(overCap), LOOKUP_JSON_TOO_LARGE);
});

test('the cap is measured in bytes, not characters', () => {
  // A multi-byte character counts once as a character and up to four times
  // as a byte, and it is bytes that land in the replica. Built to exceed
  // the cap in bytes while staying under it in `.length`.
  const wide = envelope({ parsed: { blob: '\u{1F600}'.repeat(LOOKUP_JSON_CAP_BYTES / 3) } });
  assert.equal(lookupJsonFor(wide), LOOKUP_JSON_TOO_LARGE);
});
