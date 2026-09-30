import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoResolution } from '../src/videoResolution.ts';
import { VIDEO_RESOLUTION_CASES } from './videoResolutionCases.ts';

test('the accepted values, lowercased, and null for everything else', () => {
  for (const [input, expected] of VIDEO_RESOLUTION_CASES) {
    assert.equal(normalizeVideoResolution(input), expected, `input ${JSON.stringify(input) ?? 'undefined'}`);
  }
});
