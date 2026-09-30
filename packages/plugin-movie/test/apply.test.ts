import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Media } from '@pickarr/openmetadata';
import { lookupTableMigration } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyMovie, checkMovie } from '../src/apply.ts';
import { MOVIE_MIGRATIONS } from '../src/migrations.ts';
import { createMoviePlugin } from '../src/index.ts';

const NOW = 1_700_000_000_000;

/** `MOVIE_MIGRATIONS` starts at version 2; version 1, the engine's own
 * `movie_lookup` state table, is prepended here the way `createLookupPlugin`
 * does it for real -- `videoResolutionBackfillMigration` (version 4) reads
 * that table. */
function harnessWithTables() {
  const harness = createTestHarness();
  lookupTableMigration('movie').up(harness.raw);
  for (const migration of MOVIE_MIGRATIONS) migration.up(harness.raw);
  return harness;
}

function movie(details: Media['details']): Media {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    kind: 'movie',
    title: 'Dune: Part Two',
    releaseDate: '2024-03-01',
    year: 2024,
    provider: 'tmdb',
    providerRef: 'tmdb:movie:693134',
    overview: 'Paul unites with the Fremen.',
    details,
    parents: [],
    people: [],
  };
}

// `node:sqlite` rows have a null prototype, and `deepEqual` compares
// prototypes -- so every row is normalized to a plain object here, once,
// rather than at each call site.
function detailRow(harness: ReturnType<typeof harnessWithTables>): Record<string, unknown> | undefined {
  const row = harness.raw.prepare(
    'SELECT media_item_id, runtime_minutes, imdb_id, tagline, collection_name, updated_at FROM movie_detail',
  ).get() as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.assign({}, row);
}

test('writes the four documented keys', async () => {
  const harness = harnessWithTables();

  await applyMovie({
    media: movie({ runtimeMinutes: 166, imdbId: 'tt15239678', tagline: 'Long live the fighters', collectionName: 'Dune' }),
    mediaItemId: 3,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  assert.deepEqual(detailRow(harness), {
    media_item_id: 3,
    runtime_minutes: 166,
    imdb_id: 'tt15239678',
    tagline: 'Long live the fighters',
    collection_name: 'Dune',
    updated_at: NOW,
  });
});

test('an absent or null key is null, not an empty string', async () => {
  const harness = harnessWithTables();

  await applyMovie({
    media: movie({ runtimeMinutes: 166, tagline: null }),
    mediaItemId: 4,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  const row = detailRow(harness);
  assert.equal(row?.['imdb_id'], null);
  assert.equal(row?.['tagline'], null);
  assert.equal(row?.['collection_name'], null);
});

test('keeps every details key verbatim', async () => {
  const harness = harnessWithTables();

  await applyMovie({
    media: movie({ runtimeMinutes: 166, budget: 190000000 }),
    mediaItemId: 5,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  const stored = harness.raw.prepare('SELECT details_json FROM movie_detail').get()?.['details_json'];
  assert.deepEqual(JSON.parse(String(stored)), { runtimeMinutes: 166, budget: 190000000 });
});

test('re-applying updates the one row', async () => {
  const harness = harnessWithTables();
  const args = { media: movie({ runtimeMinutes: 166 }), mediaItemId: 6, raw: harness.raw, ctx: harness.ctx };

  await applyMovie({ ...args, now: NOW });
  await applyMovie({ ...args, media: movie({ runtimeMinutes: 167 }), now: NOW + 500 });

  const rows = (harness.raw.prepare('SELECT runtime_minutes, updated_at FROM movie_detail').all() as Record<string, unknown>[])
    .map((row) => Object.assign({}, row));
  assert.deepEqual(rows, [{ runtime_minutes: 167, updated_at: NOW + 500 }]);
});

test('a runtime the service sent as a string is still a number', async () => {
  const harness = harnessWithTables();
  await applyMovie({ media: movie({ runtimeMinutes: '166' }), mediaItemId: 7, raw: harness.raw, ctx: harness.ctx, now: NOW });
  assert.equal(detailRow(harness)?.['runtime_minutes'], 166);
});

test('a kind that is not a film throws', async () => {
  const harness = harnessWithTables();
  await assert.rejects(
    () => applyMovie({
      media: { ...movie({}), kind: 'episode' },
      mediaItemId: 8,
      raw: harness.raw,
      ctx: harness.ctx,
      now: NOW,
    }),
    /episode/,
  );
});

test('the pre-flight refuses what a film cannot be, before the engine writes anything', () => {
  // Asked before a `media_item` exists, which is the whole reason
  // `checkMovie` is separate from `applyMovie`.
  assert.throws(() => { checkMovie({ ...movie({}), kind: 'episode' }); }, /episode/);
  checkMovie(movie({}));
});

test('migration 3 creates the placement table the engine records imports in', () => {
  const harness = createTestHarness();
  lookupTableMigration('movie').up(harness.raw);
  for (const migration of MOVIE_MIGRATIONS) migration.up(harness.raw);
  assert.deepEqual(MOVIE_MIGRATIONS.map((migration) => migration.version), [2, 3, 4]);
  const row = harness.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'movie_placement'")
    .get();
  assert.ok(row !== undefined, 'movie_placement was not created');
});

test('a film expects a single file', async () => {
  const plugin = createMoviePlugin({ now: () => 1, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'k' });
  // `expects` is not on MediaPlugin; exercise it through a download instead.
  const harness = createTestHarness();
  for (const migration of plugin.migrations) migration.up(harness.raw);
  harness.answerList([
    { path: '/d/r/a.mkv', relativePath: 'a.mkv', sizeBytes: 1 },
    { path: '/d/r/b.mkv', relativePath: 'b.mkv', sizeBytes: 1 },
  ]);
  await assert.rejects(
    () => plugin.onDownloadedFile({ path: '/d/r', sizeBytes: 1, downloadClientId: 1, rssItemId: 7, mediaItemId: 1 }, harness.ctx),
    /too-many-video-files/,
  );
});
