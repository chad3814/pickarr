import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, HostFetch, JobHandler, MediaPlugin, PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../src/db/open.ts';
import { migrateHost } from '../src/db/migrate.ts';
import { createHost } from '../src/host.ts';

/** A `HostFetch` that fails loudly if a test never meant to reach the network. */
const unusedFetch: HostFetch = {
  json: async () => { throw new Error('fetch.json: not used by this test'); },
  bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
};

/** A `DownloadClients` that fails loudly if a test never meant to submit anywhere. */
const unusedDownloads: DownloadClients = {
  submit: async () => { throw new Error('downloads.submit: not used by this test'); },
};

/** An entry point a plugin under test never expects to be reached. */
function unusedEntryPoint(name: string): () => Promise<never> {
  return async () => { throw new Error(`${name}: not used by this test`); };
}

function insertFeed(raw: DatabaseSync, pluginId: string, url: string): number {
  const result = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES (?, 'feed', ?, 0, 0)
  `).run(pluginId, url);
  return Number(result.lastInsertRowid);
}

function insertRssItem(raw: DatabaseSync, feedId: number): number {
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, 'x.mkv', 'https://example.test/x', 0, 0, 'nzb', 'pending')
  `).run(feedId);
  return Number(result.lastInsertRowid);
}

/** A minimal but complete `MediaPlugin` — every required entry point present, most unused. */
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

function setup() {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const host = createHost({ raw, db, fetch: unusedFetch, downloads: unusedDownloads, now: () => 1000 });
  return { raw, db, host };
}

test('registering a plugin applies its migrations', () => {
  const { raw, host } = setup();
  const plugin = makePlugin({
    id: 'alpha',
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE alpha_thing (id INTEGER PRIMARY KEY)') }],
  });

  host.register(plugin);

  const names = new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
  assert.ok(names.has('alpha_thing'), 'migration was never applied');
});

test('new rss items are dispatched to the plugin owning their feed', async () => {
  const { raw, host } = setup();

  const alphaReceived: number[][] = [];
  const betaReceived: number[][] = [];
  const alpha = makePlugin({ id: 'alpha', onNewRssItems: async (ids) => { alphaReceived.push([...ids]); } });
  const beta = makePlugin({ id: 'beta', onNewRssItems: async (ids) => { betaReceived.push([...ids]); } });
  host.register(alpha);
  host.register(beta);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedB = insertFeed(raw, 'beta', 'https://b.test/feed');
  const a1 = insertRssItem(raw, feedA);
  const a2 = insertRssItem(raw, feedA);
  const b1 = insertRssItem(raw, feedB);

  await host.notifyNewRssItems([a1, b1, a2]);

  // Each plugin is called exactly once, with its whole own array — not once
  // per item, which a length check on the outer array alone would miss.
  assert.equal(alphaReceived.length, 1, 'alpha.onNewRssItems must be called exactly once');
  assert.deepEqual(alphaReceived[0], [a1, a2]);
  assert.equal(betaReceived.length, 1, 'beta.onNewRssItems must be called exactly once');
  assert.deepEqual(betaReceived[0], [b1]);
});

test('two plugins may register the same job kind without colliding', async () => {
  const { raw, host } = setup();

  const alphaRuns: unknown[] = [];
  const betaRuns: unknown[] = [];
  const alphaHandler: JobHandler = async (job) => { alphaRuns.push(job.payload); };
  const betaHandler: JobHandler = async (job) => { betaRuns.push(job.payload); };

  const alpha = makePlugin({
    id: 'alpha',
    jobs: { same: alphaHandler },
    onNewRssItems: async (_ids, ctx: PluginContext) => {
      await ctx.jobs.enqueue({ kind: 'same', payload: { owner: 'alpha' } });
    },
  });
  const beta = makePlugin({
    id: 'beta',
    jobs: { same: betaHandler },
    onNewRssItems: async (_ids, ctx: PluginContext) => {
      await ctx.jobs.enqueue({ kind: 'same', payload: { owner: 'beta' } });
    },
  });
  host.register(alpha);
  host.register(beta);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedB = insertFeed(raw, 'beta', 'https://b.test/feed');
  const a1 = insertRssItem(raw, feedA);
  const b1 = insertRssItem(raw, feedB);

  // Each onNewRssItems enqueues one job of kind "same" under its own plugin id.
  await host.notifyNewRssItems([a1, b1]);

  assert.equal(await host.runOnce(), true);
  assert.equal(await host.runOnce(), true);
  assert.equal(await host.runOnce(), false, 'only two jobs were enqueued');

  assert.equal(alphaRuns.length, 1, 'alpha\'s own "same" handler must run exactly once');
  assert.deepEqual(alphaRuns[0], { owner: 'alpha' });
  assert.equal(betaRuns.length, 1, 'beta\'s own "same" handler must run exactly once');
  assert.deepEqual(betaRuns[0], { owner: 'beta' });
});

test('a download request reaches the plugin owning that item\'s feed', async () => {
  const { raw, host } = setup();

  const alphaReceived: number[] = [];
  const betaReceived: number[] = [];
  const alpha = makePlugin({ id: 'alpha', onDownloadRequest: async (id) => { alphaReceived.push(id); } });
  const beta = makePlugin({ id: 'beta', onDownloadRequest: async (id) => { betaReceived.push(id); } });
  // Beta registers first, so a mutation that dispatches to "whichever plugin
  // registered first" rather than to the actual owner would send this
  // request to beta instead of alpha.
  host.register(beta);
  host.register(alpha);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedB = insertFeed(raw, 'beta', 'https://b.test/feed');
  const itemA = insertRssItem(raw, feedA);
  insertRssItem(raw, feedB); // owned by beta, whose handler must never fire for this request

  await host.requestDownload(itemA);

  assert.deepEqual(alphaReceived, [itemA]);
  assert.deepEqual(betaReceived, []);
});

test('registering two plugins with the same id is refused', () => {
  const { host } = setup();
  host.register(makePlugin({ id: 'dupe' }));

  assert.throws(
    () => host.register(makePlugin({ id: 'dupe' })),
    /already registered/i,
  );
});

test('an rss item whose feed has no registered plugin is reported, not silently skipped', async () => {
  const { raw, host } = setup();

  const alphaReceived: number[][] = [];
  const alpha = makePlugin({ id: 'alpha', onNewRssItems: async (ids) => { alphaReceived.push([...ids]); } });
  host.register(alpha);

  const feedA = insertFeed(raw, 'alpha', 'https://a.test/feed');
  const feedGhost = insertFeed(raw, 'ghost', 'https://ghost.test/feed'); // 'ghost' never registered
  const itemA = insertRssItem(raw, feedA);
  const itemGhost = insertRssItem(raw, feedGhost);

  await assert.rejects(
    () => host.notifyNewRssItems([itemA, itemGhost]),
    (err: unknown) => err instanceof Error && err.message.includes(String(itemGhost)),
  );

  // The unowned item being reported must not have cost alpha its own,
  // legitimately owned, delivery.
  assert.equal(alphaReceived.length, 1);
  assert.deepEqual(alphaReceived[0], [itemA]);
});
