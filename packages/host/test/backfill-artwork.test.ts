import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { lookupTableMigration } from '@pickarr/openmetadata';
import { TV_MIGRATIONS } from '@pickarr/plugin-tv';
import { migrateHost, migratePlugin } from '../src/db/migrate.ts';
import { openTestDatabase } from '../src/db/open.ts';
import { DEFAULT_MAX_ATTEMPTS } from '../src/host.ts';
import { backfillArtwork, parseArgs } from '../src/backfill-artwork.ts';

const NOW = 1_700_000_000_000;

function database(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

interface ItemInit {
  pluginId: string;
  /** `null` is a real value here -- an unresolved item -- so the helper tests for the key, not for nullishness. */
  provider?: string | null;
  providerRef?: string | null;
}

/**
 * `TV_MIGRATIONS` starts at version 2; version 1 is the engine's own
 * `tv_lookup` state table, which the version-4 backfill reads. Applied the
 * way `createLookupPlugin` orders them for real.
 */
function withTvTables(raw: DatabaseSync): void {
  migratePlugin(raw, 'tv', [lookupTableMigration('tv'), ...TV_MIGRATIONS]);
}

let nextId = 1;

/** One `media_item` row; `provider` and `providerRef` default to a resolved item. */
function item(raw: DatabaseSync, init: ItemInit): number {
  const id = nextId;
  nextId += 1;
  raw.prepare(
    'INSERT INTO media_item (id, plugin_id, created_at, updated_at, provider, provider_ref, title) VALUES (?, ?, 1, 1, ?, ?, ?)',
  ).run(
    id,
    init.pluginId,
    'provider' in init ? init.provider : 'tpdb',
    'providerRef' in init ? init.providerRef : `ref-${String(id)}`,
    `Item ${String(id)}`,
  );
  return id;
}

function person(raw: DatabaseSync, mediaItemId: number, providerRef: string, billingOrder: number): number {
  const result = raw.prepare(
    'INSERT INTO person (name, provider_ref, created_at, updated_at) VALUES (?, ?, 1, 1)',
  ).run(`Person ${providerRef}`, providerRef);
  const personId = Number(result.lastInsertRowid);
  raw.prepare(
    'INSERT INTO role (media_item_id, person_id, role, name, billing_order, created_at) VALUES (?, ?, ?, NULL, ?, 1)',
  ).run(mediaItemId, personId, 'performer', billingOrder);
  return personId;
}

interface JobRow {
  plugin_id: string;
  kind: string;
  payload_json: string;
  max_attempts: number;
  run_at: number;
  state: string;
}

function jobs(raw: DatabaseSync): JobRow[] {
  return raw.prepare(
    'SELECT plugin_id, kind, payload_json, max_attempts, run_at, state FROM jobs ORDER BY id',
  ).all() as unknown as JobRow[];
}

function payloads(raw: DatabaseSync): unknown[] {
  return jobs(raw).map((row) => JSON.parse(row.payload_json) as unknown);
}

function queueArtworkJob(raw: DatabaseSync, pluginId: string, mediaItemId: number, state: string): void {
  raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, last_error, created_at, updated_at)
    VALUES (?, 'artwork', ?, 0, 5, 1, ?, NULL, 1, 1)
  `).run(pluginId, JSON.stringify({ mediaItemId }), state);
}

test('parseArgs: --plugin is required and names the only mandatory flag', () => {
  assert.throws(() => parseArgs([]), /--plugin=<id>/);
  assert.deepEqual(parseArgs(['--plugin=xxx']), { pluginId: 'xxx', databasePath: undefined, limit: undefined, dryRun: false });
});

test('parseArgs: every flag, and a bad limit or an unknown flag is refused', () => {
  assert.deepEqual(
    parseArgs(['--plugin=tv', '--database=/tmp/p.db', '--limit=25', '--dry-run']),
    { pluginId: 'tv', databasePath: '/tmp/p.db', limit: 25, dryRun: true },
  );
  assert.throws(() => parseArgs(['--plugin=tv', '--limit=0']), /--limit must be a positive integer, got "0"/);
  assert.throws(() => parseArgs(['--plugin=tv', '--limit=ten']), /--limit must be a positive integer, got "ten"/);
  assert.throws(() => parseArgs(['--plugin=tv', '--verbose']), /Unknown argument: --verbose/);
});

test('an xxx item is queued as a scene with its cast and no parents, as a ready artwork job under the plugin id', () => {
  const raw = database();
  const mediaItemId = item(raw, { pluginId: 'xxx', provider: 'tpdb', providerRef: '77d5c67b-f51c-4019-8bc5-c420f3c965e2' });
  // Inserted so that id order (c, a, b), reverse id order (b, a, c) and
  // billing order (a, b, c) are three different sequences -- a query that
  // sorted by anything but billing would fail the expectation below.
  const third = person(raw, mediaItemId, 'performer-c', 3);
  const first = person(raw, mediaItemId, 'performer-a', 1);
  const second = person(raw, mediaItemId, 'performer-b', 2);

  const report = backfillArtwork(raw, { pluginId: 'xxx', dryRun: false, now: () => NOW });

  assert.deepEqual(report, { candidates: 1, queued: 1, alreadyQueued: 0 });
  const [row] = jobs(raw);
  assert.ok(row !== undefined);
  assert.equal(row.plugin_id, 'xxx');
  assert.equal(row.kind, 'artwork');
  assert.equal(row.state, 'ready');
  assert.equal(row.max_attempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(row.run_at, NOW);
  assert.deepEqual(JSON.parse(row.payload_json), {
    mediaItemId,
    kind: 'scene',
    provider: 'tpdb',
    providerRef: '77d5c67b-f51c-4019-8bc5-c420f3c965e2',
    // Billing order, the order `attachPeople` wrote them in.
    people: [
      { personId: first, providerRef: 'performer-a' },
      { personId: second, providerRef: 'performer-b' },
      { personId: third, providerRef: 'performer-c' },
    ],
    parents: [],
  });
});

test('a movie item is queued as kind movie with no parents', () => {
  const raw = database();
  const mediaItemId = item(raw, { pluginId: 'movie', provider: 'tmdb', providerRef: 'tmdb:movie:335984' });

  backfillArtwork(raw, { pluginId: 'movie', dryRun: false, now: () => NOW });

  assert.deepEqual(payloads(raw), [
    { mediaItemId, kind: 'movie', provider: 'tmdb', providerRef: 'tmdb:movie:335984', people: [], parents: [] },
  ]);
});

test('a tv item takes its kind from tv_release and its parents, nearest first, from tv_season and tv_series', () => {
  const raw = database();
  withTvTables(raw);
  const episode = item(raw, { pluginId: 'tv', provider: 'tmdb', providerRef: 'tmdb:episode:10019744' });
  const season = item(raw, { pluginId: 'tv', provider: 'tmdb', providerRef: 'tmdb:season:3627' });
  const series = item(raw, { pluginId: 'tv', provider: 'tmdb', providerRef: 'tmdb:tv:184871' });
  raw.prepare(
    "INSERT INTO tv_series (id, provider, provider_ref, title, created_at, updated_at) VALUES (1, 'tmdb', 'tmdb:tv:184871', 'Series', 1, 1)",
  ).run();
  raw.prepare(
    "INSERT INTO tv_season (id, series_id, provider, provider_ref, season_number, created_at, updated_at) VALUES (1, 1, 'tmdb', 'tmdb:season:3627', 1, 1, 1)",
  ).run();
  const release = raw.prepare(
    'INSERT INTO tv_release (media_item_id, kind, series_id, season_id, episode_number, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 1, 1)',
  );
  release.run(episode, 'episode', 1, 2);
  release.run(season, 'season', 1, null);
  release.run(series, 'series', null, null);

  backfillArtwork(raw, { pluginId: 'tv', dryRun: false, now: () => NOW });

  assert.deepEqual(payloads(raw), [
    {
      mediaItemId: episode, kind: 'episode', provider: 'tmdb', providerRef: 'tmdb:episode:10019744', people: [],
      parents: [{ kind: 'season', providerRef: 'tmdb:season:3627' }, { kind: 'series', providerRef: 'tmdb:tv:184871' }],
    },
    {
      mediaItemId: season, kind: 'season', provider: 'tmdb', providerRef: 'tmdb:season:3627', people: [],
      parents: [{ kind: 'series', providerRef: 'tmdb:tv:184871' }],
    },
    { mediaItemId: series, kind: 'series', provider: 'tmdb', providerRef: 'tmdb:tv:184871', people: [], parents: [] },
  ]);
});

test('a tv item with no tv_release row is a defect and is reported, not silently skipped', () => {
  const raw = database();
  withTvTables(raw);
  const orphan = item(raw, { pluginId: 'tv', provider: 'tmdb', providerRef: 'tmdb:episode:1' });

  assert.throws(
    () => backfillArtwork(raw, { pluginId: 'tv', dryRun: false, now: () => NOW }),
    new RegExp(`media_item ${String(orphan)} has no tv_release row`),
  );
  assert.equal(jobs(raw).length, 0, 'nothing was queued before the throw');
});

test('unresolved items, and items of another plugin, are left alone', () => {
  const raw = database();
  item(raw, { pluginId: 'xxx', provider: null, providerRef: null });
  item(raw, { pluginId: 'movie', provider: 'tmdb', providerRef: 'tmdb:movie:1' });
  const resolved = item(raw, { pluginId: 'xxx' });

  const report = backfillArtwork(raw, { pluginId: 'xxx', dryRun: false, now: () => NOW });

  assert.deepEqual(report, { candidates: 1, queued: 1, alreadyQueued: 0 });
  assert.deepEqual(payloads(raw).map((payload) => (payload as { mediaItemId: number }).mediaItemId), [resolved]);
});

test('an item with a ready or running artwork job is not queued twice; done and dead jobs do not count', () => {
  const raw = database();
  const ready = item(raw, { pluginId: 'xxx' });
  const running = item(raw, { pluginId: 'xxx' });
  const done = item(raw, { pluginId: 'xxx' });
  const dead = item(raw, { pluginId: 'xxx' });
  queueArtworkJob(raw, 'xxx', ready, 'ready');
  queueArtworkJob(raw, 'xxx', running, 'running');
  queueArtworkJob(raw, 'xxx', done, 'done');
  queueArtworkJob(raw, 'xxx', dead, 'dead');

  const report = backfillArtwork(raw, { pluginId: 'xxx', dryRun: false, now: () => NOW });

  assert.deepEqual(report, { candidates: 4, queued: 2, alreadyQueued: 2 });
  const queuedNow = jobs(raw).filter((row) => row.run_at === NOW)
    .map((row) => (JSON.parse(row.payload_json) as { mediaItemId: number }).mediaItemId);
  assert.deepEqual(queuedNow, [done, dead]);
});

test('--limit caps how many are queued, and a dry run queues none but reports the same candidates', () => {
  const raw = database();
  for (let index = 0; index < 5; index += 1) item(raw, { pluginId: 'xxx' });

  const dry = backfillArtwork(raw, { pluginId: 'xxx', dryRun: true, limit: 2, now: () => NOW });
  assert.deepEqual(dry, { candidates: 5, queued: 2, alreadyQueued: 0 }, 'a dry run reports what a real run would queue');
  assert.equal(jobs(raw).length, 0, 'and inserts nothing');

  const real = backfillArtwork(raw, { pluginId: 'xxx', dryRun: false, limit: 2, now: () => NOW });
  assert.deepEqual(real, { candidates: 5, queued: 2, alreadyQueued: 0 });
  assert.equal(jobs(raw).length, 2);

  const rest = backfillArtwork(raw, { pluginId: 'xxx', dryRun: false, now: () => NOW });
  assert.deepEqual(rest, { candidates: 5, queued: 3, alreadyQueued: 2 }, 'the next run queues the remainder');
});

test('a plugin this script does not know how to rebuild a payload for is refused by name', () => {
  const raw = database();
  assert.throws(
    () => backfillArtwork(raw, { pluginId: 'books', dryRun: false, now: () => NOW }),
    /no artwork payload rule for plugin "books"; known: movie, tv, xxx/,
  );
});
