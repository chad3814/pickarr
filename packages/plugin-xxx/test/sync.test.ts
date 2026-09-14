import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Media } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { XXX_SYNCED } from '../src/sync.ts';
import { XXX_PLUGIN_ID } from '../src/index.ts';
import { applyXxx } from '../src/apply.ts';
import { XXX_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;
const MARKER = 'XXX-DETAILS-MARKER-3a8f0c';

function harnessWithTables() {
  const harness = createTestHarness();
  for (const migration of XXX_MIGRATIONS) migration.up(harness.raw);
  return harness;
}

function scene(): Media {
  return {
    id: 'id-tpdb:scene:1',
    kind: 'scene',
    title: 'A Scene',
    releaseDate: '2026-01-15',
    year: 2026,
    provider: 'tpdb',
    providerRef: 'tpdb:scene:1',
    overview: null,
    // `marker` is not one of the keys `apply.ts` reads by name -- it survives
    // only inside `details_json`, which is what makes it useful here: if it
    // ever reached the returned read, `read` would have to have copied the
    // whole details blob rather than named fields.
    details: { siteName: 'A Site', siteRef: 'tpdb:site:7', durationSeconds: 1_800, marker: MARKER },
    parents: [],
    people: [],
  };
}

test('every declared table carries the plugin id as its prefix', () => {
  for (const table of XXX_SYNCED) {
    assert.ok(table.table.startsWith(`${XXX_PLUGIN_ID}_`), `${table.table} must be prefixed`);
  }
});

test('the declared set is exactly the tables the migrations create', () => {
  assert.deepEqual(XXX_SYNCED.map((t) => t.table).toSorted(), ['xxx_scene', 'xxx_site']);
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
  await applyXxx({ media: scene(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW });

  const row = harness.raw.prepare('SELECT id FROM xxx_scene WHERE media_item_id = ?').get(1) as
    { id: number } | undefined;
  assert.ok(row !== undefined, 'the scene row must exist');
  const sceneId = row.id;

  // Confirms the fixture actually landed the marker in `details_json` --
  // otherwise a broken fixture would pass this test for the wrong reason.
  const stored = harness.raw.prepare('SELECT details_json FROM xxx_scene WHERE id = ?').get(sceneId) as
    { details_json: string };
  assert.ok(stored.details_json.includes(MARKER), 'fixture sanity: the marker must be in details_json');

  // `xxx_scene` is the only one of the two declared tables with a
  // `details_json` column at all -- `xxx_site` has nowhere to leak it from --
  // so it is the one whose `read` this test exercises.
  const scenes = XXX_SYNCED.find((table) => table.table === 'xxx_scene');
  assert.ok(scenes !== undefined, 'xxx_scene must be declared');
  const result = scenes.read(harness.raw, [sceneId]);
  assert.ok(!JSON.stringify(result).includes(MARKER), "xxx_scene's read must not return details_json");
});
