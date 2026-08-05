import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStandardQuality } from '@pickarr/plugin-api';

test('higher resolution always outranks lower', () => {
  assert.ok(
    scoreStandardQuality({ resolution: 2160 }) > scoreStandardQuality({ resolution: 1080 }),
  );
  assert.ok(
    scoreStandardQuality({ resolution: 1080 }) > scoreStandardQuality({ resolution: 720 }),
  );
});

test('resolution dominates codec and source', () => {
  const lowResBestEverythingElse = scoreStandardQuality({
    resolution: 720,
    source: 'BluRay',
    videoCodec: 'x265',
  });
  const highResWorstEverythingElse = scoreStandardQuality({ resolution: 1080 });
  assert.ok(highResWorstEverythingElse > lowResBestEverythingElse);
});

test('at equal resolution, better source and codec win', () => {
  const base = scoreStandardQuality({ resolution: 1080 });
  assert.ok(scoreStandardQuality({ resolution: 1080, source: 'BluRay' }) > base);
  assert.ok(scoreStandardQuality({ resolution: 1080, videoCodec: 'x265' }) > base);
});

test('size breaks ties without ever overtaking a quality tier', () => {
  const small = scoreStandardQuality({ resolution: 1080, sizeBytes: 1_000_000_000 });
  const huge = scoreStandardQuality({ resolution: 1080, sizeBytes: 900_000_000_000 });
  assert.ok(huge > small);
  assert.ok(huge < scoreStandardQuality({ resolution: 2160 }));
});

test('unknown tokens score without throwing', () => {
  assert.equal(typeof scoreStandardQuality({}), 'number');
  assert.equal(typeof scoreStandardQuality({ source: 'NotARealSource' }), 'number');
});
