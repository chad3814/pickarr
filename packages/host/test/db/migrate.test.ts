import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Migration } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { HOST_MIGRATIONS, migrateHost, migrateHostWith, migratePlugin } from '../../src/db/migrate.ts';

/** The tables a database currently holds, narrowed the way this file narrows every row. */
function tableNames(raw: DatabaseSync): Set<string> {
  return new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
}

/**
 * Same rows as `tableNames`, but as an array: the atomicity test below filters
 * the result, and `Set` has no `.filter`. Kept local rather than exported
 * from `migrate.ts` — its private `tableNames` stays private.
 */
function tableNamesFor(raw: DatabaseSync): string[] {
  return raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map((r) => String((r as { name: unknown }).name));
}

/** The `(plugin_id, version)` pairs recorded as applied, or `[]` when the table is absent. */
function appliedVersions(raw: DatabaseSync): [string, number][] {
  if (!tableNames(raw).has('plugin_migrations')) return [];
  return raw.prepare('SELECT plugin_id, version FROM plugin_migrations ORDER BY plugin_id, version')
    .all().map((r) => {
      const row = r as { plugin_id: unknown; version: unknown };
      return [String(row.plugin_id), Number(row.version)];
    });
}

test('host migrations create the shared tables and are idempotent', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const names = tableNames(raw);
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

test('a plugin table not prefixed with the plugin id is refused, and the refusal survives a restart', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const offending: readonly Migration[] = [
    { version: 1, up: (db) => db.exec('CREATE TABLE not_prefixed (id INTEGER PRIMARY KEY)') },
  ];

  // Prefixing is what keeps two plugins from colliding on a table name, so it
  // is enforced rather than documented.
  assert.throws(() => migratePlugin(raw, 'delta', offending), /prefix/i);

  // The throw is not the whole of the enforcement. SQLite's DDL autocommits,
  // so a guard that only threw would leave the offending table behind and
  // leave the version unrecorded — and the *next* boot would then find the
  // table already there, see a migration that created nothing new, pass the
  // guard and record it as applied. Enforcement that lasts one process
  // lifetime is not enforcement.
  assert.equal(tableNames(raw).has('not_prefixed'), false, 'a refused migration must leave no table behind');
  assert.deepEqual(appliedVersions(raw), [], 'a refused migration must not be recorded as applied');

  assert.throws(
    () => migratePlugin(raw, 'delta', offending),
    /prefix/i,
    'the second attempt is the restart: the guard must refuse it too',
  );
  assert.equal(tableNames(raw).has('not_prefixed'), false);
  assert.deepEqual(appliedVersions(raw), []);
});

test('a plugin migration that throws part way leaves neither its tables nor its version behind', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  // The prefix guard is one reason a migration is refused; the plugin's own
  // `up` throwing is the other, and both have to leave the same nothing.
  assert.throws(() => migratePlugin(raw, 'eps', [{
    version: 1,
    up: (db) => {
      db.exec('CREATE TABLE eps_first (id INTEGER PRIMARY KEY)');
      throw new Error('the plugin changed its mind');
    },
  }]), /changed its mind/);

  assert.equal(tableNames(raw).has('eps_first'), false, 'the half-applied table must be rolled back');
  assert.deepEqual(appliedVersions(raw), []);
});

test('a host migration that throws leaves no trace of itself', () => {
  const raw = new DatabaseSync(':memory:');
  const boom: Migration[] = [
    { version: 1, up: (db) => db.exec('CREATE TABLE kept (id INTEGER PRIMARY KEY)') },
    { version: 2, up: (db) => {
      db.exec('CREATE TABLE half_done (id INTEGER PRIMARY KEY)');
      throw new Error('migration 2 failed');
    } },
  ];
  assert.throws(() => migrateHostWith(raw, boom), /migration 2 failed/);

  // Version 1 stands. Version 2 left neither its table nor its version row,
  // so the next boot re-runs it rather than skipping it as applied.
  assert.deepEqual(tableNamesFor(raw).filter((n) => n === 'kept' || n === 'half_done'), ['kept']);
  const versions = raw.prepare('SELECT version FROM host_migrations ORDER BY version').all();
  assert.deepEqual(versions.map((r) => Number((r as { version: unknown }).version)), [1]);

  // `ROLLBACK TO` undoes the savepoint's work but leaves it on the stack; a
  // throw that skips the matching `RELEASE` would leave the connection
  // inside a transaction nothing will ever close, and the next statement
  // that tries to open one (a fresh `BEGIN`, or another host migration on
  // the next boot) would fail. `isTransaction` is `node:sqlite`'s own name
  // for this, confirmed by probe: it is `false` before any `SAVEPOINT` and
  // stays `true` after a bare `ROLLBACK TO` with no `RELEASE`.
  assert.equal(raw.isTransaction, false);
});

test('a migration to version 2 backfills its new NOT NULL columns onto an existing rss_feed row', () => {
  const { raw } = openTestDatabase();
  // Stop after version 1, so `rss_feed` exists without `download_type` or
  // `poll_interval_s` yet — the shape a real database has the moment before
  // this migration runs, and the only shape on which `ADD COLUMN ... NOT
  // NULL` even needs a `DEFAULT` to be legal.
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version === 1));
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', 'Feed', 'https://example.com/feed', 1, 1)
  `).run();

  // Picks up only version 2: version 1 is already recorded as applied.
  migrateHost(raw);

  const row = raw.prepare('SELECT download_type, poll_interval_s FROM rss_feed').get() as {
    download_type: unknown;
    poll_interval_s: unknown;
  };
  assert.deepEqual(
    { download_type: String(row.download_type), poll_interval_s: Number(row.poll_interval_s) },
    { download_type: 'torrent', poll_interval_s: 900 },
  );
});

test('two pre-existing rss_item rows with no guid do not collide under the new unique index', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version === 1));
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', 'Feed', 'https://example.com/feed', 1, 1)
  `).run();
  // Two rows on the same feed, written before `guid` existed. If SQLite
  // treated NULLs as equal in a unique index, the second insert below would
  // have collided with the first the moment the index was created.
  for (const filename of ['a.mkv', 'b.mkv']) {
    raw.prepare(`
      INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
      VALUES (1, ?, 'https://example.com/' || ?, 1, 1, 'torrent', '1080p')
    `).run(filename, filename);
  }

  migrateHost(raw);

  const rows = raw.prepare('SELECT filename, guid FROM rss_item ORDER BY filename').all() as {
    filename: unknown;
    guid: unknown;
  }[];
  assert.deepEqual(
    rows.map((r) => ({ filename: String(r.filename), guid: r.guid })),
    [{ filename: 'a.mkv', guid: null }, { filename: 'b.mkv', guid: null }],
  );
});

test('a migration to version 3 adds started_at to a populated jobs table', () => {
  const { raw } = openTestDatabase();
  // Stop after version 2, so `jobs` exists without `started_at` yet -- the
  // shape a real database has the moment before this migration runs.
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 2));
  raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, max_attempts, run_at, state, created_at, updated_at)
    VALUES ('alpha', 'index', '{}', 3, 1, 'ready', 1, 1)
  `).run();

  // Picks up only version 3: versions 1 and 2 are already recorded as applied.
  migrateHost(raw);

  const row = raw.prepare('SELECT state, started_at FROM jobs').get() as {
    state: unknown;
    started_at: unknown;
  };
  assert.deepEqual(
    { state: String(row.state), started_at: row.started_at },
    { state: 'ready', started_at: null },
  );
});

test('a migration to version 4 adds delivered_at to a populated rss_item table, leaving existing rows undelivered', () => {
  const { raw } = openTestDatabase();
  // Stop after version 3, so `rss_item` exists without `delivered_at` yet --
  // the shape a real database has the moment before this migration runs.
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 3));
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', 'Feed', 'https://example.com/feed', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, guid, created_at, updated_at, download_type, resolution)
    VALUES (1, 'a.mkv', 'https://example.com/a', 'guid-a', 1, 1, 'torrent', '1080p')
  `).run();

  // Picks up only version 4: versions 1 through 3 are already recorded as applied.
  migrateHost(raw);

  const row = raw.prepare('SELECT filename, delivered_at FROM rss_item').get() as {
    filename: unknown;
    delivered_at: unknown;
  };
  // The row survives the migration -- proving this was tested against a
  // populated table, not an empty one -- and its new column is null rather
  // than backfilled to some "already delivered" value, which is exactly
  // what lets a pre-existing row be re-offered rather than treated as
  // already handled.
  assert.deepEqual(
    { filename: String(row.filename), delivered_at: row.delivered_at },
    { filename: 'a.mkv', delivered_at: null },
  );
});

test('migrating renames an existing feed from usenet to nzb', () => {
  const { raw } = openTestDatabase();
  // Stop after version 4, so `download_type` already exists and can hold the
  // pre-rename value -- the shape a real database has the moment before this
  // migration runs.
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 4));
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, download_type, created_at, updated_at)
    VALUES ('alpha', 'Feed', 'https://example.com/feed', 'usenet', 1, 1)
  `).run();

  // Picks up only version 5: versions 1 through 4 are already recorded as applied.
  migrateHost(raw);

  const row = raw.prepare('SELECT download_type FROM rss_feed').get() as { download_type: unknown };
  assert.equal(String(row.download_type), 'nzb');
});

/**
 * A download_client row plus the rss_feed/rss_item row a torrent_download
 * row must reference -- `open.ts` turns `PRAGMA foreign_keys` on, so both
 * are needed before any insert into torrent_download or nzb_download can
 * succeed. Every row after the client is id 1, which is all callers below need.
 */
function seedDownloadTarget(raw: DatabaseSync): void {
  raw.prepare(`
    INSERT INTO download_client (name, type, url, category, import_mode, created_at, updated_at)
    VALUES ('Client', 'torrent', 'https://example.com', 'movies', 'copy', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', 'Feed', 'https://example.com/feed', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (1, 'a.mkv', 'https://example.com/a', 1, 1, 'torrent', '1080p')
  `).run();
}

test('a migration to version 6 adds implementation to a populated download_client row', () => {
  const { raw } = openTestDatabase();
  // Stop after version 5, so download_client exists without
  // `implementation` yet -- the shape a real database has the moment before
  // this migration runs, and the only shape on which `ADD COLUMN ... NOT
  // NULL` even needs a `DEFAULT` to be legal.
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 5));
  raw.prepare(`
    INSERT INTO download_client (name, type, url, category, import_mode, created_at, updated_at)
    VALUES ('Client', 'torrent', 'https://example.com', 'movies', 'copy', 1, 1)
  `).run();

  // Picks up only version 6: versions 1 through 5 are already recorded as applied.
  migrateHost(raw);

  const row = raw.prepare('SELECT name, implementation FROM download_client').get() as {
    name: unknown;
    implementation: unknown;
  };
  // The row survives the migration -- proving this ran against a populated
  // table -- and the new column reads the default that makes `ADD COLUMN
  // ... NOT NULL` legal, not some value backfilled with real intent.
  assert.deepEqual(
    { name: String(row.name), implementation: String(row.implementation) },
    { name: 'Client', implementation: 'qbittorrent' },
  );
});

test('two unconfirmed downloads for one client coexist', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedDownloadTarget(raw);

  // Both rows have a null client_ref -- the shape a submission has the
  // moment after the request is made but before the client confirms it.
  // SQLite exempts NULL from a unique constraint whether or not it is
  // partial, so this insert pair would succeed even against a total index
  // -- it is the assertion below on the index's own recorded SQL, not this
  // one, that actually distinguishes a partial index from a total one.
  const insert = raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, status, created_at, updated_at)
    VALUES (1, 1, 'pending', 1, 1)
  `);
  insert.run();
  insert.run();

  const count = raw.prepare('SELECT COUNT(*) AS n FROM torrent_download').get() as { n: unknown };
  assert.equal(Number(count.n), 2);

  // The insert pair above cannot tell a partial index from a total one --
  // SQLite treats NULL as distinct in a unique index either way. This is
  // the check that actually pins the partial form down: it fails the
  // moment the `WHERE` clause is dropped from the DDL.
  const index = raw.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'torrent_download_client_ref'",
  ).get() as { sql: unknown };
  assert.match(String(index.sql), /WHERE client_ref IS NOT NULL/);
});

test('two downloads cannot claim the same client_ref', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedDownloadTarget(raw);

  const insert = raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, client_ref, status, created_at, updated_at)
    VALUES (1, 1, 'confirmed-1', 'pending', 1, 1)
  `);
  insert.run();

  assert.throws(
    () => insert.run(),
    (err: unknown) => {
      const code = (err as { code?: unknown }).code;
      // 2067 is SQLite's own SQLITE_CONSTRAINT_UNIQUE -- proof that the
      // unique index on (download_client_id, client_ref) fired, not merely
      // that some insert threw for some reason.
      const errcode = (err as { errcode?: unknown }).errcode;
      return code === 'ERR_SQLITE_ERROR' && errcode === 2067;
    },
  );
});
