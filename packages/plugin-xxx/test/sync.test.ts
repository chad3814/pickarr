import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { XxxRead, XxxSiteRead } from '@pickarr/contract';
import type { Media } from '@pickarr/openmetadata';
import { lookupTableMigration } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { XXX_SYNCED } from '../src/sync.ts';
import { XXX_PLUGIN_ID } from '../src/index.ts';
import { applyXxx } from '../src/apply.ts';
import { XXX_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;
const MARKER = 'XXX-DETAILS-MARKER-3a8f0c';

function harnessWithTables() {
  const harness = createTestHarness();
  lookupTableMigration('xxx').up(harness.raw);
  for (const migration of XXX_MIGRATIONS) migration.up(harness.raw);
  // Placeholder rows with high, distinct ids, so every row a test then
  // writes has an `id` that differs from its `media_item_id` and from its
  // site's id. Without them a scene's id and its media item's are both 1 for
  // the first media item, and a read returning the row's own id where it
  // means to return the media item's would pass every assertion below.
  // `createTestHarness` runs with `PRAGMA foreign_keys = OFF`, so nothing
  // these point at need exist.
  harness.raw.exec(`
    INSERT INTO xxx_site (id, provider, provider_ref, name, created_at, updated_at)
      VALUES (200, 'tpdb', 'tpdb:site:placeholder', 'Placeholder', 0, 0);
    INSERT INTO xxx_scene (id, media_item_id, site_id, created_at, updated_at)
      VALUES (100, 900, 200, 0, 0);
  `);
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

/**
 * The joined reads, asserted on their values rather than only on what they
 * omit. Nothing did until this wave; adding `mediaItemId` to `XxxRead`
 * rewrote exactly these mapping functions, and a hand trace is not a test.
 */

/** The same scene shape, with the site fields a test wants. */
function sceneWith(providerRef: string, site: { name: string; ref: string } | null): Media {
  return {
    ...scene(),
    id: `id-${providerRef}`,
    providerRef,
    details: site === null
      ? { durationSeconds: 1_800, marker: MARKER }
      : { siteName: site.name, siteRef: site.ref, durationSeconds: 1_800, marker: MARKER },
  };
}

function tableNamed(name: string) {
  const table = XXX_SYNCED.find((candidate) => candidate.table === name);
  assert.ok(table !== undefined, `${name} must be declared`);
  return table;
}

function sceneIdFor(harness: ReturnType<typeof harnessWithTables>, mediaItemId: number): number {
  const row = harness.raw.prepare('SELECT id FROM xxx_scene WHERE media_item_id = ?').get(mediaItemId) as
    { id: number } | undefined;
  assert.ok(row !== undefined, `a scene row must exist for media item ${String(mediaItemId)}`);
  return row.id;
}

test("a scene's read carries its site's name and reference through the join, and null when it has none", async () => {
  const harness = harnessWithTables();
  await applyXxx({
    media: sceneWith('tpdb:scene:1', { name: 'A Site', ref: 'tpdb:site:7' }),
    mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW,
  });
  await applyXxx({
    media: sceneWith('tpdb:scene:2', null),
    mediaItemId: 2, raw: harness.raw, ctx: harness.ctx, now: NOW,
  });

  const read = tableNamed('xxx_scene').read(harness.raw, [sceneIdFor(harness, 1), sceneIdFor(harness, 2)]);

  assert.deepEqual(read[sceneIdFor(harness, 1)] as XxxRead | undefined, {
    mediaItemId: 1,
    siteName: 'A Site',
    siteRef: 'tpdb:site:7',
  });

  // `xxx_scene.site_id` is nullable and the join is left, so a scene with no
  // known site reads both fields null rather than dropping out of the read.
  assert.deepEqual(read[sceneIdFor(harness, 2)] as XxxRead | undefined, {
    mediaItemId: 2,
    siteName: null,
    siteRef: null,
  });
});

test("a site's own read carries its own columns, however many scenes share the site", async () => {
  const harness = harnessWithTables();
  const site = { name: 'A Site', ref: 'tpdb:site:7' };
  await applyXxx({
    media: sceneWith('tpdb:scene:1', site), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW,
  });
  await applyXxx({
    media: sceneWith('tpdb:scene:2', site), mediaItemId: 2, raw: harness.raw, ctx: harness.ctx, now: NOW,
  });

  // Counted by provider reference, not `count(*)`: `harnessWithTables` seeds
  // a placeholder site of its own so ids cannot alias.
  assert.equal(harness.raw.prepare(
    "SELECT count(*) c FROM xxx_site WHERE provider_ref = 'tpdb:site:7'",
  ).get()?.c, 1, 'fixture sanity: the provider_ref unique index makes both scenes share one site row');

  // Found by provider reference rather than through the table declaration: a
  // `SyncedTable` answers what its rows *are* and no longer how to reach them
  // from a media item, so a test that needs an id looks it up the way the log
  // would have handed it over.
  const siteId = Number(harness.raw.prepare(
    "SELECT id FROM xxx_site WHERE provider_ref = 'tpdb:site:7'",
  ).get()?.id);

  assert.deepEqual(tableNamed('xxx_site').read(harness.raw, [siteId])[siteId] as XxxSiteRead | undefined, {
    name: 'A Site',
    providerRef: 'tpdb:site:7',
  });

  // And one entry per row, not per scene: the site is one row, so one op --
  // the deduplication the walk used to need `rowsFor` for is now the log's
  // own shape, one entry per row.
  assert.deepEqual(Object.keys(tableNamed('xxx_site').read(harness.raw, [siteId, siteId])), [String(siteId)]);
});
