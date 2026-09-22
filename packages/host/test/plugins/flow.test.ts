/**
 * The three shipped plugins, driven through the real host.
 *
 * Real migrations (through `host.register`, which runs `migratePlugin`), the
 * real `MediaWriter`/`MediaReader` pair, the real job queue, the real
 * delivery paths (`host.notifyNewRssItems` and `host.deliverToPlugin`), and
 * the §5.1 fake service at the real wire shape. Nothing here hand-builds a
 * `PluginContext` or a job payload, and that is the whole point of the
 * file: what these tests prove that the library's own tests cannot is the
 * **enqueue-to-dispatch contract** -- that the job `onNewRssItems` creates
 * is one the engine's own handler can read. A hand-written payload proves
 * that only by coincidence.
 *
 * The import tests at the end are the same argument one layer further on.
 * A path is asserted whole, against rows the *lookup* wrote: the season
 * number the fake service sent becomes `Season 03` through the plugin's own
 * resolver, the host's `plugin_destination` row and `resolveShape`, with
 * nothing in this file padding, joining or naming a series. And they are the
 * only tests in the tree that drive `ctxFor`'s `library`, which no
 * hand-assembled context could.
 *
 * The dispatcher is deliberately not started, and no timer is faked. What is
 * under test is the payload, not the scheduling: the job row the host
 * actually wrote is read back out of `jobs` and handed to the handler with
 * the context the host actually built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DownloadClients, MediaPlugin, PluginContext } from '@pickarr/contract';
import { createFakeLookupService, resolvedEnvelope } from '@pickarr/openmetadata/testing';
import type { LookupEnvelope, Media } from '@pickarr/openmetadata';
import { LOOKUP_JOB } from '@pickarr/openmetadata';
import { createMoviePlugin } from '@pickarr/plugin-movie';
import { createTvPlugin } from '@pickarr/plugin-tv';
import { createXxxPlugin } from '@pickarr/plugin-xxx';
import { migrateHost } from '../../src/db/migrate.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';
import { createHost } from '../../src/host.ts';

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
      people: [{ providerRef: 'tmdb:person:1', name: 'A Actor', role: 'performer', characterName: 'Carmy', billingOrder: 0 }],
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

/**
 * Nothing in this flow attaches artwork -- the lookup API offers no image
 * urls -- so the directory is one that does not exist. `createArtworkStore`
 * touches it only when something is stored, so a write would fail loudly
 * rather than this test having a temp directory to clean up.
 */
const unusedArtworkDir = '/nonexistent/pickarr-test-artwork-unused';

/** This flow submits nothing, so a submission is a failure rather than a no-op. */
const unusedDownloads: DownloadClients = {
  submit: async () => { throw new Error('downloads.submit: this flow submits nothing'); },
};

/**
 * The host wants a `QueuedFetch`, which is a `HostFetch` plus `text` for the
 * feed reader. Nothing here polls a feed -- rss items are seeded directly --
 * so `text` throws rather than pretending to serve xml.
 */
function queued(fetch: { json: QueuedFetch['json']; bytes: QueuedFetch['bytes'] }): QueuedFetch {
  return {
    json: fetch.json,
    bytes: fetch.bytes,
    text: async () => { throw new Error('fetch.text: this flow polls no feed'); },
  };
}

/**
 * The plugin, with the context the host handed it remembered.
 *
 * There is no other way to get the *real* `ctxFor` output: `host.ts` builds
 * one per plugin and hands it only to the plugin, and the alternative -- a
 * `PluginContext` literal assembled here -- was a hand-maintained second copy
 * of `ctxFor` that could drift from it silently. Wrapping the one entry point
 * the host calls before any job runs is what lets the handler below be driven
 * with the host's own writer, reader, fetch and job queue.
 */
function capturing(plugin: MediaPlugin): { plugin: MediaPlugin; context: () => PluginContext } {
  let seen: PluginContext | undefined;
  return {
    plugin: {
      ...plugin,
      async onNewRssItems(ids, ctx) {
        seen = ctx;
        await plugin.onNewRssItems(ids, ctx);
      },
    },
    context: () => {
      assert.ok(seen !== undefined, `${plugin.id} was never offered an rss item`);
      return seen;
    },
  };
}

/**
 * A real host over a real migrated database, with the three real plugins
 * registered -- which is what applies their migrations, since `register`
 * calls `migratePlugin` itself.
 */
function fixture() {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const service = createFakeLookupService({ batch: SCRIPT, polls: new Map() });
  const deps = {
    now: () => NOW,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  };
  const wrapped = [createTvPlugin(deps), createMoviePlugin(deps), createXxxPlugin(deps)].map(capturing);
  const host = createHost({
    raw,
    db,
    fetch: queued(service.fetch),
    downloads: () => unusedDownloads,
    // The real store over this test's own database and a directory that does
    // not exist: the plugins under test are handed `resolveSecret` directly
    // by `deps` above, so nothing here ever asks it for anything. It is
    // present because `createHost` hands one to the reconcile handler.
    secrets: createSecrets({ raw, baseDir: join(tmpdir(), 'pickarr-flow-no-secrets') }),
    now: () => NOW,
    artworkDir: unusedArtworkDir,
  });
  // Registered, never started: the dispatcher would run these jobs on a real
  // timer, and what is under test is the payload rather than the scheduling.
  for (const { plugin } of wrapped) host.register(plugin);
  return { raw, host, service, wrapped };
}

/** One feed and one item for a plugin, returning the ids both got. */
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
 * `node:sqlite` rows have a null prototype, and `deepEqual` compares
 * prototypes -- so every row is normalized to a plain object here, once,
 * rather than at each call site.
 *
 * The single-column `assert.equal` reads below deliberately do not go through
 * this: they compare a primitive pulled straight off a row, and no prototype
 * is involved in comparing two strings or two numbers.
 */
function rows(
  raw: DatabaseSync,
  sql: string,
  ...params: readonly SQLInputValue[]
): Record<string, unknown>[] {
  return (raw.prepare(sql).all(...params) as Record<string, unknown>[])
    .map((row) => Object.assign({}, row));
}

/** The `lookup` job a plugin's `onNewRssItems` actually wrote, as the dispatcher would read it. */
function enqueuedLookup(raw: DatabaseSync, pluginId: string): { id: number; kind: string; payload: unknown; attempts: number } {
  const found = rows(
    raw,
    "SELECT id, kind, payload_json, attempts FROM jobs WHERE plugin_id = ? AND state = 'ready'",
    pluginId,
  );
  assert.equal(found.length, 1, `${pluginId} enqueued exactly one job`);
  const row = found[0];
  assert.ok(row !== undefined);
  return {
    id: Number(row['id']),
    kind: String(row['kind']),
    payload: JSON.parse(String(row['payload_json'])),
    attempts: Number(row['attempts']),
  };
}

test('every plugin table carries its own prefix, as migratePlugin demands', () => {
  const { raw, wrapped } = fixture();
  const names = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => String((row as { name: unknown }).name));

  for (const { plugin } of wrapped) {
    const mine = names.filter((name) => name.startsWith(`${plugin.id}_`));
    assert.ok(mine.length > 0, `${plugin.id} created no tables`);
  }
  assert.ok(names.includes('tv_release'));
  assert.ok(names.includes('movie_detail'));
  assert.ok(names.includes('xxx_scene'));
});

test('each plugin identifies its own feed item end to end, through the job the host enqueued', async () => {
  const { raw, host, service, wrapped } = fixture();
  // The plugin id is taken from the plugin rather than written beside it:
  // spelled twice, the seed table and the plugin list could disagree about
  // which feed belongs to whom and every assertion below would still pass.
  const filenames = ['episode.mkv', 'film.mkv', 'scene.mp4'];
  const seeds = wrapped.map((entry, index) => {
    const filename = filenames[index] ?? '';
    const seeded = seedFeed(raw, entry.plugin.id, filename);
    return { plugin: entry.plugin, context: entry.context, filename, rssItemId: seeded.rssItemId };
  });

  // One delivery for all three items, exactly as a poll over three feeds
  // would reach the host -- so the routing below is the host's own, not this
  // test calling each plugin in turn.
  const outcome = await host.notifyNewRssItems(seeds.map((seed) => seed.rssItemId));
  assert.deepEqual(outcome.unowned, [], 'every seeded feed names a registered plugin');
  assert.deepEqual(outcome.failures, [], 'and no plugin rejected its own batch');

  // §5.4's "an item for one plugin's feed is never delivered to another's",
  // asserted rather than assumed: each plugin's own state table holds its own
  // rss item and nobody else's.
  for (const seed of seeds) {
    const mine = rows(raw, `SELECT rss_item_id FROM ${seed.plugin.id}_lookup`);
    assert.deepEqual(
      mine,
      [{ rss_item_id: seed.rssItemId }],
      `${seed.plugin.id} took its own item and no other plugin's`,
    );
  }

  for (const seed of seeds) {
    // The payload the engine actually wrote, read back out of the host's own
    // `jobs` table: this is the contract between `onNewRssItems` and the
    // handler, and nothing else in the tree exercises it.
    const job = enqueuedLookup(raw, seed.plugin.id);
    assert.equal(job.kind, LOOKUP_JOB);
    const handler = seed.plugin.jobs[job.kind];
    assert.ok(handler !== undefined, `${seed.plugin.id} registered no handler for ${job.kind}`);
    // eslint-disable-next-line no-await-in-loop -- each plugin's job runs in turn, as a serial dispatcher would run them, and the order decides which of two items claiming one provider ref would win
    await handler(job, seed.context());
  }

  const items = rows(raw, 'SELECT plugin_id, title, provider_ref FROM media_item ORDER BY plugin_id');
  assert.deepEqual(items, [
    { plugin_id: 'movie', title: 'A Film', provider_ref: 'tmdb:movie:1' },
    { plugin_id: 'tv', title: 'Tomorrow', provider_ref: 'tmdb:episode:1' },
    { plugin_id: 'xxx', title: 'A Scene', provider_ref: 'tpdb:scene:1' },
  ]);
  // `filename` as well as `resolution`: ordered by id alone, three identical
  // rows cannot say which plugin was the one that failed.
  assert.deepEqual(rows(raw, 'SELECT filename, resolution FROM rss_item ORDER BY id'), [
    { filename: 'episode.mkv', resolution: 'resolved' },
    { filename: 'film.mkv', resolution: 'resolved' },
    { filename: 'scene.mp4', resolution: 'resolved' },
  ]);
  assert.deepEqual(rows(raw, 'SELECT name FROM person'), [{ name: 'A Actor' }]);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM role').get()?.['n'], 1);

  // Through the join rather than against the literal `1`: an id equal to 1 is
  // an autoincrement, and what these rows are for is the relationship.
  assert.equal(
    raw.prepare('SELECT s.title AS title FROM tv_release r JOIN tv_series s ON s.id = r.series_id').get()?.['title'],
    'The Bear',
  );
  assert.equal(
    raw.prepare('SELECT t.name AS name FROM xxx_scene c JOIN xxx_site t ON t.id = c.site_id').get()?.['name'],
    'A Site',
  );
  // The film's own row, which nothing used to read at all: the shared
  // `media_item` above is written by the engine before `apply` runs, so a
  // movie `apply` that silently returned would have left every assertion
  // before this one green. The value, not the row count, for the same reason.
  assert.equal(
    raw.prepare('SELECT runtime_minutes AS minutes FROM movie_detail').get()?.['minutes'],
    120,
  );

  // Each plugin asked the service under its own wire category -- `movie`
  // asks as `movies`, plural, the one asymmetry §3.3 documents. This is the
  // one place this slice's design could silently send the wrong category to
  // the service, which is why `batchCategories` exists at all.
  assert.deepEqual(service.batchCategories, ['tv', 'movies', 'xxx']);
});

/**
 * Identifies one item through the real flow, then answers the media item id
 * the television plugin ended up with.
 *
 * Shared by the import tests below so that none of them hand-writes a
 * `tv_release`, a `tv_season` or a `media_item`: what the shape resolves
 * against is what the lookup actually wrote, which is the only way an
 * end-to-end path assertion says anything about the plugin.
 */
async function identifiedEpisode(
  fixtureResult: ReturnType<typeof fixture>,
): Promise<{ rssItemId: number; mediaItemId: number }> {
  const { raw, host, wrapped } = fixtureResult;
  const tv = wrapped.find((entry) => entry.plugin.id === 'tv');
  assert.ok(tv !== undefined, 'the television plugin is registered');
  const { rssItemId } = seedFeed(raw, 'tv', 'episode.mkv');

  await host.notifyNewRssItems([rssItemId]);
  const job = enqueuedLookup(raw, 'tv');
  const handler = tv.plugin.jobs[job.kind];
  assert.ok(handler !== undefined);
  await handler(job, tv.context());

  const mediaItemId = raw.prepare('SELECT media_item_id AS id FROM tv_release').get()?.['id'];
  assert.equal(typeof mediaItemId, 'number', 'the lookup wrote no tv_release row to import against');
  return { rssItemId, mediaItemId: Number(mediaItemId) };
}

/** Writes one plugin's destination directly -- `saveDestination` has its own tests. */
function destinationFor(raw: DatabaseSync, pluginId: string, root: string, shape: string): void {
  raw.prepare(
    `INSERT INTO plugin_destination (plugin_id, root, shape, unmatched_dir, created_at, updated_at)
     VALUES (?, ?, ?, '_unmatched', ?, ?)`,
  ).run(pluginId, root, shape, NOW, NOW);
}

test('spec 8.2: an identified episode lands at exactly the path its shape names, zero-padded', async () => {
  const result = fixture();
  const { raw, host } = result;
  const { rssItemId, mediaItemId } = await identifiedEpisode(result);

  const dir = await mkdtemp(join(tmpdir(), 'pickarr-flow-import-'));
  try {
    const root = join(dir, 'tv');
    await mkdir(root);
    const source = join(dir, 'downloads', 'episode.mkv');
    await mkdir(join(dir, 'downloads'));
    await writeFile(source, 'the episode');
    destinationFor(raw, 'tv', root, '{series}/Season {season}/{series} - S{season}E{episode}.{ext}');

    // The host's own dispatch, not a `PluginContext` this file assembled:
    // `deliverToPlugin` is what `deliverCompleted` calls, and it is the only
    // way to prove `ctxFor` wires `library` at all.
    await host.deliverToPlugin('tv', {
      path: source, sizeBytes: 11, downloadClientId: 1, rssItemId, mediaItemId,
    });

    // Every segment spelled out. `Season 03` and `S03E01` come from a
    // `season_number` of 3 and an `episode_number` of 1 that the *lookup*
    // wrote -- nothing in this test pads anything, and nothing in it names
    // the series either.
    assert.equal(
      await readFile(join(root, 'The Bear', 'Season 03', 'The Bear - S03E01.mkv'), 'utf8'),
      'the episode',
    );
    // Copy, not move: design spec §4 and §9.
    assert.equal(await readFile(source, 'utf8'), 'the episode');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spec 2026-09-22 §4.1: an episode delivered as a directory places its one video and nothing else', async () => {
  const result = fixture();
  const { raw, host } = result;
  const { rssItemId, mediaItemId } = await identifiedEpisode(result);

  const dir = await mkdtemp(join(tmpdir(), 'pickarr-flow-import-'));
  try {
    const root = join(dir, 'tv');
    await mkdir(root);
    const download = join(dir, 'downloads', 'The.Bear.S03E01.1080p-GRP');
    await mkdir(join(download, 'Sample'), { recursive: true });
    await writeFile(join(download, 'The.Bear.S03E01.1080p-GRP.mkv'), 'the episode');
    await writeFile(join(download, 'The.Bear.S03E01.1080p-GRP.nfo'), 'info');
    await writeFile(join(download, 'Sample', 'sample.mkv'), 'sample');
    destinationFor(raw, 'tv', root, '{series}/Season {season}/{series} - S{season}E{episode}.{ext}');

    await host.deliverToPlugin('tv', { path: download, sizeBytes: 4096, downloadClientId: 1, rssItemId, mediaItemId });

    assert.equal(
      await readFile(join(root, 'The Bear', 'Season 03', 'The Bear - S03E01.mkv'), 'utf8'),
      'the episode',
    );
    const placed = raw.prepare('SELECT relative_path AS p FROM tv_placement').all().map((row) => row['p']);
    assert.deepEqual(placed, ['The.Bear.S03E01.1080p-GRP.mkv']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spec 5: a destination that already exists leaves the plugin rejecting, so the row stays completed', async () => {
  const result = fixture();
  const { raw, host } = result;
  const { rssItemId, mediaItemId } = await identifiedEpisode(result);

  const dir = await mkdtemp(join(tmpdir(), 'pickarr-flow-import-'));
  try {
    const root = join(dir, 'tv');
    await mkdir(join(root, 'The Bear', 'Season 03'), { recursive: true });
    await writeFile(join(root, 'The Bear', 'Season 03', 'The Bear - S03E01.mkv'), 'the better copy');
    const source = join(dir, 'episode.mkv');
    await writeFile(source, 'the episode');
    destinationFor(raw, 'tv', root, '{series}/Season {season}/{series} - S{season}E{episode}.{ext}');

    // Rejecting is what `deliverCompleted` reads as "leave it `completed`
    // and try next tick" -- and the message is logged there, so it names
    // the rule and nothing else.
    await assert.rejects(
      () => host.deliverToPlugin('tv', {
        path: source, sizeBytes: 11, downloadClientId: 1, rssItemId, mediaItemId,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /destination-exists/);
        assert.ok(!error.message.includes(dir), 'the thrown message carries a path');
        return true;
      },
    );
    assert.equal(
      await readFile(join(root, 'The Bear', 'Season 03', 'The Bear - S03E01.mkv'), 'utf8'),
      'the better copy',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spec 4.3: a release nothing matched lands under the unmatched directory, in a directory named for it, keeping its own filename', async () => {
  const { raw, host } = fixture();
  const { rssItemId } = seedFeed(raw, 'tv', 'episode.mkv');

  const dir = await mkdtemp(join(tmpdir(), 'pickarr-flow-import-'));
  try {
    const root = join(dir, 'tv');
    await mkdir(root);
    const source = join(dir, 'Something.Nobody.Identified.mkv');
    await writeFile(source, 'the mystery');
    destinationFor(raw, 'tv', root, '{series}/Season {season}/{series} - S{season}E{episode}.{ext}');

    await host.deliverToPlugin('tv', {
      path: source, sizeBytes: 11, downloadClientId: 1, rssItemId, mediaItemId: null,
    });

    // The shape is not consulted: no `The Bear`, no `Season`. The single
    // file gets a directory named for it without its extension (download
    // file selection spec §4.3), and the whole source filename survives
    // inside it, extension included.
    assert.equal(
      await readFile(join(root, '_unmatched', 'Something.Nobody.Identified', 'Something.Nobody.Identified.mkv'), 'utf8'),
      'the mystery',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
