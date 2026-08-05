import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQuality, formatBytes } from '../src/api/format.ts';

test('formats the tokens that are present, in a stable order', () => {
  assert.equal(
    formatQuality({ resolution: 1080, source: 'web-dl', videoCodec: 'h265', releaseGroup: 'WRB' }),
    '1080p · web-dl · h265 · WRB',
  );
});

test('omits absent tokens without leaving separators', () => {
  assert.equal(formatQuality({ resolution: 2160 }), '2160p');
  assert.equal(formatQuality({ source: 'bluray' }), 'bluray');
});

test('an empty token set reads as unknown', () => {
  assert.equal(formatQuality({}), 'unknown quality');
});

test('formats sizes in binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(5_368_709_120), '5.0 GiB');
});
