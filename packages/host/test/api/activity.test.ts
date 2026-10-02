import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { ACTIVITY_RECENT_LIMIT } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { readActivity } from '../../src/api/activity.ts';

function seed(raw: DatabaseSync, state: string, at: number, extra: { runAt?: number; lastError?: string | null; payload?: string } = {}): number {
  return Number(raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, last_error, created_at, updated_at)
    VALUES ('alpha', 'noop', ?, 1, 3, ?, ?, ?, ?, ?)`)
    .run(extra.payload ?? '{"secret":"never-shown"}', extra.runAt ?? at, state, extra.lastError ?? null, at, at).lastInsertRowid);
}

test('the four lists, in their orders, with no payload anywhere', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const running = seed(raw, 'running', 100);
  const later = seed(raw, 'ready', 100, { runAt: 900 });
  const sooner = seed(raw, 'ready', 100, { runAt: 500 });
  const deadOld = seed(raw, 'dead', 100, { lastError: 'boom' });
  const deadNew = seed(raw, 'dead', 200, { lastError: 'bang' });
  seed(raw, 'done', 300);
  const read = readActivity(raw, () => []);
  assert.deepEqual(read.jobs.running.map((j) => j.id), [running]);
  assert.deepEqual(read.jobs.waiting.map((j) => j.id), [sooner, later], 'soonest run first');
  assert.deepEqual(read.jobs.dead.map((j) => j.id), [deadNew, deadOld], 'newest first');
  assert.equal(read.jobs.dead[0]?.lastError, 'bang');
  assert.equal(read.jobs.waiting[0]?.lastError, null);
  assert.ok(!JSON.stringify(read).includes('never-shown'), 'no payload travels');
  assert.ok(!/payload/i.test(JSON.stringify(read)), 'not even the key');
});

test('recent is capped and newest first', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  for (let i = 1; i <= ACTIVITY_RECENT_LIMIT + 5; i += 1) seed(raw, 'done', i);
  const { recent } = readActivity(raw, () => []).jobs;
  assert.equal(recent.length, ACTIVITY_RECENT_LIMIT);
  assert.equal(recent[0]?.updatedAt, ACTIVITY_RECENT_LIMIT + 5);
});

test('a job in a state this build does not know is in none of the lists, and nothing throws', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seed(raw, 'paused', 100);
  const read = readActivity(raw, () => []);
  assert.deepEqual([read.jobs.running, read.jobs.waiting, read.jobs.dead, read.jobs.recent].map((l) => l.length), [0, 0, 0, 0]);
});

test('fetches is the snapshot, passed through', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const hosts = [{ hostname: 'h', limit: 1, inFlight: [], waiting: [{ method: 'GET', target: 'https://h/x' }] }];
  assert.deepEqual(readActivity(raw, () => hosts).fetches, hosts);
});

test('lastError is read only from a dead job: a ready or done row that still holds one reads null', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seed(raw, 'ready', 100, { lastError: 'earlier attempt failed' });
  seed(raw, 'done', 100, { lastError: 'earlier attempt failed' });
  seed(raw, 'dead', 100, { lastError: 'gave up' });
  const { jobs } = readActivity(raw, () => []);
  assert.equal(jobs.waiting[0]?.lastError, null);
  assert.equal(jobs.recent[0]?.lastError, null);
  assert.equal(jobs.dead[0]?.lastError, 'gave up');
});
