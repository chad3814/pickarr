import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase, setSyncChangedListener } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { installSyncTriggers } from '../../src/sync/log.ts';

test('recursive triggers are on, so a displacing REPLACE logs the deletion it causes', () => {
  const { raw } = openTestDatabase();
  assert.equal(Number(raw.prepare('PRAGMA recursive_triggers').get()?.recursive_triggers), 1);
});

test('every connection carries pickarr_sync_changed, so a trigger that calls it never fails a write', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)');
  installSyncTriggers(raw, ['probe']);
  // No listener installed: the default is a no-op, and the write must succeed.
  assert.doesNotThrow(() => raw.exec("INSERT INTO probe (v) VALUES ('a')"));
});

test('a listener hears every row a trigger logs, inside the writing statement, and can be removed', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)');
  installSyncTriggers(raw, ['probe']);
  let calls = 0;
  setSyncChangedListener(raw, () => { calls += 1; });
  raw.exec("INSERT INTO probe (v) VALUES ('a'), ('b')");
  raw.exec("UPDATE probe SET v = 'c'");
  raw.exec('DELETE FROM probe');
  assert.equal(calls, 6, 'two inserts, two updates, two deletes');
  setSyncChangedListener(raw, undefined);
  raw.exec("INSERT INTO probe (v) VALUES ('d')");
  assert.equal(calls, 6, 'removed: silent again');
});
