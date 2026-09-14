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

test('the prefix check is self-consistency only, not a defense against a host or plugin collision', () => {
  // `packages/contract` does not know the host's table names or any other
  // plugin's, so it cannot refuse a table just because something else
  // already owns it -- only `sync/registry.ts` in the host can, since it is
  // the one place both sets are gathered. Given a plugin id that happens to
  // equal a host table's own prefix, the check passes both host tables:
  assert.doesNotThrow(() => { assertSyncedTableName('media', 'media_item'); });
  assert.doesNotThrow(() => { assertSyncedTableName('sync', 'sync_log'); });
});
