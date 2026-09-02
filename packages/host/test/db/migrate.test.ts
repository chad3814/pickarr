import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost, migratePlugin } from '../../src/db/migrate.ts';

test('host migrations create the shared tables and are idempotent', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const names = new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
  for (const t of ['rss_feed', 'rss_item', 'media_item', 'person', 'role', 'jobs']) {
    assert.ok(names.has(t), `missing ${t}`);
  }
  // Running again must not throw: the runner has to skip applied versions
  // rather than re-running CREATE TABLE.
  migrateHost(raw);
});

test('a plugin migration is tracked under its own id, so two plugins may both have version 1', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const applied = migratePlugin(raw, 'alpha', [
    { version: 1, up: (db) => db.exec('CREATE TABLE alpha_thing (id INTEGER PRIMARY KEY)') },
  ]);
  const alsoApplied = migratePlugin(raw, 'beta', [
    { version: 1, up: (db) => db.exec('CREATE TABLE beta_thing (id INTEGER PRIMARY KEY)') },
  ]);
  assert.equal(applied, 1);
  assert.equal(alsoApplied, 1, 'beta version 1 must apply even though alpha version 1 did');
});

test('a plugin migration added later applies only itself', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const first = [{ version: 1, up: (db: DatabaseSync) => db.exec('CREATE TABLE g_a (id INTEGER PRIMARY KEY)') }];
  migratePlugin(raw, 'g', first);
  let secondRan = 0;
  const both = [
    ...first,
    { version: 2, up: (db: DatabaseSync) => { secondRan += 1; db.exec('CREATE TABLE g_b (id INTEGER PRIMARY KEY)'); } },
  ];
  const applied = migratePlugin(raw, 'g', both);
  assert.equal(applied, 1, 'only version 2 was outstanding');
  assert.equal(secondRan, 1);
});

test('a plugin table not prefixed with the plugin id is refused', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  // Prefixing is what keeps two plugins from colliding on a table name, so it
  // is enforced rather than documented.
  assert.throws(
    () => migratePlugin(raw, 'delta', [
      { version: 1, up: (db) => db.exec('CREATE TABLE not_prefixed (id INTEGER PRIMARY KEY)') },
    ]),
    /prefix/i,
  );
});
