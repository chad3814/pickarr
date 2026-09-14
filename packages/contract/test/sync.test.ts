import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSyncedTableName } from '../src/sync.ts';

test('a plugin may only declare tables carrying its own id as a prefix', () => {
  assert.doesNotThrow(() => { assertSyncedTableName('tv', 'tv_series'); });
  assert.doesNotThrow(() => { assertSyncedTableName('tv', 'tv_release'); });
  for (const table of ['media_item', 'movie_detail', 'sync_log', 'secret', 'tvseries']) {
    assert.throws(() => { assertSyncedTableName('tv', table); }, /prefix/, `${table} must be refused`);
  }
});

test('a table name that is not a plain identifier is refused', () => {
  // The name reaches a trigger body as text, where SQLite binds no parameters.
  for (const table of ['tv_a; DROP TABLE media_item', 'tv_a"b', 'tv_a b', 'tv_a-b', '']) {
    assert.throws(() => { assertSyncedTableName('tv', table); }, /identifier|prefix/, `${table} must be refused`);
  }
});
