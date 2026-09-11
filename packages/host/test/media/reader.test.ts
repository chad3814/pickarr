import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, MediaPlugin, PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createMediaReader } from '../../src/media/reader.ts';
import { createHost } from '../../src/host.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';
import type { Secrets } from '../../src/secrets/instance.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/**
 * A media item owned by `pluginId`, with its provider pair claimed. Written
 * with raw SQL rather than through `MediaWriter`: what is under test here is
 * the reader, and going through the writer would make a reader failure and a
 * writer failure look the same.
 */
function seedMediaItem(
  raw: DatabaseSync,
  pluginId: string,
  title: string,
  provider: string,
  ref: string,
): number {
  const info = raw.prepare(`
    INSERT INTO media_item (plugin_id, created_at, updated_at, provider, provider_ref, title, release_date, description)
    VALUES (?, 10, 20, ?, ?, ?, '1999-10-15', 'A description')
  `).run(pluginId, provider, ref, title);
  return Number(info.lastInsertRowid);
}

/** `rss_feed_url` is unique, so every feed a test seeds needs its own url. */
function seedFeed(raw: DatabaseSync, pluginId: string, url: string): number {
  const info = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, poll_interval_s, created_at, updated_at)
    VALUES (?, 'Feed', ?, 900, 1, 1)
  `).run(pluginId, url);
  return Number(info.lastInsertRowid);
}

/** `rss_item_feed_guid` is unique on `(feed_id, guid)`, so the guid is derived from the filename. */
function seedRssItem(
  raw: DatabaseSync,
  feedId: number,
  filename: string,
  mediaItemId: number | null,
): number {
  const info = raw.prepare(`
    INSERT INTO rss_item
      (feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution, resolution_detail, guid)
    VALUES (?, ?, ?, 30, 40, 'torrent', ?, '1080p', 'x264', ?)
  `).run(feedId, filename, `https://example.com/${filename}`, mediaItemId, `guid-${filename}`);
  return Number(info.lastInsertRowid);
}

/** `download_client_name` is unique, so every client a test seeds needs its own name. */
function seedClient(raw: DatabaseSync, name: string): number {
  const info = raw.prepare(`
    INSERT INTO download_client (name, type, url, category, import_mode, created_at, updated_at)
    VALUES (?, 'torrent', ?, 'movies', 'copy', 1, 1)
  `).run(name, `https://example.com/${name}`);
  return Number(info.lastInsertRowid);
}

function seedTorrentDownload(raw: DatabaseSync, rssItemId: number, clientId: number, clientRef: string): number {
  const info = raw.prepare(`
    INSERT INTO torrent_download
      (rss_item_id, download_client_id, infohash, client_ref, status, last_error, created_at, updated_at, percentage, absent_since, delivered_at)
    VALUES (?, ?, 'deadbeef', ?, 'downloading', NULL, 50, 60, 40, NULL, NULL)
  `).run(rssItemId, clientId, clientRef);
  return Number(info.lastInsertRowid);
}

test('a reader answers with its own plugin\'s media item', async () => {
  const raw = setup();
  const id = seedMediaItem(raw, 'alpha', 'Fight Club', 'tmdb', '550');
  const reader = createMediaReader(raw, 'alpha');

  const expected = {
    id,
    title: 'Fight Club',
    releaseDate: '1999-10-15',
    description: 'A description',
    provider: 'tmdb',
    providerRef: '550',
    createdAt: 10,
    updatedAt: 20,
  };
  assert.deepEqual(await reader.mediaItem(id), expected);
  assert.deepEqual(await reader.mediaItemByProviderRef('tmdb', '550'), expected);
  // An id this plugin owns nothing under is the same `null` a foreign id
  // gets -- absence and ownership are one answer, deliberately.
  assert.equal(await reader.mediaItem(id + 1000), null);
});

test('a reader answers null for another plugin\'s media item, by id and by reference', async () => {
  // Null, not a throw: "not yours" and "not there" are the same answer to a
  // plugin, and distinguishing them would leak the other plugin's contents.
  const raw = setup();
  const mine = seedMediaItem(raw, 'alpha', 'Mine', 'tmdb', '550');
  const theirs = seedMediaItem(raw, 'beta', 'Theirs', 'tvdb', '99');
  const reader = createMediaReader(raw, 'alpha');

  assert.equal(await reader.mediaItem(theirs), null);
  assert.equal(await reader.mediaItemByProviderRef('tvdb', '99'), null);
  // The same reader still sees its own row, so the two assertions above are
  // scoping rather than a reader that answers null to everything.
  assert.equal((await reader.mediaItem(mine))?.title, 'Mine');
  assert.equal((await reader.mediaItemByProviderRef('tmdb', '550'))?.title, 'Mine');
});

test('a reader reaches an item\'s rss items and their downloads', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw, 'alpha', 'Fight Club', 'tmdb', '550');
  const feedId = seedFeed(raw, 'alpha', 'https://example.com/feed');
  const rssItemId = seedRssItem(raw, feedId, 'fight.club.mkv', mediaItemId);
  seedRssItem(raw, feedId, 'unrelated.mkv', null);
  const clientId = seedClient(raw, 'qbit');
  const downloadId = seedTorrentDownload(raw, rssItemId, clientId, 'ref-1');
  const reader = createMediaReader(raw, 'alpha');

  assert.deepEqual(await reader.rssItemsFor(mediaItemId), [{
    id: rssItemId,
    feedId,
    filename: 'fight.club.mkv',
    link: 'https://example.com/fight.club.mkv',
    mediaItemId,
    resolution: '1080p',
    resolutionDetail: 'x264',
    downloadType: 'torrent',
    deliveredAt: null,
  }]);

  assert.deepEqual(await reader.downloadsFor(rssItemId), [{
    id: downloadId,
    rssItemId,
    downloadClientId: clientId,
    transport: 'torrent',
    status: 'downloading',
    clientRef: 'ref-1',
    infohash: 'deadbeef',
    percentage: 40,
    absentSince: null,
    deliveredAt: null,
    lastError: null,
  }]);
});

test('a reader answers empty for another plugin\'s rss items and downloads, by an id it never gave out', async () => {
  // Task 4b's gap: `rssItemsFor` and `downloadsFor` used to take a bare id
  // and filter by nothing else, so a plugin handing back an id it was never
  // given -- any integer -- read another plugin's releases and downloads
  // through this reader. A real second plugin, with a real feed and a real
  // item, is seeded here rather than a nonexistent id, which would pass
  // even against no filter at all.
  const raw = setup();
  const mediaItemId = seedMediaItem(raw, 'alpha', 'Fight Club', 'tmdb', '550');
  const theirFeedId = seedFeed(raw, 'beta', 'https://example.com/their-feed');
  // Beta's rss item points at the *same* media item id alpha holds, so the
  // isolation being tested is the feed's ownership, not the media item's.
  const theirItemId = seedRssItem(raw, theirFeedId, 'theirs.mkv', mediaItemId);
  const clientId = seedClient(raw, 'qbit');
  seedTorrentDownload(raw, theirItemId, clientId, 'their-ref');

  const reader = createMediaReader(raw, 'alpha');

  assert.deepEqual(await reader.rssItemsFor(mediaItemId), []);
  assert.deepEqual(await reader.downloadsFor(theirItemId), []);

  // The same reader, asked as beta, still sees them -- so the emptiness
  // above is scoping, not a reader that answers empty to everything.
  const theirReader = createMediaReader(raw, 'beta');
  assert.deepEqual(
    (await theirReader.rssItemsFor(mediaItemId)).map((item) => item.id),
    [theirItemId],
  );
  assert.deepEqual(
    (await theirReader.downloadsFor(theirItemId)).map((row) => row.clientRef),
    ['their-ref'],
  );
});

/** A `QueuedFetch` that fails loudly: nothing in this file polls a feed. */
const unusedFetch: QueuedFetch = {
  json: async () => { throw new Error('fetch.json: not used by this test'); },
  bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  text: async () => { throw new Error('fetch.text: not used by this test'); },
};

/** A `DownloadClients` that fails loudly: nothing in this file submits. */
const unusedDownloads: DownloadClients = {
  submit: async () => { throw new Error('downloads.submit: not used by this test'); },
};
/**
 * A `Secrets` that fails loudly if a test never meant to resolve a
 * credential. No test in this file reads a `download_client` row through
 * `readClientConfig`, so nothing here should reach the secrets chain --
 * `clients/config.test.ts` and `clients/reconcile-job.test.ts` are where a
 * real one is exercised.
 */
const unusedSecrets: Secrets = {
  get: async () => { throw new Error('secrets.get: not used by this test'); },
  saveSecret: () => { throw new Error('secrets.saveSecret: not used by this test'); },
};

/**
 * No test here attaches artwork, so this directory is never created --
 * `createArtworkStore` only touches the filesystem from its first `put()`.
 * A path under a directory that does not exist means a test that did reach
 * an `attach*` method would fail loudly on `mkdir` rather than quietly
 * writing somewhere real. The same fake `host.test.ts` uses.
 */
const unusedArtworkDir = '/nonexistent/pickarr-test-artwork-unused';

/** An entry point a plugin under test never expects to be reached. */
function unusedEntryPoint(name: string): () => Promise<never> {
  return async () => { throw new Error(`${name}: not used by this test`); };
}

/** A minimal but complete `MediaPlugin`, the shape `host.test.ts` builds. */
function makePlugin(overrides: Partial<MediaPlugin> & { id: string }): MediaPlugin {
  return {
    mediaType: 'movie',
    migrations: [],
    jobs: {},
    onNewRssItems: unusedEntryPoint('onNewRssItems'),
    onDownloadedFile: unusedEntryPoint('onDownloadedFile'),
    onDownloadRequest: unusedEntryPoint('onDownloadRequest'),
    ...overrides,
  };
}

test('a plugin\'s context carries a reader scoped to it', async () => {
  // Through host.register + ctxFor, not by constructing one directly.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const host = createHost({
    raw,
    db,
    fetch: unusedFetch,
    downloads: unusedDownloads,
    secrets: unusedSecrets,
    now: () => 1000,
    artworkDir: unusedArtworkDir,
    // No `timers` override and no `start()`: the dispatcher arms nothing
    // until started, so no real timer is ever created by this test.
  });

  const mine = seedMediaItem(raw, 'alpha', 'Mine', 'tmdb', '550');
  const theirs = seedMediaItem(raw, 'beta', 'Theirs', 'tvdb', '99');

  const contexts: PluginContext[] = [];
  host.register(makePlugin({
    id: 'alpha',
    onNewRssItems: async (_ids, ctx) => { contexts.push(ctx); },
  }));

  const feedId = seedFeed(raw, 'alpha', 'https://example.com/alpha');
  const rssItemId = seedRssItem(raw, feedId, 'x.mkv', mine);
  const outcome = await host.notifyNewRssItems([rssItemId]);
  assert.deepEqual(outcome.failures, [], 'the plugin\'s own handler must not have rejected');

  const ctx = contexts[0];
  assert.ok(ctx, 'alpha\'s onNewRssItems must have been called with a context');
  assert.equal((await ctx.read.mediaItem(mine))?.title, 'Mine');
  // The id is closed over by `ctxFor`, so alpha cannot reach beta's row
  // through its own context however it asks.
  assert.equal(await ctx.read.mediaItem(theirs), null);
  assert.equal(await ctx.read.mediaItemByProviderRef('tvdb', '99'), null);
});
