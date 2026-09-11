import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { readSecretValue, writeSecretValue } from '../../src/secrets/store.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
};

test('a written secret reads back', () => {
  const raw = open();
  writeSecretValue(raw, 'tvdb_key', 'test-value', 1000);
  assert.equal(readSecretValue(raw, 'tvdb_key'), 'test-value');
});

test('a name with no row reads null', () => {
  assert.equal(readSecretValue(open(), 'tvdb_key'), null);
});

test('writing twice updates rather than throwing, and moves updated_at only', () => {
  const raw = open();
  writeSecretValue(raw, 'tvdb_key', 'first-value', 1000);
  writeSecretValue(raw, 'tvdb_key', 'second-value', 2000);
  assert.equal(readSecretValue(raw, 'tvdb_key'), 'second-value');
  const row = raw.prepare('SELECT created_at, updated_at FROM secret WHERE name = ?').get('tvdb_key');
  assert.equal(Number((row as { created_at: unknown }).created_at), 1000, 'created_at must not move');
  assert.equal(Number((row as { updated_at: unknown }).updated_at), 2000, 'updated_at must move');
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM secret').get()?.c), 1, 'one row, not two');
});

test('an illegal name is refused by both halves of the store', () => {
  const raw = open();
  assert.throws(() => { writeSecretValue(raw, '../escape', 'test-value', 1); }, /secret name/);
  assert.throws(() => { readSecretValue(raw, '../escape'); }, /secret name/);
});
