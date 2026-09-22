import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { Media } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyXxx, checkXxx } from '../src/apply.ts';
import { XXX_MIGRATIONS } from '../src/migrations.ts';
import { createXxxPlugin } from '../src/index.ts';

const NOW = 1_700_000_000_000;

function harnessWithTables() {
  const harness = createTestHarness();
  for (const migration of XXX_MIGRATIONS) migration.up(harness.raw);
  return harness;
}

function scene(providerRef: string, details: Media['details']): Media {
  return {
    id: `id-${providerRef}`,
    kind: 'scene',
    title: 'A Scene',
    releaseDate: '2026-01-15',
    year: 2026,
    provider: 'tpdb',
    providerRef,
    overview: null,
    details,
    parents: [],
    people: [],
  };
}

const SITE = { siteName: 'A Site', siteRef: 'tpdb:site:7' };

// `node:sqlite` rows have a null prototype, and `deepEqual` compares
// prototypes -- so every row is normalized to a plain object here, once,
// rather than at each call site.
function rows(raw: DatabaseSync, sql: string): Record<string, unknown>[] {
  return (raw.prepare(sql).all() as Record<string, unknown>[]).map((record) => Object.assign({}, record));
}

function row(raw: DatabaseSync, sql: string): Record<string, unknown> | undefined {
  const result = raw.prepare(sql).get() as Record<string, unknown> | undefined;
  return result === undefined ? undefined : Object.assign({}, result);
}

test('writes the site and the scene', async () => {
  const harness = harnessWithTables();

  await applyXxx({
    media: scene('tpdb:scene:1', { ...SITE, durationSeconds: 1800, releasedOn: '2026-01-15' }),
    mediaItemId: 2,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  assert.deepEqual(rows(harness.raw, 'SELECT provider, provider_ref, name FROM xxx_site'), [
    { provider: 'tpdb', provider_ref: 'tpdb:site:7', name: 'A Site' },
  ]);
  assert.deepEqual(
    row(harness.raw, 'SELECT media_item_id, site_id, duration_seconds, released_on FROM xxx_scene'),
    { media_item_id: 2, site_id: 1, duration_seconds: 1800, released_on: '2026-01-15' },
  );
});

test('two scenes from one site share the site row', async () => {
  const harness = harnessWithTables();
  const common = { raw: harness.raw, ctx: harness.ctx, now: NOW };

  await applyXxx({ ...common, media: scene('tpdb:scene:1', SITE), mediaItemId: 1 });
  await applyXxx({ ...common, media: scene('tpdb:scene:2', SITE), mediaItemId: 2 });

  assert.equal(row(harness.raw, 'SELECT count(*) AS n FROM xxx_site')?.['n'], 1);
  assert.deepEqual(
    rows(harness.raw, 'SELECT media_item_id, site_id FROM xxx_scene ORDER BY media_item_id'),
    [{ media_item_id: 1, site_id: 1 }, { media_item_id: 2, site_id: 1 }],
  );
});

test('a scene whose details name no site is still recorded', async () => {
  const harness = harnessWithTables();

  await applyXxx({
    media: scene('tpdb:scene:3', { durationSeconds: 600 }),
    mediaItemId: 3,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  assert.equal(row(harness.raw, 'SELECT count(*) AS n FROM xxx_site')?.['n'], 0);
  assert.equal(row(harness.raw, 'SELECT site_id FROM xxx_scene')?.['site_id'], null);
});

test('a site named without a reference is not written, since nothing could key it', async () => {
  const harness = harnessWithTables();

  await applyXxx({
    media: scene('tpdb:scene:4', { siteName: 'A Site' }),
    mediaItemId: 4,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  assert.equal(row(harness.raw, 'SELECT count(*) AS n FROM xxx_site')?.['n'], 0);
  assert.equal(row(harness.raw, 'SELECT site_id FROM xxx_scene')?.['site_id'], null);
});

test('a renamed site updates its row rather than adding one', async () => {
  const harness = harnessWithTables();
  const common = { raw: harness.raw, ctx: harness.ctx };

  await applyXxx({ ...common, media: scene('tpdb:scene:1', SITE), mediaItemId: 1, now: NOW });
  await applyXxx({
    ...common,
    media: scene('tpdb:scene:2', { siteName: 'A Site Renamed', siteRef: 'tpdb:site:7' }),
    mediaItemId: 2,
    now: NOW + 100,
  });

  assert.deepEqual(rows(harness.raw, 'SELECT name, updated_at FROM xxx_site'), [
    { name: 'A Site Renamed', updated_at: NOW + 100 },
  ]);
});

test('keeps every details key verbatim, and falls back to the answer date', async () => {
  const harness = harnessWithTables();

  await applyXxx({
    media: scene('tpdb:scene:5', { ...SITE, unexpected: 'kept' }),
    mediaItemId: 5,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  const result = row(harness.raw, 'SELECT released_on, details_json FROM xxx_scene');
  // `releasedOn` was absent, so the answer's own `releaseDate` stands in --
  // one date for a reader, rather than a null beside a date the media item has.
  assert.equal(result?.['released_on'], '2026-01-15');
  assert.deepEqual(JSON.parse(String(result?.['details_json'])), { ...SITE, unexpected: 'kept' });
});

test('a kind that is not a scene throws', async () => {
  const harness = harnessWithTables();
  await assert.rejects(
    () => applyXxx({
      media: { ...scene('tpdb:scene:6', SITE), kind: 'movie' },
      mediaItemId: 6,
      raw: harness.raw,
      ctx: harness.ctx,
      now: NOW,
    }),
    /movie/,
  );
});

test('the pre-flight refuses what a scene cannot be, before the engine writes anything', () => {
  // Asked before a `media_item` exists, which is the whole reason `checkXxx`
  // is separate from `applyXxx`.
  assert.throws(() => { checkXxx({ ...scene('tpdb:scene:7', SITE), kind: 'movie' }); }, /movie/);
  checkXxx(scene('tpdb:scene:7', SITE));
});

test('migration 3 creates the placement table the engine records imports in', () => {
  const harness = createTestHarness();
  for (const migration of XXX_MIGRATIONS) migration.up(harness.raw);
  assert.deepEqual(XXX_MIGRATIONS.map((migration) => migration.version), [2, 3]);
  const found = harness.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'xxx_placement'")
    .get();
  assert.ok(found !== undefined, 'xxx_placement was not created');
});

test('a scene expects a single file', async () => {
  const plugin = createXxxPlugin({ now: () => 1, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'k' });
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
