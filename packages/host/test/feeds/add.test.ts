import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, MediaPlugin } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createHost } from '../../src/host.ts';
import type { Host, AddFeedInput } from '../../src/host.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';
import type { Timers } from '../../src/jobs/dispatcher.ts';
import type { Secrets } from '../../src/secrets/instance.ts';

/** A `QueuedFetch` that fails loudly if a test never meant to reach the network -- no test in this file polls a feed. */
const unusedFetch: QueuedFetch = {
  json: async () => { throw new Error('fetch.json: not used by this test'); },
  bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  text: async () => { throw new Error('fetch.text: not used by this test'); },
};

/** A `DownloadClients` that fails loudly if a test never meant to submit anywhere. */
const unusedDownloads: DownloadClients = {
  submit: async () => { throw new Error('downloads.submit: not used by this test'); },
};

/** A `Secrets` that fails loudly if a test never meant to resolve a credential. */
const unusedSecrets: Secrets = {
  get: async () => { throw new Error('secrets.get: not used by this test'); },
  saveSecret: () => { throw new Error('secrets.saveSecret: not used by this test'); },
};

/**
 * No test here attaches artwork, so this directory is never created or
 * written to. Mirrors `host.test.ts`'s own `unusedArtworkDir`.
 */
const unusedArtworkDir = '/nonexistent/pickarr-test-artwork-unused';

/** An entry point a plugin under test never expects to be reached. */
function unusedEntryPoint(name: string): () => Promise<never> {
  return async () => { throw new Error(`${name}: not used by this test`); };
}

/** A minimal but complete `MediaPlugin` -- every required entry point present, none reached by these tests. Mirrors `host.test.ts`'s own `makePlugin`. */
function makePlugin(id: string): MediaPlugin {
  return {
    id,
    mediaType: 'movie',
    migrations: [],
    jobs: {},
    synced: [],
    onNewRssItems: unusedEntryPoint('onNewRssItems'),
    onDownloadedFile: unusedEntryPoint('onDownloadedFile'),
    onDownloadRequest: unusedEntryPoint('onDownloadRequest'),
  };
}

/** A `Timers` whose calls are never fired -- no test here calls `host.start()`, so nothing here needs to be real. Mirrors `host.test.ts`'s own `createFakeTimers`. */
function fakeTimers(): Timers {
  let nextHandle = 0;
  return {
    setTimeout: () => ++nextHandle,
    clearTimeout: () => {},
    setInterval: () => ++nextHandle,
    clearInterval: () => {},
  };
}

/**
 * A real host over a migrated in-memory database, with `registered` plugins
 * already registered, and `schedulePoll` wrapped to record every feed id it
 * is asked to schedule. `Host.addFeed` calls this host's own
 * `schedulePoll` -- the same call `main.ts` makes at boot for a feed already
 * on file -- so wrapping it here observes exactly that call, on the public
 * surface, with no reach into `host.ts`'s internals.
 */
function setupHost(opts: { registered: readonly string[] }): { host: Host; raw: DatabaseSync; scheduled: number[] } {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const host = createHost({
    raw,
    db,
    fetch: unusedFetch,
    downloads: () => unusedDownloads,
    secrets: unusedSecrets,
    now: () => 1000,
    artworkDir: unusedArtworkDir,
    timers: fakeTimers(),
  });
  for (const pluginId of opts.registered) host.register(makePlugin(pluginId));

  const scheduled: number[] = [];
  const realSchedulePoll = host.schedulePoll.bind(host);
  host.schedulePoll = (feedId, runAt) => {
    scheduled.push(feedId);
    return realSchedulePoll(feedId, runAt);
  };

  return { host, raw, scheduled };
}

/** A valid `AddFeedInput`, so each test overrides only the one field it means to break. */
function input(overrides?: Partial<AddFeedInput>): AddFeedInput {
  return {
    pluginId: 'movie',
    name: 'Movies',
    url: 'https://tracker.example/rss',
    downloadType: 'torrent',
    pollIntervalS: 900,
    ...overrides,
  };
}

test('a feed for an unregistered plugin is refused', async () => {
  const { host } = setupHost({ registered: ['movie'] });
  const result = await host.addFeed(input({ pluginId: 'tv' }));
  assert.deepEqual(result, { refusal: 'unknown-plugin' });
});

test('a url already on file is refused, not thrown', async () => {
  // `rss_feed` has a uniqueIndex on url, so without this the second insert
  // raises a raw SQLite constraint violation -- a 500 where the honest
  // answer is "that feed is already here". Driven through a real second
  // insert rather than a stubbed error: the uniqueness lives in the table.
  const { host } = setupHost({ registered: ['movie'] });
  const first = await host.addFeed(input({ url: 'https://tracker.example/rss' }));
  assert.ok('id' in first, 'the first insert succeeds');
  const second = await host.addFeed(input({ url: 'https://tracker.example/rss' }));
  assert.deepEqual(second, { refusal: 'duplicate-url' });
});

test('a poll interval below the floor is refused', async () => {
  // Nothing clamps this today: `host.ts`'s poll handler reschedules at
  // `now + seconds * 1000`, so zero enqueues in the past and spins the
  // dispatcher.
  const { host } = setupHost({ registered: ['movie'] });
  assert.deepEqual(await host.addFeed(input({ pollIntervalS: 0 })), { refusal: 'bad-poll-interval' });
  assert.deepEqual(await host.addFeed(input({ pollIntervalS: 59 })), { refusal: 'bad-poll-interval' });
  assert.deepEqual(await host.addFeed(input({ pollIntervalS: 86_401 })), { refusal: 'bad-poll-interval' });
});

test('a bad download type is refused', async () => {
  const { host } = setupHost({ registered: ['movie'] });
  const result = await host.addFeed({ ...input(), downloadType: 'magnet' as AddFeedInput['downloadType'] });
  assert.deepEqual(result, { refusal: 'bad-download-type' });
});

test('an accepted feed is written and polled at once', async () => {
  // Polling immediately is the point: items arriving is the only real
  // confirmation the url was right, and `main` already makes this same call
  // at boot for feeds on file.
  const { host, raw, scheduled } = setupHost({ registered: ['movie'] });
  const result = await host.addFeed(input({ name: 'Movies HD' }));
  assert.ok('id' in result);
  // `node:sqlite` rows have a null prototype, and `deepEqual` compares
  // prototypes, so the row is spread into a plain object first -- see
  // `plugins/flow.test.ts`'s own `rows` helper for the same normalization.
  const row = { ...raw.prepare('SELECT name, plugin_id FROM rss_feed WHERE id = ?').get(result.id) };
  assert.deepEqual(row, { name: 'Movies HD', plugin_id: 'movie' });
  assert.deepEqual(scheduled, [result.id], 'the first poll was scheduled');
});
