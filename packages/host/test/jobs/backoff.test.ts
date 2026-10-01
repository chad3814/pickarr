import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doublingDelayMs } from '../../src/jobs/backoff.ts';

test('doublingDelayMs doubles from the base and holds at the cap', () => {
  const ladder = [1, 2, 3, 4, 5, 6, 7].map((n) => doublingDelayMs(n, 10_000, 300_000));
  assert.deepEqual(ladder, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.equal(doublingDelayMs(1, 10_000, 3_600_000), 10_000);
  assert.equal(doublingDelayMs(20, 10_000, 3_600_000), 3_600_000);
});
