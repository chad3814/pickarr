import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrate } from '../../src/db/migrate.ts';
import { migrations } from '../../src/db/migrations.ts';

test('migrate creates every table', () => {
  const db = openTestDatabase();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row['name']));

  for (const expected of [
    'discovered_sites',
    'downloads',
    'feed_items',
    'imported_files',
    'media_groups',
    'releases',
    'schema_migrations',
  ]) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test('migrate is idempotent', () => {
  const db = openTestDatabase();
  migrate(db);
  migrate(db);
  const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  // Against the list rather than a literal: the property under test is that a
  // second run applies nothing, which a hardcoded count stops expressing the
  // moment a migration is added.
  assert.equal(Number(row?.['n']), migrations.length);
  db.close();
});

test('an existing database gains discovered_sites without losing its data', () => {
  // The migration ships after real databases exist, so it has to run as an
  // upgrade and not only as part of a fresh create.
  const db = openTestDatabase();
  db.prepare('DROP TABLE discovered_sites').run();
  db.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
       created_at, list_rank_at) VALUES (1, 'scenes', 'k', '{}', 't', 'new', 1, 1)`,
  ).run();

  migrate(db);

  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row['name']));
  assert.ok(names.includes('discovered_sites'));
  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']),
    1,
    'existing rows must survive the upgrade',
  );
  db.close();
});

/**
 * A database as it stood before a given migration: every earlier migration
 * run and recorded, nothing after it.
 *
 * The sibling test above fakes its "before" by dropping a table off a fully
 * migrated database, which works only because migration 2 is a CREATE TABLE.
 * Migration 3 is this repo's first ALTER TABLE, and an added column cannot be
 * taken back off the same way, so the old shape has to be built forwards.
 */
function databaseAtVersion(version: number): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const migration of migrations.filter((m) => m.version <= version)) {
    migration.up(db);
    record.run(migration.version, 1);
  }
  return db;
}

test('an existing database gains the manual-metadata columns without losing its data', () => {
  const db = databaseAtVersion(2);
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at, parse_error)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 300, 'no site')`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
       created_at, list_rank_at) VALUES (1, 'scenes', 'k', '{}', 't', 'new', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":1080}', 1080, 1)`,
  ).run();

  migrate(db);

  // Every pre-existing value is still there, and the three added columns read
  // NULL — "nobody has dismissed or edited this" is the only honest answer for
  // a row that predates the columns, and it is what the Failed list's default
  // filter and the edit stamps both assume of history.
  const item = db
    .prepare('SELECT raw_title, parse_error, dismissed_at FROM feed_items WHERE id = 1')
    .get();
  assert.equal(item?.['raw_title'], 'T1');
  assert.equal(item?.['parse_error'], 'no site');
  assert.equal(item?.['dismissed_at'], null);

  const group = db.prepare('SELECT search_text, edited_at FROM media_groups WHERE id = 1').get();
  assert.equal(group?.['search_text'], 't');
  assert.equal(group?.['edited_at'], null);

  const release = db.prepare('SELECT score, edited_at FROM releases WHERE id = 1').get();
  assert.equal(release?.['score'], 1080);
  assert.equal(release?.['edited_at'], null);

  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.['n']),
    migrations.length,
  );
  db.close();
});

test('an upgraded database gets the partial index the failed listing pages on', () => {
  const upgraded = databaseAtVersion(2);
  migrate(upgraded);
  const fresh = openTestDatabase();

  // Asserted on both paths because they are different code: the upgrade runs
  // migration 3's CREATE INDEX against a populated table, the fresh create
  // runs it against an empty one, and an index missing from either would make
  // the Failed list scan the whole feed history.
  for (const db of [upgraded, fresh]) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('feed_items_failed');
    assert.ok(row !== undefined, 'feed_items_failed index is missing');
    assert.match(String(row?.['sql']), /WHERE parse_error IS NOT NULL/);
    db.close();
  }
});

test('feed_items rejects a duplicate guid within a feed', () => {
  const db = openTestDatabase();
  const insert = db.prepare(
    `INSERT INTO feed_items (feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run('feed1', 'guid-1', 'Title', 'http://example.invalid/1', 1);
  assert.throws(() => insert.run('feed1', 'guid-1', 'Title', 'http://example.invalid/1', 2));
  db.close();
});

test('feed_items allows the same guid in a different feed', () => {
  const db = openTestDatabase();
  const insert = db.prepare(
    `INSERT INTO feed_items (feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run('feed1', 'guid-1', 'Title', 'http://example.invalid/1', 1);
  insert.run('feed2', 'guid-1', 'Title', 'http://example.invalid/1', 1);
  db.close();
});

test('media_groups rejects a duplicate identity within a plugin', () => {
  const db = openTestDatabase();
  const insert = db.prepare(
    `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run('scenes', 'key-1', '{}', 'text', 1, 1);
  assert.throws(() => insert.run('scenes', 'key-1', '{}', 'text', 1, 1));
  db.close();
});
