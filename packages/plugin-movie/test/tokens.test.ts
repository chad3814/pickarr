/**
 * `MOVIE_TOKENS`: what a film path may name, resolved against the row
 * `applyMovie` really writes.
 *
 * Seeded through `applyMovie` rather than by hand, for the reason
 * `plugin-tv/test/tokens.test.ts` gives: a fixture written directly would
 * be this file's idea of `movie_detail` rather than the plugin's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedFile, PluginContext } from '@pickarr/contract';
import type { Media } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyMovie } from '../src/apply.ts';
import { MOVIE_MIGRATIONS } from '../src/migrations.ts';
import { MOVIE_TOKENS } from '../src/tokens.ts';

const NOW = 1_700_000_000_000;
const MEDIA_ITEM_ID = 1;

function movie(over: Partial<Media> = {}): Media {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    kind: 'movie',
    title: 'Dune: Part Two',
    releaseDate: '2024-03-01',
    year: 2024,
    provider: 'tmdb',
    providerRef: 'tmdb:movie:693134',
    overview: null,
    details: { collectionName: 'Dune Collection' },
    parents: [],
    people: [],
    ...over,
  };
}

function downloaded(): DownloadedFile {
  return {
    path: '/downloads/Dune.Part.Two.2024.2160p.mkv',
    sizeBytes: 10,
    downloadClientId: 1,
    rssItemId: 7,
    mediaItemId: MEDIA_ITEM_ID,
  };
}

/** Every declared token resolved, exactly as the engine builds the map. */
async function resolveAll(ctx: PluginContext): Promise<Record<string, string | null>> {
  const entries = Object.entries(MOVIE_TOKENS);
  const values = await Promise.all(entries.map(async ([, resolve]) => resolve(downloaded(), ctx)));
  return Object.fromEntries(entries.map(([name], index) => [name, values[index] ?? null]));
}

async function seeded(media: Media): Promise<PluginContext> {
  const harness = createTestHarness();
  for (const migration of MOVIE_MIGRATIONS) migration.up(harness.raw);
  const id = await harness.ctx.media.createMediaItem({
    pluginId: 'movie', title: media.title, releaseDate: media.releaseDate, description: null,
  });
  assert.equal(id, MEDIA_ITEM_ID);
  await applyMovie({ media, mediaItemId: id, raw: harness.raw, ctx: harness.ctx, now: NOW });
  return harness.ctx;
}

test('every declared token resolves, and the whole map is what a film shape may name', async () => {
  const ctx = await seeded(movie());

  assert.deepEqual(await resolveAll(ctx), {
    title: 'Dune: Part Two',
    year: '2024',
    releaseDate: '2024-03-01',
    collection: 'Dune Collection',
    // Design spec §3 says this comes from `rss_item`; the column of that
    // name is the lookup state, not a video resolution, and 2.0 records no
    // video resolution anywhere. See `openmetadata`'s `resolveResolution`.
    resolution: null,
    filename: 'Dune.Part.Two.2024.2160p',
    ext: 'mkv',
  });
});

test('spec 8.8: a film with no collection resolves the token to nothing, not to an empty name', async () => {
  const ctx = await seeded(movie({ details: {} }));

  const values = await resolveAll(ctx);

  // §8.8's own worked example. `null` rather than `''` so
  // `resolveShape` drops the segment, which is what keeps
  // `{collection}/{title} ({year}).{ext}` from growing a nameless
  // top-level directory holding every film that belongs to no collection.
  assert.equal(values['collection'], null);
  assert.equal(values['title'], 'Dune: Part Two');
});

test('the 2009 film *9* keeps its one-character title, which is what removing the resolver padding bought', async () => {
  const ctx = await seeded(movie({ title: '9', releaseDate: '2009-09-09', details: {} }));

  const values = await resolveAll(ctx);

  // While `media/shape.ts` padded every all-digit value this was `09`, in
  // the directory name and in the filename, permanently -- design spec §10
  // puts re-importing out of scope. The year beside it is four digits and
  // was never affected, which is why both are asserted.
  assert.equal(values['title'], '9');
  assert.equal(values['year'], '2009');
});
