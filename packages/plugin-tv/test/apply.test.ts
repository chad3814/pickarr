import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { Media, MediaKind, MediaParent } from '@pickarr/openmetadata';
import { lookupTableMigration } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyTv, checkTv } from '../src/apply.ts';
import { TV_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;

/** `TV_MIGRATIONS` starts at version 2; version 1, the engine's own
 * `tv_lookup` state table, is prepended here the way `createLookupPlugin`
 * does it for real -- `videoResolutionBackfillMigration` (version 4) reads
 * that table. */
function harnessWithTables() {
  const harness = createTestHarness();
  lookupTableMigration('tv').up(harness.raw);
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  return harness;
}

function parent(kind: MediaKind, providerRef: string, title: string): MediaParent {
  return {
    id: `id-${providerRef}`,
    kind,
    title,
    releaseDate: '2024-06-26',
    year: 2024,
    provider: 'tmdb',
    providerRef,
  };
}

function episode(overrides: Partial<Media> = {}): Media {
  return {
    ...parent('episode', 'tmdb:episode:1', 'Tomorrow'),
    overview: 'Carmy reopens.',
    details: { seasonNumber: 3, episodeNumber: 1 },
    parents: [
      parent('season', 'tmdb:season:10', 'Season 3'),
      parent('series', 'tmdb:series:100', 'The Bear'),
    ],
    people: [],
    ...overrides,
  };
}

async function apply(harness: ReturnType<typeof harnessWithTables>, media: Media, mediaItemId: number) {
  await applyTv({ media, mediaItemId, raw: harness.raw, ctx: harness.ctx, now: NOW });
}

// `node:sqlite` rows have a null prototype, and `deepEqual` compares
// prototypes -- so every row is normalized to a plain object here, once,
// rather than at each call site.
function rows(raw: DatabaseSync, sql: string): Record<string, unknown>[] {
  return (raw.prepare(sql).all() as Record<string, unknown>[]).map((row) => Object.assign({}, row));
}

test('an episode writes its series, its season and one release row', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode(), 1);

  assert.deepEqual(rows(harness.raw, 'SELECT provider_ref, title, first_air_date FROM tv_series'), [
    { provider_ref: 'tmdb:series:100', title: 'The Bear', first_air_date: '2024-06-26' },
  ]);
  assert.deepEqual(rows(harness.raw, 'SELECT provider_ref, season_number, title FROM tv_season'), [
    { provider_ref: 'tmdb:season:10', season_number: 3, title: 'Season 3' },
  ]);
  assert.deepEqual(
    rows(harness.raw, 'SELECT media_item_id, kind, series_id, season_id, episode_number FROM tv_release'),
    [{ media_item_id: 1, kind: 'episode', series_id: 1, season_id: 1, episode_number: 1 }],
  );
});

test('keeps the details object verbatim, including a key nothing reads', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode({ details: { seasonNumber: 3, episodeNumber: 1, airedOn: '2024-06-27' } }), 1);

  const stored = rows(harness.raw, 'SELECT details_json FROM tv_release')[0]?.['details_json'];
  assert.deepEqual(JSON.parse(String(stored)), { seasonNumber: 3, episodeNumber: 1, airedOn: '2024-06-27' });
});

test('a second episode of the same season adds one release and no second parent', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode(), 1);
  await apply(harness, episode({
    ...parent('episode', 'tmdb:episode:2', 'Next Time'),
    details: { seasonNumber: 3, episodeNumber: 2 },
    parents: [parent('season', 'tmdb:season:10', 'Season 3'), parent('series', 'tmdb:series:100', 'The Bear')],
    overview: null,
    people: [],
  }), 2);

  assert.equal(rows(harness.raw, 'SELECT id FROM tv_series').length, 1);
  assert.equal(rows(harness.raw, 'SELECT id FROM tv_season').length, 1);
  assert.deepEqual(
    rows(harness.raw, 'SELECT media_item_id, episode_number FROM tv_release ORDER BY media_item_id'),
    [{ media_item_id: 1, episode_number: 1 }, { media_item_id: 2, episode_number: 2 }],
  );
});

test('re-applying the same answer updates the row rather than adding one', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode(), 1);
  await applyTv({ media: episode(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW + 1000 });

  const release = rows(harness.raw, 'SELECT id, updated_at FROM tv_release');
  assert.equal(release.length, 1);
  assert.equal(release[0]?.['updated_at'], NOW + 1000);
});

test('a season pack links at the season level with no episode number', async () => {
  const harness = harnessWithTables();
  const season: Media = {
    ...parent('season', 'tmdb:season:10', 'Season 3'),
    overview: null,
    details: { seasonNumber: 3 },
    parents: [parent('series', 'tmdb:series:100', 'The Bear')],
    people: [],
  };

  await apply(harness, season, 5);

  assert.deepEqual(
    rows(harness.raw, 'SELECT kind, season_id, episode_number FROM tv_release'),
    [{ kind: 'season', season_id: 1, episode_number: null }],
  );
  assert.equal(rows(harness.raw, 'SELECT season_number FROM tv_season')[0]?.['season_number'], 3);
});

test('a series pack links at the series level with no season', async () => {
  const harness = harnessWithTables();
  const series: Media = {
    ...parent('series', 'tmdb:series:100', 'The Bear'),
    overview: 'A restaurant.',
    details: {},
    parents: [],
    people: [],
  };

  await apply(harness, series, 6);

  assert.deepEqual(
    rows(harness.raw, 'SELECT kind, season_id, episode_number FROM tv_release'),
    [{ kind: 'series', season_id: null, episode_number: null }],
  );
  assert.equal(rows(harness.raw, 'SELECT overview FROM tv_series')[0]?.['overview'], 'A restaurant.');
});

test('an episode whose parents name no series throws', async () => {
  const harness = harnessWithTables();
  await assert.rejects(
    () => apply(harness, episode({ parents: [parent('season', 'tmdb:season:10', 'Season 3')] }), 1),
    /series/,
  );
});

test('a kind that cannot be television throws', async () => {
  const harness = harnessWithTables();
  await assert.rejects(
    () => apply(harness, episode({ kind: 'movie' }), 1),
    /movie/,
  );
});

test('a missing episode number is stored as null rather than guessed', async () => {
  const harness = harnessWithTables();
  await apply(harness, episode({ details: { seasonNumber: 3 } }), 1);
  assert.equal(rows(harness.raw, 'SELECT episode_number FROM tv_release')[0]?.['episode_number'], null);
});

test('an episode with no season parent still records its series', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode({ parents: [parent('series', 'tmdb:series:100', 'The Bear')] }), 1);

  assert.deepEqual(
    rows(harness.raw, 'SELECT kind, series_id, season_id FROM tv_release'),
    [{ kind: 'episode', series_id: 1, season_id: null }],
  );
});

test('the pre-flight refuses what television cannot write, before the engine writes anything', () => {
  // The same two refusals `applyTv` makes, asked before a `media_item`
  // exists -- which is the whole reason `checkTv` is separate from it.
  assert.throws(() => { checkTv(episode({ kind: 'movie' })); }, /movie/);
  assert.throws(
    () => { checkTv(episode({ parents: [parent('season', 'tmdb:season:10', 'Season 3')] })); },
    /names no series/,
  );

  // And it passes all three shapes a television feed actually delivers,
  // including the full-series pack that is its own series.
  checkTv(episode());
  checkTv(episode({ kind: 'season', parents: [parent('series', 'tmdb:series:100', 'The Bear')] }));
  checkTv(episode({ kind: 'series', parents: [] }));
});

test('a series parent carrying no date does not erase the date a fuller answer taught us', async () => {
  const harness = harnessWithTables();
  await apply(harness, episode(), 1);
  assert.equal(rows(harness.raw, 'SELECT first_air_date FROM tv_series')[0]?.['first_air_date'], '2024-06-26');

  // `MediaParent.releaseDate` is nullable, and a series reached as an
  // episode's parent is exactly where the service has least to say about it.
  const dateless: MediaParent = { ...parent('series', 'tmdb:series:100', 'The Bear'), releaseDate: null };
  await apply(harness, episode({
    providerRef: 'tmdb:episode:2',
    parents: [parent('season', 'tmdb:season:10', 'Season 3'), dateless],
  }), 2);

  assert.equal(
    rows(harness.raw, 'SELECT first_air_date FROM tv_series')[0]?.['first_air_date'],
    '2024-06-26',
    'COALESCE keeps it, exactly as it keeps the overview one line below',
  );
});

test('migration 3 creates the placement table the engine records imports in', () => {
  const harness = createTestHarness();
  lookupTableMigration('tv').up(harness.raw);
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  assert.deepEqual(TV_MIGRATIONS.map((migration) => migration.version), [2, 3, 4]);
  const row = harness.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tv_placement'")
    .get();
  assert.ok(row !== undefined, 'tv_placement was not created');
});
