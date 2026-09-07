import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { PluginNotRegisteredError } from '../../src/host.ts';
import { deliverCompleted } from '../../src/clients/deliver.ts';
import type { DeliverDeps } from '../../src/clients/deliver.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/** Inserts one `download_client` row and returns its id. Mirrors `rows.test.ts`'s own `seedClient`. */
function seedClient(raw: DatabaseSync, overrides: { name?: string } = {}): number {
  const name = overrides.name ?? 'Client';
  raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key, username, password, category, import_mode, created_at, updated_at)
    VALUES (?, 'torrent', 'qbittorrent', 'https://client.example.com', 'key', NULL, NULL, 'movies', 'copy', 1, 1)
  `).run(name);
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(name);
  return Number((inserted as { id: unknown }).id);
}

/** Inserts one `filepath_mapping` row for `clientId`. Mirrors `paths.test.ts`'s own `seedMapping`. */
function seedMapping(raw: DatabaseSync, clientId: number, fromPath: string, toPath: string): void {
  raw.prepare(`
    INSERT INTO filepath_mapping (download_client_id, from_path, to_path, created_at)
    VALUES (?, ?, ?, 1)
  `).run(clientId, fromPath, toPath);
}

/**
 * Inserts one `rss_feed` and one `rss_item` row and returns the item's id --
 * the foreign keys `torrent_download` requires. Mirrors `rows.test.ts`'s own
 * `seedRssItem`, with a caller-chosen `pluginId` so a feed can name a plugin
 * this test never registers anywhere (there is no registry here at all --
 * `deliverCompleted` only ever sees a plugin id string).
 */
function seedRssItem(raw: DatabaseSync, name: string, pluginId = 'alpha'): number {
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES (?, ?, ?, 1, 1)
  `).run(pluginId, name, `https://example.test/${name}`);
  const feedId = Number((raw.prepare('SELECT id FROM rss_feed WHERE name = ?').get(name) as { id: unknown }).id);
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, ?, ?, 1, 1, 'torrent', '1080p')
  `).run(feedId, `${name}.mkv`, `https://example.test/${name}.mkv`);
  return Number(result.lastInsertRowid);
}

/** Inserts one `torrent_download` row and returns its id. */
function insertTorrentRow(
  raw: DatabaseSync,
  params: {
    rssItemId: number;
    downloadClientId: number;
    clientRef?: string | null;
    status?: string;
    storagePath?: string | null;
    deliveredAt?: number | null;
  },
): number {
  const status = params.status ?? 'completed';
  const result = raw.prepare(`
    INSERT INTO torrent_download
      (rss_item_id, download_client_id, client_ref, status, storage_path, delivered_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1)
  `).run(
    params.rssItemId,
    params.downloadClientId,
    params.clientRef ?? null,
    status,
    params.storagePath ?? null,
    params.deliveredAt ?? null,
  );
  return Number(result.lastInsertRowid);
}

/** Reads one raw column back off `torrent_download`, for assertions that must not trust the module under test. */
function readColumn(raw: DatabaseSync, id: number, column: string): unknown {
  const row = raw.prepare(`SELECT ${column} FROM torrent_download WHERE id = ?`).get(id) as Record<string, unknown>;
  return row[column];
}

/** A `stat` that fails loudly if a test never meant to reach it. */
const unusedStat: DeliverDeps['stat'] = async () => { throw new Error('stat: not used by this test'); };

/** A `deliver` that fails loudly if a test never meant to reach it. */
const unusedDeliver: DeliverDeps['deliver'] = async () => { throw new Error('deliver: not used by this test'); };

/**
 * Builds a full `DeliverDeps`, `remove` present only when `overrides` names
 * one -- `exactOptionalPropertyTypes` is on, so an explicit `remove:
 * undefined` is not the same thing as the property being absent, and the
 * "no remove" test depends on that distinction actually holding.
 */
function baseDeps(
  raw: DatabaseSync,
  clientId: number,
  overrides: Partial<Omit<DeliverDeps, 'raw' | 'clientId'>> = {},
): DeliverDeps {
  const { remove, ...rest } = overrides;
  const deps: DeliverDeps = {
    raw,
    clientId,
    now: rest.now ?? 1000,
    stat: rest.stat ?? unusedStat,
    deliver: rest.deliver ?? unusedDeliver,
    log: rest.log ?? (() => {}),
  };
  return remove === undefined ? deps : { ...deps, remove };
}

test('a completed row is delivered to the plugin owning its feed', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });

  const statCalls: string[] = [];
  const deliverCalls: { pluginId: string; file: DownloadedFile }[] = [];
  const result = await deliverCompleted(baseDeps(raw, clientId, {
    stat: async (path) => { statCalls.push(path); return { sizeBytes: 4096 }; },
    deliver: async (pluginId, file) => { deliverCalls.push({ pluginId, file }); },
  }));

  assert.deepEqual(result, { delivered: 1, reclaimed: 0, unowned: 0 });
  // The path passed to `stat` and to `deliver` is the *mapped* one, never
  // the client's own stored path.
  assert.deepEqual(statCalls, ['/media/movie.mkv']);
  assert.deepEqual(deliverCalls, [
    { pluginId: 'alpha', file: { path: '/media/movie.mkv', sizeBytes: 4096, downloadClientId: clientId } },
  ]);
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
  assert.equal(readColumn(raw, id, 'delivered_at'), 1000);
});

test('a delivered row is not delivered again', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });

  let calls = 0;
  const deps = baseDeps(raw, clientId, {
    stat: async () => ({ sizeBytes: 10 }),
    deliver: async () => { calls += 1; },
  });

  const first = await deliverCompleted(deps);
  const second = await deliverCompleted(deps);

  assert.equal(calls, 1, 'deliver must be called exactly once across both passes');
  assert.equal(first.delivered, 1);
  assert.equal(second.delivered, 0);
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
});

test('a plugin that throws leaves the row completed for the next tick', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });

  let calls = 0;
  const deps = baseDeps(raw, clientId, {
    stat: async () => ({ sizeBytes: 10 }),
    deliver: async () => { calls += 1; throw new Error('plugin exploded'); },
  });

  const first = await deliverCompleted(deps);
  const second = await deliverCompleted(deps);

  // Retried: the same row is offered to the plugin again on the next pass.
  assert.equal(calls, 2, 'a plugin that keeps throwing must be retried every pass');
  assert.equal(first.delivered, 0);
  assert.equal(second.delivered, 0);
  assert.equal(readColumn(raw, id, 'status'), 'completed');
  assert.equal(readColumn(raw, id, 'delivered_at'), null);
});

test('a file that is not there is a delivery failure, not a completion failure', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });

  const result = await deliverCompleted(baseDeps(raw, clientId, {
    stat: async () => { throw new Error('ENOENT: no such file or directory'); },
    deliver: unusedDeliver,
  }));

  assert.equal(result.delivered, 0);
  // Never `failed` -- a corrected `filepath_mapping` takes effect on the
  // very next tick with nothing needing to be un-failed.
  assert.equal(readColumn(raw, id, 'status'), 'completed');
  assert.equal(readColumn(raw, id, 'last_error'), null);
  assert.equal(readColumn(raw, id, 'delivered_at'), null);
});

test('a row whose plugin is not registered is reported unowned and retried', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'ghost');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });

  let calls = 0;
  const deps = baseDeps(raw, clientId, {
    stat: async () => ({ sizeBytes: 10 }),
    deliver: async (pluginId) => { calls += 1; throw new PluginNotRegisteredError(pluginId); },
  });

  const first = await deliverCompleted(deps);
  const second = await deliverCompleted(deps);

  assert.equal(calls, 2, 'an unowned row must be retried every pass');
  assert.deepEqual(first, { delivered: 0, reclaimed: 0, unowned: 1 });
  assert.deepEqual(second, { delivered: 0, reclaimed: 0, unowned: 1 });
  assert.equal(readColumn(raw, id, 'status'), 'completed');
});

test('a delivered row is reclaimed when the adapter can reclaim', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'delivered', deliveredAt: 500,
  });

  const removedRefs: string[] = [];
  const result = await deliverCompleted(baseDeps(raw, clientId, {
    remove: async (ref) => { removedRefs.push(ref); },
  }));

  assert.deepEqual(result, { delivered: 0, reclaimed: 1, unowned: 0 });
  assert.deepEqual(removedRefs, ['ref-1']);
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
});

test('a client with no remove reclaims nothing', async () => {
  // The torrent case: qBittorrent has no way to drop a job without also
  // stopping the seed, so `deps.remove` is simply absent.
  const raw = setup();
  const clientId = seedClient(raw);
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'delivered', deliveredAt: 500,
  });

  const result = await deliverCompleted(baseDeps(raw, clientId));

  assert.deepEqual(result, { delivered: 0, reclaimed: 0, unowned: 0 });
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
});
