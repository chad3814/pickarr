import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { assertUniqueVersions, migrate } from '../../src/db/migrate.ts';
import { migrations, type Migration } from '../../src/db/migrations.ts';
import { dueMetadataQueue, enqueueMetadata } from '../../src/db/metadata.ts';

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

// --- Migration 4: the site segment loses its separators ---------------------

interface SeedGroup {
  id: number;
  key: string;
  plugin?: string;
  state?: 'new' | 'picked';
  pickedReleaseId?: number;
  upgradeReleaseId?: number;
  createdAt?: number;
  listRankAt?: number;
  display?: string;
  searchText?: string;
}

/**
 * A group as migration 4 will find it. Ids are given rather than generated
 * because "the survivor is the lowest id" and "even when it is the higher id"
 * are properties under test, so which row gets which id is part of the fixture,
 * not an implementation detail.
 */
function addGroup(db: DatabaseSync, group: SeedGroup): void {
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
       picked_release_id, upgrade_release_id, created_at, list_rank_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    group.id,
    group.plugin ?? 'scenes',
    group.key,
    group.display ?? '{}',
    group.searchText ?? 'text',
    group.state ?? (group.pickedReleaseId === undefined ? 'new' : 'picked'),
    group.pickedReleaseId ?? null,
    group.upgradeReleaseId ?? null,
    group.createdAt ?? 100,
    group.listRankAt ?? group.createdAt ?? 100,
  );
}

/**
 * A release and the feed item it came from. `releases.feed_item_id` is NOT NULL
 * UNIQUE, so one cannot exist without the other; the ids are kept equal so a
 * test only has to name one number.
 */
function addRelease(
  db: DatabaseSync,
  release: { id: number; groupId: number; score: number },
): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, 'T', 'https://indexer.invalid/x.nzb', 1)`,
  ).run(release.id, `guid-${release.id}`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, ?, ?, '{}', ?, 1)`,
  ).run(release.id, release.groupId, release.id, release.score);
}

function addDownload(
  db: DatabaseSync,
  download: { id: number; releaseId: number; groupId: number },
): void {
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'sab', 'nzb', 'done', 1, 1)`,
  ).run(download.id, download.releaseId, download.groupId);
}

function addImportedFile(
  db: DatabaseSync,
  file: { id: number; downloadId: number; groupId: number; trashedAt?: number },
): void {
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path, size_bytes,
       trashed_at, trash_path, created_at)
     VALUES (?, ?, ?, ?, ?, 10, ?, ?, 1)`,
  ).run(
    file.id,
    file.downloadId,
    file.groupId,
    `/src/${file.id}`,
    `/lib/${file.id}`,
    file.trashedAt ?? null,
    file.trashedAt === undefined ? null : `/trash/${file.id}`,
  );
}

function keyOf(db: DatabaseSync, groupId: number): string | undefined {
  const row = db.prepare('SELECT identity_key FROM media_groups WHERE id = ?').get(groupId);
  return row === undefined ? undefined : String(row['identity_key']);
}

function groupIds(db: DatabaseSync): number[] {
  return db
    .prepare('SELECT id FROM media_groups ORDER BY id')
    .all()
    .map((row) => Number(row['id']));
}

function count(db: DatabaseSync, sql: string): number {
  return Number(db.prepare(sql).get()?.['n']);
}

/**
 * Nothing points at a group that is gone.
 *
 * Asserted with a query rather than by reasoning about the delete order,
 * because the whole hazard of this migration is a referencing row left behind.
 * `PRAGMA foreign_keys = ON` would make an orphaning delete throw rather than
 * succeed, but that only covers rows the *database* knows are references —
 * these joins say the same thing without depending on the pragma being on.
 */
function orphanCount(db: DatabaseSync): number {
  return count(
    db,
    `SELECT (SELECT COUNT(*) FROM releases r
               LEFT JOIN media_groups g ON g.id = r.group_id WHERE g.id IS NULL)
          + (SELECT COUNT(*) FROM downloads d
               LEFT JOIN media_groups g ON g.id = d.group_id WHERE g.id IS NULL)
          + (SELECT COUNT(*) FROM imported_files f
               LEFT JOIN media_groups g ON g.id = f.group_id WHERE g.id IS NULL) AS n`,
  );
}

test('a lone hyphenated group is re-keyed and keeps everything pointing at it', () => {
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'touch-my-wife:2025-02-07:anna-claire-clouds' });
  addRelease(db, { id: 1, groupId: 1, score: 2160 });
  addDownload(db, { id: 1, releaseId: 1, groupId: 1 });
  addImportedFile(db, { id: 1, downloadId: 1, groupId: 1 });

  migrate(db);

  // Only the site segment loses its separators. The scene slug's hyphens are
  // word boundaries in a title that is not mutable, and stripping them too
  // would collide scenes that are genuinely different.
  assert.equal(keyOf(db, 1), 'touchmywife:2025-02-07:anna-claire-clouds');
  assert.deepEqual(groupIds(db), [1]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 1'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM downloads WHERE group_id = 1'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM imported_files WHERE group_id = 1'), 1);
  // A re-keyed row is still a row nobody typed. `edited_at` is what a future
  // re-parse pass reads as "leave this alone", and stamping it here would
  // immunise every group this migration touches against that pass.
  const group = db
    .prepare('SELECT created_at, list_rank_at, edited_at FROM media_groups WHERE id = 1')
    .get();
  assert.equal(group?.['edited_at'], null);
  assert.equal(group?.['created_at'], 100);
  assert.equal(group?.['list_rank_at'], 100);
  db.close();
});

test('the reported split collapses back into one group holding every release', () => {
  // The bug as filed: the 2160p arrived before ThePornDB confirmed the site and
  // keyed run-together, the 1080p and 720p arrived after and keyed hyphenated.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'touchmywife:2025-02-07:anna-claire-clouds' });
  addGroup(db, { id: 2, key: 'touch-my-wife:2025-02-07:anna-claire-clouds' });
  addRelease(db, { id: 1, groupId: 1, score: 2160 });
  addRelease(db, { id: 2, groupId: 2, score: 1080 });
  addRelease(db, { id: 3, groupId: 2, score: 720 });

  migrate(db);

  assert.deepEqual(groupIds(db), [1]);
  assert.equal(keyOf(db, 1), 'touchmywife:2025-02-07:anna-claire-clouds');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 1'), 3);
  assert.equal(orphanCount(db), 0);
  db.close();
});

test('the group with imported files survives even when it is the higher id', () => {
  // Its name is on files that exist on disk; the other group's is on nothing.
  const db = databaseAtVersion(3);
  addGroup(db, {
    id: 1,
    key: 'the-life-erotic:2024-01-01:s',
    display: '{"title":"S","subtitle":"The-Life-Erotic"}',
    searchText: 'loser',
  });
  addGroup(db, {
    id: 2,
    key: 'thelifeerotic:2024-01-01:s',
    display: '{"title":"S","subtitle":"The Life Erotic"}',
    searchText: 'survivor',
  });
  addRelease(db, { id: 1, groupId: 1, score: 1080 });
  addRelease(db, { id: 2, groupId: 2, score: 720 });
  // Group 1 has a download too, so both the "prefer downloads" rule and the
  // "lowest id" rule would name group 1. Only the imported file names group 2.
  addDownload(db, { id: 1, releaseId: 1, groupId: 1 });
  addDownload(db, { id: 2, releaseId: 2, groupId: 2 });
  addImportedFile(db, { id: 1, downloadId: 2, groupId: 2 });

  migrate(db);

  assert.deepEqual(groupIds(db), [2]);
  assert.equal(keyOf(db, 2), 'thelifeerotic:2024-01-01:s');
  // The survivor keeps its own display and search text, the same rule the
  // manual merge follows: the losing key was never the user's way of naming
  // this scene, it was an accident of when the site was learned.
  //
  // `display` is pinned as hard as the key. Since Task 1, `path-template.ts`
  // renders `{site}`, `{Site}` and `{SiteName}` from `display.subtitle`, so
  // taking the loser's would relocate every file this group imports from here
  // on — `The-Life-Erotic/` instead of `The Life Erotic/`.
  const group = db.prepare('SELECT display, search_text FROM media_groups WHERE id = 2').get();
  assert.equal(group?.['display'], '{"title":"S","subtitle":"The Life Erotic"}');
  assert.equal(group?.['search_text'], 'survivor');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 2'), 2);
  db.close();
});

test('a merge leaves created_at, list_rank_at and edited_at alone', () => {
  // Three documented decisions, none of which any other assertion reaches.
  // `created_at` because the survivor was created when it was created;
  // `list_rank_at` because only a release *arriving* lifts a group up the
  // browse list, and an upgrade that re-sorted the list would look like a feed
  // full of new scenes; `edited_at` because it means "these values were typed",
  // which a future re-parse pass reads as "do not overwrite".
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'sexy-hub:2024-01-01:s', createdAt: 100, listRankAt: 150 });
  addGroup(db, { id: 2, key: 'sexyhub:2024-01-01:s', createdAt: 900, listRankAt: 950 });
  addRelease(db, { id: 1, groupId: 1, score: 720 });
  addRelease(db, { id: 2, groupId: 2, score: 2160 });

  migrate(db);

  assert.deepEqual(groupIds(db), [1]);
  const group = db
    .prepare('SELECT created_at, list_rank_at, edited_at FROM media_groups WHERE id = 1')
    .get();
  assert.equal(group?.['created_at'], 100);
  assert.equal(group?.['list_rank_at'], 150);
  assert.equal(group?.['edited_at'], null);
  db.close();
});

test('a trashed imported file does not outrank a live download', () => {
  // The rule's justification is "its name is on files that exist on disk", and
  // a trashed file is not one. Every read in `db/imported-files.ts` and the
  // `imported_files_live` index draw the line in the same place.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 2, key: 'sexyhub:2024-01-01:s' });
  addGroup(db, { id: 5, key: 'sexy-hub:2024-01-01:s' });
  addRelease(db, { id: 1, groupId: 2, score: 1080 });
  addRelease(db, { id: 2, groupId: 5, score: 720 });
  addDownload(db, { id: 1, releaseId: 1, groupId: 2 });
  // Group 5 downloaded and imported, then the file was trashed. Counting that
  // as a live import would hand it the merge over a group with a real download.
  addDownload(db, { id: 2, releaseId: 2, groupId: 5 });
  addImportedFile(db, { id: 1, downloadId: 2, groupId: 5, trashedAt: 500 });

  migrate(db);

  assert.deepEqual(groupIds(db), [2]);
  // The trashed row still moves. Trashing recorded where the file went; that is
  // history, and history is exactly what a merge must not drop.
  const file = db.prepare('SELECT group_id, trashed_at FROM imported_files WHERE id = 1').get();
  assert.equal(file?.['group_id'], 2);
  assert.equal(file?.['trashed_at'], 500);
  assert.equal(orphanCount(db), 0);
  db.close();
});

test('the group with a download survives when neither has imported files', () => {
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'viv-thomas:2024-01-01:s' });
  addGroup(db, { id: 2, key: 'vivthomas:2024-01-01:s' });
  addRelease(db, { id: 1, groupId: 1, score: 1080 });
  addRelease(db, { id: 2, groupId: 2, score: 720 });
  addDownload(db, { id: 1, releaseId: 2, groupId: 2 });

  migrate(db);

  assert.deepEqual(groupIds(db), [2]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 2'), 2);
  db.close();
});

test('the oldest group survives when neither has a download or an imported file', () => {
  const db = databaseAtVersion(3);
  addGroup(db, { id: 3, key: 'viv-thomas:2024-01-01:s' });
  addGroup(db, { id: 7, key: 'vivthomas:2024-01-01:s' });
  addRelease(db, { id: 1, groupId: 3, score: 1080 });
  addRelease(db, { id: 2, groupId: 7, score: 720 });

  migrate(db);

  assert.deepEqual(groupIds(db), [3]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 3'), 2);
  db.close();
});

test("a loser's downloads and imported files are repointed, not orphaned or dropped", () => {
  // The failure this guards against is the one that cannot be undone: a merge
  // that loses the record of a file already in the user's library.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'bang-bros:2024-01-01:s' });
  addGroup(db, { id: 2, key: 'bangbros:2024-01-01:s' });
  addRelease(db, { id: 1, groupId: 1, score: 1080 });
  addRelease(db, { id: 2, groupId: 2, score: 2160 });
  // Both sides have history, so whichever survives, the other's rows must move.
  addDownload(db, { id: 1, releaseId: 1, groupId: 1 });
  addImportedFile(db, { id: 1, downloadId: 1, groupId: 1 });
  addDownload(db, { id: 2, releaseId: 2, groupId: 2 });
  addImportedFile(db, { id: 2, downloadId: 2, groupId: 2 });

  migrate(db);

  const survivors = groupIds(db);
  assert.deepEqual(survivors, [1], 'lowest id wins the tie when both have imported files');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM downloads'), 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM imported_files'), 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM downloads WHERE group_id = 1'), 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM imported_files WHERE group_id = 1'), 2);
  assert.equal(orphanCount(db), 0);
  db.close();
});

test("a survivor with no pick adopts the loser's, and is picked afterwards", () => {
  // Dropping the pick would tell the user they no longer own a file they do:
  // the release is still here, it merely changed groups.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'brazzers-network:2024-01-01:s' });
  addGroup(db, { id: 2, key: 'brazzersnetwork:2024-01-01:s', pickedReleaseId: 2 });
  addRelease(db, { id: 1, groupId: 1, score: 720 });
  addRelease(db, { id: 2, groupId: 2, score: 1080 });

  migrate(db);

  assert.deepEqual(groupIds(db), [1]);
  const group = db
    .prepare('SELECT state, picked_release_id, upgrade_release_id FROM media_groups WHERE id = 1')
    .get();
  assert.equal(group?.['picked_release_id'], 2);
  // `state` travels with the pick. A row with a pick and state 'new' is off
  // the Picks page and still in Browse — the pick would be adopted in name
  // only, which is the same loss this branch exists to prevent.
  assert.equal(group?.['state'], 'picked');
  // Nothing in the merged set beats the pick, so no upgrade is flagged.
  assert.equal(group?.['upgrade_release_id'], null);
  db.close();
});

test('a dangling pick is not adopted onto an unpicked survivor', () => {
  // `picked_release_id` has no foreign key, so a hand-edited database can hold
  // one that names nothing. Adopting it would take a working group out of
  // Browse (`state = 'picked'`) and point the Picks page at a release that does
  // not exist — the migration turning someone else's broken row into two.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'brazzers-network:2024-01-01:s' });
  addGroup(db, { id: 2, key: 'brazzersnetwork:2024-01-01:s', pickedReleaseId: 999 });
  addRelease(db, { id: 1, groupId: 1, score: 720 });
  addRelease(db, { id: 2, groupId: 2, score: 1080 });

  migrate(db);

  assert.deepEqual(groupIds(db), [1]);
  const group = db
    .prepare('SELECT state, picked_release_id FROM media_groups WHERE id = 1')
    .get();
  assert.equal(group?.['picked_release_id'], null);
  assert.equal(group?.['state'], 'new');
  db.close();
});

test("a survivor's dangling pick does not outrank a loser's real one", () => {
  // "Keep the survivor's pick" is a rule about a pick, and a pointer to a
  // release that no longer exists is not one. Preferring it would discard the
  // only real pick in the cluster.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'brazzers-network:2024-01-01:s', pickedReleaseId: 999 });
  addGroup(db, { id: 2, key: 'brazzersnetwork:2024-01-01:s', pickedReleaseId: 2 });
  addRelease(db, { id: 1, groupId: 1, score: 720 });
  addRelease(db, { id: 2, groupId: 2, score: 1080 });

  migrate(db);

  assert.deepEqual(groupIds(db), [1]);
  const group = db
    .prepare('SELECT state, picked_release_id FROM media_groups WHERE id = 1')
    .get();
  assert.equal(group?.['picked_release_id'], 2);
  assert.equal(group?.['state'], 'picked');
  db.close();
});

test('the upgrade flag after a merge names the best release in the combined set', () => {
  // Carrying the old flag across would be wrong twice over: it was derived
  // against a smaller set of releases, and the survivor's pick may not be the
  // one it was derived against.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'evil-angel:2024-01-01:s', pickedReleaseId: 1 });
  addGroup(db, { id: 2, key: 'evilangel:2024-01-01:s' });
  addRelease(db, { id: 1, groupId: 1, score: 720 });
  addRelease(db, { id: 2, groupId: 2, score: 2160 });
  addRelease(db, { id: 3, groupId: 2, score: 1080 });

  migrate(db);

  const group = db
    .prepare('SELECT picked_release_id, upgrade_release_id FROM media_groups WHERE id = 1')
    .get();
  assert.equal(group?.['picked_release_id'], 1);
  assert.equal(group?.['upgrade_release_id'], 2, 'the 2160p, not the 1080p, and not nothing');
  db.close();
});

test('a stale upgrade flag is cleared when the merged set holds nothing better', () => {
  // The survivor's flag named a release that no longer beats its pick once the
  // whole set is considered; a merge that only ever set the flag would leave
  // the group advertising an upgrade to a release the user already has.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'evil-angel:2024-01-01:s', pickedReleaseId: 1, upgradeReleaseId: 2 });
  addGroup(db, { id: 2, key: 'evilangel:2024-01-01:s' });
  addRelease(db, { id: 1, groupId: 1, score: 2160 });
  addRelease(db, { id: 2, groupId: 1, score: 1080 });
  addRelease(db, { id: 3, groupId: 2, score: 720 });

  migrate(db);

  assert.equal(
    db.prepare('SELECT upgrade_release_id FROM media_groups WHERE id = 1').get()?.[
      'upgrade_release_id'
    ],
    null,
  );
  db.close();
});

test("two picks keep the survivor's, and the discard is said out loud", () => {
  // The one case where the migration discards information. The release it
  // discards must still be in the group, and the discard must be reported: the
  // warning is the only record that a pick the user made was dropped, so an
  // untested one is a mitigation that can be deleted without anything noticing.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'sexy-hub:2024-01-01:s', pickedReleaseId: 1 });
  addGroup(db, { id: 2, key: 'sexyhub:2024-01-01:s', pickedReleaseId: 2 });
  addRelease(db, { id: 1, groupId: 1, score: 1080 });
  addRelease(db, { id: 2, groupId: 2, score: 720 });

  const warnMock = mock.method(console, 'warn', () => {});
  try {
    migrate(db);

    const group = db.prepare('SELECT picked_release_id FROM media_groups WHERE id = 1').get();
    assert.equal(group?.['picked_release_id'], 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 1 AND id = 2'), 1);

    assert.equal(warnMock.mock.callCount(), 1);
    const message = String(warnMock.mock.calls[0]?.arguments[0] ?? '');
    // Both groups and both releases, because "a pick was dropped" without
    // naming which one sends the reader to look through every merged group.
    assert.match(message, /group 2 into group 1/);
    assert.match(message, /release 2 is no longer picked/);
    assert.match(message, /release 1 stands/);
    assert.match(message, /sexyhub:2024-01-01:s/);
  } finally {
    warnMock.mock.restore();
  }
  db.close();
});

test('a merge with one pick says nothing', () => {
  // The warning marks a loss. A merge that lost nothing must not print one, or
  // the line stops meaning anything on a database with hundreds of merges.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'sexy-hub:2024-01-01:s', pickedReleaseId: 1 });
  addGroup(db, { id: 2, key: 'sexyhub:2024-01-01:s' });
  addRelease(db, { id: 1, groupId: 1, score: 1080 });
  addRelease(db, { id: 2, groupId: 2, score: 720 });

  const warnMock = mock.method(console, 'warn', () => {});
  try {
    migrate(db);
    assert.equal(warnMock.mock.callCount(), 0);
  } finally {
    warnMock.mock.restore();
  }
  db.close();
});

test('a group whose site segment has no separators is left exactly as it was', () => {
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'bangbros:2024-01-01:a-scene-title', createdAt: 555 });

  migrate(db);

  const group = db
    .prepare(
      'SELECT identity_key, created_at, list_rank_at, edited_at FROM media_groups WHERE id = 1',
    )
    .get();
  assert.equal(group?.['identity_key'], 'bangbros:2024-01-01:a-scene-title');
  assert.equal(group?.['created_at'], 555);
  assert.equal(group?.['list_rank_at'], 555);
  // A migration is not a human editing the group.
  assert.equal(group?.['edited_at'], null);
  db.close();
});

test('three groups collapsing onto one key all merge', () => {
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'touch-my-wife:2025-02-07:s' });
  addGroup(db, { id: 2, key: 'touchmywife:2025-02-07:s' });
  addGroup(db, { id: 3, key: 'touch-mywife:2025-02-07:s' });
  addRelease(db, { id: 1, groupId: 1, score: 720 });
  addRelease(db, { id: 2, groupId: 2, score: 1080 });
  addRelease(db, { id: 3, groupId: 3, score: 2160 });

  migrate(db);

  assert.deepEqual(groupIds(db), [1]);
  assert.equal(keyOf(db, 1), 'touchmywife:2025-02-07:s');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 1'), 3);
  assert.equal(orphanCount(db), 0);
  db.close();
});

test('groups that differ outside the site segment are not merged', () => {
  // The re-key must not become a general key normaliser: two scenes of one site
  // on one day are two scenes, and merging them would lose one of them.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'touch-my-wife:2025-02-07:scene-one' });
  addGroup(db, { id: 2, key: 'touch-my-wife:2025-02-07:scene-two' });

  migrate(db);

  assert.deepEqual(groupIds(db), [1, 2]);
  assert.equal(keyOf(db, 1), 'touchmywife:2025-02-07:scene-one');
  assert.equal(keyOf(db, 2), 'touchmywife:2025-02-07:scene-two');
  db.close();
});

test('a group belonging to another plugin is not re-keyed', () => {
  // Scope. Migration 4 exists because the scenes plugin's key rule changed;
  // another plugin's first segment means whatever that plugin says it means,
  // and stripping its separators would move an identity nothing asked to move.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'some-show:s01e01', plugin: 'series' });

  migrate(db);

  assert.equal(keyOf(db, 1), 'some-show:s01e01');
  db.close();
});

test('a key collision across plugins is not a collision, and does not merge', () => {
  // Correctness, and a different property from the test above. `UNIQUE` is
  // `(plugin, identity_key)`, so these two rows can coexist and are not the
  // same group — clustering on the new key alone would delete the series group
  // into the scenes group and take its release with it. The scope filter hides
  // this today; the cluster identity is what actually decides it.
  const db = databaseAtVersion(3);
  addGroup(db, { id: 1, key: 'bang-bros:2024-01-01:s', plugin: 'scenes' });
  addGroup(db, { id: 2, key: 'bangbros:2024-01-01:s', plugin: 'series' });
  addRelease(db, { id: 1, groupId: 1, score: 1080 });
  addRelease(db, { id: 2, groupId: 2, score: 720 });

  migrate(db);

  assert.deepEqual(groupIds(db), [1, 2]);
  assert.equal(keyOf(db, 1), 'bangbros:2024-01-01:s');
  assert.equal(keyOf(db, 2), 'bangbros:2024-01-01:s');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 1'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM releases WHERE group_id = 2'), 1);
  assert.equal(orphanCount(db), 0);
  db.close();
});

test('a survivor with no subtitle still wins on files, and its key is the path fallback', () => {
  // The survivor rule does not consult `display`, though `path-template.ts`
  // renders `{site}`, `{Site}` and `{SiteName}` from `display.subtitle` since
  // Task 1. Deliberately: `buildRelease` always sets a subtitle, so a group
  // without one takes a hand-edited database, and even then the template falls
  // back to the key's site segment — which this migration has just corrected to
  // the run-together form. The cost is a cosmetic path, and trading a group
  // that has files on disk for one that spells its site more prettily would
  // move files that are already placed.
  const db = databaseAtVersion(3);
  addGroup(db, {
    id: 1,
    key: 'touch-my-wife:2025-02-07:s',
    display: '{"title":"S","subtitle":"Touch My Wife"}',
  });
  addGroup(db, { id: 2, key: 'touchmywife:2025-02-07:s', display: '{"title":"S"}' });
  addRelease(db, { id: 1, groupId: 1, score: 1080 });
  addRelease(db, { id: 2, groupId: 2, score: 720 });
  addDownload(db, { id: 1, releaseId: 2, groupId: 2 });
  addImportedFile(db, { id: 1, downloadId: 1, groupId: 2 });

  migrate(db);

  assert.deepEqual(groupIds(db), [2], 'files on disk decide it, not the nicer subtitle');
  const group = db.prepare('SELECT display, identity_key FROM media_groups WHERE id = 2').get();
  assert.equal(group?.['display'], '{"title":"S"}');
  // What `path-template.ts` falls back to when there is no subtitle, and it is
  // now the correct run-together spelling rather than a hyphenated one.
  assert.equal(group?.['identity_key'], 'touchmywife:2025-02-07:s');
  db.close();
});

// --- Migration 5: the metadata tables and the site's integer id -------------

test('migration 6 creates the metadata tables and the site id column', () => {
  const db = openTestDatabase();

  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row['name'])),
  );
  assert.ok(tables.has('group_metadata'));
  assert.ok(tables.has('metadata_queue'));
  assert.ok(tables.has('metadata_candidates'));

  const columns = db
    .prepare('PRAGMA table_info(discovered_sites)')
    .all()
    .map((row) => String(row['name']));
  assert.ok(columns.includes('source_id'));
  db.close();
});

test('migration 6 is idempotent across a second run', () => {
  // `openTestDatabase` already migrates, so this is the second run.
  const db = openTestDatabase();
  migrate(db);
  const applied = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => Number(row['version']));
  assert.deepEqual(applied, [1, 2, 3, 4, 5, 6, 7, 8]);
  db.close();
});

// --- Migration 7: performer identities and the refetch backfill -------------

test('migration 7 re-queues confirmed groups so they refetch with performers', () => {
  const db = databaseAtVersion(6);
  db.prepare(`INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
              VALUES (1,'t','a','{}','a',1,1), (2,'t','b','{}','b',1,1), (3,'t','c','{}','c',1,1)`).run();
  db.prepare(`INSERT INTO group_metadata (group_id, state, source, fetched_at)
              VALUES (1,'confirmed','theporndb',1), (2,'none','theporndb',1)`).run();

  migrations.find((m) => m.version === 7)!.up(db);

  // Confirmed only. A 'none' answer has nothing to enrich — re-asking it is
  // the loop `enqueueMetadata`'s guard exists to prevent — and group 3 was
  // never asked, so it queues on its own when someone browses to it.
  const queued = db.prepare('SELECT group_id FROM metadata_queue ORDER BY group_id').all();
  assert.deepEqual(queued.map((r) => (r as { group_id: number }).group_id), [1]);
});

test('a backfilled row is due at once but yields to anything requested after the upgrade', () => {
  // `dueMetadataQueue` filters on `next_at` and orders by `requested_at`, and
  // the backfill uses the two columns against each other on purpose. Stamping
  // `requested_at` from `fetched_at` — the group's own answer time, the
  // obvious choice — puts every backfill row ahead of every request made
  // after the upgrade, so at the worker's ~1 group/s a few thousand groups
  // means hours in which a freshly ingested group the user is looking at sits
  // at `pending` behind the whole backlog.
  const db = databaseAtVersion(6);
  db.prepare(`INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
              VALUES (1,'t','a','{}','a',1,1), (2,'t','b','{}','b',1,1)`).run();
  db.prepare(`INSERT INTO group_metadata (group_id, state, source, fetched_at)
              VALUES (1,'confirmed','theporndb',1000)`).run();

  migrations.find((m) => m.version === 7)!.up(db);

  // Group 2 is browsed after the upgrade, at a real clock reading.
  const now = 1_760_000_000_000;
  enqueueMetadata(db, [2], now);

  assert.deepEqual(
    dueMetadataQueue(db, now, 10).map((r) => r.groupId),
    [2, 1],
    'the newly browsed group goes first, and the backfilled one is still due behind it',
  );
});

test('migration 7 adds the performer tables and the scene slug', () => {
  const db = databaseAtVersion(7);
  // Literal column lists, not a shape read back out of the schema: an
  // assertion derived from the thing under test cannot detect it changing.
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)');
  assert.deepEqual(
    columns.all('performers').map((r) => (r as { name: string }).name),
    ['id', 'source', 'source_uuid', 'slug', 'name', 'kind', 'face_url', 'face_path', 'image_url', 'image_path', 'fetched_at'],
  );
  assert.deepEqual(
    columns.all('group_performers').map((r) => (r as { name: string }).name),
    ['group_id', 'performer_id', 'position'],
  );
  assert.ok(
    columns.all('group_metadata').some((r) => (r as { name: string }).name === 'scene_slug'),
  );
});

test('two performers cannot share one source uuid', () => {
  const db = databaseAtVersion(7);
  const insert = db.prepare(
    `INSERT INTO performers (source, source_uuid, slug, name, kind, fetched_at)
     VALUES ('theporndb', 'u', ?, 'N', 'performer', 1)`,
  );
  insert.run('a');
  assert.throws(() => insert.run('b'), /UNIQUE/);
});

// --- Migration 8: absence becomes a timestamp, not a poll count ------------

test('migration 8 adds absent_since, NULL for rows that already existed', () => {
  const db = databaseAtVersion(7);
  addGroup(db, { id: 1, key: 'a' });
  addRelease(db, { id: 1, groupId: 1, score: 100 });
  addDownload(db, { id: 1, releaseId: 1, groupId: 1 });

  migrations.find((m) => m.version === 8)!.up(db);

  const columns = db
    .prepare('PRAGMA table_info(downloads)')
    .all()
    .map((row) => String(row['name']));
  assert.ok(columns.includes('absent_since'));

  const row = db.prepare('SELECT absent_since FROM downloads WHERE id = 1').get();
  assert.equal(row?.['absent_since'], null, 'a row that predates the column has nothing to backfill it with');
});
