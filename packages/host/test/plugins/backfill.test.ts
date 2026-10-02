/**
 * The video-resolution backfill migration's job row, run by the real
 * dispatcher against the real host schema.
 *
 * `videoResolutionBackfillMigration` writes the host's `jobs` table with raw
 * SQL, because a plugin migration cannot reach `JobQueue`. This is what
 * stops a later change to `jobs` from silently turning that row into one
 * nothing ever runs -- `packages/openmetadata`'s own tests stub that table
 * and cannot see a drift between the stub and the real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost, migratePlugin } from '../../src/db/migrate.ts';
import { shippedPlugins } from '../../src/main.ts';
import { createDispatcher } from '../../src/jobs/dispatcher.ts';
import type { Timers } from '../../src/jobs/dispatcher.ts';

/** One `setTimeout`/`setInterval` call, as the fake `Timers` below records it. */
interface TimerCall {
  handle: number;
  ms: number;
  fn: () => void;
}

/**
 * A `Timers` whose every call is logged rather than actually scheduled, so a
 * test can fire a logged `fn` directly and simulate a timer firing without
 * ever waiting on real time. Copied from `jobs/dispatcher.test.ts`.
 */
function createFakeTimers(): {
  timers: Timers;
  setTimeoutCalls: TimerCall[];
} {
  let nextHandle = 0;
  const setTimeoutCalls: TimerCall[] = [];
  const setIntervalCalls: TimerCall[] = [];
  const timers: Timers = {
    setTimeout(fn, ms) {
      const handle = ++nextHandle;
      setTimeoutCalls.push({ handle, ms, fn });
      return handle;
    },
    clearTimeout() {},
    setInterval(fn, ms) {
      const handle = ++nextHandle;
      setIntervalCalls.push({ handle, ms, fn });
      return handle;
    },
    clearInterval() {},
  };
  return { timers, setTimeoutCalls };
}

/** A `sleep` that resolves on the next microtask, for a test that never controls it. Copied from `jobs/dispatcher.test.ts`. */
const noopSleep = (_ms: number): Promise<void> => Promise.resolve();

/** A real signal, for a test that never fires it and needs no fake. Copied from `jobs/dispatcher.test.ts`. */
const realAbortSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);

const noopLog = (): void => {};

/**
 * A `PluginContext` whose capabilities all reject if called. Copied from
 * `jobs/dispatcher.test.ts` -- the recorder handler below never touches
 * `ctx`, so a capability firing at all would mean the test reached further
 * than intended.
 */
const fakeCtx: PluginContext = {
  db: undefined,
  media: {
    createMediaItem: async () => { throw new Error('media.createMediaItem: not used by this test'); },
    updateMediaItem: async () => { throw new Error('media.updateMediaItem: not used by this test'); },
    claimProviderRef: async () => { throw new Error('media.claimProviderRef: not used by this test'); },
    relinkRssItem: async () => { throw new Error('media.relinkRssItem: not used by this test'); },
    reassignRelease: async () => { throw new Error('media.reassignRelease: not used by this test'); },
    dropMediaItem: async () => { throw new Error('media.dropMediaItem: not used by this test'); },
    attachPoster: async () => { throw new Error('media.attachPoster: not used by this test'); },
    attachBackground: async () => { throw new Error('media.attachBackground: not used by this test'); },
    attachLogo: async () => { throw new Error('media.attachLogo: not used by this test'); },
    attachPersonImage: async () => { throw new Error('media.attachPersonImage: not used by this test'); },
    upsertPerson: async () => { throw new Error('media.upsertPerson: not used by this test'); },
    attachRole: async () => { throw new Error('media.attachRole: not used by this test'); },
    setLookupState: async () => { throw new Error('media.setLookupState: not used by this test'); },
    setVideoResolution: async () => { throw new Error('media.setVideoResolution: not used by this test'); },
  },
  read: {
    mediaItem: async () => { throw new Error('read.mediaItem: not used by this test'); },
    mediaItemByProviderRef: async () => { throw new Error('read.mediaItemByProviderRef: not used by this test'); },
    rssItemsFor: async () => { throw new Error('read.rssItemsFor: not used by this test'); },
    downloadsFor: async () => { throw new Error('read.downloadsFor: not used by this test'); },
  },
  jobs: { enqueue: async () => { throw new Error('jobs.enqueue: not used by this test'); } },
  library: {
    list: async () => { throw new Error('library.list: not used by this test'); },
    place: async () => { throw new Error('library.place: not used by this test'); },
  },
  fetch: {
    json: async () => { throw new Error('fetch.json: not used by this test'); },
    bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  },
  downloads: { submit: async () => { throw new Error('downloads.submit: not used by this test'); } },
  log: () => {},
};

test("the backfill migration's job row is one the real dispatcher runs", async () => {
  const { raw }: { raw: DatabaseSync } = openTestDatabase();
  migrateHost(raw);
  const plugin = shippedPlugins({ now: () => Date.now(), resolveSecret: async () => 'k', baseUrl: 'https://lookup.example.test' })
    .find((each) => each.id === 'movie');
  assert.ok(plugin !== undefined);
  migratePlugin(raw, 'movie', plugin.migrations.filter((m) => m.version < 4));
  raw.exec(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('movie', 'f', 'http://f', 1, 1);
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, lookup_state)
      VALUES (1, 'Film.2023.1080p.mkv', 'http://a', 1, 1, 'torrent', 'resolved');
    INSERT INTO movie_lookup (rss_item_id, created_at, updated_at) VALUES (1, 1, 1);
  `);
  migratePlugin(raw, 'movie', plugin.migrations);

  const ran: string[] = [];
  const { timers, setTimeoutCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => Date.now(), timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(
    (pluginId, kind) => (pluginId === 'movie' && kind === 'video-resolution-backfill'
      ? async () => { ran.push(kind); }
      : undefined),
    () => fakeCtx,
  );
  // The migration's row is due the moment it is inserted, but the fake
  // timer never fires on its own -- `dispatcher.test.ts`'s own "runs a ready
  // job" tests fire the armed timer by hand for the same reason.
  const fire = setTimeoutCalls[0]?.fn;
  assert.ok(fire, 'construction did not arm a timer for the migration\'s job row');
  fire();

  for (let tries = 0; ran.length === 0 && tries < 50; tries += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  dispatcher.stop();
  assert.deepEqual(ran, ['video-resolution-backfill']);
  raw.close();
});
