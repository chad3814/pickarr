import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { PluginNotRegisteredError } from '../../src/host.ts';
import { deliverCompleted } from '../../src/clients/deliver.ts';
import type { DeliverDeps } from '../../src/clients/deliver.ts';
import { createSabnzbdClient } from '../../src/clients/sabnzbd.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/**
 * Inserts one `download_client` row and returns its id. Mirrors
 * `rows.test.ts`'s own `seedClient`, minus the credential: nothing in this
 * file reads the row through `readClientConfig`, and since migration 14 the
 * row would hold only a `secret` name, so a name here would be one nothing
 * ever resolves. `paths.test.ts` and `select.test.ts` seed the same way.
 */
function seedClient(raw: DatabaseSync, overrides: { name?: string } = {}): number {
  const name = overrides.name ?? 'Client';
  raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key_secret_name, username, password_secret_name,
       category, import_mode, created_at, updated_at)
    VALUES (?, 'torrent', 'qbittorrent', 'https://client.example.com', NULL, NULL, NULL, 'movies', 'copy', 1, 1)
  `).run(name);
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(name);
  return Number((inserted as { id: unknown }).id);
}

/** Inserts one `filepath_mapping` row for `clientId`. Mirrors `paths.test.ts`'s own `seedMapping`. */
function seedMapping(raw: DatabaseSync, clientId: number, fromPath: string, toPath: string): void {
  raw.prepare(`
    INSERT INTO filepath_mapping (download_client_id, from_path, to_path, created_at, updated_at)
    VALUES (?, ?, ?, 1, 1)
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
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, lookup_state)
    VALUES (?, ?, ?, 1, 1, 'torrent', 'resolved')
  `).run(feedId, `${name}.mkv`, `https://example.test/${name}.mkv`);
  return Number(result.lastInsertRowid);
}

/**
 * Inserts one `media_item` row at a caller-chosen id and returns it.
 *
 * The id is explicit so a test can keep it apart from the rss item's and the
 * download row's: all three are integers, so a delivery that carried the
 * wrong one of them would satisfy any assertion that only checked the type.
 */
function seedMediaItem(raw: DatabaseSync, id: number, title: string, pluginId = 'alpha'): number {
  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, created_at, updated_at, title)
    VALUES (?, ?, 1, 1, ?)
  `).run(id, pluginId, title);
  return id;
}

/** Points an existing `rss_item` at a media item, the way a resolved lookup does. */
function linkRssItem(raw: DatabaseSync, rssItemId: number, mediaItemId: number): void {
  raw.prepare('UPDATE rss_item SET media_item_id = ? WHERE id = ?').run(mediaItemId, rssItemId);
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
    reclaimedAt?: number | null;
    /**
     * Chosen by the caller only where the row's own id has to differ from
     * the rss item id it names -- see `seedMediaItem`. Left out everywhere
     * else, so the rowid sequence stays the default.
     */
    id?: number;
  },
): number {
  const status = params.status ?? 'completed';
  const result = raw.prepare(`
    INSERT INTO torrent_download
      (id, rss_item_id, download_client_id, client_ref, status, storage_path, delivered_at, reclaimed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `).run(
    params.id ?? null,
    params.rssItemId,
    params.downloadClientId,
    params.clientRef ?? null,
    status,
    params.storagePath ?? null,
    params.deliveredAt ?? null,
    params.reclaimedAt ?? null,
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
  // `id: 42` so this test's own `rssItemId` assertion below can fail. Both
  // sequences start at 1, so without it the download row and the rss item
  // are both 1 and that line reads as a pin it is not -- it survived the
  // `row.id`-for-`row.rssItemId` mutant that the test below kills.
  const id = insertTorrentRow(raw, {
    id: 42, rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });

  const statCalls: string[] = [];
  const deliverCalls: { pluginId: string; file: DownloadedFile }[] = [];
  const result = await deliverCompleted(baseDeps(raw, clientId, {
    stat: async (path) => { statCalls.push(path); return { sizeBytes: 4096 }; },
    deliver: async (pluginId, file) => { deliverCalls.push({ pluginId, file }); },
  }));

  assert.deepEqual(result, { delivered: 1, reclaimed: 0, unowned: 0, reclaimFailures: 0, undeliverable: 0, refused: 0 });
  // The path passed to `stat` and to `deliver` is the *mapped* one, never
  // the client's own stored path.
  assert.deepEqual(statCalls, ['/media/movie.mkv']);
  assert.deepEqual(deliverCalls, [
    {
      pluginId: 'alpha',
      file: {
        path: '/media/movie.mkv',
        sizeBytes: 4096,
        downloadClientId: clientId,
        rssItemId: itemId,
        mediaItemId: null,
      },
    },
  ]);
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
  assert.equal(readColumn(raw, id, 'delivered_at'), 1000);
});

test('a delivered file names the rss item it came from and the media item that item resolved to', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const mediaItemId = seedMediaItem(raw, 77, 'A Title');
  linkRssItem(raw, itemId, mediaItemId);
  // The download row's own id, the rss item's and the media item's are three
  // different integers here, chosen so that a delivery carrying the wrong one
  // fails this test rather than passing it. Pinned rather than trusted: the
  // ids come from three sequences that all start at 1.
  const id = insertTorrentRow(raw, {
    id: 42, rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });
  assert.equal(id, 42);
  assert.equal(itemId, 1);
  assert.equal(mediaItemId, 77);

  const deliverCalls: DownloadedFile[] = [];
  const result = await deliverCompleted(baseDeps(raw, clientId, {
    stat: async () => ({ sizeBytes: 4096 }),
    deliver: async (_pluginId, file) => { deliverCalls.push(file); },
  }));

  assert.equal(result.delivered, 1);
  assert.deepEqual(deliverCalls, [{
    path: '/media/movie.mkv',
    sizeBytes: 4096,
    downloadClientId: clientId,
    rssItemId: 1,
    mediaItemId: 77,
  }]);
});

test('an rss item that resolved to no media item is delivered with mediaItemId null', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  // A second rss item that *does* have one, so a delivery reading the column
  // off the wrong row -- or off no row at all -- has something to find.
  const matchedItemId = seedRssItem(raw, 'other', 'alpha');
  linkRssItem(raw, matchedItemId, seedMediaItem(raw, 77, 'A Title'));
  const id = insertTorrentRow(raw, {
    id: 42, rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });

  const deliverCalls: DownloadedFile[] = [];
  const result = await deliverCompleted(baseDeps(raw, clientId, {
    stat: async () => ({ sizeBytes: 4096 }),
    deliver: async (_pluginId, file) => { deliverCalls.push(file); },
  }));

  // Null, not a throw and not a zero: an unmatched release is a state the
  // boundary reports, not an error the import discovers later.
  assert.deepEqual(deliverCalls, [{
    path: '/media/movie.mkv',
    sizeBytes: 4096,
    downloadClientId: clientId,
    rssItemId: itemId,
    mediaItemId: null,
  }]);
  assert.equal(result.delivered, 1);
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
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
    now: 1_000,
    stat: async () => ({ sizeBytes: 10 }),
    deliver: async () => { calls += 1; throw new Error('plugin exploded'); },
  });

  const first = await deliverCompleted(deps);
  // A pass before the backoff `first` just recorded is due: not retried, and
  // not counted as a fresh refusal either (#101).
  const stillWaiting = await deliverCompleted(deps);
  // Retried once the backoff `first` recorded has passed -- never abandoned,
  // just not offered on every tick in between.
  const second = await deliverCompleted({ ...deps, now: 11_000 });

  assert.equal(calls, 2, 'a plugin that keeps throwing is retried once its backoff has passed, not every pass');
  assert.equal(first.delivered, 0);
  assert.equal(first.refused, 1);
  assert.equal(stillWaiting.refused, 0, 'not yet due: not attempted');
  assert.equal(second.delivered, 0);
  assert.equal(second.refused, 1);
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
  assert.deepEqual(first, { delivered: 0, reclaimed: 0, unowned: 1, reclaimFailures: 0, undeliverable: 0, refused: 0 });
  assert.deepEqual(second, { delivered: 0, reclaimed: 0, unowned: 1, reclaimFailures: 0, undeliverable: 0, refused: 0 });
  assert.equal(readColumn(raw, id, 'status'), 'completed');
});

test('a completed row the client gave no path for is counted and logged on every pass, and never failed', async () => {
  // `ClientHistoryEntry`'s own doc permits a `completed` entry with no
  // `storagePath`, and both adapters emit null for a missing or empty field.
  // The row used to be filtered out of the pass in silence: `sweepAbsent`
  // clears its absence because its ref *is* accounted for, so across tick
  // after tick it produced zero counters and zero log lines while sitting
  // `completed` with `delivered_at` null. Three passes here, because one
  // pass cannot tell "stuck" from "not yet".
  const raw = setup();
  const clientId = seedClient(raw);
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', storagePath: null,
  });

  const logs: { message: string; detail?: Readonly<Record<string, unknown>> }[] = [];
  // `stat` and `deliver` are the loud unused doubles: reaching either would
  // mean this row was treated as deliverable after all.
  const deps = baseDeps(raw, clientId, {
    log: (message, detail) => { logs.push(detail === undefined ? { message } : { message, detail }); },
  });

  const passes = [await deliverCompleted(deps), await deliverCompleted(deps), await deliverCompleted(deps)];

  for (const pass of passes) {
    assert.deepEqual(pass, { delivered: 0, reclaimed: 0, unowned: 0, reclaimFailures: 0, undeliverable: 1, refused: 0 });
  }
  assert.deepEqual(logs, [
    { message: 'download client reported this download completed with no storage path, nothing to deliver', detail: { rowId: id } },
    { message: 'download client reported this download completed with no storage path, nothing to deliver', detail: { rowId: id } },
    { message: 'download client reported this download completed with no storage path, nothing to deliver', detail: { rowId: id } },
  ]);
  // Not failed, and not delivered: a path the client reports later, or a
  // corrected mapping, still works -- the same reasoning a missing file gets.
  assert.equal(readColumn(raw, id, 'status'), 'completed');
  assert.equal(readColumn(raw, id, 'delivered_at'), null);
  assert.equal(readColumn(raw, id, 'last_error'), null);
  assert.equal(readColumn(raw, id, 'storage_path'), null);
});

test('a path the client supplies later is delivered, with no un-failing needed', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  // `id: 42` for the reason the first delivery test gives: otherwise the
  // `rssItemId` in the `deepEqual` below cannot fail.
  const id = insertTorrentRow(raw, {
    id: 42, rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', storagePath: null,
  });

  const deliverCalls: DownloadedFile[] = [];
  const deps = baseDeps(raw, clientId, {
    stat: async () => ({ sizeBytes: 8 }),
    deliver: async (_pluginId, file) => { deliverCalls.push(file); },
  });

  const first = await deliverCompleted(deps);
  assert.equal(first.undeliverable, 1);
  assert.deepEqual(deliverCalls, []);

  // What a later poll's `setStoragePath` writes -- the row was left in a
  // state that write is still legal against.
  raw.prepare('UPDATE torrent_download SET storage_path = ? WHERE id = ?').run('/downloads/movie.mkv', id);

  const second = await deliverCompleted(deps);
  assert.deepEqual(second, { delivered: 1, reclaimed: 0, unowned: 0, reclaimFailures: 0, undeliverable: 0, refused: 0 });
  assert.deepEqual(deliverCalls, [{
    path: '/media/movie.mkv', sizeBytes: 8, downloadClientId: clientId, rssItemId: itemId, mediaItemId: null,
  }]);
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
  assert.equal(readColumn(raw, id, 'delivered_at'), 1000);
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
    now: 900,
    remove: async (ref) => { removedRefs.push(ref); },
  }));

  assert.deepEqual(result, { delivered: 0, reclaimed: 1, unowned: 0, reclaimFailures: 0, undeliverable: 0, refused: 0 });
  assert.deepEqual(removedRefs, ['ref-1']);
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
  assert.equal(readColumn(raw, id, 'reclaimed_at'), 900, 'the mark is what makes the next pass skip this row');
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

  assert.deepEqual(result, { delivered: 0, reclaimed: 0, unowned: 0, reclaimFailures: 0, undeliverable: 0, refused: 0 });
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
  assert.equal(readColumn(raw, id, 'reclaimed_at'), null);
});

test('a delivered row is reclaimed exactly once, however many passes follow -- the defect this task fixes', async () => {
  // Without `reclaimed_at` gating the query, this row would be offered to
  // `remove` again on every single pass forever: a SABnzbd client with 500
  // delivered downloads would issue 500 delete requests a minute,
  // indefinitely. A single-pass test cannot see that at all -- this is the
  // test that actually proves the fix.
  const raw = setup();
  const clientId = seedClient(raw);
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'delivered', deliveredAt: 500,
  });

  const removedRefs: string[] = [];
  const deps = baseDeps(raw, clientId, {
    now: 900,
    remove: async (ref) => { removedRefs.push(ref); },
  });

  const first = await deliverCompleted(deps);
  const second = await deliverCompleted(deps);

  assert.equal(removedRefs.length, 1, 'remove must be called exactly once across both passes');
  assert.deepEqual(removedRefs, ['ref-1']);
  assert.equal(first.reclaimed, 1, 'the first pass performs the reclaim');
  assert.equal(second.reclaimed, 0, 'the second pass finds nothing left to reclaim');
  assert.equal(readColumn(raw, id, 'status'), 'delivered');
  assert.equal(readColumn(raw, id, 'reclaimed_at'), 900);
});

test('a remove that throws leaves the row unreclaimed, and the next pass retries it', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'delivered', deliveredAt: 500,
  });

  let calls = 0;
  const deps = baseDeps(raw, clientId, {
    now: 900,
    remove: async () => {
      calls += 1;
      if (calls === 1) throw new Error('client unreachable');
    },
  });

  // A failing `remove` is caught per row, so the pass reports it and keeps
  // going rather than rejecting -- the same shape `deliverOne` already
  // applies to a plugin that throws.
  const first = await deliverCompleted(deps);
  assert.equal(first.reclaimed, 0);
  assert.equal(first.reclaimFailures, 1, 'the failure is reported, not only logged');
  assert.equal(readColumn(raw, id, 'reclaimed_at'), null, 'the row stays unmarked -- remove never confirmed success');

  const second = await deliverCompleted(deps);
  assert.equal(calls, 2, 'the row must be retried on the next pass, the same shape delivery already has');
  assert.equal(second.reclaimed, 1);
  assert.equal(second.reclaimFailures, 0);
  assert.equal(readColumn(raw, id, 'reclaimed_at'), 900);
});

test("a SABnzbd delete refused at HTTP 200 leaves the row unreclaimed, and the next pass retries it", async () => {
  // The real adapter, not a hand-written `remove`: the defect was that
  // `remove` read nothing out of the response, so a refusal answered with a
  // 200 came back as success, `reclaimed_at` was stamped, the row was never
  // offered again, and -- because the request carries `del_files=1` -- the
  // files stayed on disk forever. Wiring the actual client in is what makes
  // this test see that, rather than testing a double that agrees with it.
  const raw = setup();
  const clientId = seedClient(raw);
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'SABnzbd_nzo_1',
    status: 'delivered', deliveredAt: 500,
  });

  let calls = 0;
  const fetch: QueuedFetch = {
    snapshot: () => [],
    async json<T>(): Promise<T> {
      calls += 1;
      // Refused on the first pass, accepted on the second: SABnzbd answers
      // both with HTTP 200, which is the whole point.
      const body: unknown = calls === 1
        ? { status: false, error: 'API Key Incorrect' }
        : { status: true };
      return body as T;
    },
    bytes(): Promise<Uint8Array> { throw new Error('bytes is not used by this test'); },
    text(): Promise<string> { throw new Error('text is not used by this test'); },
  };
  const sabnzbd = createSabnzbdClient({
    kind: 'sabnzbd', id: 41, baseUrl: 'https://sab.example.com', apiKey: 'not-a-real-key', category: 'movies',
  }, fetch);
  const deps = baseDeps(raw, clientId, { now: 900, remove: (ref) => sabnzbd.remove(ref) });

  const first = await deliverCompleted(deps);

  assert.equal(first.reclaimed, 0, 'a refused delete is not a reclaim');
  assert.equal(first.reclaimFailures, 1, 'the refusal is reported, not swallowed');
  assert.equal(readColumn(raw, id, 'reclaimed_at'), null, 'the row must stay unmarked -- the job is still in SABnzbd');
  assert.equal(readColumn(raw, id, 'status'), 'delivered');

  const second = await deliverCompleted(deps);

  assert.equal(calls, 2, 'the row must be offered again, which the stamp would have prevented forever');
  assert.equal(second.reclaimed, 1);
  assert.equal(second.reclaimFailures, 0);
  assert.equal(readColumn(raw, id, 'reclaimed_at'), 900);
});

test('one ref the client will not delete does not starve the rows behind it', async () => {
  // The reason reclaim is caught per row rather than per pass. Without it,
  // the first bad ref rejects the whole pass, and because the next tick reads
  // the same rows in the same order it stops at the same one -- so a single
  // permanently-undeletable job blocks reclaim for every row behind it,
  // forever, while `reclaimed: 0` looks indistinguishable from "nothing left
  // to reclaim".
  const raw = setup();
  const clientId = seedClient(raw);
  const poisonItem = seedRssItem(raw, 'poison', 'alpha');
  const goodItem = seedRssItem(raw, 'good', 'alpha');
  const poisonId = insertTorrentRow(raw, {
    rssItemId: poisonItem, downloadClientId: clientId, clientRef: 'ref-poison', status: 'delivered', deliveredAt: 500,
  });
  const goodId = insertTorrentRow(raw, {
    rssItemId: goodItem, downloadClientId: clientId, clientRef: 'ref-good', status: 'delivered', deliveredAt: 500,
  });

  const asked: string[] = [];
  const deps = baseDeps(raw, clientId, {
    now: 900,
    remove: async (ref: string) => {
      asked.push(ref);
      if (ref === 'ref-poison') throw new Error('will never delete this one');
    },
  });

  const result = await deliverCompleted(deps);

  assert.deepEqual(asked, ['ref-poison', 'ref-good'], 'the good row must still be asked for');
  assert.equal(result.reclaimed, 1);
  assert.equal(result.reclaimFailures, 1);
  assert.equal(readColumn(raw, poisonId, 'reclaimed_at'), null);
  assert.equal(readColumn(raw, goodId, 'reclaimed_at'), 900, 'the row behind the poison one is reclaimed');
});

test('a delivery failure\'s message is redacted, the same way a reclaim failure\'s already was', async () => {
  // Defence in depth, not a live leak: the four steps `deliverOne` guards
  // are two sqlite reads, `deps.stat` and the plugin's own
  // `onDownloadedFile`, none of which is handed a url with a credential in
  // it. This asserts the two catches in this file no longer differ -- a
  // reader should not have to check which of them redacts, and a later step
  // that does build a url cannot leak through the one that was left raw.
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');
  const itemId = seedRssItem(raw, 'movie', 'alpha');
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/movie.mkv',
  });

  const lines: { message: string; detail: Readonly<Record<string, unknown>> | undefined }[] = [];
  const result = await deliverCompleted(baseDeps(raw, clientId, {
    stat: async () => ({ sizeBytes: 8 }),
    deliver: async () => {
      throw new Error('plugin refused: https://sab.example.com/api?apikey=super-secret&mode=queue');
    },
    log: (message, detail) => { lines.push({ message, detail }); },
  }));

  assert.equal(result.delivered, 0);
  assert.deepEqual(
    lines,
    [{
      message: 'failed to deliver a completed download, leaving it completed for the next tick',
      detail: {
        rowId: id,
        error: 'plugin refused: https://sab.example.com/api?apikey=*****&mode=queue',
      },
    }],
    'the logged message must carry the redacted url, not the raw one',
  );
  assert.equal(readColumn(raw, id, 'status'), 'completed', 'the row is still retried next tick');
});

test('a refused import is counted, and waits on a doubling ladder before it is tried again', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  const itemId = seedRssItem(raw, 'x', 'alpha');
  const rowId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, storagePath: '/downloads/x.mkv' });
  let calls = 0;
  const refuse: DeliverDeps['deliver'] = async () => { calls += 1; throw new Error('alpha: this download was not imported (destination-exists)'); };

  const first = await deliverCompleted(baseDeps(raw, clientId, { now: 1_000, deliver: refuse, stat: async () => ({ sizeBytes: 10 }) }));
  assert.equal(first.refused, 1);
  assert.equal(readColumn(raw, rowId, 'import_failures'), 1);
  assert.equal(readColumn(raw, rowId, 'import_retry_at'), 11_000);
  assert.equal(readColumn(raw, rowId, 'status'), 'completed', 'never terminal');

  const early = await deliverCompleted(baseDeps(raw, clientId, { now: 10_999, deliver: refuse, stat: async () => ({ sizeBytes: 10 }) }));
  assert.equal(early.refused, 0, 'not yet due: not attempted');
  assert.equal(calls, 1);

  const second = await deliverCompleted(baseDeps(raw, clientId, { now: 11_000, deliver: refuse, stat: async () => ({ sizeBytes: 10 }) }));
  assert.equal(second.refused, 1);
  assert.equal(readColumn(raw, rowId, 'import_retry_at'), 11_000 + 20_000);
});
