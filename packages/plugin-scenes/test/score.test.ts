import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStandardQuality } from '@pickarr/plugin-api';
import { scoreScene } from '../src/score.ts';

test('a release with no stated source is treated as an original site rip', () => {
  assert.equal(
    scoreScene({ resolution: 1080 }),
    scoreStandardQuality({ resolution: 1080, source: 'siterip' }),
  );
});

test('an explicit re-encode source ranks below an unstated one', () => {
  assert.ok(scoreScene({ resolution: 1080, source: 'webrip' }) < scoreScene({ resolution: 1080 }));
});

test('an explicit source is never overridden', () => {
  assert.equal(
    scoreScene({ resolution: 1080, source: 'bluray' }),
    scoreStandardQuality({ resolution: 1080, source: 'bluray' }),
  );
});

test('resolution still dominates the source adjustment', () => {
  assert.ok(scoreScene({ resolution: 2160, source: 'webrip' }) > scoreScene({ resolution: 1080 }));
});
