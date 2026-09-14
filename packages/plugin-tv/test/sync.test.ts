import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Media, MediaKind, MediaParent } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { TV_SYNCED } from '../src/sync.ts';
import { TV_PLUGIN_ID } from '../src/index.ts';
import { applyTv } from '../src/apply.ts';
import { TV_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;
const MARKER = 'TV-DETAILS-MARKER-6f2c1a';

function harnessWithTables() {
  const harness = createTestHarness();
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
