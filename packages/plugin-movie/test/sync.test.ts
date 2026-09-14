import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MovieRead } from '@pickarr/contract';
import type { Media } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { MOVIE_SYNCED } from '../src/sync.ts';
import { MOVIE_PLUGIN_ID } from '../src/index.ts';
import { applyMovie } from '../src/apply.ts';
import { MOVIE_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;
const MARKER = 'MOVIE-DETAILS-MARKER-9d4e7b';

function harnessWithTables() {
  const harness = createTestHarness();
  for (const migration of MOVIE_MIGRATIONS) migration.up(harness.raw);
  // A placeholder row with a high id, so every row a test then writes has an
  // `id` that differs from its `media_item_id`. Without it both are 1 for the
  // first media item, and a read that returned the row's own id where it
  // means to return the media item's would pass every assertion below.
  // `createTestHarness` runs with `PRAGMA foreign_keys = OFF`, so the
  // media item this points at need not exist.
  harness.raw.prepare(
    'INSERT INTO movie_detail (id, media_item_id, created_at, updated_at) VALUES (100, 900, 0, 0)',
  ).run();
  return harness;
}

function movie(): Media {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    kind: 'movie',
    title: 'Dune: Part Two',
    releaseDate: '2024-03-01',
    year: 2024,
    provider: 'tmdb',
    providerRef: 'tmdb:movie:693134',
    overview: 'Paul unites with the Fremen.',
    // `marker` is not one of the four keys `apply.ts` reads by name -- it
    // survives only inside `details_json`, which is what makes it useful
    // here: if it ever reached the returned read, `read` would have to have
    // copied the whole details blob rather than named fields.
    details: { runtimeMinutes: 166, tagline: 'Long live the fighters.', marker: MARKER },
    parents: [],
    people: [],
  };
}

test('every declared table carries the plugin id as its prefix', () => {
  for (const table of MOVIE_SYNCED) {
    assert.ok(table.table.startsWith(`${MOVIE_PLUGIN_ID}_`), `${table.table} must be prefixed`);
  }
});

test('the declared set is exactly the tables the migrations create', () => {
  assert.deepEqual(MOVIE_SYNCED.map((t) => t.table).toSorted(), ['movie_detail']);
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
  await applyMovie({ media: movie(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW });

  const row = harness.raw.prepare('SELECT id FROM movie_detail WHERE media_item_id = ?').get(1) as
    { id: number } | undefined;
  assert.ok(row !== undefined, 'the detail row must exist');
  const detailId = row.id;

  // Confirms the fixture actually landed the marker in `details_json` --
  // otherwise a broken fixture would pass this test for the wrong reason.
  const stored = harness.raw.prepare('SELECT details_json FROM movie_detail WHERE id = ?').get(detailId) as
    { details_json: string };
  assert.ok(stored.details_json.includes(MARKER), 'fixture sanity: the marker must be in details_json');

  const detail = MOVIE_SYNCED.find((table) => table.table === 'movie_detail');
  assert.ok(detail !== undefined, 'movie_detail must be declared');
  const result = detail.read(harness.raw, [detailId]);
  assert.ok(!JSON.stringify(result).includes(MARKER), "movie_detail's read must not return details_json");
});

test('a detail read carries its media item and its own columns', async () => {
  const harness = harnessWithTables();
  await applyMovie({ media: movie(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW });

  const detail = MOVIE_SYNCED.find((table) => table.table === 'movie_detail');
  assert.ok(detail !== undefined, 'movie_detail must be declared');

  const id = Number(harness.raw.prepare('SELECT id FROM movie_detail WHERE media_item_id = 1').get()?.id);

  // `mediaItemId` is how a client attaches this row to its group; the row's
  // own key is on the op, not in here (`packages/contract/src/sync.ts`).
  assert.deepEqual(detail.read(harness.raw, [id])[id] as MovieRead | undefined, {
    mediaItemId: 1,
    runtimeMinutes: 166,
    tagline: 'Long live the fighters.',
  });

  assert.deepEqual(detail.read(harness.raw, []), {}, 'an empty id list never reaches SQLite');
});
