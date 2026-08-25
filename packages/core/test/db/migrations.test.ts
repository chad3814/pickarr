import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.ts';
import { migrations } from '../../src/db/migrations.ts';
import { getGroupMetadata } from '../../src/db/metadata.ts';

/**
 * A database as it stood right before migration 15: every earlier migration
 * run and recorded, nothing after it. Mirrors `databaseAtVersion` in
 * `migrate.test.ts` — built forwards through the real `up()` functions,
 * because an added column cannot be taken back off a fully migrated database
 * the way `migrate.test.ts`'s other helper drops a whole table.
 */
function openAtVersion(version: number): DatabaseSync {
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

function seedGroup(db: DatabaseSync, id: number): void {
  db.prepare(
    `INSERT INTO media_groups
       (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (?, 't', ?, '{}', '', 1, 1)`,
  ).run(id, `key-${id}`);
}

test('migration 15 files a background URL as a background', () => {
  const db = openAtVersion(14);
  seedGroup(db, 1);
  db.exec(`INSERT INTO group_metadata (group_id, state, source, poster_url, poster_path, fetched_at)
           VALUES (1, 'confirmed', 'theporndb',
                   'https://cdn.theporndb.net/scene/aa/bb/background/bg-x.jpg', '1.jpg', 1)`);
  migrate(db);
  const row = getGroupMetadata(db, 1);
  assert.equal(row?.posterUrl, null);
  assert.equal(row?.posterPath, null);
  assert.equal(row?.backgroundUrl, 'https://cdn.theporndb.net/scene/aa/bb/background/bg-x.jpg');
  // The file is not renamed; the column keeps pointing at it.
  assert.equal(row?.backgroundPath, '1.jpg');
});

test('migration 15 discards a synthesised crop under either name', () => {
  const db = openAtVersion(14);
  seedGroup(db, 2);
  db.exec(`INSERT INTO group_metadata (group_id, state, source, poster_url, poster_path, fetched_at)
           VALUES (2, 'confirmed', 'theporndb',
                   'https://thumb.theporndb.net/abc=/800x1200/smart/scene%2Fx.jpg', '2.jpg', 1)`);
  migrate(db);
  const row = getGroupMetadata(db, 2);
  assert.equal(row?.posterUrl, null);
  assert.equal(row?.posterPath, null);
  assert.equal(row?.backgroundUrl, null);
  assert.equal(row?.backgroundPath, null);
});

test('migration 15 leaves a real poster alone', () => {
  const db = openAtVersion(14);
  seedGroup(db, 3);
  db.exec(`INSERT INTO group_metadata (group_id, state, source, poster_url, poster_path, fetched_at)
           VALUES (3, 'confirmed', 'theporndb',
                   'https://cdn.theporndb.net/scene/aa/bb/poster/p.jpg', '3.jpg', 1)`);
  migrate(db);
  const row = getGroupMetadata(db, 3);
  assert.equal(row?.posterUrl, 'https://cdn.theporndb.net/scene/aa/bb/poster/p.jpg');
  assert.equal(row?.posterPath, '3.jpg');
  assert.equal(row?.backgroundUrl, null);
  assert.equal(row?.backgroundPath, null);
});

test('migration 15 files a background that also carries a crop marker as a background, not a discard', () => {
  // This pins the *order* of the two UPDATEs, not merely their outcome. Both
  // markers appear in this one URL, so the statements disagree about what to
  // do with it: the background move would file it, the crop discard would
  // null it out. The migration runs the move first for exactly this case, and
  // a reordering that swapped the two statements would still pass every other
  // test here — only this row would go from filed to discarded. Do not delete
  // this as a duplicate of the plain background case above; it is the only
  // test that would notice that swap.
  const db = openAtVersion(14);
  seedGroup(db, 4);
  db.exec(`INSERT INTO group_metadata (group_id, state, source, poster_url, poster_path, fetched_at)
           VALUES (4, 'confirmed', 'theporndb',
                   'https://cdn.theporndb.net/scene/aa/bb/background/abc=/800x1200/smart/bg-y.jpg',
                   '4.jpg', 1)`);
  migrate(db);
  const row = getGroupMetadata(db, 4);
  assert.equal(row?.posterUrl, null);
  assert.equal(row?.posterPath, null);
  assert.equal(
    row?.backgroundUrl,
    'https://cdn.theporndb.net/scene/aa/bb/background/abc=/800x1200/smart/bg-y.jpg',
  );
  assert.equal(row?.backgroundPath, '4.jpg');
});
