/**
 * Identifying a release by hand (design spec 2026-10-02 §1.3): the
 * validation-and-dispatch rule behind `POST /api/releases/:id/identify`.
 * These cover which refusal each condition produces, which of the two
 * effects (move the release, or ask its plugin) each mode reaches, and what
 * the plugin is handed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaPlugin, PluginContext } from '@pickarr/contract';
import type { ArtworkStore } from '../../src/artwork/store.ts';
import { openTestDatabase, type HostDb } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createMediaWriter } from '../../src/media/writer.ts';
import { identifyRelease, type IdentifyDeps } from '../../src/media/identify.ts';

const NOW = 1_700_000_000_000;

/** No test here attaches artwork. */
const unusedArtwork: ArtworkStore = {
  put: async () => { throw new Error('artwork.put: not used by this test'); },
  putPerson: async () => { throw new Error('artwork.putPerson: not used by this test'); },
  remove: async () => { throw new Error('artwork.remove: not used by this test'); },
};

function setup(feedPluginId = 'tv'): { raw: DatabaseSync; db: HostDb } {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at)
    VALUES (1, ?, 'a feed', 'https://tracker.example/rss', 10, 10)
  `).run(feedPluginId);
  return { raw, db };
}

function seedRelease(raw: DatabaseSync, id: number, mediaItemId: number | null = null, lookupState = 'unresolved'): void {
  raw.prepare(`
    INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, lookup_state, media_item_id)
    VALUES (?, 1, 'a.mkv', 'https://tracker.example/a.torrent', 10, 10, 'torrent', ?, ?)
  `).run(id, lookupState, mediaItemId);
}

function seedMediaItem(raw: DatabaseSync, id: number, pluginId = 'tv'): void {
  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, title, created_at, updated_at)
    VALUES (?, ?, 'A Show', 10, 10)
  `).run(id, pluginId);
}

interface LookupCall {
  readonly rssItemId: number;
  readonly hint: { name: string } | undefined;
  readonly ctx: PluginContext;
}

interface Harness {
  readonly deps: IdentifyDeps;
  readonly lookups: LookupCall[];
  readonly reassigns: [number, number][];
  readonly ctx: PluginContext;
}

/** Deps with a `tv` plugin that records the lookups it is asked for, and a `reassign` that records its moves. */
function harness(raw: DatabaseSync, db: HostDb, onLookup?: () => Promise<void>): Harness {
  const lookups: LookupCall[] = [];
  const reassigns: [number, number][] = [];
  const unused = async (): Promise<never> => { throw new Error('not used by this test'); };
  const plugin: MediaPlugin = {
    id: 'tv',
    mediaType: 'tv',
    migrations: [],
    jobs: {},
    synced: [],
    tokens: {},
    onNewRssItems: unused,
    onDownloadedFile: unused,
    onDownloadRequest: unused,
    onMediaItemDropped: unused,
    onLookupRequest: async (rssItemId, hint, ctx) => {
      lookups.push({ rssItemId, hint, ctx });
      if (onLookup !== undefined) await onLookup();
    },
  };
  const ctx: PluginContext = {
    db: raw,
    media: createMediaWriter(db, () => NOW, unusedArtwork, { dropRows: async () => {} }),
    read: { mediaItem: unused, mediaItemByProviderRef: unused, rssItemsFor: unused, downloadsFor: unused },
    jobs: { enqueue: unused },
    fetch: { json: unused, bytes: unused },
    downloads: { submit: unused },
    library: { list: unused, place: unused },
    log: () => {},
  };
  return {
    lookups,
    reassigns,
    ctx,
    deps: {
      raw,
      pluginFor: (id) => (id === 'tv' ? plugin : undefined),
      ctxFor: () => ctx,
      reassign: async (rssItemId, mediaItemId) => { reassigns.push([rssItemId, mediaItemId]); },
    },
  };
}

test('media-item mode moves the release and answers linked', async () => {
  const { raw, db } = setup();
  seedMediaItem(raw, 1); seedMediaItem(raw, 2); seedRelease(raw, 10, 1);
  const { deps, reassigns, lookups } = harness(raw, db);

  assert.deepEqual(await identifyRelease(deps, 10, { mode: 'media-item', mediaItemId: 2 }), { outcome: 'linked', mediaItemId: 2 });
  assert.deepEqual(reassigns, [[10, 2]]);
  assert.deepEqual(lookups, [], 'moving a release asks no plugin anything');
  raw.close();
});

test('requery and name modes ask the owning plugin, with and without the hint', async () => {
  const { raw, db } = setup();
  seedRelease(raw, 10);
  const { deps, reassigns, lookups, ctx } = harness(raw, db);

  assert.deepEqual(await identifyRelease(deps, 10, { mode: 'requery' }), { accepted: true });
  assert.deepEqual(await identifyRelease(deps, 10, { mode: 'name', name: 'Dune' }), { accepted: true });
  assert.deepEqual(lookups.map(({ rssItemId, hint }) => ({ rssItemId, hint })), [
    { rssItemId: 10, hint: undefined },
    { rssItemId: 10, hint: { name: 'Dune' } },
  ]);
  assert.ok(lookups.every((call) => call.ctx === ctx), 'the plugin is handed its own context');
  assert.deepEqual(reassigns, [], 'asking a plugin moves nothing');
  raw.close();
});

test('a padded name reaches the plugin trimmed at the ends only', async () => {
  // The route hands the host a name it has already trimmed. The host passes
  // it through unchanged: inner runs of space are the lookup service's business.
  const { raw, db } = setup();
  seedRelease(raw, 10);
  const { deps, lookups } = harness(raw, db);

  await identifyRelease(deps, 10, { mode: 'name', name: 'Dune   Part Two' });

  assert.deepEqual(lookups.map(({ hint }) => hint), [{ name: 'Dune   Part Two' }]);
  raw.close();
});

test('each refusal from its condition', async () => {
  const { raw, db } = setup();
  seedMediaItem(raw, 1); seedMediaItem(raw, 2); seedMediaItem(raw, 3, 'movie');
  seedRelease(raw, 10, 2);
  const { deps, reassigns, lookups } = harness(raw, db);

  assert.deepEqual(await identifyRelease(deps, 404, { mode: 'requery' }), { refusal: 'unknown-release' });
  assert.deepEqual(await identifyRelease(deps, 10, { mode: 'media-item', mediaItemId: 99 }), { refusal: 'unknown-media-item' });
  assert.deepEqual(await identifyRelease(deps, 10, { mode: 'media-item', mediaItemId: 3 }), { refusal: 'wrong-plugin' });
  assert.deepEqual(await identifyRelease(deps, 10, { mode: 'media-item', mediaItemId: 2 }), { refusal: 'already-linked' });
  assert.deepEqual(reassigns, []);
  assert.deepEqual(lookups, []);
  raw.close();

  const ghost = setup('ghost');
  seedRelease(ghost.raw, 10);
  const ghostHarness = harness(ghost.raw, ghost.db);
  assert.deepEqual(await identifyRelease(ghostHarness.deps, 10, { mode: 'requery' }), { refusal: 'plugin-not-registered' });
  assert.deepEqual(ghostHarness.lookups, []);
  ghost.raw.close();
});

test('a release whose lookup is already pending is still re-asked', async () => {
  const { raw, db } = setup();
  seedRelease(raw, 10, null, 'pending');
  const { deps, lookups } = harness(raw, db);

  assert.deepEqual(await identifyRelease(deps, 10, { mode: 'requery' }), { accepted: true });
  assert.equal(lookups.length, 1);
  raw.close();
});

test('a throwing plugin surfaces as a fault, not a refusal', async () => {
  const { raw, db } = setup();
  seedRelease(raw, 10);
  const boom = new Error('the plugin could not enqueue');
  const { deps } = harness(raw, db, async () => { throw boom; });

  await assert.rejects(
    () => identifyRelease(deps, 10, { mode: 'requery' }),
    (err: unknown) => err === boom,
  );
  raw.close();
});
