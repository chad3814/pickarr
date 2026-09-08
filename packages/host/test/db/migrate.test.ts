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
  migrateHost(raw);

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

test('a tombstone cannot be written twice for one media item', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

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
