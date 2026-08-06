import { test } from 'node:test';
import assert from 'node:assert/strict';
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
