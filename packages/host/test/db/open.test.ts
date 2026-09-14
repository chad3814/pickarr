import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';

test('recursive triggers are on, so a displacing REPLACE logs the deletion it causes', () => {
  const { raw } = openTestDatabase();
  assert.equal(Number(raw.prepare('PRAGMA recursive_triggers').get()?.recursive_triggers), 1);
});
