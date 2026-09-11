import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { HostFetch, JobEnqueue, PluginContext } from '@pickarr/contract';
import { createFakeLookupService, resolvedEnvelope } from '@pickarr/openmetadata/testing';
import type { LookupEnvelope, Media } from '@pickarr/openmetadata';
import { LOOKUP_JOB } from '@pickarr/openmetadata';
import { createMoviePlugin } from '@pickarr/plugin-movie';
import { createTvPlugin } from '@pickarr/plugin-tv';
import { createXxxPlugin } from '@pickarr/plugin-xxx';
import type { ArtworkStore } from '../../src/artwork/store.ts';
import { migrateHost, migratePlugin } from '../../src/db/migrate.ts';
import type { HostDb } from '../../src/db/open.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { createMediaReader } from '../../src/media/reader.ts';
import { createMediaWriter } from '../../src/media/writer.ts';

const NOW = 1_700_000_000_000;

function media(fields: Partial<Media> & Pick<Media, 'kind' | 'providerRef'>): Media {
  return {
    id: `id-${fields.providerRef}`,
    title: 'A Title',
    releaseDate: '2026-01-15',
    year: 2026,
    provider: 'tmdb',
    overview: null,
    details: {},
    parents: [],
    people: [],
    ...fields,
  };
}

const SCRIPT = new Map<string, LookupEnvelope>([
  ['episode.mkv', resolvedEnvelope({
    lookupId: 'lookup-tv',
    media: media({
      kind: 'episode',
      providerRef: 'tmdb:episode:1',
      title: 'Tomorrow',
      details: { seasonNumber: 3, episodeNumber: 1 },
      parents: [
        { id: 's', kind: 'season', title: 'Season 3', releaseDate: null, year: 2024, provider: 'tmdb', providerRef: 'tmdb:season:10' },
        { id: 'e', kind: 'series', title: 'The Bear', releaseDate: null, year: 2022, provider: 'tmdb', providerRef: 'tmdb:series:100' },
      ],
      people: [{ providerRef: 'tmdb:person:1', name: 'A Actor', role: 'cast', characterName: 'Carmy', billingOrder: 0 }],
    }),
  })],
  ['film.mkv', resolvedEnvelope({
    lookupId: 'lookup-movie',
    media: media({ kind: 'movie', providerRef: 'tmdb:movie:1', title: 'A Film', details: { runtimeMinutes: 120 } }),
  })],
  ['scene.mp4', resolvedEnvelope({
    lookupId: 'lookup-xxx',
    media: media({
      kind: 'scene',
      provider: 'tpdb',
      providerRef: 'tpdb:scene:1',
      title: 'A Scene',
      details: { siteName: 'A Site', siteRef: 'tpdb:site:7', durationSeconds: 1800 },
    }),
  })],
]);

/** A host database with the three plugins migrated, and one feed and item each. */
function fixture() {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const service = createFakeLookupService({ batch: SCRIPT, polls: new Map() });
  const deps = {
    now: () => NOW,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  };
  const plugins = [createTvPlugin(deps), createMoviePlugin(deps), createXxxPlugin(deps)];
  for (const plugin of plugins) migratePlugin(raw, plugin.id, plugin.migrations);
  return { raw, db, service, plugins };
}

function seedFeed(raw: DatabaseSync, pluginId: string, filename: string): { feedId: number; rssItemId: number } {
  const feed = raw.prepare(
    `INSERT INTO rss_feed (plugin_id, name, url, poll_interval_s, created_at, updated_at)
     VALUES (?, ?, ?, 900, ?, ?) RETURNING id`,
  ).get(pluginId, `${pluginId} feed`, `https://feed.test/${pluginId}`, NOW, NOW);
  const feedId = Number((feed as { id: unknown }).id);
  const item = raw.prepare(
    `INSERT INTO rss_item (feed_id, filename, link, resolution, download_type, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'torrent', ?, ?) RETURNING id`,
  ).get(feedId, filename, `https://feed.test/${filename}`, NOW, NOW);
  return { feedId, rssItemId: Number((item as { id: unknown }).id) };
}

/**
 * Nothing in this test attaches artwork -- the lookup API offers no image
 * urls -- so the store fails loudly rather than writing to a temp directory
 * this test would then have to clean up.
 */
const unusedArtwork: ArtworkStore = {
  put: async () => { throw new Error('artwork.put: this flow attaches no artwork'); },
  remove: async () => { throw new Error('artwork.remove: this flow removes no artwork'); },
};

/** The real writer and reader, the real connection, and one recording job queue per plugin. */
function contextFor(
  raw: DatabaseSync,
  db: HostDb,
  pluginId: string,
  fetch: HostFetch,
): { ctx: PluginContext; enqueued: JobEnqueue[] } {
  const enqueued: JobEnqueue[] = [];
  return {
    ctx: {
      db: raw,
      media: createMediaWriter(db, () => NOW, unusedArtwork),
      read: createMediaReader(raw, pluginId),
      jobs: {
        async enqueue(job: JobEnqueue): Promise<number> {
          enqueued.push(job);
          return enqueued.length;
        },
      },
      fetch,
      downloads: {
        async submit(): Promise<string | null> {
          throw new Error('downloads.submit: this flow submits nothing');
        },
      },
      log: () => {},
    },
    enqueued,
  };
}

// `node:sqlite` rows have a null prototype, and `deepEqual` compares
// prototypes -- so every row is normalized to a plain object here, once,
// rather than at each call site.
function rows(raw: DatabaseSync, sql: string): Record<string, unknown>[] {
  return (raw.prepare(sql).all() as Record<string, unknown>[]).map((row) => Object.assign({}, row));
}

test('every plugin table carries its own prefix, as migratePlugin demands', () => {
  const { raw, plugins } = fixture();
  const names = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => String((row as { name: unknown }).name));

  for (const plugin of plugins) {
    const mine = names.filter((name) => name.startsWith(`${plugin.id}_`));
    assert.ok(mine.length > 0, `${plugin.id} created no tables`);
  }
  assert.ok(names.includes('tv_release'));
  assert.ok(names.includes('movie_detail'));
  assert.ok(names.includes('xxx_scene'));
});

test('each plugin identifies its own feed item end to end', async () => {
  const { raw, db, service, plugins } = fixture();
  const seeds = [
    { plugin: plugins[0], ...seedFeed(raw, 'tv', 'episode.mkv') },
    { plugin: plugins[1], ...seedFeed(raw, 'movie', 'film.mkv') },
    { plugin: plugins[2], ...seedFeed(raw, 'xxx', 'scene.mp4') },
  ];

  for (const seed of seeds) {
    const plugin = seed.plugin;
    assert.ok(plugin !== undefined);
    const { ctx } = contextFor(raw, db, plugin.id, service.fetch);
    // eslint-disable-next-line no-await-in-loop -- each plugin's items are delivered in turn, as the host delivers them
    await plugin.onNewRssItems([seed.rssItemId], ctx);
    const handler = plugin.jobs[LOOKUP_JOB];
    assert.ok(handler !== undefined);
    // eslint-disable-next-line no-await-in-loop -- see above
    await handler({ id: 1, kind: LOOKUP_JOB, payload: { rssItemIds: [seed.rssItemId] }, attempts: 1 }, ctx);
  }

  const items = rows(raw, 'SELECT plugin_id, title, provider_ref FROM media_item ORDER BY plugin_id');
  assert.deepEqual(items, [
    { plugin_id: 'movie', title: 'A Film', provider_ref: 'tmdb:movie:1' },
    { plugin_id: 'tv', title: 'Tomorrow', provider_ref: 'tmdb:episode:1' },
    { plugin_id: 'xxx', title: 'A Scene', provider_ref: 'tpdb:scene:1' },
  ]);
  assert.deepEqual(
    rows(raw, 'SELECT resolution FROM rss_item ORDER BY id'),
    [{ resolution: 'resolved' }, { resolution: 'resolved' }, { resolution: 'resolved' }],
  );
  assert.deepEqual(rows(raw, 'SELECT name FROM person'), [{ name: 'A Actor' }]);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM role').get()?.['n'], 1);
  assert.equal(raw.prepare('SELECT series_id FROM tv_release').get()?.['series_id'], 1);
  assert.equal(raw.prepare('SELECT site_id FROM xxx_scene').get()?.['site_id'], 1);

  // Each plugin asked the service under its own wire category -- `movie`
  // asks as `movies`, plural, the one asymmetry §3.3 documents. This is the
  // one place this slice's design could silently send the wrong category to
  // the service, which is why `batchCategories` exists at all.
  assert.deepEqual(service.batchCategories, ['tv', 'movies', 'xxx']);
});
