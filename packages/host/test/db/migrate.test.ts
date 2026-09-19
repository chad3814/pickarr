import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Migration } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { HOST_MIGRATIONS, migrateHost, migrateHostWith, migratePlugin } from '../../src/db/migrate.ts';
import { SYNC_QUERIES, deletionsSince } from '../../src/api/reads.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import { readClientConfig } from '../../src/clients/config.ts';

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

  // Both rows have a null client_ref -- the shape a submission has the moment
  // after the request is made but before the client confirms it. Two of them
  // must be able to sit in the table at once, or a submission that died
  // waiting for an answer would block its own retry.
  //
  // This holds because SQLite exempts NULL from a unique constraint, NOT
  // because the index is partial, so this test passes against a total index
  // too. That is not a weakness: the coexistence is the property the write
  // path depends on, and it is worth pinning on its own terms. The `WHERE`
  // clause gets its own test below.
  const insert = raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, status, created_at, updated_at)
    VALUES (1, 1, 'pending', 1, 1)
  `);
  insert.run();
  insert.run();

  const count = raw.prepare('SELECT COUNT(*) AS n FROM torrent_download').get() as { n: unknown };
  assert.equal(Number(count.n), 2);
});

test('the client_ref index is partial on both download tables', () => {
  // A drift guard, and named as one. Dropping `WHERE client_ref IS NOT NULL`
  // changes no insert's outcome -- NULLs are distinct in a unique index either
  // way -- so nothing behavioural can pin the clause down, and a test that
  // claimed to would be measuring nothing. Reading it back from
  // `sqlite_master` is honest about what it checks: that a deliberate intent
  // marker, and the index-size saving that comes with it, are still there.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  for (const name of ['torrent_download_client_ref', 'nzb_download_client_ref']) {
    const index = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(name) as { sql: unknown } | undefined;
    assert.ok(index, `expected an index named ${name}`);
    assert.match(String(index.sql), /WHERE client_ref IS NOT NULL/, `${name} should be partial`);
  }
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

test('a migration to version 7 adds the reconcile columns to both download tables', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedDownloadTarget(raw);

  raw.prepare(`
    INSERT INTO torrent_download
      (rss_item_id, download_client_id, status, storage_path, percentage, absent_since, delivered_at, created_at, updated_at)
    VALUES (1, 1, 'pending', '/downloads/movie.mkv', 42, 100, 200, 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO nzb_download
      (rss_item_id, download_client_id, status, storage_path, percentage, absent_since, delivered_at, created_at, updated_at)
    VALUES (1, 1, 'pending', '/downloads/other.mkv', 84, 300, 400, 1, 1)
  `).run();

  const torrentRow = raw.prepare(
    'SELECT storage_path, percentage, absent_since, delivered_at FROM torrent_download',
  ).get() as { storage_path: unknown; percentage: unknown; absent_since: unknown; delivered_at: unknown };
  assert.deepEqual(
    {
      storage_path: String(torrentRow.storage_path),
      percentage: Number(torrentRow.percentage),
      absent_since: Number(torrentRow.absent_since),
      delivered_at: Number(torrentRow.delivered_at),
    },
    { storage_path: '/downloads/movie.mkv', percentage: 42, absent_since: 100, delivered_at: 200 },
  );

  const nzbRow = raw.prepare(
    'SELECT storage_path, percentage, absent_since, delivered_at FROM nzb_download',
  ).get() as { storage_path: unknown; percentage: unknown; absent_since: unknown; delivered_at: unknown };
  assert.deepEqual(
    {
      storage_path: String(nzbRow.storage_path),
      percentage: Number(nzbRow.percentage),
      absent_since: Number(nzbRow.absent_since),
      delivered_at: Number(nzbRow.delivered_at),
    },
    { storage_path: '/downloads/other.mkv', percentage: 84, absent_since: 300, delivered_at: 400 },
  );
});

test('the new columns are nullable, so an existing row needs no back-filled guess', () => {
  const { raw } = openTestDatabase();
  // Stop after version 6, so torrent_download and nzb_download exist without
  // any of the four reconcile columns yet -- the shape a real database has
  // the moment before this migration runs.
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 6));
  seedDownloadTarget(raw);
  raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, status, created_at, updated_at)
    VALUES (1, 1, 'pending', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO nzb_download (rss_item_id, download_client_id, status, created_at, updated_at)
    VALUES (1, 1, 'pending', 1, 1)
  `).run();

  // Picks up only version 7: versions 1 through 6 are already recorded as applied.
  migrateHost(raw);

  const torrentRow = raw.prepare(
    'SELECT storage_path, percentage, absent_since, delivered_at FROM torrent_download',
  ).get() as { storage_path: unknown; percentage: unknown; absent_since: unknown; delivered_at: unknown };
  assert.deepEqual(
    { storagePath: torrentRow.storage_path, percentage: torrentRow.percentage, absentSince: torrentRow.absent_since, deliveredAt: torrentRow.delivered_at },
    { storagePath: null, percentage: null, absentSince: null, deliveredAt: null },
  );

  const nzbRow = raw.prepare(
    'SELECT storage_path, percentage, absent_since, delivered_at FROM nzb_download',
  ).get() as { storage_path: unknown; percentage: unknown; absent_since: unknown; delivered_at: unknown };
  assert.deepEqual(
    { storagePath: nzbRow.storage_path, percentage: nzbRow.percentage, absentSince: nzbRow.absent_since, deliveredAt: nzbRow.delivered_at },
    { storagePath: null, percentage: null, absentSince: null, deliveredAt: null },
  );
});

test('a migration to version 8 adds reclaimed_at to both download tables', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedDownloadTarget(raw);

  raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, status, reclaimed_at, created_at, updated_at)
    VALUES (1, 1, 'delivered', 200, 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO nzb_download (rss_item_id, download_client_id, status, reclaimed_at, created_at, updated_at)
    VALUES (1, 1, 'delivered', 400, 1, 1)
  `).run();

  const torrentRow = raw.prepare('SELECT reclaimed_at FROM torrent_download').get() as { reclaimed_at: unknown };
  assert.equal(Number(torrentRow.reclaimed_at), 200);

  const nzbRow = raw.prepare('SELECT reclaimed_at FROM nzb_download').get() as { reclaimed_at: unknown };
  assert.equal(Number(nzbRow.reclaimed_at), 400);
});

test('reclaimed_at is nullable, so a row that predates it needs no back-filled guess', () => {
  const { raw } = openTestDatabase();
  // Stop after version 7, so torrent_download and nzb_download exist without
  // reclaimed_at yet -- the shape a real database has the moment before this
  // migration runs.
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 7));
  seedDownloadTarget(raw);
  raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, status, created_at, updated_at)
    VALUES (1, 1, 'delivered', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO nzb_download (rss_item_id, download_client_id, status, created_at, updated_at)
    VALUES (1, 1, 'delivered', 1, 1)
  `).run();

  // Picks up only version 8: versions 1 through 7 are already recorded as applied.
  migrateHost(raw);

  const torrentRow = raw.prepare('SELECT reclaimed_at FROM torrent_download').get() as { reclaimed_at: unknown };
  assert.equal(torrentRow.reclaimed_at, null);

  const nzbRow = raw.prepare('SELECT reclaimed_at FROM nzb_download').get() as { reclaimed_at: unknown };
  assert.equal(nzbRow.reclaimed_at, null);
});

test('a migration to version 9 adds the tombstone table and the sync indexes', () => {
  const { raw } = openTestDatabase();
  // A prefix ending at 9, not the whole list: migration 11 drops
  // `deleted_media_item_at` and replaces it, so this is the only way to watch
  // migration 9 create what migration 9 creates. Run to head it would assert
  // an index a current database deliberately does not have.
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 9));

  assert.ok(tableNames(raw).has('deleted_media_item'), 'missing deleted_media_item');

  for (const [indexName, table] of [
    ['deleted_media_item_at', 'deleted_media_item'],
    ['media_item_sync', 'media_item'],
  ] as const) {
    const index = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(indexName) as { sql: unknown } | undefined;
    assert.ok(index, `expected an index named ${indexName} on ${table}`);
  }
});

test('no second (updated_at, id) index is created on rss_item', () => {
  // `rss_item_updated` has indexed exactly those columns in that order since
  // migration 1. A second identical index would never be chosen by SQLite and
  // would be maintained on every rss_item write for nothing -- a feed poll
  // writes one row per item, reconcile writes one per delivery. Migration 9's
  // first draft created one; this is what stops it coming back.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const rows = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rss_item'",
  ).all().map((row) => String((row as { name: unknown }).name));

  const onUpdatedAtAndId = rows.filter((name) => {
    const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
    const text = String((sql as { sql: unknown } | undefined)?.sql ?? '');
    return /\(\s*updated_at\s*,\s*id\s*\)/.test(text);
  });

  assert.deepEqual(onUpdatedAtAndId, ['rss_item_updated'], 'exactly one index covers (updated_at, id)');
});

test('a migration to version 10 indexes rss_item.media_item_id', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const index = raw.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'rss_item_media_item'",
  ).get() as { sql: unknown } | undefined;
  assert.ok(index, 'expected an index named rss_item_media_item');
  assert.match(
    String(index.sql),
    /CREATE INDEX rss_item_media_item ON rss_item \(media_item_id\)/,
  );

  // The index exists because one query needs it, so the query is what is
  // asserted rather than the index alone: "every release found for this media
  // item" must seek. Before migration 10 the plan was a bare `SCAN rss_item`,
  // and the read API asks this once per media item.
  // `filename` is outside the index deliberately: selecting only indexed
  // columns would plan as a *covering* index scan, which is a different plan
  // string from the one the read API's query gets and would pin the wrong
  // fact.
  const plan = raw.prepare(
    'EXPLAIN QUERY PLAN SELECT id, filename FROM rss_item WHERE media_item_id = ? ORDER BY id',
  ).all(1).map((row) => String((row as { detail: unknown }).detail)).join('\n');
  assert.match(plan, /SEARCH rss_item USING INDEX rss_item_media_item \(media_item_id=\?\)/);
  // One column suffices for `ORDER BY id`: an index entry carries the rowid.
  assert.doesNotMatch(plan, /USE TEMP B-TREE/);
});

test('migrating renames an existing rss item from usenet to nzb, which migration 5 did not', () => {
  // The half of migration 5's rename that migration 5 left undone. Migration
  // 5 is `UPDATE rss_feed ...` and only `rss_feed`, while `feeds/reader.ts`
  // copies a feed's `download_type` onto every `rss_item` it inserts -- so
  // every rss item written before migration 5 ran still held `'usenet'`, and
  // the read API types the value as `'torrent' | 'nzb'`.
  //
  // Seeded on the pre-migration-10 schema through a prefix of the real
  // `HOST_MIGRATIONS`, the same way the migration-5 test above does it, so
  // this watches the real `MIGRATION_10` statement act on a real row rather
  // than a synthetic one.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 9));
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, download_type, created_at, updated_at)
    VALUES ('alpha', 'Feed', 'https://example.com/feed', 'nzb', 1, 1)
  `).run();
  // Three rows: the stale spelling, the current one, and a torrent, so the
  // statement is shown renaming exactly what it should and nothing else.
  const insert = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (1, ?, ?, 10, 20, ?, '1080p')
  `);
  insert.run('stale.mkv', 'https://example.com/stale', 'usenet');
  insert.run('current.mkv', 'https://example.com/current', 'nzb');
  insert.run('torrent.mkv', 'https://example.com/torrent', 'torrent');

  // Picks up only version 10: versions 1 through 9 are already recorded as applied.
  migrateHost(raw);

  assert.deepEqual(
    raw.prepare('SELECT filename, download_type, updated_at FROM rss_item ORDER BY id').all()
      .map((r) => {
        const row = r as { filename: unknown; download_type: unknown; updated_at: unknown };
        return {
          filename: String(row.filename),
          downloadType: String(row.download_type),
          updatedAt: Number(row.updated_at),
        };
      }),
    [
      // Renamed, and `updated_at` untouched: the row's transport was always
      // nzb and only its spelling changed, so bumping it would re-serve the
      // row to every synced client for a change no client can see.
      { filename: 'stale.mkv', downloadType: 'nzb', updatedAt: 20 },
      { filename: 'current.mkv', downloadType: 'nzb', updatedAt: 20 },
      { filename: 'torrent.mkv', downloadType: 'torrent', updatedAt: 20 },
    ],
  );

  // And no row is left outside the union the read API promises, which is the
  // property the rename exists for.
  assert.deepEqual(
    raw.prepare(
      "SELECT DISTINCT download_type FROM rss_item WHERE download_type NOT IN ('torrent', 'nzb')",
    ).all(),
    [],
  );
});

test('a migration to version 11 replaces the tombstone index with one that leads with plugin_id', () => {
  // The half of migration 9's index that was missing, and the half that
  // matters. `deletionsSince` is `WHERE plugin_id = ? AND (deleted_at,
  // media_item_id) > (?, ?)`, and `deleted_media_item_at` named no
  // `plugin_id` at all -- so the plan sought the time and then walked every
  // other plugin's tombstones testing `plugin_id` row by row. `LIMIT 200`
  // bounded the output and nothing bounded the input: measured with one
  // plugin caught up and returning zero rows, 3.26 ms against another
  // plugin's 50,000 tombstones, 6.57 ms at 100,000, 13.00 ms at 200,000 and
  // 26.53 ms at 400,000, on a table the read API spec's §8 says nothing ever
  // prunes. 0.004 ms at 400,000 with this index.
  //
  // Seeded on the pre-migration-11 schema through a prefix of the real
  // `HOST_MIGRATIONS`, so the real `MIGRATION_11` statement is watched acting
  // on a populated table -- a `DROP INDEX` and a `CREATE INDEX` in one
  // migration, on rows that already exist.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 10));
  const insert = raw.prepare(
    'INSERT INTO deleted_media_item (media_item_id, plugin_id, deleted_at) VALUES (?, ?, ?)',
  );
  insert.run(1, 'alpha', 10);
  insert.run(2, 'beta', 20);
  insert.run(3, 'beta', 30);

  // Picks up only version 11: versions 1 through 10 are already recorded as applied.
  migrateHost(raw);

  const indexes = raw.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deleted_media_item' ORDER BY name",
  ).all().map((r) => {
    const row = r as { name: unknown; sql: unknown };
    return { name: String(row.name), sql: String(row.sql ?? '') };
  });

  // Exactly one, and it is the new one. The replaced index is dropped in the
  // same migration rather than left beside it: nothing reads it once this
  // exists -- `deletionsSince` is the only query over this table, and
  // `MediaWriter.dropMediaItem` upserts on the primary key -- and an index no
  // query uses is a B-tree maintained on every tombstone write for nothing.
  // Migration 9's first draft shipped a duplicate of `rss_item_updated` and
  // slice D shipped two status indexes nothing used; this is that lesson.
  assert.deepEqual(indexes.map((index) => index.name), ['deleted_media_item_sync']);
  assert.match(
    indexes[0]?.sql ?? '',
    /CREATE INDEX deleted_media_item_sync ON deleted_media_item \(plugin_id, deleted_at, media_item_id\)/,
  );

  // The index exists because one query needs it, so the query is what is
  // asserted rather than the index alone -- and the fixture holds two
  // plugins, because with one plugin's rows in the table the defective index
  // and this one are indistinguishable by both plan and clock.
  const plan = raw.prepare(`EXPLAIN QUERY PLAN ${SYNC_QUERIES['deletionsSince'] ?? ''}`)
    .all('alpha', 10, 1, 200)
    .map((row) => String((row as { detail: unknown }).detail)).join('\n');
  assert.match(plan, /SEARCH deleted_media_item USING COVERING INDEX deleted_media_item_sync \(plugin_id=\? AND deleted_at>\?\)/);
  assert.doesNotMatch(plan, /USE TEMP B-TREE/);

  // And the rows are still readable through it, scoped to their own plugin:
  // an index swap that changed what the query answers would be a far worse
  // bug than the one it fixes.
  assert.deepEqual(deletionsSince(raw, 'beta', null).items, [2, 3]);
  assert.deepEqual(deletionsSince(raw, 'alpha', null).items, [1]);
});

test('a tombstone cannot be written twice for one media item', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  // What the constraint guarantees, not what `dropMediaItem` does: that
  // writer inserts with `ON CONFLICT (media_item_id) DO UPDATE`, so a media
  // item id SQLite handed out a second time moves this row forward instead
  // of tripping the key. The constraint is what makes one row per id the
  // only possibility for either of them.
  const insert = raw.prepare(`
    INSERT INTO deleted_media_item (media_item_id, plugin_id, deleted_at)
    VALUES (1, 'alpha', 100)
  `);
  insert.run();

  assert.throws(
    () => insert.run(),
    (err: unknown) => {
      const code = (err as { code?: unknown }).code;
      // 1555 is SQLite's own SQLITE_CONSTRAINT_PRIMARYKEY -- proof that the
      // primary key on media_item_id fired, not merely that some insert
      // threw for some reason.
      const errcode = (err as { errcode?: unknown }).errcode;
      return code === 'ERR_SQLITE_ERROR' && errcode === 1555;
    },
  );
});

test('the tombstone keeps its own plugin_id, because the row it names is gone', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  raw.prepare(`
    INSERT INTO deleted_media_item (media_item_id, plugin_id, deleted_at)
    VALUES (1, 'alpha', 100)
  `).run();

  // No media_item row exists at id 1 -- there is nothing left to join to, so
  // plugin_id must read back from the tombstone's own column.
  const row = raw.prepare('SELECT plugin_id, deleted_at FROM deleted_media_item WHERE media_item_id = 1')
    .get() as { plugin_id: unknown; deleted_at: unknown };
  assert.deepEqual(
    { plugin_id: String(row.plugin_id), deleted_at: Number(row.deleted_at) },
    { plugin_id: 'alpha', deleted_at: 100 },
  );
});

test('both download tables carry a status index', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  for (const [indexName, table] of [
    ['torrent_download_status', 'torrent_download'],
    ['nzb_download_status', 'nzb_download'],
  ] as const) {
    const index = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(indexName) as { sql: unknown } | undefined;
    assert.ok(index, `expected an index named ${indexName}`);
    assert.match(String(index.sql), new RegExp(`CREATE INDEX ${indexName} ON ${table} \\(status\\)`));
  }
});

test('a migration to version 12 adds host_state and the four auth tables', () => {
  // Seeded on the pre-migration-12 schema through a prefix of the real
  // `HOST_MIGRATIONS`, the same way the migration-11 test above does it, so
  // the real `MIGRATION_12` DDL is watched acting on a database that already
  // holds the other sixteen tables.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 11));
  for (const table of ['host_state', 'auth_user', 'auth_session', 'auth_account', 'auth_verification']) {
    assert.equal(tableNames(raw).has(table), false, `${table} must not exist before migration 12`);
  }

  // Picks up only version 12: versions 1 through 11 are already recorded as applied.
  migrateHost(raw);

  const names = tableNames(raw);
  for (const table of ['host_state', 'auth_user', 'auth_session', 'auth_account', 'auth_verification']) {
    assert.ok(names.has(table), `missing ${table}`);
  }

  // The indexes Better Auth's own lookups need, by name and shape. The
  // adapter maps by the schema object's property key, so it is these SQL
  // names that have to be right rather than the Drizzle ones.
  const indexes = raw.prepare(`
    SELECT name, sql FROM sqlite_master
     WHERE type = 'index' AND tbl_name LIKE 'auth_%' AND sql IS NOT NULL
     ORDER BY name
  `).all().map((r) => {
    const row = r as { name: unknown; sql: unknown };
    return { name: String(row.name), sql: String(row.sql ?? '') };
  });
  assert.deepEqual(indexes.map((index) => index.name), [
    'auth_account_user',
    'auth_session_token',
    'auth_session_user',
    'auth_user_email',
    'auth_verification_identifier',
  ]);
  // Uniqueness is the part of an index's shape that changes behaviour rather
  // than only speed: two rows sharing a session token, or two users sharing
  // an email, is a correctness failure and not a slow query.
  const sqlByName = new Map(indexes.map((index) => [index.name, index.sql]));
  assert.match(sqlByName.get('auth_user_email') ?? '', /CREATE UNIQUE INDEX auth_user_email ON auth_user \(email\)/);
  assert.match(sqlByName.get('auth_session_token') ?? '', /CREATE UNIQUE INDEX auth_session_token ON auth_session \(token\)/);
  assert.match(sqlByName.get('auth_session_user') ?? '', /CREATE INDEX auth_session_user ON auth_session \(user_id\)/);
  assert.match(sqlByName.get('auth_account_user') ?? '', /CREATE INDEX auth_account_user ON auth_account \(user_id\)/);
  assert.match(
    sqlByName.get('auth_verification_identifier') ?? '',
    /CREATE INDEX auth_verification_identifier ON auth_verification \(identifier\)/,
  );
});

test('every auth table is keyed by TEXT, not an integer rowid', () => {
  // Better Auth generates base62 string ids. An INTEGER PRIMARY KEY here would
  // accept them (SQLite is permissive) and then hand back numbers, so this is
  // asserted from PRAGMA table_info rather than from a successful insert.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  for (const table of ['auth_user', 'auth_session', 'auth_account', 'auth_verification']) {
    const id = raw.prepare(`PRAGMA table_info(${table})`).all()
      .map((r) => {
        const row = r as { name: unknown; type: unknown; pk: unknown };
        return { name: String(row.name), type: String(row.type), pk: Number(row.pk) };
      })
      .find((column) => column.name === 'id');
    assert.deepEqual(id, { name: 'id', type: 'TEXT', pk: 1 }, `${table}.id must be the TEXT primary key`);
  }

  // The foreign keys onto it are TEXT too, or a session would key its user by
  // a value the user table cannot hold.
  for (const table of ['auth_session', 'auth_account']) {
    const userId = raw.prepare(`PRAGMA table_info(${table})`).all()
      .map((r) => {
        const row = r as { name: unknown; type: unknown };
        return { name: String(row.name), type: String(row.type) };
      })
      .find((column) => column.name === 'user_id');
    assert.deepEqual(userId, { name: 'user_id', type: 'TEXT' }, `${table}.user_id must be TEXT`);
  }
});

test('host_state holds one row per key', () => {
  // The primary key is the point: two rows for one key would make "the
  // secret" ambiguous. Assert errcode 1555, not message text.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const insert = raw.prepare(
    'INSERT INTO host_state (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  insert.run('auth.secret.placeholder', 'first', 10, 10);

  assert.throws(
    () => insert.run('auth.secret.placeholder', 'second', 20, 20),
    (err: unknown) => {
      const code = (err as { code?: unknown }).code;
      // 1555 is SQLite's own SQLITE_CONSTRAINT_PRIMARYKEY -- proof that the
      // primary key on `key` fired, not merely that some insert threw for
      // some reason. A plain unique violation would be 2067.
      const errcode = (err as { errcode?: unknown }).errcode;
      return code === 'ERR_SQLITE_ERROR' && errcode === 1555;
    },
  );

  // And the first row is still the one that is there, so the refusal did not
  // half-apply the second.
  assert.deepEqual(
    raw.prepare('SELECT key, value FROM host_state').all()
      .map((r) => {
        const row = r as { key: unknown; value: unknown };
        return { key: String(row.key), value: String(row.value) };
      }),
    [{ key: 'auth.secret.placeholder', value: 'first' }],
  );
});

test('migration 13 creates the secret table with name as its primary key', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const columns = raw.prepare('PRAGMA table_info(secret)').all()
    .map((row) => ({
      name: String((row as { name: unknown }).name),
      notNull: Number((row as { notnull: unknown }).notnull),
      pk: Number((row as { pk: unknown }).pk),
    }));
  assert.deepEqual(columns, [
    { name: 'name', notNull: 0, pk: 1 },
    { name: 'value', notNull: 1, pk: 0 },
    { name: 'created_at', notNull: 1, pk: 0 },
    { name: 'updated_at', notNull: 1, pk: 0 },
  ], 'secret must be keyed on name, with a non-null value');
});

test('a second row for one secret name is refused', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const insert = raw.prepare('INSERT INTO secret (name, value, created_at, updated_at) VALUES (?, ?, ?, ?)');
  insert.run('tvdb_key', 'test-value', 1, 1);
  try {
    insert.run('tvdb_key', 'other-value', 2, 2);
    assert.fail('a duplicate secret name must be refused');
  } catch (error) {
    // 1555 is SQLITE_CONSTRAINT_PRIMARYKEY. Asserted by code, not message.
    assert.equal((error as { errcode?: number }).errcode, 1555);
  }
});

/**
 * The two credential fakes below (`'sab-api-key'`, `'qbt-password'`) are
 * fixed, recognisable strings rather than anything real, so a failure diff
 * from these tests is safe to read. Migration 14 moves real credentials on a
 * real install; nothing here may print one.
 */
test('migration 14 moves a credential into secret and leaves a name behind', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 13));
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'sab', 'nzb', 'http://sab', 'sab-api-key', null, null, 'movies', 'move', 1, 1, 'sabnzbd');
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'qbt', 'torrent', 'http://qbt', null, 'admin', 'qbt-password', 'movies', 'move', 1, 1, 'qbittorrent');

  migrateHost(raw);

  const rows = raw.prepare('SELECT id, username, api_key_secret_name, password_secret_name FROM download_client ORDER BY id').all();
  // Before either row is indexed: a migration that dropped the rows it was
  // moving credentials off would otherwise be caught only incidentally, by
  // whichever assertion below happened to throw on `undefined` first.
  assert.equal(rows.length, 2, 'both client rows must survive the migration');
  const sab = rows[0] as Record<string, unknown>;
  const qbt = rows[1] as Record<string, unknown>;

  assert.match(String(sab['api_key_secret_name']), /^[0-9a-f-]{36}$/, 'the api key must be replaced by a uuid');
  assert.equal(sab['password_secret_name'], null);
  assert.equal(qbt['api_key_secret_name'], null);
  assert.match(String(qbt['password_secret_name']), /^[0-9a-f-]{36}$/, 'the password must be replaced by a uuid');
  assert.equal(qbt['username'], 'admin', 'a username is not a credential and must not move');

  // The credentials are now in `secret`, addressed by those names.
  const value = (name: unknown) => String(
    (raw.prepare('SELECT value FROM secret WHERE name = ?').get(String(name)) as { value: unknown }).value,
  );
  assert.equal(value(sab['api_key_secret_name']), 'sab-api-key');
  assert.equal(value(qbt['password_secret_name']), 'qbt-password');
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM secret').get()?.c), 2, 'one secret per moved credential');

  // The old columns are gone.
  const columns = new Set(
    raw.prepare('PRAGMA table_info(download_client)').all()
      .map((row) => String((row as { name: unknown }).name)),
  );
  assert.ok(!columns.has('api_key'), 'api_key must be dropped');
  assert.ok(!columns.has('password'), 'password must be dropped');
  assert.ok(columns.has('username'), 'username must remain');
});

test('a row resolves to the same ClientConfig after migration 14 as before it', async () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 13));
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'sab', 'nzb', 'http://sab', 'sab-api-key', null, null, 'movies', 'move', 1, 1, 'sabnzbd');
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'qbt', 'torrent', 'http://qbt', null, 'admin', 'qbt-password', 'movies', 'move', 1, 1, 'qbittorrent');

  // What the old, pre-migration code produced for these two rows, by hand --
  // this is the contract the indirection must not change.
  const before = [
    { kind: 'sabnzbd', id: 1, baseUrl: 'http://sab', apiKey: 'sab-api-key', category: 'movies' },
    { kind: 'qbittorrent-login', id: 2, baseUrl: 'http://qbt', username: 'admin', password: 'qbt-password', category: 'movies' },
  ];

  migrateHost(raw);
  const secrets = createSecrets({ raw, baseDir: '/nonexistent-secrets-dir' });
  const after = [await readClientConfig(raw, 1, secrets), await readClientConfig(raw, 2, secrets)];

  assert.deepEqual(after, before, 'the indirection must be invisible to every caller');
});

test('migration 14 gives a blank credential no secret and no name', () => {
  // `''` is what a blank form field saves as, and pre-migration
  // `readClientConfig` folded it to "absent" and refused the client. If the
  // migration named it, the row would come out holding a real uuid
  // addressing a `secret` whose value is `''` -- so the client would read as
  // *configured with a blank credential* rather than be refused, and that
  // refusal would be lost on exactly the rows that most need it. The fold
  // in `migration14` is what preserves it, and the analogous fold in
  // `readClientConfig` is pinned by `clients/config.test.ts`.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 13));
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'blank-key', 'nzb', 'http://sab', '', null, null, 'movies', 'move', 1, 1, 'sabnzbd');
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'blank-password', 'torrent', 'http://qbt', null, 'admin', '', 'movies', 'move', 1, 1, 'qbittorrent');

  migrateHost(raw);

  const rows = raw.prepare('SELECT id, api_key_secret_name, password_secret_name FROM download_client ORDER BY id').all()
    .map((row) => row as Record<string, unknown>);
  // Both rows are still there, asserted before anything is read off them.
  // `node:assert/strict` already makes `assert.equal(undefined, null)` throw,
  // so an absent row fails the two assertions below rather than passing
  // them -- but resting that on which `assert` this file happens to import
  // is thinner than saying it, and a migration that dropped these rows
  // should fail by name rather than incidentally. The `?.` stays regardless:
  // `noUncheckedIndexedAccess` types an index read as possibly `undefined`
  // and no runtime length assertion narrows that.
  assert.equal(rows.length, 2, 'the migration must not drop the rows it was moving credentials off');
  assert.equal(rows[0]?.['api_key_secret_name'], null, 'a blank api key must not become a name');
  assert.equal(rows[1]?.['password_secret_name'], null, 'a blank password must not become a name');
  assert.equal(
    Number(raw.prepare('SELECT count(*) c FROM secret').get()?.c),
    0,
    'a blank credential is not a credential, so it gets no secret row either',
  );
});

test('migration 14 leaves a row with no credential alone', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 13));
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'bare', 'torrent', 'http://qbt', null, null, null, 'movies', 'move', 1, 1, 'qbittorrent');
  migrateHost(raw);
  const row = raw.prepare('SELECT api_key_secret_name, password_secret_name FROM download_client WHERE id = 1').get();
  assert.equal((row as Record<string, unknown>)['api_key_secret_name'], null);
  assert.equal((row as Record<string, unknown>)['password_secret_name'], null);
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM secret').get()?.c), 0, 'no secret row for a row with no credential');
});

test('migration 15 creates sync_log with a monotonic id and a unique row key', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const columns = raw.prepare('PRAGMA table_info(sync_log)').all()
    .map((row) => String((row as { name: unknown }).name));
  assert.deepEqual(columns, ['id', 'table_name', 'row_id', 'op', 'at']);

  // AUTOINCREMENT is what makes the cursor safe. Asserted against
  // `sync_log`'s own stored DDL, not against the presence of
  // `sqlite_sequence`: that table exists if *any* table in the database uses
  // AUTOINCREMENT, so the count below passed even with `sync_log` weakened,
  // as long as something else had gained it. `PRAGMA table_info` cannot
  // report it at all -- `test/db/schema.test.ts`'s own doc has the
  // measurement, and guards the Drizzle mirror against the same weakening.
  const table = raw.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_log'",
  ).get();
  assert.match(String((table as { sql: unknown }).sql), /AUTOINCREMENT/,
    "sync_log's own DDL must declare AUTOINCREMENT");

  // Kept beside it: SQLite records the declaration by creating
  // `sqlite_sequence`, so its absence would mean nothing in the database
  // uses AUTOINCREMENT at all.
  const seq = raw.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'",
  ).get();
  assert.equal(Number((seq as { c: unknown }).c), 1, 'sync_log must be AUTOINCREMENT');

  const idx = raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='sync_log_row'").get();
  assert.match(String((idx as { sql: unknown }).sql), /UNIQUE/, 'the row key must be unique');
});

test('a sync_log id is never handed out twice, though every change deletes a row', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const insert = raw.prepare('INSERT INTO sync_log (table_name, row_id, op, at) VALUES (?, ?, ?, ?)');
  const remove = raw.prepare('DELETE FROM sync_log WHERE table_name = ? AND row_id = ?');

  insert.run('media_item', 1, 'upsert', 1);
  const first = Number(raw.prepare('SELECT id FROM sync_log WHERE row_id = 1').get()?.id);
  remove.run('media_item', 1);
  insert.run('media_item', 1, 'upsert', 2);
  const second = Number(raw.prepare('SELECT id FROM sync_log WHERE row_id = 1').get()?.id);

  assert.ok(second > first, `a re-logged row must take a higher id, got ${second} after ${first}`);
});

test('migration 15 seeds the log, so rows written before it existed are reachable by a log walk', () => {
  // The correctness hole the log walk has and the current-state walk did not:
  // `MIGRATION_15_DDL` creates `sync_log` *empty*, and the triggers it then
  // installs only ever log a row that changes afterwards. A cursor that reads
  // the log as an index of which rows exist would therefore serve none of the
  // rows a real database already holds, permanently -- the log would index
  // only what has changed since it was created.
  //
  // Migrated to 14 and seeded by hand rather than through `migrateHost`, so
  // these rows are written with no trigger in existence: that is the whole
  // point, and inserting them after `migrateHost` would log them the ordinary
  // way and prove nothing.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 14));

  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, created_at, updated_at, title) VALUES (1, 'tv', 1, 1, 'a'), (2, 'tv', 2, 2, 'b')
  `).run();
  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at)
    VALUES (1, 'tv', 'f', 'https://example.test/feed', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution)
    VALUES (7, 1, 'x.mkv', 'https://example.test/x', 1, 1, 'torrent', 1, '1080p')
  `).run();
  raw.prepare("INSERT INTO person (id, name, provider_ref, created_at, updated_at) VALUES (3, 'P', 'p:3', 1, 1)").run();
  raw.prepare("INSERT INTO role (id, media_item_id, person_id, role, created_at) VALUES (4, 1, 3, 'cast', 1)").run();

  migrateHostWith(raw, HOST_MIGRATIONS);

  const logged = raw.prepare('SELECT table_name, row_id, op FROM sync_log ORDER BY table_name, row_id').all()
    .map((row) => {
      const entry = row as { table_name: unknown; row_id: unknown; op: unknown };
      return [String(entry.table_name), Number(entry.row_id), String(entry.op)];
    });
  assert.deepEqual(logged, [
    ['media_item', 1, 'upsert'],
    ['media_item', 2, 'upsert'],
    ['person', 3, 'upsert'],
    ['role', 4, 'upsert'],
    ['rss_feed', 1, 'upsert'],
    ['rss_item', 7, 'upsert'],
  ], 'one entry per live row of every synced table, and none for a table that is not synced');
});

test('migration 16 seeds the log for a feed already on file, so an existing replica backfills it', () => {
  // `rss_feed` joined the synced set in this slice (`sync/tables.ts`'s top
  // docblock has why); this is `migration15`'s own test above, aimed at the
  // migration that actually brings this table in rather than the one that
  // brought the other six in. Migrated to 15 and seeded by hand, same
  // reasoning as above: these rows exist with no `rss_feed` trigger installed
  // yet, which is the state a database applying this migration for the first
  // time is actually in.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 15));

  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at)
    VALUES (1, 'tv', 'a feed', 'https://example.test/feed', 1, 1)
  `).run();

  migrateHostWith(raw, HOST_MIGRATIONS);

  const logged = raw.prepare("SELECT row_id, op FROM sync_log WHERE table_name = 'rss_feed'").all()
    .map((row) => {
      // Narrowed with `typeof`/`in` -- the way `useCounts.ts`'s
      // `isStoreClosed` narrows -- rather than a cast on `node:sqlite`'s
      // `unknown` row.
      if (typeof row !== 'object' || row === null || !('row_id' in row) || !('op' in row)) {
        throw new Error('sync_log row has no row_id/op');
      }
      return [Number(row.row_id), String(row.op)];
    });
  assert.deepEqual(logged, [[1, 'upsert']],
    'a feed that predates this migration must be indexed, so a client backfills it rather than never learning it exists');
});

test('the seed stamps `at` in real milliseconds, like the triggers', () => {
  // The same measurement `sync/log.ts`'s trigger doc records, on the seed's
  // copy of the expression: `unixepoch()` alone is whole seconds, so a bare
  // `* 1000` would look like milliseconds and be accurate to a thousand of
  // them.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 14));
  raw.prepare("INSERT INTO media_item (id, plugin_id, created_at, updated_at, title) VALUES (1, 'tv', 1, 1, 'a')").run();

  const before = Date.now();
  migrateHostWith(raw, HOST_MIGRATIONS);
  const after = Date.now();

  const at = Number((raw.prepare('SELECT at FROM sync_log WHERE row_id = 1').get() as { at: unknown }).at);
  assert.ok(at >= before - 1 && at <= after + 1,
    `the seed's at must be milliseconds around now, got ${at} for [${before}, ${after}]`);
});

test('the seed is a no-op on a fresh install, where every synced table is empty', () => {
  // A fresh database runs the same statements; they just match nothing. This
  // is what makes seeding unconditional in the migration rather than
  // conditional on noticing that rows exist.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const count = raw.prepare('SELECT count(*) c FROM sync_log').get();
  assert.equal(Number((count as { c: unknown }).c), 0, 'no rows, so nothing to log');
});
