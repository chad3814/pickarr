import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import {
  AUTH_SECRET_KEY,
  clearHostState,
  ensureAuthSecret,
  readHostState,
  writeHostState,
} from '../../src/db/host-state.ts';

/**
 * Placeholder values below are obviously synthetic -- fixed strings that
 * cannot be mistaken for a real generated secret -- because
 * `ensureAuthSecret` itself produces the only values in this file that are
 * meant to look like credentials, and even those are never printed: every
 * assertion below compares them, it never formats one into a message.
 */

test('a secret generated once is returned again unchanged', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const first = ensureAuthSecret(raw, 1_000);
  const second = ensureAuthSecret(raw, 2_000);

  assert.equal(second, first);
});

test('two ensureAuthSecret calls on one database yield one secret', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  // Stands in for the winner of a real race between two processes: a row
  // already committed under AUTH_SECRET_KEY before this call ever runs,
  // using the exact statement `ensureAuthSecret` itself issues so this is
  // "another caller's insert already landed", not just "some data exists".
  // A test that instead called `ensureAuthSecret` twice in this one
  // process could not tell the read-back implementation from a version
  // that returns the value it generated: the first call's own write would
  // make the second call's read-back correct either way. Pre-seeding the
  // row *before the first call this test makes* is what forces the
  // "loser" path through code that never itself won the insert.
  raw.prepare(`
    INSERT INTO host_state (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run(AUTH_SECRET_KEY, 'placeholder-preexisting-secret-value', 500, 500);

  const returned = ensureAuthSecret(raw, 1_000);

  assert.equal(returned, 'placeholder-preexisting-secret-value');
  const rows = raw.prepare('SELECT key FROM host_state WHERE key = ?').all(AUTH_SECRET_KEY);
  assert.equal(rows.length, 1);
});

test('a secret survives a fresh connection to the same file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-host-state-'));
  try {
    const path = join(dir, 'pickarr.db');

    const first = openDatabase(path);
    migrateHost(first.raw);
    const generated = ensureAuthSecret(first.raw, 1_000);
    first.raw.close();

    const second = openDatabase(path);
    const reread = ensureAuthSecret(second.raw, 2_000);
    second.raw.close();

    assert.equal(reread, generated);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an absent key reads as null rather than throwing', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  assert.equal(readHostState(raw, 'auth.neverSet'), null);
});

test('writing an existing key moves updated_at and keeps one row', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  writeHostState(raw, 'auth.claimToken', 'placeholder-token-one', 1_000);
  writeHostState(raw, 'auth.claimToken', 'placeholder-token-two', 2_000);

  assert.equal(readHostState(raw, 'auth.claimToken'), 'placeholder-token-two');
  const rows = raw.prepare(
    'SELECT created_at, updated_at FROM host_state WHERE key = ?',
  ).all('auth.claimToken') as { created_at: unknown; updated_at: unknown }[];
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0]?.created_at), 1_000);
  assert.equal(Number(rows[0]?.updated_at), 2_000);
});

test('clearing a key removes it', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  writeHostState(raw, 'auth.claimToken', 'placeholder-token', 1_000);
  clearHostState(raw, 'auth.claimToken');

  assert.equal(readHostState(raw, 'auth.claimToken'), null);
  const rows = raw.prepare('SELECT key FROM host_state WHERE key = ?').all('auth.claimToken');
  assert.equal(rows.length, 0);
});
