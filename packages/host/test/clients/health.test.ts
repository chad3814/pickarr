import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { isReachable, reconcileRetryDelayMs, recordContactFailure, recordContactSuccess } from '../../src/clients/health.ts';

function setup(): { raw: DatabaseSync; clientId: number } {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec(`INSERT INTO download_client (name, type, implementation, url, category, import_mode, created_at, updated_at)
            VALUES ('c', 'torrent', 'qbittorrent', 'https://c.example', 'movies', 'copy', 1, 1)`);
  return { raw, clientId: 1 };
}

function health(raw: DatabaseSync): Record<string, unknown> {
  return { ...raw.prepare('SELECT consecutive_failures, unreachable_since, updated_at FROM download_client WHERE id = 1').get() };
}

test('a failure counts up and stamps the start of the streak once', () => {
  const { raw, clientId } = setup();
  assert.equal(recordContactFailure(raw, clientId, 100), 1);
  assert.equal(recordContactFailure(raw, clientId, 200), 2);
  assert.deepEqual(health(raw), { consecutive_failures: 2, unreachable_since: 100, updated_at: 200 });
});

test('a success ends a streak, and a success with no streak writes nothing', () => {
  const { raw, clientId } = setup();
  recordContactSuccess(raw, clientId, 50);
  assert.deepEqual(health(raw), { consecutive_failures: 0, unreachable_since: null, updated_at: 1 }, 'healthy: no write at all');

  recordContactFailure(raw, clientId, 100);
  recordContactSuccess(raw, clientId, 300);
  assert.deepEqual(health(raw), { consecutive_failures: 0, unreachable_since: null, updated_at: 300 });
});

test('a healthy client polled repeatedly adds nothing to the sync log', () => {
  const { raw, clientId } = setup();
  const maxLog = (): number => Number((raw.prepare('SELECT max(id) AS m FROM sync_log').get() as { m: unknown }).m ?? 0);
  const before = maxLog();
  for (let at = 10; at <= 100; at += 10) recordContactSuccess(raw, clientId, at);
  assert.equal(maxLog(), before);
});

test('the retry ladder and the reachability threshold', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(reconcileRetryDelayMs), [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.equal(isReachable(2), true);
  assert.equal(isReachable(3), false);
});

test('a failure count of 0 -- the client row vanished mid-tick -- is clamped onto the ladder\'s first rung', () => {
  // `recordContactFailure` answers 0 when the row it was updating no
  // longer exists. Unclamped, `doublingDelayMs(0, ...)` reads as one
  // attempt before the first rung and answers half of it (5s), a delay
  // off the ladder every real failure count uses.
  assert.equal(reconcileRetryDelayMs(0), reconcileRetryDelayMs(1));
  assert.equal(reconcileRetryDelayMs(0), 10_000);
});
