import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TvRead } from '@pickarr/contract';
import type { Media, MediaKind, MediaParent } from '@pickarr/openmetadata';
import { lookupTableMigration } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { TV_SYNCED } from '../src/sync.ts';
import { TV_PLUGIN_ID } from '../src/index.ts';
import { applyTv } from '../src/apply.ts';
import { TV_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;
const MARKER = 'TV-DETAILS-MARKER-6f2c1a';

function harnessWithTables() {
  const harness = createTestHarness();
  lookupTableMigration('tv').up(harness.raw);
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  // Placeholder rows with high, distinct ids, so every row a test then
  // writes has an `id` that differs from its `media_item_id` and from the
  // ids of the other two tables. Without them a release's id, its media
  // item's id, its season's and its series' are all 1 for the first media
  // item, and a read returning the wrong one of the four would pass every
  // assertion below. `createTestHarness` runs with
  // `PRAGMA foreign_keys = OFF`, so nothing these point at need exist.
  harness.raw.exec(`
    INSERT INTO tv_series (id, provider, provider_ref, title, created_at, updated_at)
      VALUES (200, 'tmdb', 'tmdb:series:placeholder', 'Placeholder', 0, 0);
    INSERT INTO tv_season (id, series_id, provider, provider_ref, created_at, updated_at)
      VALUES (300, 200, 'tmdb', 'tmdb:season:placeholder', 0, 0);
    INSERT INTO tv_release (id, media_item_id, kind, series_id, created_at, updated_at)
      VALUES (100, 900, 'series', 200, 0, 0);
  `);
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

function episode(): Media {
  return {
    ...parent('episode', 'tmdb:episode:1', 'Tomorrow'),
    overview: 'Carmy reopens.',
    // `marker` is not a key either `apply.ts` or `sync.ts` reads by name --
    // it survives only inside `details_json`, which is exactly what makes it
    // useful here: if it ever reached the returned read, `read` would have
    // to have copied the whole details blob rather than named fields.
    details: { seasonNumber: 3, episodeNumber: 1, marker: MARKER },
    parents: [
      parent('season', 'tmdb:season:10', 'Season 3'),
      parent('series', 'tmdb:series:100', 'The Bear'),
    ],
    people: [],
  };
}

test('every declared table carries the plugin id as its prefix', () => {
  for (const table of TV_SYNCED) {
    assert.ok(table.table.startsWith(`${TV_PLUGIN_ID}_`), `${table.table} must be prefixed`);
  }
});

test('the declared set is exactly the tables the migrations create', () => {
  assert.deepEqual(
    TV_SYNCED.map((t) => t.table).toSorted(),
    ['tv_release', 'tv_season', 'tv_series'],
  );
});

test('tv_series is declared before tv_season, because a season names a series by row id', () => {
  // Declaration order is the order the backfill emits a plugin's tables for
  // one group (`sync/backfill.ts`), and `TvSeasonRead.seriesId` is a
  // `tv_series.id` -- so a client replaying a page in order has to be
  // holding the series by the time the season op lands. This shipped the
  // other way round, as `[release, season, series]`, which made a page emit
  // a `tv_season` op naming `seriesId: 200` before the `tv_series` op with
  // id 200. Asserted as the ordering *property*, not the literal list, so
  // adding a fourth table cannot make this test pass by accident.
  const names = TV_SYNCED.map((table) => table.table);
  assert.ok(
    names.indexOf('tv_series') < names.indexOf('tv_season'),
    `tv_series must precede tv_season, got ${JSON.stringify(names)}`,
  );
});

// Step 1's original third assertion inspected the declaration --
// `JSON.stringify(table)` on the `SyncedTable` object itself -- which cannot
// fail even if `read` returned `details_json`, since a function's source
// text is not part of what `JSON.stringify` walks. Replaced per the brief
// with a real one: a row is written with a recognisable marker buried in
// `details_json`, `read` is called against it, and the marker must not
// appear anywhere in the result.
test('a read never returns details_json', async () => {
  const harness = harnessWithTables();
  await applyTv({ media: episode(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW });

  const row = harness.raw.prepare('SELECT id FROM tv_release WHERE media_item_id = ?').get(1) as
    { id: number } | undefined;
  assert.ok(row !== undefined, 'the release row must exist');
  const releaseId = row.id;

  // Confirms the fixture actually landed the marker in `details_json` --
  // otherwise a broken fixture would pass this test for the wrong reason.
  const stored = harness.raw.prepare('SELECT details_json FROM tv_release WHERE id = ?').get(releaseId) as
    { details_json: string };
  assert.ok(stored.details_json.includes(MARKER), 'fixture sanity: the marker must be in details_json');

  // `tv_release` is the only one of the three declared tables with a
  // `details_json` column at all -- `tv_season` and `tv_series` have nowhere
  // to leak it from -- so it is the one whose `read` this test exercises.
  const release = TV_SYNCED.find((table) => table.table === 'tv_release');
  assert.ok(release !== undefined, 'tv_release must be declared');
  const result = release.read(harness.raw, [releaseId]);
  assert.ok(!JSON.stringify(result).includes(MARKER), "tv_release's read must not return details_json");
});

/**
 * The joined reads, asserted on their values rather than only on what they
 * omit. Nothing did until this wave: a reviewer had traced every alias
 * against every field access by hand, which is exactly the check that stops
 * holding the moment these mapping functions are rewritten -- as adding
 * `mediaItemId` to `TvRead` rewrote them.
 */

/** A season pack: the answer is the season itself, and it names a series as a parent. */
function seasonPack(): Media {
  return {
    ...parent('season', 'tmdb:season:10', 'Season 3'),
    overview: null,
    details: { seasonNumber: 3, marker: MARKER },
    parents: [parent('series', 'tmdb:series:100', 'The Bear')],
    people: [],
  };
}

/** A series pack: the answer is the series itself, so there is no season at all. */
function seriesPack(): Media {
  return {
    ...parent('series', 'tmdb:series:100', 'The Bear'),
    overview: 'Carmy comes home.',
    details: { marker: MARKER },
    parents: [],
    people: [],
  };
}

function tableNamed(name: string) {
  const table = TV_SYNCED.find((candidate) => candidate.table === name);
  assert.ok(table !== undefined, `${name} must be declared`);
  return table;
}

function releaseIdFor(harness: ReturnType<typeof harnessWithTables>, mediaItemId: number): number {
  const row = harness.raw.prepare('SELECT id FROM tv_release WHERE media_item_id = ?').get(mediaItemId) as
    { id: number } | undefined;
  assert.ok(row !== undefined, `a release row must exist for media item ${String(mediaItemId)}`);
  return row.id;
}

test("a season pack's read carries its season number, and a series pack's carries null", async () => {
  const harness = harnessWithTables();
  await applyTv({ media: seasonPack(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW });
  await applyTv({ media: seriesPack(), mediaItemId: 2, raw: harness.raw, ctx: harness.ctx, now: NOW });

  const release = tableNamed('tv_release');
  const packs = release.read(harness.raw, [releaseIdFor(harness, 1), releaseIdFor(harness, 2)]);

  const season = packs[releaseIdFor(harness, 1)] as TvRead | undefined;
  assert.deepEqual(season, {
    mediaItemId: 1,
    kind: 'season',
    seriesTitle: 'The Bear',
    seriesRef: 'tmdb:series:100',
    seasonNumber: 3,
    episodeNumber: null,
  });

  const series = packs[releaseIdFor(harness, 2)] as TvRead | undefined;
  assert.deepEqual(series, {
    mediaItemId: 2,
    kind: 'series',
    seriesTitle: 'The Bear',
    seriesRef: 'tmdb:series:100',
    // `tv_release.season_id` is null for a series pack, and the join is left,
    // so this reads null rather than borrowing another release's season.
    seasonNumber: null,
    episodeNumber: null,
  });
});

test("an episode's read carries its episode number and its season's number from two different tables", async () => {
  const harness = harnessWithTables();
  await applyTv({ media: episode(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW });

  const read = tableNamed('tv_release').read(harness.raw, [releaseIdFor(harness, 1)]);
  assert.deepEqual(read[releaseIdFor(harness, 1)], {
    mediaItemId: 1,
    kind: 'episode',
    seriesTitle: 'The Bear',
    seriesRef: 'tmdb:series:100',
    seasonNumber: 3,
    episodeNumber: 1,
  });
});

test("a season's and a series' own reads carry their own columns, not a release's", async () => {
  const harness = harnessWithTables();
  await applyTv({ media: seasonPack(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW });
  await applyTv({ media: seriesPack(), mediaItemId: 2, raw: harness.raw, ctx: harness.ctx, now: NOW });

  // Found by provider reference rather than through the table declaration:
  // a `SyncedTable` answers what its rows *are* and no longer how to reach
  // them from a media item, so a test that needs an id looks it up the way
  // the log would have handed it over.
  const seasonId = Number(harness.raw.prepare(
    "SELECT id FROM tv_season WHERE provider_ref = 'tmdb:season:10'",
  ).get()?.id);
  const seriesId = Number(harness.raw.prepare(
    "SELECT id FROM tv_series WHERE provider_ref = 'tmdb:series:100'",
  ).get()?.id);
  assert.ok(Number.isInteger(seasonId) && Number.isInteger(seriesId), 'fixture: both parents exist');

  assert.deepEqual(tableNamed('tv_season').read(harness.raw, [seasonId])[seasonId], {
    // The season's own `series_id`, which resolves against the id on the
    // `tv_series` op -- see `packages/contract/src/sync.ts`.
    seriesId,
    seasonNumber: 3,
    title: 'Season 3',
  });

  assert.deepEqual(tableNamed('tv_series').read(harness.raw, [seriesId])[seriesId], {
    title: 'The Bear',
    providerRef: 'tmdb:series:100',
    firstAirDate: '2024-06-26',
    // Only a series *pack* contributes an overview, which media item 2 was.
    overview: 'Carmy comes home.',
  });
});
