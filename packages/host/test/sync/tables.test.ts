import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { HOST_SYNCED_TABLES, readHostRows } from '../../src/sync/tables.ts';
import { syncedTriggerNames } from '../../src/sync/log.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { redactUrl } from '../../src/clients/redact.ts';
import type {
  DownloadClientSyncRead,
  FilepathMappingSyncRead,
  MediaItemSyncRead,
  PluginDestinationSyncRead,
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
  // `download_client` was the seventh name on this list and is not on it any
  // more -- it joined the synced set in this slice. It is off the list
  // because it stopped belonging on it, not to make room: since migration 14
  // the row holds no credential *value* at all, only the `secret` names that
  // resolve to one, and `selectSql` projects neither of those names. The six
  // below each still hold a value. The two guarantees that replaced
  // `download_client`'s entry here are pinned by their own tests further
  // down -- the projection's key set, and the url normalisation -- because a
  // table being synced is now the premise rather than the violation.
  for (const forbidden of ['auth_user', 'auth_session', 'auth_account', 'auth_verification', 'host_state', 'secret']) {
    assert.ok(!HOST_SYNCED_TABLES.includes(forbidden), `${forbidden} must never be synced`);
  }
});

test('download_client is one of the ten host synced tables', () => {
  // The bootstrap assertion for the download-clients slice, and the first
  // comment here was
  // wrong about why -- recorded because the wrong version is the plausible
  // one. It claimed the projection tests would stay green without this
  // entry, since `readHostRows` dispatches on `selectSql` having a `case`
  // rather than on this export. They do not: they read through
  // `createSyncRegistry`, which routes on `HOST_SYNCED_TABLES.includes` and
  // answers `{}` for a table it does not know, so they red on a missing row.
  //
  // Measured in that slice, dropping `'download_client'` from the list and
  // running this file: **8 red, 16 green**. This one, the six
  // `download_client`
  // projection tests, and the read-shape set comparison. The test that does
  // *not* notice is "every host synced table has all three triggers" -- it
  // iterates this very list, so deleting an entry deletes its check. That is
  // the blind spot this assertion covers, and it is a different one from the
  // one first written down here.
  assert.ok(HOST_SYNCED_TABLES.includes('download_client'),
    'download_client must be synced -- a settings list reads it from the replica');
  assert.equal(HOST_SYNCED_TABLES.length, 10,
    'the host syncs ten of its own tables; an eleventh needs a read shape, a migration and a decision');
});

test('filepath_mapping is the ninth host synced table', () => {
  // The bootstrap assertion for the path-mappings slice, the same shape the
  // one above has for the download-clients slice -- and it covers the same
  // blind spot, because "every host synced table has all three triggers"
  // iterates this list and so cannot see an entry that is missing.
  //
  // Measured, dropping `'filepath_mapping'` from the list and running this
  // file: **4 red, 22 green** -- this one, the length assertion above, `a
  // filepath mapping reaches a client as both of its paths and nothing
  // else` (which reads through `createSyncRegistry` and so gets `{}`), and
  // `every host synced table has a read shape in the contract`.
  //
  // **Two tests that look like they should notice do not, and the reason is
  // the blind spot rather than a gap in them.** `each host projection and
  // its contract read shape name exactly the same fields` and `every column
  // a host table projects reaches the wire in camelCase` both iterate this
  // list through `projectionsOf`, so deleting an entry deletes its check --
  // exactly as the triggers test does. A first draft of this comment
  // predicted the opposite for the first of them and was wrong; the
  // measurement is what replaced the guess.
  assert.ok(HOST_SYNCED_TABLES.includes('filepath_mapping'),
    'filepath_mapping must be synced -- the mappings under each client are read from the replica');
});

test('plugin_destination is the tenth host synced table', () => {
  // The bootstrap assertion for the importer slice, the same shape the two
  // above have -- and it covers the same blind spot, because every test that
  // iterates `HOST_SYNCED_TABLES` loses its check for an entry that is
  // missing rather than failing over it.
  //
  // Measured, dropping `'plugin_destination'` from the list and running this
  // file: **4 red, 24 green** -- this one, the length assertion above, `a
  // destination reaches a client as its root, shape and unmatched
  // directory`, and `every host synced table has a read shape in the
  // contract`.
  assert.ok(HOST_SYNCED_TABLES.includes('plugin_destination'),
    'plugin_destination must be synced -- the settings screen reads each library root from the replica');
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
function seedFeed(
  raw: ReturnType<typeof openTestDatabase>['raw'],
  overrides: { url?: string; id?: number },
): void {
  // `id` is an override so one test can seed two feeds and compare them --
  // a redacted url against an untouched one in the same read, which is what
  // shows the rule discriminates rather than masks everything.
  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at)
    VALUES (?, 'tv', 'a feed', ?, 10, 20)
  `).run(overrides.id ?? 1, overrides.url ?? 'https://tracker.example/rss');
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

test('a passkey-bearing url IS redacted now, which is issue #78 closing', () => {
  // This test used to assert the opposite, and said so: "when #78 broadens
  // `redactUrl` this test fails -- which is the point: the gap closing must
  // be observable rather than silent. Do not 'fix' this by changing the
  // expectation; change it when #78 changes the behaviour, and say so
  // there." This is that change.
  //
  // **It did not fail, and that is worth recording.** Its fixture was
  // `passkey=SECRET` -- six characters. #78 closed by matching what a
  // credential *looks like* (8+ hex, or 8+ alphanumerics with two of each
  // class), and `SECRET` trips neither, so the gap closed underneath a test
  // written to observe it and nothing went red. A placeholder short enough
  // to be obviously fake was also short enough to be invisible to the rule.
  // The fixture below is a realistic 32-hex passkey for that reason.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedFeed(raw, { url: 'https://tracker.example/rss?passkey=9f8e7d6c5b4a39281706f5e4d3c2b1a0' });
  const rows = registry.readRows(raw, 'rss_feed', [1]);
  assert.equal(
    rowUrl(rows[1]),
    'https://tracker.example/rss?passkey=*****',
    'the value is masked; the parameter name and the url around it survive',
  );
});

test('a passkey embedded in the path is redacted too, which no parameter list could reach', () => {
  // The case #78 called the reason it "is not a one-line fix": there is no
  // parameter to strip. The module doc used to argue this was undetectable
  // in principle -- "nothing about a string distinguishes a secret segment
  // from a category slug" -- which is true of a *name* rule and not of a
  // shape rule. The second assertion is the other half: an ordinary slug is
  // left alone, so the shape rule is doing discrimination rather than
  // blanket masking.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedFeed(raw, { url: 'https://tr.example/announce/9f8e7d6c5b4a39281706f5e4d3c2b1a0/rss' });
  seedFeed(raw, { url: 'https://tr.example/category/tv-shows/rss', id: 2 });
  const rows = registry.readRows(raw, 'rss_feed', [1, 2]);
  assert.equal(rowUrl(rows[1]), 'https://tr.example/announce/*****/rss');
  assert.equal(rowUrl(rows[2]), 'https://tr.example/category/tv-shows/rss', 'a slug is not a secret');
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
 * Inserts one `download_client` row (id 1) with every column named, so a test
 * varies only the url it is about.
 *
 * The two secret-name columns are filled with a recognisable literal prefix
 * (`b2f1c0de`) rather than left null. A null column still produces a *key* in
 * a `SELECT`'s result, so a key-set assertion catches a projection that names
 * the column either way -- but only a non-null value catches the other half,
 * a projection that names it and happens to be read on a row where it is
 * null. `username` is filled for the opposite reason: it is projected on
 * purpose, and a null there would make "it is on the wire" unobservable.
 */
function seedDownloadClient(
  raw: ReturnType<typeof openTestDatabase>['raw'],
  overrides: { url?: string },
): void {
  raw.prepare(`
    INSERT INTO download_client (
      id, name, type, implementation, url, api_key_secret_name, username,
      password_secret_name, category, import_mode, created_at, updated_at
    ) VALUES (
      1, 'qbit', 'torrent', 'qbittorrent', ?,
      'b2f1c0de-0000-4000-8000-000000000001', 'admin',
      'b2f1c0de-0000-4000-8000-000000000002', 'tv', 'copy', 10, 20
    )
  `).run(overrides.url ?? 'http://qbit.local:8080');
}

/**
 * Reads `url` off a projected `download_client` row, narrowed rather than
 * cast, the way `rowUrl` above does for a feed. Separate from `rowUrl` only
 * because this one must accept `''`, which is a legitimate projection here
 * (see `readHostRows`) and is never one for a feed.
 */
function clientUrl(row: unknown): string {
  if (typeof row !== 'object' || row === null || !('url' in row) || typeof row.url !== 'string') {
    throw new Error('download_client projection has no string url');
  }
  return row.url;
}

test('a download client reaches a client with its address and neither of its secret names', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedDownloadClient(raw, {});

  const row = registry.readRows(raw, 'download_client', [1])[1];
  if (typeof row !== 'object' || row === null) {
    throw new Error('download_client projection is not an object');
  }
  assert.deepEqual(
    Object.keys(row).toSorted(),
    ['category', 'createdAt', 'id', 'implementation', 'name', 'type', 'updatedAt', 'url', 'username'],
    'design spec §5 names exactly these nine',
  );

  // Both spellings, and then the contents. The key-set assertion above
  // already fails on an extra key, but it fails with a nine-name diff that
  // does not say *which* door opened; these two do. And they are checked
  // under both the aliased and the raw column name because the alias is this
  // module's own choice -- a `SELECT api_key_secret_name` with no `AS` would
  // satisfy an `apiKeySecretName` check and still put the name on the wire.
  for (const forbidden of [
    'apiKeySecretName', 'api_key_secret_name', 'passwordSecretName', 'password_secret_name',
  ]) {
    assert.ok(!(forbidden in row), `download_client.${forbidden} must never be projected`);
  }
  // The content check the two above cannot make: a secret name reaching the
  // wire under some third spelling. The fixture's prefix is what is looked
  // for, and the failure message deliberately does not quote what was found.
  assert.ok(!JSON.stringify(row).includes('b2f1c0de'),
    'a secret name reached the wire under a name this test does not enumerate');

  // Values, not only names, and as one object rather than field by field:
  // reading `row.username` off an `unknown` would need a cast, and the whole
  // object is a stronger assertion anyway. `username` is here on purpose --
  // it is plaintext because a username is not a credential (`db/schema.ts`)
  // -- and `url` is the seed's default put through the normalisation, which
  // gives the root path the parser supplies.
  assert.deepEqual(row, {
    id: 1,
    name: 'qbit',
    type: 'torrent',
    implementation: 'qbittorrent',
    url: 'http://qbit.local:8080/',
    username: 'admin',
    category: 'tv',
    createdAt: 10,
    updatedAt: 20,
  });
});

test('a download client url reaches the replica as origin and path, with userinfo, query and fragment gone', () => {
  // The guarantee design spec §5 is built on, and the one place this slice is
  // safer than the feeds slice it copies. Three absence assertions before the
  // equality, each naming the part of the url it guards: a lone `assert.equal`
  // reds for any of the three and reports only that two strings differ, which
  // is the least useful thing it could say about a partial normalisation.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedDownloadClient(raw, { url: 'http://user:hunter2@qbit.local:8080/base?token=abc#frag' });

  const url = clientUrl(registry.readRows(raw, 'download_client', [1])[1]);

  assert.ok(!url.includes('hunter2'), 'userinfo must be dropped -- this is the case redactUrl would pass through intact');
  assert.ok(!url.includes('token'), 'the query string must be dropped, parameter name and all');
  assert.ok(!url.includes('frag'), 'the fragment must be dropped');
  assert.equal(url, 'http://qbit.local:8080/base',
    'origin and path, nothing else -- host and port are the address and must survive');
});

test('redactUrl would not have caught the userinfo this projection drops', () => {
  // Not a test of this module: a test of the premise the module doc argues
  // from. The doc says `origin + pathname` is stronger than the feeds
  // precedent *because* `redactUrl` returns `http://user:hunter2@qbit:8080`
  // unchanged, and an argued reason is exactly what this codebase has found
  // to be wrong most often. So construct it rather than assert it in prose.
  // If issue #78 ever widens `redactUrl` to cover userinfo, this reds and the
  // docblock's contrast needs rewording -- which is the point.
  assert.equal(
    redactUrl('http://user:hunter2@qbit.local:8080/base?token=abc#frag'),
    'http://user:hunter2@qbit.local:8080/base?token=abc#frag',
    'redactUrl knows one query parameter name and nothing structural',
  );
});

test('a url that does not parse projects as the empty string, and the row still travels', () => {
  // The deliberate decision, stated in `sync/tables.ts`'s docblock: the row
  // reaches the replica with no address rather than the sync throwing, and
  // rather than the row being dropped. Both alternatives were available and
  // both are worse -- a throw takes down a whole page of unrelated rows, and
  // a dropped row leaves `torrent_download.downloadClientId` pointing at
  // something the client will never learn exists.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedDownloadClient(raw, { url: 'not a url at all' });

  const rows = registry.readRows(raw, 'download_client', [1]);
  assert.deepEqual(Object.keys(rows), ['1'], 'the row is still in the page, not dropped from it');
  assert.equal(clientUrl(rows[1]), '', 'no address, rather than a throw or a missing row');
  // The whole row, so "the rest of it is unaffected" is asserted rather than
  // sampled: an implementation that blanked more than the url would pass a
  // check on `name` alone.
  assert.deepEqual(rows[1], {
    id: 1,
    name: 'qbit',
    type: 'torrent',
    implementation: 'qbittorrent',
    url: '',
    username: 'admin',
    category: 'tv',
    createdAt: 10,
    updatedAt: 20,
  });
});

test('a url that parses but names no host projects as the empty string, not the literal `null8080`', () => {
  // The case `URL.parse` returning non-null does *not* rule out, measured by
  // task 1 and recorded in `clients/add.ts`'s `isClientAddress`:
  // `URL.parse('qbit.example:8080')` succeeds with scheme `qbit.example:`,
  // `hostname: ''` and `origin: 'null'`. A projection guarded only on
  // `parsed !== null` would build `origin + pathname` out of those and put
  // the eight characters `null8080` in front of an operator as an address --
  // eight, as `clientAddress`'s own docblock says; "six" here was a
  // miscount, and the test comment contradicting the code it tests is
  // exactly the drift this file exists to stop.
  // This is the whole reason the guard here is on the scheme rather than on
  // parsing, and it is constructed rather than argued.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedDownloadClient(raw, { url: 'qbit.example:8080' });

  const url = clientUrl(registry.readRows(raw, 'download_client', [1])[1]);
  assert.ok(!url.includes('null'), 'an opaque origin must not be serialised into the address');
  assert.equal(url, '');
});

test('a download client url keeps a base path and a trailing slash exactly as the origin and path give them', () => {
  // The other half of the normalisation, and the one a too-eager
  // implementation breaks: a reverse-proxied client lives at a base path, and
  // dropping it would give the replica an address that names the wrong
  // service. `URL`'s own parse is what decides this, so the assertion is on
  // the two shapes that differ.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedDownloadClient(raw, { url: 'https://box.example/qbittorrent/' });

  assert.equal(clientUrl(registry.readRows(raw, 'download_client', [1])[1]), 'https://box.example/qbittorrent/');
});

test('a download client url with no path at all projects the root path the parser gives it', () => {
  // `new URL('http://qbit.local:8080').pathname` is `'/'`, not `''`, so the
  // projection of the most ordinary address this field ever holds is
  // `http://qbit.local:8080/`. Pinned because it is the default every other
  // test in this file seeds, and because "the url comes back unchanged" is
  // the wrong expectation to carry into a review of this module.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  seedDownloadClient(raw, { url: 'http://qbit.local:8080' });

  assert.equal(clientUrl(registry.readRows(raw, 'download_client', [1])[1]), 'http://qbit.local:8080/');
});

test('a filepath mapping reaches a client as both of its paths and nothing else', () => {
  // **The one projection in this module that carries a path on purpose**,
  // which is why it gets a test of its own rather than only the key-set
  // comparison at the bottom of this file. `selectSql`'s own doc refuses
  // `storage_path` outright, and design spec §5 amends that rule rather than
  // breaking it: a `storage_path` is *discovered* -- the client reports
  // where it happened to put a file -- and a mapping is *dictated*, both
  // halves typed by the operator into the screen that reads them back.
  //
  // Both values are asserted literally rather than read back through
  // anything that built them, and neither is a prefix of the other, so a
  // projection that swapped `from_path` and `to_path` fails here.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seedDownloadClient(raw, {});
  raw.prepare(`
    INSERT INTO filepath_mapping (id, download_client_id, from_path, to_path, created_at, updated_at)
    VALUES (1, 1, '/downloads/tv', '/srv/media', 10, 20)
  `).run();

  const registry = createSyncRegistry(raw, []);
  const row = registry.readRows(raw, 'filepath_mapping', [1])[1];
  assert.deepEqual(row, {
    id: 1, downloadClientId: 1, fromPath: '/downloads/tv', toPath: '/srv/media',
    createdAt: 10, updatedAt: 20,
  });
});

test('a destination reaches a client as its root, shape and unmatched directory', () => {
  // The second projection here that carries a path on purpose, on exactly
  // the distinction the mapping test above draws: a root is *dictated* --
  // the operator types it into the settings screen that then reads it back
  // -- where `storage_path` is *discovered* and stays out. Design spec §3.
  //
  // All three strings are asserted literally, and none is a prefix or a
  // rearrangement of another, so a projection that aliased `unmatched_dir`
  // onto `shape` (or swapped any pair) fails here rather than passing the
  // key-set comparison at the bottom of this file, which only checks names.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.prepare(`
    INSERT INTO plugin_destination (id, plugin_id, root, shape, unmatched_dir, created_at, updated_at)
    VALUES (1, 'movie', '/srv/films', '{title} ({year})/{title}.{ext}', '_pickarr/unmatched', 10, 20)
  `).run();

  const registry = createSyncRegistry(raw, []);
  const row = registry.readRows(raw, 'plugin_destination', [1])[1];
  assert.deepEqual(row, {
    id: 1,
    pluginId: 'movie',
    root: '/srv/films',
    shape: '{title} ({year})/{title}.{ext}',
    unmatchedDir: '_pickarr/unmatched',
    createdAt: 10,
    updatedAt: 20,
  });
});

/**
 * One row in every host synced table, with every nullable column filled, so a
 * projection's key set can be read off a real row rather than declared.
 *
 * Every value is non-null on purpose. `node:sqlite` returns a key for a null
 * column too, so `Object.keys` would be the same either way -- but the
 * read-shape comparison below is about names, and a fixture whose nulls were
 * accidental would make a *type* mismatch on a nullable field invisible if
 * that comparison is ever widened past names. `download_client` and
 * `rss_feed` are both seeded as FK parents -- the two downloads'
 * `download_client_id` and `rss_item.feed_id` -- but neither is *only* that
 * any more: both are in `HOST_SYNCED_TABLES` and each gets its own row read
 * back like every other table in the loop. `download_client` was the last
 * unsynced parent, which is what made `downloadClientId` unresolvable in the
 * contract until this slice.
 *
 * `seedDownloadClient` writes that row, so the two secret-name columns and
 * `username` are filled here for the same "every nullable column filled"
 * reason -- and so the projection tests above and this one cannot disagree
 * about what a row looks like.
 */
function seedOneRowPerSyncedTable(raw: ReturnType<typeof openTestDatabase>['raw']): void {
  seedDownloadClient(raw, {});
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
  raw.prepare(`
    INSERT INTO filepath_mapping (id, download_client_id, from_path, to_path, created_at, updated_at)
    VALUES (1, 1, '/downloads', '/media', 10, 20)
  `).run();
  raw.prepare(`
    INSERT INTO plugin_destination (id, plugin_id, root, shape, unmatched_dir, created_at, updated_at)
    VALUES (1, 'tv', '/library/tv', '{series}/Season {season}/{series} - S{season}E{episode}.{ext}', '_unmatched', 10, 20)
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
 * *names* in these ten objects are `@pickarr/contract`'s ten host shapes,
 * mechanically, and the test below compares them against what the ten
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
  download_client: {
    id: true, name: true, type: true, implementation: true, url: true,
    username: true, category: true, createdAt: true, updatedAt: true,
  } satisfies Record<keyof DownloadClientSyncRead, true>,
  filepath_mapping: {
    id: true, downloadClientId: true, fromPath: true, toPath: true,
    createdAt: true, updatedAt: true,
  } satisfies Record<keyof FilepathMappingSyncRead, true>,
  plugin_destination: {
    id: true, pluginId: true, root: true, shape: true, unmatchedDir: true,
    createdAt: true, updatedAt: true,
  } satisfies Record<keyof PluginDestinationSyncRead, true>,
};

test('every host synced table has a read shape in the contract', () => {
  // The set, before the fields: an eleventh synced table added with no shape
  // would leave a client back on `unknown` for it, which is the state this
  // whole comparison exists to end -- `rss_feed` was the seventh,
  // `download_client` the eighth, `filepath_mapping` the ninth and
  // `plugin_destination` the tenth, and this guard is what each had to pass.
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
