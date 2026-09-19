import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { HOST_SYNCED_TABLES, readHostRows } from '../../src/sync/tables.ts';
import { syncedTriggerNames } from '../../src/sync/log.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import type {
  MediaItemSyncRead,
  NzbDownloadSyncRead,
  PersonSyncRead,
  RoleSyncRead,
  RssFeedSyncRead,
  RssItemSyncRead,
  TorrentDownloadSyncRead,
} from '@pickarr/contract';

test('every host synced table has all three triggers after migration', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const present = new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
  for (const table of HOST_SYNCED_TABLES) {
    for (const name of syncedTriggerNames(table)) {
      assert.ok(present.has(name), `${table} is synced but ${name} does not exist`);
    }
  }
});

test('no credential-bearing table is synced', () => {
  for (const forbidden of ['auth_user', 'auth_session', 'auth_account', 'auth_verification', 'host_state', 'secret', 'download_client']) {
    assert.ok(!HOST_SYNCED_TABLES.includes(forbidden), `${forbidden} must never be synced`);
  }
});

test('every synced table has an integer primary key named id', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  for (const table of HOST_SYNCED_TABLES) {
    const pk = raw.prepare(`PRAGMA table_info(${table})`).all()
      .filter((r) => Number((r as { pk: unknown }).pk) > 0)
      .map((r) => String((r as { name: unknown }).name));
    assert.deepEqual(pk, ['id'], `${table}'s primary key must be a single column named id`);
  }
});

test('a log row can hold nothing but a table name, a row id, an op and a time', () => {
  // Spec 7.17. Structural rather than behavioural: the guarantee that no
  // credential or url reaches the log is the table's shape, so assert the
  // shape. A column added here later would need this test changed, which is
  // the point.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  assert.deepEqual(
    raw.prepare('PRAGMA table_info(sync_log)').all().map((r) => String((r as { name: unknown }).name)),
    ['id', 'table_name', 'row_id', 'op', 'at'],
  );
});

test('readHostRows projects the declared columns for media_item, keyed by id', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, title, created_at, updated_at, provider, provider_ref)
    VALUES (1, 'alpha', 'The Grid', 10, 20, 'tmdb', 'movie:512')
  `).run();
  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, title, created_at, updated_at)
    VALUES (2, 'alpha', 'Encom', 30, 40)
  `).run();

  const rows = readHostRows(raw, 'media_item', [1, 2]);
  assert.deepEqual(Object.keys(rows).toSorted(), ['1', '2']);
  assert.deepEqual(rows[1], {
    id: 1, pluginId: 'alpha', createdAt: 10, updatedAt: 20,
    provider: 'tmdb', providerRef: 'movie:512', title: 'The Grid',
    releaseDate: null, description: null,
  });
  assert.deepEqual(rows[2], {
    id: 2, pluginId: 'alpha', createdAt: 30, updatedAt: 40,
    provider: null, providerRef: null, title: 'Encom',
    releaseDate: null, description: null,
  });
});

test('readHostRows projects the declared columns for person, and skips an id that does not exist', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.prepare(`
    INSERT INTO person (id, name, provider_ref, created_at, updated_at)
    VALUES (1, 'Kevin Flynn', 'tmdb:1', 10, 20)
  `).run();

  const rows = readHostRows(raw, 'person', [1, 999]);
  assert.deepEqual(Object.keys(rows), ['1']);
  assert.deepEqual(rows[1], {
    id: 1, name: 'Kevin Flynn', providerRef: 'tmdb:1', createdAt: 10, updatedAt: 20,
  });
});

test('readHostRows never touches the database for an empty ids array', () => {
  // No migration has run, so `media_item` does not exist. If this ever
  // issued a query it would throw "no such table: media_item" -- returning
  // {} cleanly is what proves the early return actually fires before SQL.
  const { raw } = openTestDatabase();
  assert.deepEqual(readHostRows(raw, 'media_item', []), {});
});

test('readHostRows refuses a table outside HOST_SYNCED_TABLES', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  assert.throws(() => readHostRows(raw, 'secret', [1]), /secret/);
});

test('readHostRows never projects a path, a url or a credential-bearing column', () => {
  // Regression coverage for two review findings: `storage_path` is a
  // filesystem path (schema.ts's own words), and `link`/`guid` can carry a
  // private tracker's passkey (`api/server.ts`'s module doc; `guid` falls
  // back to `link` verbatim in `feeds/parse-rss.ts` when a feed omits its
  // own `<guid>`). `last_error` is redacted of a credential's *value* only
  // (`clients/redact.ts`'s `redactUrl`), not of the url or path around it.
  // Every value below is deliberately shaped like the thing that must never
  // reach a client, so a regression that reintroduces any of them fails on
  // its actual content, not only on the key existing.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, category, import_mode, created_at, updated_at)
    VALUES (1, 'sab', 'sabnzbd', 'http://localhost:8080', 'movies', 'move', 10, 10)
  `).run();
  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, download_client_id, created_at, updated_at, download_type)
    VALUES (1, 'tv', 'a feed', 'https://example.test/feed?apikey=shh', 1, 10, 10, 'torrent')
  `).run();
  raw.prepare(`
    INSERT INTO rss_item (
      id, feed_id, filename, link, guid, created_at, updated_at, download_type, resolution
    ) VALUES (
      1, 1, 'The.Grid.mkv', 'https://tracker.example/dl?passkey=abc123', 'https://tracker.example/dl?passkey=abc123',
      10, 20, 'torrent', '1080p'
    )
  `).run();
  raw.prepare(`
    INSERT INTO torrent_download (
      id, rss_item_id, download_client_id, status, last_error, storage_path, created_at, updated_at
    ) VALUES (
      1, 1, 1, 'failed', 'connect to http://tracker.example/announce?apikey=***: /downloads/incomplete/x.mkv not writable',
      '/downloads/incomplete/x.mkv', 10, 20
    )
  `).run();
  raw.prepare(`
    INSERT INTO nzb_download (
      id, rss_item_id, download_client_id, status, last_error, storage_path, created_at, updated_at
    ) VALUES (
      1, 1, 1, 'failed', 'connect to http://sab.example/api?apikey=***: /downloads/incomplete/y.nzb not writable',
      '/downloads/incomplete/y.nzb', 10, 20
    )
  `).run();

  const rssItem = readHostRows(raw, 'rss_item', [1])[1] as Record<string, unknown>;
  assert.deepEqual(Object.keys(rssItem).toSorted(), [
    'createdAt', 'deliveredAt', 'downloadType', 'feedId', 'filename',
    'id', 'mediaItemId', 'rankingScore', 'resolution', 'resolutionDetail', 'updatedAt',
  ]);
  assert.ok(!('link' in rssItem), 'rss_item.link must never be projected');
  assert.ok(!('guid' in rssItem), 'rss_item.guid must never be projected');

  const torrent = readHostRows(raw, 'torrent_download', [1])[1] as Record<string, unknown>;
  assert.deepEqual(Object.keys(torrent).toSorted(), [
    'absentSince', 'attempts', 'clientRef', 'createdAt', 'deliveredAt', 'downloadClientId',
    'id', 'infohash', 'percentage', 'reclaimedAt', 'rssItemId', 'status', 'updatedAt',
  ]);
  assert.ok(!('storagePath' in torrent), 'torrent_download.storage_path must never be projected');
  assert.ok(!('lastError' in torrent), 'torrent_download.last_error must never be projected');

  const nzb = readHostRows(raw, 'nzb_download', [1])[1] as Record<string, unknown>;
  assert.deepEqual(Object.keys(nzb).toSorted(), [
    'absentSince', 'attempts', 'clientRef', 'createdAt', 'deliveredAt', 'downloadClientId',
    'id', 'percentage', 'reclaimedAt', 'rssItemId', 'status', 'updatedAt',
  ]);
  assert.ok(!('storagePath' in nzb), 'nzb_download.storage_path must never be projected');
  assert.ok(!('lastError' in nzb), 'nzb_download.last_error must never be projected');
});

/** Inserts one `rss_feed` row (id 1) with sensible defaults, so a test names only the column it is testing. */
function seedFeed(raw: ReturnType<typeof openTestDatabase>['raw'], overrides: { url?: string }): void {
  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at)
    VALUES (1, 'tv', 'a feed', ?, 10, 20)
  `).run(overrides.url ?? 'https://tracker.example/rss');
}

/**
 * Reads `url` off a projected row, narrowed with `typeof`/`in` -- the way
 * `useCounts.ts`'s `categoryOf` narrows -- rather than a cast: `readHostRows`
 * hands back `unknown`, and this is a test asserting on its shape, not
 * assuming it.
 */
function rowUrl(row: unknown): string {
  if (typeof row !== 'object' || row === null || !('url' in row) || typeof row.url !== 'string') {
    throw new Error('rss_feed projection has no string url');
  }
  return row.url;
}

test('a feed reaches a client with its apikey redacted', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedFeed(raw, { url: 'https://tracker.example/rss?apikey=SECRET' });
  const rows = registry.readRows(raw, 'rss_feed', [1]);
  assert.equal(rowUrl(rows[1]), 'https://tracker.example/rss?apikey=***');
});

test('a passkey-bearing url is NOT redacted today, and this pins that', () => {
  // Deliberate, and the most important test in this task. `redactUrl` knows
  // one parameter name. Issue #78 broadens it, and when it does this test
  // fails -- which is the point: the gap closing must be observable rather
  // than silent. Do not "fix" this by changing the expectation; change it
  // when #78 changes the behaviour, and say so there.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedFeed(raw, { url: 'https://tracker.example/rss?passkey=SECRET' });
  const rows = registry.readRows(raw, 'rss_feed', [1]);
  assert.equal(
    rowUrl(rows[1]),
    'https://tracker.example/rss?passkey=SECRET',
    'redactUrl does not know `passkey`; issue #78 tracks it',
  );
});

test('the projection carries no column the client has no business holding', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedFeed(raw, {});
  const row = registry.readRows(raw, 'rss_feed', [1])[1];
  // Narrowed to `object` with `typeof`/`null` -- enough for `Object.keys`,
  // and no cast needed for it the way `Record<string, unknown>` would be.
  if (typeof row !== 'object' || row === null) {
    throw new Error('rss_feed projection is not an object');
  }
  assert.deepEqual(
    Object.keys(row).toSorted(),
    ['createdAt', 'downloadClientId', 'downloadType', 'id', 'name', 'pluginId', 'pollIntervalS', 'updatedAt', 'url'],
  );
});

/**
 * One row in every host synced table, with every nullable column filled, so a
 * projection's key set can be read off a real row rather than declared.
 *
 * Every value is non-null on purpose. `node:sqlite` returns a key for a null
 * column too, so `Object.keys` would be the same either way -- but the
 * read-shape comparison below is about names, and a fixture whose nulls were
 * accidental would make a *type* mismatch on a nullable field invisible if
 * that comparison is ever widened past names. `download_client` is seeded as
 * an FK parent because the two downloads' `download_client_id` is a
 * `NOT NULL` reference to it and it is not itself synced, which is the point
 * `downloadClientId` carries in the contract. `rss_feed` is seeded for the
 * same FK reason -- `rss_item.feed_id` -- but is no longer an unsynced
 * parent itself: it is one of `HOST_SYNCED_TABLES` below and gets its own
 * row read back like every other table in the loop.
 */
function seedOneRowPerSyncedTable(raw: ReturnType<typeof openTestDatabase>['raw']): void {
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, category, import_mode, created_at, updated_at)
    VALUES (1, 'sab', 'sabnzbd', 'http://localhost:8080', 'movies', 'move', 10, 10)
  `).run();
  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, download_client_id, created_at, updated_at, download_type)
    VALUES (1, 'tv', 'a feed', 'https://example.test/feed', 1, 10, 10, 'torrent')
  `).run();
  raw.prepare(`
    INSERT INTO media_item (
      id, plugin_id, created_at, updated_at, provider, provider_ref, title, release_date, description
    ) VALUES (1, 'tv', 10, 20, 'tmdb', 'show:512', 'The Grid', '1982-07-09', 'A programmer.')
  `).run();
  raw.prepare(`
    INSERT INTO rss_item (
      id, feed_id, filename, link, guid, created_at, updated_at, download_type, media_item_id,
      ranking_score, resolution, resolution_detail, delivered_at
    ) VALUES (
      1, 1, 'The.Grid.mkv', 'https://tracker.example/dl', 'guid-1', 10, 20, 'torrent', 1,
      42, 'resolved', 'season pack', 30
    )
  `).run();
  raw.prepare(`
    INSERT INTO torrent_download (
      id, rss_item_id, download_client_id, infohash, client_ref, status, attempts, last_error,
      storage_path, created_at, updated_at, percentage, absent_since, delivered_at, reclaimed_at
    ) VALUES (1, 1, 1, 'abc123', 'ref-1', 'completed', 1, 'none', '/downloads/x.mkv', 10, 20, 100, 30, 40, 50)
  `).run();
  raw.prepare(`
    INSERT INTO nzb_download (
      id, rss_item_id, download_client_id, client_ref, status, attempts, last_error,
      storage_path, created_at, updated_at, percentage, absent_since, delivered_at, reclaimed_at
    ) VALUES (1, 1, 1, 'ref-2', 'completed', 1, 'none', '/downloads/y.nzb', 10, 20, 100, 30, 40, 50)
  `).run();
  raw.prepare(`
    INSERT INTO person (id, name, provider_ref, created_at, updated_at)
    VALUES (1, 'Kevin Flynn', 'tmdb:1', 10, 20)
  `).run();
  raw.prepare(`
    INSERT INTO role (id, media_item_id, person_id, role, name, billing_order, created_at)
    VALUES (1, 1, 1, 'actor', 'Flynn', 0, 10)
  `).run();
}

/** The projection of row 1 from each host synced table, keyed by table name. */
function projectionsOf(raw: ReturnType<typeof openTestDatabase>['raw']): Map<string, Record<string, unknown>> {
  const projections = new Map<string, Record<string, unknown>>();
  for (const table of HOST_SYNCED_TABLES) {
    const row = readHostRows(raw, table, [1])[1];
    if (row === undefined) throw new Error(`${table} has no row 1, so its projection cannot be read`);
    projections.set(table, row as Record<string, unknown>);
  }
  return projections;
}

test('every column a host table projects reaches the wire in camelCase', () => {
  // The whole reason these `SELECT`s carry aliases. The client's storage
  // provider is designed as one IndexedDB object store with sparse indexes on
  // `value.mediaItemId` and `value.rssItemId`, and an index key path is one
  // string for every row in the store -- so a host table spelling the field
  // `media_item_id` while a plugin table spells it `mediaItemId` cannot be
  // indexed by one path at all.
  // Asserted over every projected name rather than over the ids alone, since
  // a convention with exceptions is what a key path cannot survive.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedOneRowPerSyncedTable(raw);

  for (const [table, row] of projectionsOf(raw)) {
    for (const name of Object.keys(row)) {
      assert.ok(/^[a-z][A-Za-z0-9]*$/.test(name),
        `${table} projects ${JSON.stringify(name)}, which is not camelCase -- alias it in selectSql`);
    }
  }
});

test('the media item a row belongs to has one name across every table that names it', () => {
  // `mediaItemId` on the host's `rss_item` and `role`, and on the three plugin
  // detail shapes (`TvRead`, `MovieRead`, `XxxRead`) -- the one index key path
  // the client storage provider is planned around. `rssItemId` is the second,
  // on both download tables.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedOneRowPerSyncedTable(raw);
  const projections = projectionsOf(raw);

  for (const table of ['rss_item', 'role']) {
    assert.ok('mediaItemId' in (projections.get(table) ?? {}),
      `${table} points at a media item and must spell it mediaItemId`);
  }
  for (const table of ['torrent_download', 'nzb_download']) {
    assert.ok('rssItemId' in (projections.get(table) ?? {}),
      `${table} points at an rss item and must spell it rssItemId`);
  }
});

/**
 * One witness object per host read shape: `Record<keyof T, true>`, which the
 * compiler makes exhaustive in both directions for an object literal -- a
 * missing key is an error, and an extra one is an excess property. So the
 * *names* in these six objects are `@pickarr/contract`'s six host shapes,
 * mechanically, and the test below compares them against what the six
 * `SELECT`s actually project.
 *
 * This is `test/db/schema.test.ts`'s pattern applied to the other pair that
 * declares one thing twice. That file compares migration DDL against
 * `schema.ts` in both directions; this compares `sync/tables.ts`'s
 * projections against the read shapes a client types against, and it is the
 * only thing standing between them and the field-name drift design spec §3.7
 * calls the worst failure this design can have.
 *
 * **Which direction is mechanisable, and which is not.** Names are, and both
 * ways: the compiler holds the witness to the interface, and the assertion
 * holds the witness to the projection. Declared *types* are not -- a
 * TypeScript interface is gone at run time, so nothing here can check that
 * `RoleSyncRead.billingOrder` is `number | null` rather than `string`. Typing
 * the projection's return would not close it either: `readHostRows` hands
 * back whatever `node:sqlite` read, so a declared type there is an assertion
 * about the schema and not a check of it. What covers the types instead is
 * `test/db/schema.test.ts`, which pins every column's SQL type and
 * nullability against `schema.ts`; the gap left is a shape here disagreeing
 * with the column's type in `schema.ts`, and it is reviewed rather than
 * enforced.
 */
const HOST_READ_SHAPE_FIELDS: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  media_item: {
    id: true, pluginId: true, createdAt: true, updatedAt: true, provider: true,
    providerRef: true, title: true, releaseDate: true, description: true,
  } satisfies Record<keyof MediaItemSyncRead, true>,
  rss_item: {
    id: true, feedId: true, filename: true, createdAt: true, updatedAt: true,
    downloadType: true, mediaItemId: true, rankingScore: true, resolution: true,
    resolutionDetail: true, deliveredAt: true,
  } satisfies Record<keyof RssItemSyncRead, true>,
  torrent_download: {
    id: true, rssItemId: true, downloadClientId: true, infohash: true, clientRef: true,
    status: true, attempts: true, createdAt: true, updatedAt: true, percentage: true,
    absentSince: true, deliveredAt: true, reclaimedAt: true,
  } satisfies Record<keyof TorrentDownloadSyncRead, true>,
  nzb_download: {
    id: true, rssItemId: true, downloadClientId: true, clientRef: true,
    status: true, attempts: true, createdAt: true, updatedAt: true, percentage: true,
    absentSince: true, deliveredAt: true, reclaimedAt: true,
  } satisfies Record<keyof NzbDownloadSyncRead, true>,
  person: {
    id: true, name: true, providerRef: true, createdAt: true, updatedAt: true,
  } satisfies Record<keyof PersonSyncRead, true>,
  role: {
    id: true, mediaItemId: true, personId: true, role: true, name: true,
    billingOrder: true, createdAt: true,
  } satisfies Record<keyof RoleSyncRead, true>,
  rss_feed: {
    id: true, pluginId: true, name: true, downloadType: true, pollIntervalS: true,
    downloadClientId: true, createdAt: true, updatedAt: true, url: true,
  } satisfies Record<keyof RssFeedSyncRead, true>,
};

test('every host synced table has a read shape in the contract', () => {
  // The set, before the fields: an eighth synced table added with no shape
  // would leave a client back on `unknown` for it, which is the state this
  // whole comparison exists to end -- `rss_feed` was the seventh, and this
  // guard is what it had to pass.
  assert.deepEqual(
    Object.keys(HOST_READ_SHAPE_FIELDS).toSorted(),
    [...HOST_SYNCED_TABLES].toSorted(),
    'HOST_SYNCED_TABLES and the contract`s host read shapes must name the same tables',
  );
});

test('each host projection and its contract read shape name exactly the same fields', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedOneRowPerSyncedTable(raw);

  for (const [table, row] of projectionsOf(raw)) {
    const declared = HOST_READ_SHAPE_FIELDS[table];
    if (declared === undefined) throw new Error(`${table} has no read shape witness`);
    assert.deepEqual(
      Object.keys(row).toSorted(),
      Object.keys(declared).toSorted(),
      `${table}'s projection and its read shape must name the same fields`,
    );
  }
});
