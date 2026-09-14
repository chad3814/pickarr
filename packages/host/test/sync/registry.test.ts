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
function fakeTable(table: string, rows: Record<number, unknown>): SyncedTable<unknown> {
  return {
    table,
    read: (_raw, ids) => {
      const result: Record<number, unknown> = {};
      for (const id of ids) if (rows[id] !== undefined) result[id] = rows[id];
      return result;
    },
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

test('one plugin declaring a table twice is refused', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_shared (id INTEGER PRIMARY KEY)');
  // The only way a *shipped* configuration reaches the duplicate guard, and
  // the reason its message does not say "two plugins": an operator sent
  // looking for a second plugin would not find one. See the test below for
  // why two distinct plugins cannot get here at all.
  const one = fakePlugin('tv', [fakeTable('tv_shared', {}), fakeTable('tv_shared', {})]);
  assert.throws(() => createSyncRegistry(raw, [one]), /tv_shared.*declared twice/);
});

test('two plugins sharing an id reach the same guard', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_shared (id INTEGER PRIMARY KEY)');
  // `host.register` refuses a duplicate plugin id separately, but
  // `createSyncRegistry` takes a list and checks no ids, so this is the second
  // and last way in. It is indistinguishable from the case above from in here,
  // which is the other reason the message names the table and not a plugin.
  const a = fakePlugin('tv', [fakeTable('tv_shared', {})]);
  const b = fakePlugin('tv', [fakeTable('tv_shared', {})]);
  assert.throws(() => createSyncRegistry(raw, [a, b]), /tv_shared.*declared twice/);
});

test('two plugins with different ids cannot collide on a table name at all', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_shared (id INTEGER PRIMARY KEY)');
  // Measured, and it replaces a test that claimed to cover the duplicate guard
  // and never reached it: `assertSyncedTableName` requires the table to start
  // with `<pluginId>_`, and one name cannot start with two different prefixes,
  // so the prefix check refuses the second plugin before the duplicate check
  // is consulted. The old test asserted only `/tv_shared/`, which the prefix
  // error also contains -- so it passed while proving something else.
  const a = fakePlugin('tv', [fakeTable('tv_shared', {})]);
  const b = fakePlugin('tv2', [fakeTable('tv_shared', {})]);
  assert.throws(() => createSyncRegistry(raw, [a, b]), /does not carry its id as a prefix/);
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

// Narrowed from "...before any trigger is installed": `createSyncRegistry`
// never installs a trigger itself, and this test never builds one -- the
// claim this file can actually prove is about the registry's own
// validation. Whether the *boot* path (`host.register`, which does install
// triggers) refuses the same table before installing anything is
// `host.test.ts`'s own test, over `assertSyncable` at that call site --
// see that file for why the claim about triggers belongs there and not here.
test('createSyncRegistry refuses a synced table keyed wrong, via assertSyncable', () => {
  const raw = open();
  raw.exec('CREATE TABLE tv_wrong_key (uuid TEXT PRIMARY KEY)');
  const plugin = fakePlugin('tv', [fakeTable('tv_wrong_key', {})]);
  assert.throws(() => createSyncRegistry(raw, [plugin]), /tv_wrong_key/);
});
