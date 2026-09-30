import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Migration } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { HOST_MIGRATIONS, migrateHost, migrateHostWith, migratePlugin } from '../../src/db/migrate.ts';
import { readHostState, writeHostState, SYNC_GENERATION_KEY } from '../../src/db/host-state.ts';
import { SYNC_QUERIES, deletionsSince } from '../../src/api/reads.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import { readClientConfig } from '../../src/clients/config.ts';
import { DOWNLOAD_STATUSES } from '../../src/clients/rows.ts';
import { VIDEO_RESOLUTION_CASES } from '../../../contract/test/videoResolutionCases.ts';

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
function seedDownloadTarget(
  raw: DatabaseSync,
  // Two of this function's callers seed a schema stopped before migration
  // 24 (`HOST_MIGRATIONS.filter((m) => m.version <= 6 or 7)`), where the
  // column is still named `resolution`; every other caller runs against the
  // head schema, where migration 24 has already renamed it.
  lookupStateColumn: string = 'lookup_state',
): void {
  raw.prepare(`
    INSERT INTO download_client (name, type, url, category, import_mode, created_at, updated_at)
    VALUES ('Client', 'torrent', 'https://example.com', 'movies', 'copy', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', 'Feed', 'https://example.com/feed', 1, 1)
  `).run();
  // **Two items, not one**, so a test needing two live download rows has
  // two releases to hang them on: since migration 18 a release may have at
  // most one download in any status but `failed`. Seeded here rather than
  // per test because the two tests that need it are the two about the
  // download tables' unique indexes, and an unused second `rss_item` costs
  // the other four nothing.
  const insertItem = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, ${lookupStateColumn})
    VALUES (1, ?, ?, 1, 1, 'torrent', 'resolved')
  `);
  insertItem.run('a.mkv', 'https://example.com/a');
  insertItem.run('b.mkv', 'https://example.com/b');
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
  // must be able to sit in the table at once, or a client that has two
  // submissions in flight could not record the second.
  //
  // This holds because SQLite exempts NULL from a unique constraint, NOT
  // because the index is partial, so this test passes against a total index
  // too. That is not a weakness: the coexistence is the property the write
  // path depends on, and it is worth pinning on its own terms. The `WHERE`
  // clause gets its own test below.
  //
  // **Two releases, and this test used to use one.** The sentence above
  // used to end "or a submission that died waiting for an answer would
  // block its own retry", and since migration 18 that is exactly what a
  // dead submission does: an unconfirmed row is `submitting`, `submitting`
  // is not `failed`, and the release-level index therefore refuses a
  // second pick at the same release until something settles the first. The
  // trade is deliberate -- the insert is the only synchronous point at
  // which two concurrent picks can be told apart, so a constraint that
  // exempted `submitting` would not constrain anything the pick path can
  // reach. Migration 18's docblock has the argument; what survives here is
  // the narrower and still-load-bearing claim, that null refs are distinct.
  const insert = raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, status, created_at, updated_at)
    VALUES (?, 1, 'pending', 1, 1)
  `);
  insert.run(1);
  insert.run(2);

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

  // **Two different releases**, which is what keeps this test about the
  // index it names. Both rows on one `rss_item` would now also violate
  // migration 18's `..._live_item` index, and SQLite reports both with the
  // same errcode -- so the assertion below would pass while proving
  // nothing about `(download_client_id, client_ref)` at all.
  const insert = raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, client_ref, status, created_at, updated_at)
    VALUES (?, 1, 'confirmed-1', 'pending', 1, 1)
  `);
  insert.run(1);

  assert.throws(
    () => insert.run(2),
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

test('a release may hold only one download that has not failed, on either table', () => {
  // Migration 18's own index, driven rather than read back out of
  // `sqlite_master`: the drift guard below covers the text, this covers
  // what the text does. Both tables, because a release's table is decided
  // by its feed's transport and either one is reachable.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedDownloadTarget(raw);

  for (const table of ['torrent_download', 'nzb_download']) {
    const insert = raw.prepare(`
      INSERT INTO ${table} (rss_item_id, download_client_id, status, created_at, updated_at)
      VALUES (1, 1, ?, 1, 1)
    `);
    insert.run('submitting');
    assert.throws(
      () => { insert.run('submitting'); },
      // 2067 is SQLITE_CONSTRAINT_UNIQUE, so this is the index refusing and
      // not some other error -- the same proof the client_ref test uses.
      (err: unknown) => (err as { errcode?: unknown }).errcode === 2067,
      `${table} must refuse a second live download for one release`,
    );
  }
});

test('every status but failed blocks a second download for one release', () => {
  // The definition of "live", pinned value by value rather than by
  // restating the `WHERE` clause. `DOWNLOAD_STATUSES` is read from
  // `clients/rows.ts` so a seventh status added there reddens here rather
  // than slipping past a literal list -- the index is frozen text and this
  // is the test that notices when the vocabulary moves out from under it.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedDownloadTarget(raw);

  const blocked: string[] = [];
  for (const status of DOWNLOAD_STATUSES) {
    raw.prepare('DELETE FROM torrent_download').run();
    raw.prepare(`
      INSERT INTO torrent_download (rss_item_id, download_client_id, status, created_at, updated_at)
      VALUES (1, 1, ?, 1, 1)
    `).run(status);
    try {
      raw.prepare(`
        INSERT INTO torrent_download (rss_item_id, download_client_id, status, created_at, updated_at)
        VALUES (1, 1, 'submitting', 1, 1)
      `).run();
    } catch (err) {
      if ((err as { errcode?: unknown }).errcode !== 2067) throw err;
      blocked.push(status);
    }
  }

  // Spelled out rather than derived as `DOWNLOAD_STATUSES.filter(s => s !==
  // 'failed')`: an expectation computed from the same list the loop walks
  // would survive the list changing, which is the whole thing this test is
  // here to notice.
  assert.deepEqual(blocked, ['submitting', 'submitted', 'downloading', 'completed', 'delivered']);
  assert.ok(!blocked.includes('failed'), 'a failed download must leave its release pickable again');
});

test('the live-item index is partial on both download tables', () => {
  // The drift guard for migration 18, the shape the `client_ref` one above
  // has. Unlike that one the `WHERE` here is not decoration -- dropping it
  // would make every release permanently unpickable after one failed
  // attempt, and the test above would catch that. This pins the text so a
  // *widening* of the clause, which no insert above would notice, still
  // reds.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  for (const name of ['torrent_download_live_item', 'nzb_download_live_item']) {
    const index = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(name) as { sql: unknown } | undefined;
    assert.ok(index, `expected an index named ${name}`);
    assert.match(String(index.sql), /WHERE status <> 'failed'/, `${name} should exempt failed rows`);
  }
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
  seedDownloadTarget(raw, 'resolution');
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
  seedDownloadTarget(raw, 'resolution');
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

  // Version 15 installs a **frozen** six-table literal
  // (`MIGRATION_15_TABLES`), deliberately decoupled from the live
  // `HOST_SYNCED_TABLES` export so that a table joining that export later
  // cannot retroactively change what an already-applied migration did --
  // `docs/database-migrations.md`'s first rule. Two have joined since:
  // `rss_feed` in migration 16 and `download_client` in migration 17, each
  // with its own migration rather than an edit to this one.
  //
  // Nothing failed when that decoupling was undone: re-coupling
  // `migration15` to `[...MIGRATION_15_TABLES, 'rss_feed']` left all 2374
  // server tests green, because `migration16`'s `DROP TRIGGER IF EXISTS`
  // and `seedSyncLog`'s anti-join are both idempotent and the end state is
  // identical either way. The end state is not what the freeze is about;
  // *this* state is -- what a database looks like at version 15, which is
  // where a database that stopped there actually lives. The three triggers
  // are named literally rather than matched by prefix, so the assertion
  // cannot be satisfied by a rename.
  const feedTriggersAt15 = raw.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name IN ('rss_feed_sync_ins', 'rss_feed_sync_upd', 'rss_feed_sync_del')
    ORDER BY name
  `).all().map((row) => String(row.name));
  assert.deepEqual(feedTriggersAt15, [],
    'version 15 installs triggers for its own frozen six tables and no others -- rss_feed is migration 16\'s');

  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at)
    VALUES (1, 'tv', 'a feed', 'https://example.test/feed', 1, 1)
  `).run();

  migrateHostWith(raw, HOST_MIGRATIONS);

  const logged = raw.prepare("SELECT row_id, op FROM sync_log WHERE table_name = 'rss_feed'").all()
    .map((row) => {
      // Not narrowing `unknown` -- `node:sqlite`'s own `.all()` already
      // types `row` as `Record<string, SQLOutputValue>`, so `row.row_id`
      // and `row.op` below would typecheck with no guard here at all
      // (measured: removing this `if` does not fail typecheck). What it
      // buys instead is a fast, legible failure if this query's own
      // `SELECT row_id, op` ever loses or renames a column -- without it,
      // a missing property reads as `undefined`, and `Number`/`String`
      // below would turn that into `NaN`/`'undefined'` rather than an
      // error naming the actual problem.
      if (typeof row !== 'object' || row === null || !('row_id' in row) || !('op' in row)) {
        throw new Error('sync_log row has no row_id/op');
      }
      return [Number(row.row_id), String(row.op)];
    });
  assert.deepEqual(logged, [[1, 'upsert']],
    'a feed that predates this migration must be indexed, so a client backfills it rather than never learning it exists');
});

test('migration 17 installs the download client triggers and seeds a client already on file', () => {
  // `migration16`'s test above, aimed at the table this slice brings in.
  // Migrated to 16 and seeded by hand, same reasoning as there: the row has
  // to exist with no `download_client` trigger installed, which is the state
  // a database applying version 17 for the first time is actually in.
  // Inserting it after `migrateHost` would log it through the trigger and
  // prove only that triggers work.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 16));

  const triggerNames = `
    SELECT name FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN ('download_client_sync_ins', 'download_client_sync_upd', 'download_client_sync_del')
    ORDER BY name
  `;
  // Named literally rather than matched by prefix, for the reason the
  // migration 16 test gives: a prefix match is satisfied by a rename.
  assert.deepEqual(
    raw.prepare(triggerNames).all().map((row) => String(row.name)),
    [],
    'version 16 installs rss_feed\'s triggers and no others -- download_client is migration 17\'s',
  );

  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, category, import_mode, created_at, updated_at)
    VALUES (1, 'qbit', 'torrent', 'http://qbit.local:8080', 'tv', 'copy', 1, 1)
  `).run();

  migrateHostWith(raw, HOST_MIGRATIONS);

  assert.deepEqual(
    raw.prepare(triggerNames).all().map((row) => String(row.name)),
    ['download_client_sync_del', 'download_client_sync_ins', 'download_client_sync_upd'],
    'all three, so a later insert, update and delete each log',
  );

  const logged = raw.prepare("SELECT row_id, op FROM sync_log WHERE table_name = 'download_client'").all()
    .map((row) => {
      // Not narrowing `unknown` -- see the identical guard in the migration
      // 16 test above for what it does and does not buy.
      if (typeof row !== 'object' || row === null || !('row_id' in row) || !('op' in row)) {
        throw new Error('sync_log row has no row_id/op');
      }
      return [Number(row.row_id), String(row.op)];
    });
  assert.deepEqual(logged, [[1, 'upsert']],
    'a client that predates this migration must be indexed, or no replica ever learns it exists');
});

/**
 * The `op` of one `sync_log` row, narrowed with `in` rather than cast.
 *
 * The same guard shape the migration 17 seed test above uses inline, and the
 * reason it is a function here is that the test below reads `op` three
 * times. `(row as { … })` is the older spelling and **60 places** in this
 * file still use it -- counted on this tree, ignoring comment lines, where
 * this line said 53 -- so replacing them is not this task. But the
 * two spellings had ended up in *adjacent tests written in the same
 * commit*, one of them already using the guard, and that is the one place
 * the inconsistency is nobody's inheritance. The importer slice added two
 * more of the older spelling, in migration 20's tests; both have since
 * been narrowed, for the same reason and because that slice's plan forbids
 * a cast to silence a type error.
 */
function opsLogged(raw: ReturnType<typeof openTestDatabase>['raw'], table: string): string[] {
  return raw.prepare('SELECT op FROM sync_log WHERE table_name = ?').all(table)
    .map((row) => {
      if (typeof row !== 'object' || row === null || !('op' in row)) {
        throw new Error('sync_log row has no op');
      }
      return String(row.op);
    });
}

test('migration 17\'s triggers, not only its seed, log a download client written afterwards', () => {
  // The seed and the triggers are two separate calls, and this drives the
  // triggers rather than inspecting `sqlite_master` for them: a trigger that
  // exists and a trigger that logs are not the same claim.
  //
  // What this adds over the test above, measured rather than assumed -- the
  // first version of this comment guessed and guessed wrong, claiming the
  // test above would stay green without `installSyncTriggers`. It does not;
  // it asserts the three trigger names exist. Both tests red on that mutant,
  // this one on `the insert trigger logs`. The separation that is real is
  // the other way round: dropping `seedSyncLog` from `migration17` reds the
  // test above (`a client that predates this migration must be indexed`) and
  // leaves this one green, since a row written after the migration needs no
  // seed. So the two cover the two calls one each, and neither subsumes the
  // other -- it is just not the direction first written here.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, category, import_mode, created_at, updated_at)
    VALUES (1, 'qbit', 'torrent', 'http://qbit.local:8080', 'tv', 'copy', 1, 1)
  `).run();
  assert.deepEqual(opsLogged(raw, 'download_client'), ['upsert'], 'the insert trigger logs');

  raw.prepare("UPDATE download_client SET category = 'movies' WHERE id = 1").run();
  assert.deepEqual(opsLogged(raw, 'download_client'), ['upsert'],
    'the update trigger re-logs the row, collapsed onto one entry');

  raw.prepare('DELETE FROM download_client WHERE id = 1').run();
  assert.deepEqual(opsLogged(raw, 'download_client'), ['delete'], 'the delete trigger tombstones it');
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

/**
 * One `download_client` row and one `filepath_mapping` row under it, on
 * whatever schema version the caller has migrated to.
 *
 * **`updatedAt` is optional because the two schemas this runs against do not
 * agree on whether the column exists.** Two callers seed onto **version
 * 18**, where `filepath_mapping` has `created_at` alone and naming
 * `updated_at` fails with `no such column`; the other two run on a fully
 * migrated database, where the column is `NOT NULL` with **no default**, so
 * omitting it fails with `NOT NULL constraint failed`. There is no single
 * statement that works on both, which is the shape of migration 19 showing
 * through -- and the version-18 branch is the only reason this helper is not
 * simply one `INSERT`.
 */
function seedClientAndMapping(
  raw: ReturnType<typeof openTestDatabase>['raw'],
  createdAt: number,
  updatedAt?: number,
): void {
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, category, import_mode, created_at, updated_at)
    VALUES (1, 'qbit', 'torrent', 'http://qbit.local:8080', 'tv', 'copy', 1, 1)
  `).run();
  if (updatedAt === undefined) {
    raw.prepare(`
      INSERT INTO filepath_mapping (id, download_client_id, from_path, to_path, created_at)
      VALUES (1, 1, '/downloads', '/media', ?)
    `).run(createdAt);
    return;
  }
  raw.prepare(`
    INSERT INTO filepath_mapping (id, download_client_id, from_path, to_path, created_at, updated_at)
    VALUES (1, 1, '/downloads', '/media', ?, ?)
  `).run(createdAt, updatedAt);
}

test('migration 19 backfills updated_at from created_at on a mapping that predates it', () => {
  // The column every synced table projects, on a table that had only
  // `created_at` -- `packages/web/src/store/rows.ts`'s `listByTable` refuses
  // a table whose rows carry no `updatedAt`, so a row left without one is a
  // row the settings screen cannot page.
  //
  // Seeded at version 18 rather than after `migrateHost`, for the reason the
  // migration 17 test above gives: a row written afterwards would take the
  // column's `DEFAULT 0` through an ordinary insert and prove nothing about
  // the backfill.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 18));
  seedClientAndMapping(raw, 777);

  migrateHostWith(raw, HOST_MIGRATIONS);

  const row = raw.prepare('SELECT created_at, updated_at FROM filepath_mapping WHERE id = 1').get();
  if (typeof row !== 'object' || row === null || !('created_at' in row) || !('updated_at' in row)) {
    throw new Error('filepath_mapping row has no created_at/updated_at');
  }
  assert.equal(Number(row.created_at), 777, 'the migration must not rewrite created_at');
  assert.equal(Number(row.updated_at), 777,
    'a row that predates the column must carry its creation time, not the DEFAULT 0 that makes the ALTER legal');
});

test('two mappings for one client cannot share a from_path', () => {
  // Design spec §6: the `duplicate-from-path` refusal is *caught* from this
  // index rather than pre-checked, so two concurrent writes cannot both pass
  // a check and collide. It is also a correctness fix on its own --
  // `clients/paths.ts`'s `mapClientPath` resolves equal-length matches by
  // iteration order and says nothing may rely on that, and two identical
  // `from_path` values for one client are the only way to reach it. See
  // `test/clients/paths.test.ts` for that half, driven through the consumer.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedClientAndMapping(raw, 1, 1);

  assert.throws(
    () => raw.prepare(`
      INSERT INTO filepath_mapping (download_client_id, from_path, to_path, created_at, updated_at)
      VALUES (1, '/downloads', '/elsewhere', 2, 2)
    `).run(),
    /UNIQUE/,
    'a second mapping with the same from_path for one client must be refused by the index',
  );

  // The two halves of the key, each pinned by a row the index must admit --
  // an index on `from_path` alone would refuse the second of these, and one
  // on `download_client_id` alone would refuse the first.
  raw.prepare(`
    INSERT INTO filepath_mapping (download_client_id, from_path, to_path, created_at, updated_at)
    VALUES (1, '/downloads/tv', '/media/tv', 2, 2)
  `).run();
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, category, import_mode, created_at, updated_at)
    VALUES (2, 'sab', 'nzb', 'http://sab.local:8080', 'tv', 'copy', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO filepath_mapping (download_client_id, from_path, to_path, created_at, updated_at)
    VALUES (2, '/downloads', '/other', 2, 2)
  `).run();

  const count = raw.prepare('SELECT count(*) c FROM filepath_mapping').get();
  assert.equal(Number((count as { c: unknown }).c), 3,
    'a second from_path for one client, and the same from_path for a different client, are both fine');
});

test('migration 19 rebuilds filepath_mapping and keeps every row, id and reference', () => {
  // **What a create-copy-drop-rename most easily loses**, each asserted
  // rather than assumed: a row, its `id`, the foreign key, and the column
  // that is the whole point of the rebuild having no default.
  //
  // Two rows, with the second on a *second* client, so a copy that dropped
  // the `download_client_id` column or carried it across constant would be
  // visible here rather than passing on a single-row fixture.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 18));
  seedClientAndMapping(raw, 777);
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, category, import_mode, created_at, updated_at)
    VALUES (2, 'sab', 'nzb', 'http://sab.local:8080', 'tv', 'copy', 1, 1)
  `).run();
  raw.prepare(`
    INSERT INTO filepath_mapping (id, download_client_id, from_path, to_path, created_at)
    VALUES (9, 2, '/incoming', '/srv/nzb', 888)
  `).run();

  migrateHostWith(raw, HOST_MIGRATIONS);

  assert.deepEqual(
    raw.prepare('SELECT id, download_client_id, from_path, to_path, created_at, updated_at FROM filepath_mapping ORDER BY id')
      .all().map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>))),
    [
      { id: 1, download_client_id: 1, from_path: '/downloads', to_path: '/media', created_at: 777, updated_at: 777 },
      { id: 9, download_client_id: 2, from_path: '/incoming', to_path: '/srv/nzb', created_at: 888, updated_at: 888 },
    ],
    'every row, every column and every id survives the copy -- id 9 in particular, which a rebuild that let the new table reissue keys would renumber to 2',
  );

  // The foreign key, which `test/db/schema.test.ts` explicitly does not
  // compare (its own docblock says so), so a rebuild that dropped the
  // `REFERENCES` clause would be invisible to every structural test in this
  // repo and visible only as a refusal that stopped happening.
  const fks = raw.prepare('PRAGMA foreign_key_list(filepath_mapping)').all()
    .map((r) => {
      const row = r as { table: unknown; from: unknown; to: unknown };
      return [String(row.table), String(row.from), String(row.to)];
    });
  assert.deepEqual(fks, [['download_client', 'download_client_id', 'id']],
    'the rebuilt table still refuses a mapping for a client that does not exist');

  // And the reason the rebuild happened at all: no default, so a writer
  // that omits the column fails loudly instead of storing epoch 0.
  const updatedAt = raw.prepare('PRAGMA table_info(filepath_mapping)').all()
    .find((r) => String((r as { name: unknown }).name) === 'updated_at');
  assert.ok(updatedAt !== undefined, 'the column exists');
  assert.equal((updatedAt as { dflt_value: unknown }).dflt_value, null, 'and carries no default');
  assert.throws(
    () => raw.prepare(`
      INSERT INTO filepath_mapping (download_client_id, from_path, to_path, created_at)
      VALUES (1, '/other', '/elsewhere', 1)
    `).run(),
    /NOT NULL constraint failed: filepath_mapping.updated_at/,
    'an insert that omits updated_at is refused at the moment it is written, not silently stored as 1970',
  );
});

test('migration 19 installs the filepath_mapping triggers and seeds a mapping already on file', () => {
  // `migration17`'s test above, aimed at the table this slice brings in.
  // Migrated to 18 and seeded by hand, same reasoning as there: the row has
  // to exist with no `filepath_mapping` trigger installed, which is the
  // state a database applying version 19 for the first time is actually in.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 18));

  const triggerNames = `
    SELECT name FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN ('filepath_mapping_sync_ins', 'filepath_mapping_sync_upd', 'filepath_mapping_sync_del')
    ORDER BY name
  `;
  // Named literally rather than matched by prefix, for the reason the
  // migration 16 and 17 tests give: a prefix match is satisfied by a rename.
  assert.deepEqual(
    raw.prepare(triggerNames).all().map((row) => String(row.name)),
    [],
    'version 18 adds two indexes and no triggers -- filepath_mapping is migration 19\'s',
  );

  seedClientAndMapping(raw, 1);

  migrateHostWith(raw, HOST_MIGRATIONS);

  assert.deepEqual(
    raw.prepare(triggerNames).all().map((row) => String(row.name)),
    ['filepath_mapping_sync_del', 'filepath_mapping_sync_ins', 'filepath_mapping_sync_upd'],
    'all three, so a later insert, update and delete each log',
  );

  const logged = raw.prepare("SELECT row_id, op FROM sync_log WHERE table_name = 'filepath_mapping'").all()
    .map((row) => {
      // Not narrowing `unknown` -- see the identical guard in the migration
      // 16 test above for what it does and does not buy.
      if (typeof row !== 'object' || row === null || !('row_id' in row) || !('op' in row)) {
        throw new Error('sync_log row has no row_id/op');
      }
      return [Number(row.row_id), String(row.op)];
    });
  assert.deepEqual(logged, [[1, 'upsert']],
    'a mapping that predates this migration must be indexed, or no replica ever learns it exists');
});

test('migration 19\'s triggers log a mapping written, edited and removed afterwards', () => {
  // `migration17`'s equivalent, and the delete leg is load-bearing for this
  // slice rather than incidental: design spec §5 says a removal needs no new
  // machinery because `installSyncTriggers` already emits
  // `AFTER DELETE ... OLD.id, 'delete'`, and this is what pins that the
  // claim holds for this table too. Drives the triggers rather than
  // inspecting `sqlite_master`: a trigger that exists and a trigger that
  // logs are not the same claim.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  seedClientAndMapping(raw, 1, 1);
  assert.deepEqual(opsLogged(raw, 'filepath_mapping'), ['upsert'], 'the insert trigger logs');

  raw.prepare("UPDATE filepath_mapping SET to_path = '/media/tv' WHERE id = 1").run();
  assert.deepEqual(opsLogged(raw, 'filepath_mapping'), ['upsert'],
    'the update trigger re-logs the row, collapsed onto one entry');

  raw.prepare('DELETE FROM filepath_mapping WHERE id = 1').run();
  assert.deepEqual(opsLogged(raw, 'filepath_mapping'), ['delete'], 'the delete trigger tombstones it');
});

/**
 * Inserts one `plugin_destination` row for `pluginId`, binding every column.
 *
 * Every column named explicitly, including both timestamps: the table has no
 * default on any of them, and an insert that leans on one would not be the
 * insert the writer in `media/destinations.ts` makes.
 */
function seedDestination(
  raw: ReturnType<typeof openTestDatabase>['raw'],
  id: number,
  pluginId: string,
): void {
  raw.prepare(`
    INSERT INTO plugin_destination (id, plugin_id, root, shape, unmatched_dir, created_at, updated_at)
    VALUES (?, ?, '/library', '{title}.{ext}', '_unmatched', 10, 20)
  `).run(id, pluginId);
}

test('migration 20 creates plugin_destination, keyed by id and unique on plugin_id', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  assert.ok(tableNames(raw).has('plugin_destination'), 'the table exists');

  // Indexed, not cast. `node:sqlite` already types a row as
  // `Record<string, SQLOutputValue>`, so `row['name']` compiles on its own
  // and `(r as { … })` bought only a second, unchecked spelling of five
  // column names. 60 lines of this file still carry the older spelling and
  // replacing those is not this task -- but these two were written on this
  // branch, so they are nobody's inheritance, and the plan for this slice
  // forbids a cast to silence a type error. See `opsLogged` above for the
  // `in`-guard form, which is what a `.get()` needs.
  const columns = raw.prepare('PRAGMA table_info(plugin_destination)').all().map((row) => ({
    name: String(row['name']),
    type: String(row['type']),
    notNull: Number(row['notnull']) === 1,
    default: row['dflt_value'],
    pk: Number(row['pk']),
  }));
  assert.deepEqual(columns, [
    { name: 'id', type: 'INTEGER', notNull: false, default: null, pk: 1 },
    { name: 'plugin_id', type: 'TEXT', notNull: true, default: null, pk: 0 },
    { name: 'root', type: 'TEXT', notNull: true, default: null, pk: 0 },
    { name: 'shape', type: 'TEXT', notNull: true, default: null, pk: 0 },
    { name: 'unmatched_dir', type: 'TEXT', notNull: true, default: null, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notNull: true, default: null, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notNull: true, default: null, pk: 0 },
  ], 'a lone integer `id` key, and no column carries a default');

  // The default `_unmatched` lives in `media/destinations.ts`, not here, and
  // the absence of a column default is what keeps it to one place: an insert
  // that omits the column fails at the moment it is written rather than
  // quietly storing whatever the DDL happened to say.
  assert.throws(
    () => raw.prepare(`
      INSERT INTO plugin_destination (plugin_id, root, shape, created_at, updated_at)
      VALUES ('tv', '/library', '{title}.{ext}', 1, 1)
    `).run(),
    /NOT NULL constraint failed: plugin_destination.unmatched_dir/,
    'an insert that omits unmatched_dir is refused rather than defaulted',
  );
});

test('a plugin cannot hold two destinations', () => {
  // One row per plugin is the whole grain of the table (design spec §3), and
  // it is a unique index rather than a convention because
  // `media/destinations.ts` upserts on exactly this key -- an
  // `ON CONFLICT (plugin_id)` clause needs the index to have something to
  // conflict against.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  seedDestination(raw, 1, 'tv');
  assert.throws(
    () => seedDestination(raw, 2, 'tv'),
    /UNIQUE constraint failed: plugin_destination.plugin_id/,
  );
  // And two plugins may each have one.
  seedDestination(raw, 2, 'movie');
  // `'n' in count`, not a cast -- the guard shape `opsLogged` above uses,
  // and the one `test/media/destinations.test.ts`'s own `rowCount` uses for
  // this same query.
  const count = raw.prepare('SELECT COUNT(*) AS n FROM plugin_destination').get();
  if (count === undefined || !('n' in count)) throw new Error('COUNT(*) returned no n');
  assert.equal(Number(count.n), 2);
});

test('migration 20\'s triggers log a destination written, edited and removed afterwards', () => {
  // `migration19`'s equivalent, and it drives the triggers rather than
  // reading `sqlite_master`: a trigger that exists and a trigger that logs
  // are not the same claim. There is no seed leg here, unlike migrations 16,
  // 17 and 19 -- this migration creates the table, so at the instant the
  // triggers are installed it holds no row for a seed to index.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  seedDestination(raw, 1, 'tv');
  assert.deepEqual(opsLogged(raw, 'plugin_destination'), ['upsert'], 'the insert trigger logs');

  raw.prepare("UPDATE plugin_destination SET root = '/library/tv' WHERE id = 1").run();
  assert.deepEqual(opsLogged(raw, 'plugin_destination'), ['upsert'],
    'the update trigger re-logs the row, collapsed onto one entry');

  raw.prepare('DELETE FROM plugin_destination WHERE id = 1').run();
  assert.deepEqual(opsLogged(raw, 'plugin_destination'), ['delete'], 'the delete trigger tombstones it');
});

test('migration 22 adds lookup_json without rebuilding rss_item, so its sync triggers survive', () => {
  // The hazard `docs/database-migrations.md` exists for: a
  // create-copy-drop-rename would take the table's three triggers with it
  // and stop `rss_item` replicating to every client, silently -- the
  // screen would simply never update again. Asserted on the triggers
  // themselves, not on the column, because the column is the easy half.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const columns = raw.prepare("SELECT name FROM pragma_table_info('rss_item')").all()
    .map((row) => String((row as { name: unknown }).name));
  assert.ok(columns.includes('lookup_json'), 'the column is there');

  const triggers = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'rss_item' ORDER BY name",
  ).all().map((row) => String((row as { name: unknown }).name));
  assert.deepEqual(triggers, ['rss_item_sync_del', 'rss_item_sync_ins', 'rss_item_sync_upd'],
    'all three sync triggers are still attached');
  raw.close();
});

test('migration 23 adds person_image, and does not replicate it', () => {
  // Artwork is not synced -- `web/src/store/gather.ts` fetches it by url
  // and holds no artwork rows (#79). Installing triggers here would push
  // every image row into `sync_log` and into every browser's replica, for
  // data no client reads. Asserted as the absence of triggers, because
  // adding them is the habit this table has to resist.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const columns = raw.prepare("SELECT name FROM pragma_table_info('person_image')").all()
    .map((row) => String((row as { name: unknown }).name));
  assert.deepEqual(columns.sort(), ['created_at', 'height', 'id', 'language', 'path', 'person_id', 'title', 'url', 'width']);

  const triggers = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'person_image'",
  ).all();
  assert.deepEqual(triggers, [], 'artwork is not replicated, so this table has no sync triggers');
  raw.close();
});

test('migration 24 renames the lookup state columns in place, so rss_item keeps replicating', () => {
  // A rename, not a rebuild: `docs/database-migrations.md` measures RENAME
  // COLUMN as keeping all three triggers with their bodies rewritten, and a
  // rebuild as silently dropping them. Asserted by writing through the
  // triggers, because a trigger that survived with a body still naming
  // `resolution` would fail on the first UPDATE, not at migration time.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 23));
  raw.exec(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('tv', 'f', 'http://f', 1, 1);
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution, resolution_detail)
      VALUES (1, 'a.mkv', 'http://a', 1, 1, 'torrent', 'unresolved', 'not recognised');
  `);
  migrateHost(raw);

  const columns = new Set(
    raw.prepare("SELECT name FROM pragma_table_info('rss_item')").all()
      .map((row) => String((row as { name: unknown }).name)),
  );
  assert.ok(columns.has('lookup_state') && columns.has('lookup_state_detail'), 'renamed');
  assert.ok(!columns.has('resolution') && !columns.has('resolution_detail'), 'and the old names are gone');

  const row = raw.prepare('SELECT lookup_state, lookup_state_detail FROM rss_item WHERE id = 1').get();
  assert.deepEqual({ ...row }, { lookup_state: 'unresolved', lookup_state_detail: 'not recognised' }, 'values carried across');

  // `sync_log` collapses to one entry per changed row (`sync/log.ts`'s own
  // doc), so a repeat write to the same row leaves `COUNT(*)` exactly where
  // it was -- the row's insert already logged it, above. What a client
  // actually watches is the id: `AUTOINCREMENT` issues one strictly higher
  // than any before it, and that is what carries the update past a cursor
  // already sitting on the insert's entry.
  const before = Number((raw.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM sync_log').get() as { n: unknown }).n);
  raw.exec("UPDATE rss_item SET lookup_state = 'resolved' WHERE id = 1");
  const after = Number((raw.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM sync_log').get() as { n: unknown }).n);
  assert.ok(after > before, 'an update after the rename still logs');
  raw.close();
});

test('migration 24 forgets the sync generation, so every client re-bootstraps into the new shape', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 23));
  writeHostState(raw, SYNC_GENERATION_KEY, 'before-the-rename', 1);
  migrateHost(raw);
  // `assert.ok` rather than `assert.equal`: `readHostState` reads
  // `host_state.value`, which `check-test-hygiene.ts`'s Rule 2 treats as a
  // credential column regardless of which key is asked for, and
  // `assert.equal` formats both operands into its failure message.
  assert.ok(readHostState(raw, SYNC_GENERATION_KEY) === null, 'the next ensureSyncGeneration mints a new one');
  raw.close();
});

test("migration 24 backfills an unmatched release's video resolution from its stored answer, by the contract's rule", () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 23));
  raw.exec("INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('tv', 'f', 'http://f', 1, 1)");
  const insert = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution, lookup_json)
    VALUES (1, ?, ?, 1, 1, 'torrent', 'unresolved', ?)
  `);
  const expected = new Map<number, string | null>();
  for (const [index, [input, want]] of VIDEO_RESOLUTION_CASES.entries()) {
    const quality = input === undefined ? {} : { resolution: input };
    const id = Number(insert.run(`case-${index}.mkv`, `http://${index}`, JSON.stringify({ parsed: { quality } })).lastInsertRowid);
    expected.set(id, want);
  }
  const noAnswer = Number(insert.run('no-answer.mkv', 'http://n', null).lastInsertRowid);
  const tooLarge = Number(insert.run('too-large.mkv', 'http://t', '{"pickarr":"lookup-answer-too-large"}').lastInsertRowid);
  const malformed = Number(insert.run('malformed.mkv', 'http://m', 'not json').lastInsertRowid);
  migrateHost(raw);

  const read = raw.prepare('SELECT video_resolution FROM rss_item WHERE id = ?');
  const valueOf = (id: number): unknown => (read.get(id) as { video_resolution: unknown }).video_resolution;
  for (const [id, want] of expected) assert.equal(valueOf(id), want, `row ${id}`);
  assert.equal(valueOf(noAnswer), null, 'nothing stored, nothing backfilled');
  assert.equal(valueOf(tooLarge), null, 'the too-large marker has no parse');
  assert.equal(valueOf(malformed), null, 'malformed JSON is not an error, and is not a value');
  raw.close();
});

test('migration 24 leaves a resolved release null, because its answer was cleared when it matched', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 23));
  raw.exec(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('tv', 'f', 'http://f', 1, 1);
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution, lookup_json)
      VALUES (1, 'The.Bear.S03E01.2160p.WEB.h265-ETHEL.mkv', 'http://a', 1, 1, 'torrent', 'resolved', NULL);
  `);
  migrateHost(raw);
  const row = raw.prepare('SELECT video_resolution FROM rss_item WHERE id = 1').get() as { video_resolution: unknown };
  assert.equal(row.video_resolution, null, 'the filename says 2160p, but the migration reads only a stored answer');
  raw.close();
});

test("migration 24 moves a backfilled row's updated_at, so an /api cursor reader sees the new value, and leaves the rest", () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 23));
  raw.exec("INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('tv', 'f', 'http://f', 1, 1)");
  const insert = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution, lookup_json)
    VALUES (1, ?, ?, 1, 1, 'torrent', 'unresolved', ?)
  `);
  const backfilled = Number(insert.run('a.mkv', 'http://a', '{"parsed":{"quality":{"resolution":"1080p"}}}').lastInsertRowid);
  const untouched = Number(insert.run('b.mkv', 'http://b', '{"parsed":{"quality":{"resolution":"4K"}}}').lastInsertRowid);
  const startedAt = Date.now();
  migrateHost(raw);

  const read = raw.prepare('SELECT updated_at FROM rss_item WHERE id = ?');
  const updatedAt = (id: number): number => Number((read.get(id) as { updated_at: unknown }).updated_at);
  // SQLite's clock and this process's are the same wall clock, in ms; a
  // second of slack covers `subsec` rounding without admitting the seed.
  assert.ok(updatedAt(backfilled) >= startedAt - 1000, `the backfilled row moved past its seeded 1 (got ${updatedAt(backfilled)})`);
  assert.equal(updatedAt(untouched), 1, 'a row the backfill did not change keeps its updated_at');
  raw.close();
});
