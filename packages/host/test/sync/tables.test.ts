import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { HOST_SYNCED_TABLES, readHostRows } from '../../src/sync/tables.ts';
import { syncedTriggerNames } from '../../src/sync/log.ts';

test('every host synced table has all three triggers after migration', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const present = new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
  for (const table of HOST_SYNCED_TABLES) {
    for (const name of syncedTriggerNames(table)) {
      assert.ok(present.has(name), `${table} is synced but ${name} does not exist`);
    }
  }
});

test('no credential-bearing table is synced', () => {
  for (const forbidden of ['auth_user', 'auth_session', 'auth_account', 'auth_verification', 'host_state', 'secret', 'download_client']) {
    assert.ok(!HOST_SYNCED_TABLES.includes(forbidden), `${forbidden} must never be synced`);
  }
});

test('every synced table has an integer primary key named id', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  for (const table of HOST_SYNCED_TABLES) {
    const pk = raw.prepare(`PRAGMA table_info(${table})`).all()
      .filter((r) => Number((r as { pk: unknown }).pk) > 0)
      .map((r) => String((r as { name: unknown }).name));
    assert.deepEqual(pk, ['id'], `${table}'s primary key must be a single column named id`);
  }
});

test('a log row can hold nothing but a table name, a row id, an op and a time', () => {
  // Spec 7.17. Structural rather than behavioural: the guarantee that no
  // credential or url reaches the log is the table's shape, so assert the
  // shape. A column added here later would need this test changed, which is
  // the point.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  assert.deepEqual(
    raw.prepare('PRAGMA table_info(sync_log)').all().map((r) => String((r as { name: unknown }).name)),
    ['id', 'table_name', 'row_id', 'op', 'at'],
  );
});

test('every synced table can be paged by an immutable key', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  for (const table of HOST_SYNCED_TABLES) {
    const columns = raw.prepare(`PRAGMA table_info(${table})`).all()
      .map((r) => String((r as { name: unknown }).name));
    assert.ok(columns.includes('created_at'), `${table} needs created_at for the backfill's keyset`);
  }
});

test('readHostRows projects the declared columns for media_item, keyed by id', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, title, created_at, updated_at, provider, provider_ref)
    VALUES (1, 'alpha', 'The Grid', 10, 20, 'tmdb', 'movie:512')
  `).run();
  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, title, created_at, updated_at)
    VALUES (2, 'alpha', 'Encom', 30, 40)
  `).run();

  const rows = readHostRows(raw, 'media_item', [1, 2]);
  assert.deepEqual(Object.keys(rows).toSorted(), ['1', '2']);
  assert.deepEqual(rows[1], {
    id: 1, plugin_id: 'alpha', created_at: 10, updated_at: 20,
    provider: 'tmdb', provider_ref: 'movie:512', title: 'The Grid',
    release_date: null, description: null,
  });
  assert.deepEqual(rows[2], {
    id: 2, plugin_id: 'alpha', created_at: 30, updated_at: 40,
    provider: null, provider_ref: null, title: 'Encom',
    release_date: null, description: null,
  });
});

test('readHostRows projects the declared columns for person, and skips an id that does not exist', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.prepare(`
    INSERT INTO person (id, name, provider_ref, created_at, updated_at)
    VALUES (1, 'Kevin Flynn', 'tmdb:1', 10, 20)
  `).run();

  const rows = readHostRows(raw, 'person', [1, 999]);
  assert.deepEqual(Object.keys(rows), ['1']);
  assert.deepEqual(rows[1], {
    id: 1, name: 'Kevin Flynn', provider_ref: 'tmdb:1', created_at: 10, updated_at: 20,
  });
});

test('readHostRows never touches the database for an empty ids array', () => {
  // No migration has run, so `media_item` does not exist. If this ever
  // issued a query it would throw "no such table: media_item" -- returning
  // {} cleanly is what proves the early return actually fires before SQL.
  const { raw } = openTestDatabase();
  assert.deepEqual(readHostRows(raw, 'media_item', []), {});
});

test('readHostRows refuses a table outside HOST_SYNCED_TABLES', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  assert.throws(() => readHostRows(raw, 'secret', [1]), /secret/);
});
