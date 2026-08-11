import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { assertUniqueVersions, migrate } from '../../src/db/migrate.ts';
import { migrations, type Migration } from '../../src/db/migrations.ts';

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

test('an upgraded database gets the index the failed-download predicate seeks on', () => {
  const upgraded = databaseAtVersion(3);
  migrate(upgraded);
  const fresh = openTestDatabase();

  // Both paths, as above: the upgrade runs migration 5's CREATE INDEX against a
  // table that already holds downloads, the fresh create against an empty one.
  // Without it `WHERE release_id = ? ORDER BY id DESC LIMIT 1` scans the whole
  // downloads table, once per candidate release in `deriveUpgradeReleaseId` and
  // once per group on every browse and picks page.
  for (const db of [upgraded, fresh]) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('downloads_release');
    assert.ok(row !== undefined, 'downloads_release index is missing');
    assert.match(String(row?.['sql']), /downloads\s*\(release_id\)/);
    db.close();
  }
});

test('the failed-download predicate uses that index rather than scanning', () => {
  // The index is only worth having if the planner picks it, and the query it
  // has to serve is the one embedded in `latestDownloadFailed`. Asserting the
  // plan rather than the index's existence is what makes this a test of the
  // lookup instead of a restatement of the migration.
  const db = openTestDatabase();
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT status FROM downloads WHERE release_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .all()
    .map((row) => String(row['detail']))
    .join('\n');

  assert.match(plan, /USING INDEX downloads_release/);
  assert.doesNotMatch(plan, /SCAN downloads/);
  db.close();
});

// --- Version numbering -------------------------------------------------
//
// Two branches developed in parallel both claimed `version: 4`. Nothing caught
// it: `git merge` put its conflict markers *inside* migration 4's `up()` body,
// so it read as "pick one implementation" rather than "you have two migration
// 4s", and no test looked at the numbering at all.

test('the shipped migration list has no repeated version', () => {
  // The collision itself, as an assertion. Everything below tests the guard;
  // this tests the list the guard is pointed at.
  assert.doesNotThrow(() => assertUniqueVersions(migrations));
});

test('a repeated version is refused by name, before any statement runs', () => {
  const applied: number[] = [];
  const collide = [
    { version: 1, up: () => applied.push(1) },
    { version: 4, up: () => applied.push(4) },
    { version: 4, up: () => applied.push(44) },
  ];

  // Named, so the message says what to renumber. Left to SQLite this surfaces
  // as `UNIQUE constraint failed: schema_migrations.version`, which names a
  // table and not the mistake.
  assert.throws(() => assertUniqueVersions(collide), /Duplicate migration version 4/);
  // And nothing ran: `migrate` calls this before it touches the database, so a
  // half-applied schema is not among the outcomes.
  assert.deepEqual(applied, []);
});

test('migrate itself refuses a duplicate, and refuses it before SQLite would', () => {
  // The guard is only worth having if `migrate` runs it. Asserting
  // `assertUniqueVersions` in isolation leaves the *call* unpinned — deleting it
  // was a mutation nothing caught until this test existed.
  const db = new DatabaseSync(':memory:');
  const ran: number[] = [];
  const collide: Migration[] = [
    { version: 1, up: () => { ran.push(1); } },
    { version: 1, up: () => { ran.push(2); } },
  ];

  // Our message, not `UNIQUE constraint failed: schema_migrations.version`.
  // Reaching SQLite's version means the first migration has already run and
  // been recorded, so the failure arrives mid-schema and names a table rather
  // than the mistake.
  assert.throws(() => migrate(db, collide), /Duplicate migration version 1/);
  assert.deepEqual(ran, [], 'nothing may run before the list is validated');
  db.close();
});

test('a database carrying another branch’s migration 4 still gets ours', () => {
  // The case that made the collision dangerous rather than merely noisy, and
  // the one `databaseAtVersion` could not reach: a real deployment that has
  // already run *someone else's* 4. Numbered 4 ourselves, `migrate` reads the
  // version as applied and skips us in silence — no index, no error, and
  // `latestDownloadFailed` back to scanning the whole downloads table in
  // production. Numbered 5, we still run.
  const db = databaseAtVersion(3);
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, 1)').run();

  migrate(db);

  const index = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get('downloads_release');
  assert.ok(index !== undefined, 'our migration was skipped by a foreign version 4');
  // The foreign 4 is left alone — it is not ours to re-run or to remove.
  const versions = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => Number(row['version']));
  assert.ok(versions.includes(4));
  assert.ok(versions.includes(5));
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
