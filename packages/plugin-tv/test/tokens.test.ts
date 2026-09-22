/**
 * `TV_TOKENS`: what a television path may name, resolved against the rows
 * `applyTv` really writes.
 *
 * **Seeded through `applyTv`, not by hand-written INSERTs.** The three
 * tables are this plugin's own and the resolvers join across all three, so a
 * fixture that wrote them directly would be this file's idea of the schema
 * rather than the plugin's -- and the join that matters (`tv_release` ->
 * `tv_season` -> `season_number`) is exactly where a hand-written fixture
 * would agree with a wrong query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedFile, PluginContext } from '@pickarr/contract';
import type { Media, MediaKind, MediaParent } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyTv } from '../src/apply.ts';
import { TV_MIGRATIONS } from '../src/migrations.ts';
import { TV_TOKENS } from '../src/tokens.ts';

const NOW = 1_700_000_000_000;
const MEDIA_ITEM_ID = 1;

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

function episode(details: Record<string, number>): Media {
  return {
    ...parent('episode', 'tmdb:episode:1', 'Tomorrow'),
    overview: null,
    details,
    parents: [
      parent('season', 'tmdb:season:10', 'Season 3'),
      parent('series', 'tmdb:series:100', 'The Bear'),
    ],
    people: [],
  };
}

function downloaded(): DownloadedFile {
  return {
    path: '/downloads/The.Bear.S03E01.mkv',
    sizeBytes: 10,
    downloadClientId: 1,
    rssItemId: 7,
    mediaItemId: MEDIA_ITEM_ID,
  };
}

/** Every declared token resolved, exactly as the engine builds the map. */
async function resolveAll(ctx: PluginContext, file = downloaded()): Promise<Record<string, string | null>> {
  const entries = Object.entries(TV_TOKENS);
  const values = await Promise.all(entries.map(async ([, resolve]) => resolve(file, ctx)));
  return Object.fromEntries(entries.map(([name], index) => [name, values[index] ?? null]));
}

/** A harness with this plugin's tables, one media item, and `media` applied to it. */
async function seeded(media: Media): Promise<PluginContext> {
  const harness = createTestHarness();
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  const id = await harness.ctx.media.createMediaItem({
    pluginId: 'tv', title: media.title, releaseDate: media.releaseDate, description: null,
  });
  assert.equal(id, MEDIA_ITEM_ID);
  await applyTv({ media, mediaItemId: id, raw: harness.raw, ctx: harness.ctx, now: NOW });
  return harness.ctx;
}

test('spec 8.2: a season of 3 and an episode of 1 resolve zero-padded to two digits', async () => {
  const ctx = await seeded(episode({ seasonNumber: 3, episodeNumber: 1 }));

  const values = await resolveAll(ctx);

  // The padding lives here and nowhere else. `media/shape.ts` interpolates
  // verbatim, so if this returned `'3'` the library would read `Season 3`
  // and `S3E1` -- which is why the literal `'03'` is spelled out rather
  // than computed from the number seeded above.
  assert.equal(values['season'], '03');
  assert.equal(values['episode'], '01');
});

test('a number of two or more digits keeps every digit: the padding is a minimum, not a width', async () => {
  const ctx = await seeded(episode({ seasonNumber: 12, episodeNumber: 100 }));

  const values = await resolveAll(ctx);

  assert.equal(values['season'], '12');
  assert.equal(values['episode'], '100');
});

test('the series is the series row, and the title is the episode, so one is not the other', async () => {
  const ctx = await seeded(episode({ seasonNumber: 3, episodeNumber: 1 }));

  const values = await resolveAll(ctx);

  // Two different strings from two different tables. A `{series}` that read
  // `media_item.title` would put every episode in a directory named after
  // itself, and would pass any test where the two happened to agree.
  assert.equal(values['series'], 'The Bear');
  assert.equal(values['title'], 'Tomorrow');
});

test('every declared token resolves, and the whole map is what a television shape may name', async () => {
  const ctx = await seeded(episode({ seasonNumber: 3, episodeNumber: 1 }));

  assert.deepEqual(await resolveAll(ctx), {
    series: 'The Bear',
    season: '03',
    episode: '01',
    title: 'Tomorrow',
    releaseDate: '2024-06-26',
    filename: 'The.Bear.S03E01',
    ext: 'mkv',
  });
});

test('a series pack whose file carries no marker has no season and no episode, and those are holes rather than faults', async () => {
  const series: Media = {
    ...parent('series', 'tmdb:series:100', 'The Bear'),
    overview: null,
    details: {},
    parents: [],
    people: [],
  };
  const ctx = await seeded(series);

  const values = await resolveAll(ctx, { ...downloaded(), path: '/downloads/The.Bear.Complete/bonus.mkv' });

  // `tv_release.season_id` and `episode_number` are both nullable and both
  // null here, and the filename has no `S..E..` marker to fall back to. `resolveShape` drops the segments (design spec §8.8); a
  // throw would leave the download row `completed` for ever instead.
  assert.equal(values['season'], null);
  assert.equal(values['episode'], null);
  assert.equal(values['series'], 'The Bear');
});

test('an episode whose answer carried no numbers, in a file with no marker, resolves both as holes', async () => {
  const ctx = await seeded(episode({}));

  const values = await resolveAll(ctx, { ...downloaded(), path: '/downloads/The.Bear.Tomorrow.mkv' });

  assert.equal(values['season'], null);
  assert.equal(values['episode'], null);
});

/**
 * Pack entries. During an import the engine calls each resolver once per
 * placed entry with `file.path` set to that entry's own path, so a pack's
 * per-file season and episode come from the entry's filename when the
 * database has no number for them.
 */
function season(details: Record<string, number>): Media {
  return {
    ...parent('season', 'tmdb:season:10', 'Season 3'),
    overview: null,
    details,
    parents: [parent('series', 'tmdb:series:100', 'The Bear')],
    people: [],
  };
}

function seriesPack(): Media {
  return {
    ...parent('series', 'tmdb:series:100', 'The Bear'),
    overview: null,
    details: {},
    parents: [],
    people: [],
  };
}

function entry(path: string): DownloadedFile {
  return { ...downloaded(), path };
}

test('a season pack entry takes its episode from its own filename, and its season from the row', async () => {
  const ctx = await seeded(season({ seasonNumber: 3 }));

  const values = await resolveAll(ctx, entry('/downloads/The.Bear.S03.1080p/The.Bear.S03E02.mkv'));

  assert.equal(values['episode'], '02');
  assert.equal(values['season'], '03');
});

test('a series pack entry takes both its season and its episode from its own filename', async () => {
  const ctx = await seeded(seriesPack());

  const values = await resolveAll(ctx, entry('/downloads/The.Bear.Complete/Season 2/The.Bear.S02E05.mkv'));

  assert.equal(values['season'], '02');
  assert.equal(values['episode'], '05');
});

test('a multi-episode entry names its first episode, then each further one as -E', async () => {
  const ctx = await seeded(season({ seasonNumber: 3 }));

  const values = await resolveAll(ctx, entry('/downloads/The.Bear.S03/The.Bear.S03E01E02.mkv'));

  // So the canonical `S{season}E{episode}` shape reads `S03E01-E02`.
  assert.equal(values['episode'], '01-E02');
  assert.equal(values['season'], '03');
});

test("an episode's own numbers beat a marker in its filename that disagrees", async () => {
  const ctx = await seeded(episode({ seasonNumber: 3, episodeNumber: 1 }));

  const values = await resolveAll(ctx, entry('/downloads/The.Bear.S05E09.mkv'));

  assert.equal(values['season'], '03');
  assert.equal(values['episode'], '01');
});
