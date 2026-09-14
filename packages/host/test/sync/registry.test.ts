import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaPlugin, SyncedTable } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { HOST_SYNCED_TABLES } from '../../src/sync/tables.ts';
import { assertIntegerIdKey, createSyncRegistry } from '../../src/sync/registry.ts';

/** A minimal `MediaPlugin`, closed over the one synced table a test needs. */
function fakePlugin(id: string, synced: readonly SyncedTable<unknown>[]): MediaPlugin {
  return {
    id,
    mediaType: 'tv',
    migrations: [],
    jobs: {},
    synced,
    onNewRssItems: async () => {},
    onDownloadedFile: async () => {},
    onDownloadRequest: async () => {},
  };
}

/** A `SyncedTable` whose `read` just returns whatever the test wants back. */
function fakeTable(
  table: string,
  rows: Record<number, unknown>,
  rowsFor: (mediaItemIds: readonly number[]) => readonly number[] = () => [],
): SyncedTable<unknown> {
  return {
    table,
    read: (_raw, ids) => {
      const result: Record<number, unknown> = {};
      for (const id of ids) if (rows[id] !== undefined) result[id] = rows[id];
      return result;
    },
    rowsFor: (_raw, mediaItemIds) => rowsFor(mediaItemIds),
  };
}

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
};

test('with no plugins, the registry knows only the host tables', () => {
  const raw = open();
  const registry = createSyncRegistry(raw, []);
  assert.deepEqual(registry.tables(), HOST_SYNCED_TABLES);
});

test("a plugin's declared table joins the registry and reads through the plugin's own read", () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_extra (id INTEGER PRIMARY KEY)');
  const plugin = fakePlugin('tv', [fakeTable('tv_extra', { 1: { id: 1, title: 'x' } })]);
  const registry = createSyncRegistry(raw, [plugin]);
  assert.ok(registry.tables().includes('tv_extra'));
  assert.deepEqual(registry.readRows(raw, 'tv_extra', [1, 2]), { 1: { id: 1, title: 'x' } });
});

test('a table nobody declares reads as empty rather than throwing', () => {
  const raw = open();
  const registry = createSyncRegistry(raw, []);
  assert.deepEqual(registry.readRows(raw, 'nobody_owns_this', [1]), {});
});

test("a plugin table's rowsFor dispatches to the plugin's own implementation", () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_extra (id INTEGER PRIMARY KEY)');
  const plugin = fakePlugin('tv', [
    fakeTable('tv_extra', {}, (mediaItemIds) => mediaItemIds.map((id) => id * 10)),
  ]);
  const registry = createSyncRegistry(raw, [plugin]);
  assert.deepEqual(registry.rowsFor(raw, 'tv_extra', [1, 2]), [10, 20]);
});

test('rowsFor answers empty for a host table and for a table nobody owns', () => {
  const raw = open();
  const registry = createSyncRegistry(raw, []);
  assert.deepEqual(registry.rowsFor(raw, 'media_item', [1]), []);
  assert.deepEqual(registry.rowsFor(raw, 'nobody_owns_this', [1]), []);
});

test('a plugin cannot claim a table already synced by the host', () => {
  const raw = open();
  // `assertSyncedTableName` only checks a name against its own plugin's id,
  // so a plugin calling itself `media` passes that check for `media_item`
  // (`packages/contract/test/sync.test.ts` pins this permissiveness). Only
  // the registry, which also knows the host's tables, can refuse it.
  const plugin = fakePlugin('media', [fakeTable('media_item', {})]);
  assert.throws(
    () => createSyncRegistry(raw, [plugin]),
    /media_item/,
    'a plugin must not be able to claim a host table by matching its own id to it',
  );
});

test('a plugin cannot claim a host table the host does not even sync', () => {
  // The motivating case: `sync_log` is not in `HOST_SYNCED_TABLES`, but it is
  // still a real table the host owns, created by migration. A plugin naming
  // itself `sync` would pass `assertSyncedTableName('sync', 'sync_log')` --
  // that check is self-consistency only -- so this is refused here or nowhere.
  const raw = open();
  const plugin = fakePlugin('sync', [fakeTable('sync_log', {})]);
  assert.throws(() => createSyncRegistry(raw, [plugin]), /sync_log/);
});

test('two plugins cannot declare the same table', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_shared (id INTEGER PRIMARY KEY)');
  const a = fakePlugin('tv', [fakeTable('tv_shared', {})]);
  const b = fakePlugin('tv2', [fakeTable('tv_shared', {})]);
  assert.throws(() => createSyncRegistry(raw, [a, b]), /tv_shared/);
});

test('assertIntegerIdKey accepts a table whose primary key is a single column named id', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_ok (id INTEGER PRIMARY KEY, title TEXT)');
  assert.doesNotThrow(() => { assertIntegerIdKey(raw, 'tv_ok'); });
});

test('assertIntegerIdKey refuses a table keyed by something other than a lone id column', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_bad_key (uuid TEXT PRIMARY KEY, title TEXT)');
  assert.throws(() => { assertIntegerIdKey(raw, 'tv_bad_key'); }, /tv_bad_key/);
});

test('assertIntegerIdKey refuses a table with a composite primary key', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_composite (a INTEGER, id INTEGER, PRIMARY KEY (a, id))');
  assert.throws(() => { assertIntegerIdKey(raw, 'tv_composite'); }, /tv_composite/);
});

test('a synced table keyed wrong is refused at declaration, before any trigger is installed', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_wrong_key (uuid TEXT PRIMARY KEY)');
  const plugin = fakePlugin('tv', [fakeTable('tv_wrong_key', {})]);
  assert.throws(() => createSyncRegistry(raw, [plugin]), /tv_wrong_key/);
});
