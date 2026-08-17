import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.ts';
import { getAppState, setAppState } from '../../src/db/app-state.ts';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

test('an unset key reads as null rather than throwing', () => {
  assert.equal(getAppState(freshDb(), 'pass:nothing-ran'), null);
});

test('a value survives a write and reads back exactly', () => {
  const db = freshDb();
  setAppState(db, 'pass:rekey-scene-slugs', '60', 1_700_000_000_000);
  assert.equal(getAppState(db, 'pass:rekey-scene-slugs'), '60');
});

test('writing the same key twice replaces rather than throwing on the primary key', () => {
  const db = freshDb();
  setAppState(db, 'pass:rekey-scene-slugs', '60', 1_700_000_000_000);
  setAppState(db, 'pass:rekey-scene-slugs', '61', 1_700_000_000_001);
  assert.equal(getAppState(db, 'pass:rekey-scene-slugs'), '61');
  const rows = db.prepare('SELECT COUNT(*) AS n FROM app_state').get() as { n: number };
  assert.equal(rows.n, 1);
});
