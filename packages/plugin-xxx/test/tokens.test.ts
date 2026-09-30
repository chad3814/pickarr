/**
 * `XXX_TOKENS`: what a scene path may name, resolved against the rows
 * `applyXxx` really writes.
 *
 * Seeded through `applyXxx` rather than by hand, for the reason
 * `plugin-tv/test/tokens.test.ts` gives: `{site}` joins `xxx_scene` to
 * `xxx_site`, and a hand-written fixture would agree with a wrong join.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedFile, PluginContext } from '@pickarr/contract';
import type { Media } from '@pickarr/openmetadata';
import { lookupTableMigration } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyXxx } from '../src/apply.ts';
import { XXX_MIGRATIONS } from '../src/migrations.ts';
import { XXX_TOKENS } from '../src/tokens.ts';

const NOW = 1_700_000_000_000;
const MEDIA_ITEM_ID = 1;

function scene(details: Media['details']): Media {
  return {
    id: 'id-tpdb:scene:1',
    kind: 'scene',
    title: 'A Scene',
    releaseDate: '2026-01-15',
    year: 2026,
    provider: 'tpdb',
    providerRef: 'tpdb:scene:1',
    overview: null,
    details,
    parents: [],
    people: [],
  };
}

function downloaded(): DownloadedFile {
  return {
    path: '/downloads/A.Site.26.01.15.A.Scene.XXX.1080p.MP4',
    sizeBytes: 10,
    downloadClientId: 1,
    rssItemId: 7,
    mediaItemId: MEDIA_ITEM_ID,
  };
}

/** Every declared token resolved, exactly as the engine builds the map. */
async function resolveAll(ctx: PluginContext): Promise<Record<string, string | null>> {
  const entries = Object.entries(XXX_TOKENS);
  const values = await Promise.all(entries.map(async ([, resolve]) => resolve(downloaded(), ctx)));
  return Object.fromEntries(entries.map(([name], index) => [name, values[index] ?? null]));
}

async function seeded(media: Media): Promise<PluginContext> {
  const harness = createTestHarness();
  lookupTableMigration('xxx').up(harness.raw);
  for (const migration of XXX_MIGRATIONS) migration.up(harness.raw);
  const id = await harness.ctx.media.createMediaItem({
    pluginId: 'xxx', title: media.title, releaseDate: media.releaseDate, description: null,
  });
  assert.equal(id, MEDIA_ITEM_ID);
  await applyXxx({ media, mediaItemId: id, raw: harness.raw, ctx: harness.ctx, now: NOW });
  return harness.ctx;
}

test('every declared token resolves, and the whole map is what a scene shape may name', async () => {
  const ctx = await seeded(scene({ siteName: 'A Site', siteRef: 'tpdb:site:7' }));

  assert.deepEqual(await resolveAll(ctx), {
    // The `xxx_site` row's `name`, reached through `xxx_scene.site_id` --
    // not `media_item.title`, which is the scene.
    site: 'A Site',
    title: 'A Scene',
    releaseDate: '2026-01-15',
    // No `rss_item` row exists for this harness's `rssItemId` (7), so the
    // resolver's own hole -- a row that is gone -- is what shows here, not
    // a stored value; `openmetadata/test/tokens.test.ts` pins the stored case.
    resolution: null,
    filename: 'A.Site.26.01.15.A.Scene.XXX.1080p',
    // Lowercased from `MP4`, so two spellings of one release cannot land as
    // two files.
    ext: 'mp4',
  });
});

test('a scene whose site is unknown resolves the token to nothing, not to a fault', async () => {
  // `applyXxx` writes `site_id` only when the answer carried both a name
  // and a reference -- a name with no reference has nothing to key a row
  // on. A scene whose site is unknown is still a scene worth having.
  const ctx = await seeded(scene({ siteName: 'A Site' }));

  const values = await resolveAll(ctx);

  assert.equal(values['site'], null);
  assert.equal(values['title'], 'A Scene');
});
