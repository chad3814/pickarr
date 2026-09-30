/**
 * `expectsTv`: what a television download is judged against, read from the
 * rows `applyTv` really writes -- seeded through it for the reason
 * `tokens.test.ts` gives, since the season number is reached by the same
 * `tv_release` -> `tv_season` join.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedFile, PluginContext } from '@pickarr/contract';
import type { Media, MediaKind, MediaParent } from '@pickarr/openmetadata';
import { lookupTableMigration } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyTv } from '../src/apply.ts';
import { expectsTv } from '../src/expects.ts';
import { TV_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;

function parent(kind: MediaKind, providerRef: string, title: string): MediaParent {
  return { id: `id-${providerRef}`, kind, title, releaseDate: '2024-06-26', year: 2024, provider: 'tmdb', providerRef };
}

const SERIES = parent('series', 'tmdb:series:100', 'The Bear');
const SEASON = parent('season', 'tmdb:season:10', 'Season 3');

function media(kind: 'episode' | 'season' | 'series', details: Record<string, number>): Media {
  const self = kind === 'series' ? SERIES : kind === 'season' ? SEASON : parent('episode', 'tmdb:episode:1', 'Tomorrow');
  const parents = kind === 'series' ? [] : kind === 'season' ? [SERIES] : [SEASON, SERIES];
  return { ...self, overview: null, details, parents, people: [] };
}

/** A harness with this plugin's tables, one media item, and `media` applied to it. */
async function seeded(applied: Media): Promise<{ ctx: PluginContext; mediaItemId: number }> {
  const harness = createTestHarness();
  lookupTableMigration('tv').up(harness.raw);
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  const mediaItemId = await harness.ctx.media.createMediaItem({
    pluginId: 'tv', title: applied.title, releaseDate: applied.releaseDate, description: null,
  });
  await applyTv({ media: applied, mediaItemId, raw: harness.raw, ctx: harness.ctx, now: NOW });
  return { ctx: harness.ctx, mediaItemId };
}

function file(mediaItemId: number): DownloadedFile {
  return { path: '/downloads/pack', sizeBytes: 4096, downloadClientId: 1, rssItemId: 7, mediaItemId };
}

test('an episode expects a single file', async () => {
  const { ctx, mediaItemId } = await seeded(media('episode', { seasonNumber: 3, episodeNumber: 1 }));
  assert.deepEqual(await expectsTv(file(mediaItemId), ctx), { kind: 'single' });
});

test('a season pack expects episodes of its own season number', async () => {
  const { ctx, mediaItemId } = await seeded(media('season', { seasonNumber: 3 }));
  assert.deepEqual(await expectsTv(file(mediaItemId), ctx), { kind: 'episodes', season: 3 });
});

test('a season pack whose number is unknown expects episodes of any season', async () => {
  const { ctx, mediaItemId } = await seeded(media('season', {}));
  assert.deepEqual(await expectsTv(file(mediaItemId), ctx), { kind: 'episodes', season: null });
});

test('a series pack expects episodes of any season', async () => {
  const { ctx, mediaItemId } = await seeded(media('series', {}));
  assert.deepEqual(await expectsTv(file(mediaItemId), ctx), { kind: 'episodes', season: null });
});

test('a media item with no tv_release row throws, so the row is retried rather than guessed at', async () => {
  const harness = createTestHarness();
  lookupTableMigration('tv').up(harness.raw);
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  await assert.rejects(() => expectsTv(file(999), harness.ctx), /no tv_release/);
});
