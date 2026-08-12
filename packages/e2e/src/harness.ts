import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test as base } from '@playwright/test';
import type { MetadataCandidate } from '@pickarr/plugin-api';
import createScenesPlugin from '../../plugin-scenes/src/index.ts';
import type { SceneLookupClient } from '../../core/src/clients/theporndb.ts';
import type { ClientSnapshot, DownloadClient } from '../../core/src/clients/types.ts';
import { configSchema, type FeedConfig } from '../../core/src/config/schema.ts';
import { openDatabase } from '../../core/src/db/open.ts';
import type { FeedEntry } from '../../core/src/feeds/parse-rss.ts';
import { buildServer } from '../../core/src/http/server.ts';
import { ingestEntries, type IngestResult } from '../../core/src/ingest/ingest.ts';
import { loadPlugins } from '../../core/src/plugins/registry.ts';
import { importDownload } from '../../core/src/pipeline/import.ts';
import { runMetadataPass, type MetadataPassResult } from '../../core/src/pipeline/metadata.ts';
import {
  reconcileClient,
  type ReconcileResult,
  type UntrackedEntry,
} from '../../core/src/pipeline/reconcile.ts';
import { webDist } from './paths.ts';

/**
 * The scenes plugin is the only one shipped, and it is the one whose parser
 * every seeded title goes through. Named by *package* because that is the
 * identifier config and `registry.byPackage` use.
 */
const SCENES_PACKAGE = '@pickarr/plugin-scenes';

/**
 * A fixed epoch for seeded rows, so that list order is a function of the
 * seeding calls a spec makes and not of when the spec happened to run.
 * 2023-11-14T22:13:20Z, chosen only for being round and in the past.
 */
const CLOCK_ORIGIN = 1_700_000_000_000;

export interface AddedUrl {
  url: string;
  /** The job name Pickarr asked the client to use, marker and all. */
  name: string;
  /** The reference the fake handed back, which the download row now stores. */
  ref: string;
}

/**
 * A `DownloadClient` that records what was sent to it and reports back
 * whatever the test decided.
 *
 * This is what makes the download half of the app testable without usenet: a
 * spec can drive a picked release all the way to `failed` by setting a history
 * entry and calling `reconcile()`, which is the same code path the scheduler
 * runs in production.
 */
export interface FakeDownloadClient extends DownloadClient {
  /** Every `addUrl` call, in order. */
  readonly added: readonly AddedUrl[];
  /** Every `remove` call's ref, in order. */
  readonly removed: readonly string[];
  /** What the next `snapshot()` will return. */
  setSnapshot(snapshot: ClientSnapshot): void;
}

export interface MetadataSearch {
  readonly query: string;
  readonly siteId: number | null;
}

/**
 * A `SceneLookupClient` that records what it was asked and hands back
 * whatever the test decided — the metadata equivalent of `FakeDownloadClient`.
 *
 * Real ThePornDB credentials are never involved: `runMetadataPass` only ever
 * sees this client, and a spec drives a confirmation (or a deliberate
 * near-miss) by calling `setCandidates` before running a pass.
 */
export interface FakeMetadataClient extends SceneLookupClient {
  /** Every `searchScenes` call, in order. */
  readonly searched: readonly MetadataSearch[];
  /** What the next `searchScenes` call will return. */
  setCandidates(candidates: readonly MetadataCandidate[]): void;
}

export interface Harness {
  /** `http://127.0.0.1:<the port the OS actually assigned>`. */
  readonly baseURL: string;
  /** The test's own database. Direct SQL, for states ingest cannot reach. */
  readonly db: DatabaseSync;
  readonly client: FakeDownloadClient;
  /** The scene-metadata provider `runMetadataPass` asks. Never the real service. */
  readonly metadataClient: FakeMetadataClient;
  /** This test's temp directory; removed when the test ends. */
  readonly workDir: string;
  readonly libraryRoot: string;
  /** The single feed every seeded title arrives on. */
  readonly feed: FeedConfig;

  /**
   * Seeds releases by running raw feed titles through the *real* ingest path —
   * the real scenes parser, the real grouping and scoring. A spec therefore
   * cannot assert against a fixture the parser would never produce.
   *
   * Each call is one feed tick with one timestamp, as a real tick is; call it
   * repeatedly when a spec needs a strict ordering between groups.
   */
  ingest(titles: readonly string[]): IngestResult;

  /**
   * One poll of the fake client through the real reconcile pipeline — the same
   * function the scheduler calls, so state transitions in a spec are the ones
   * production performs, not ones the test wrote by hand.
   */
  reconcile(): Promise<ReconcileResult>;

  /**
   * One drain of the metadata queue through the real `runMetadataPass` — the
   * same function `main.ts` puts on a timer, called directly here because the
   * harness builds a server with no scheduler behind it. A spec calls this
   * once its request has reached the queue (`POST /api/metadata/request`,
   * which the SPA's `useGroupMetadata` hook issues on its own) to answer it
   * deterministically instead of waiting on a timer the harness never starts.
   */
  runMetadataPass(): Promise<MetadataPassResult>;
}

function createFakeClient(id: string, importMode: 'move' | 'copy'): FakeDownloadClient {
  const added: AddedUrl[] = [];
  const removed: string[] = [];
  let snapshot: ClientSnapshot = { queue: [], history: [] };

  return {
    id,
    importMode,
    added,
    removed,
    setSnapshot(next) {
      snapshot = next;
    },
    addUrl: async (url, name) => {
      const ref = `nzo_${String(added.length + 1)}`;
      added.push({ url, name, ref });
      return ref;
    },
    snapshot: async () => snapshot,
    remove: async (ref) => {
      removed.push(ref);
    },
    // No path mapping: the fake's "client paths" are already paths this
    // process can open, because the spec that set them made them.
    mapPath: (path) => path,
  };
}

function createFakeMetadataClient(): FakeMetadataClient {
  const searched: MetadataSearch[] = [];
  // Every call returns the same set until a spec changes it — good enough for
  // this suite, which only ever has one group queued at a time.
  let candidates: readonly MetadataCandidate[] = [];

  return {
    // Never `'theporndb'`: a source string this suite wrote itself, so a
    // `group_metadata.source` value in a failing test's database can never be
    // mistaken for a row the real service actually answered.
    source: 'e2e-fake-tpdb',
    searched,
    setCandidates(next) {
      candidates = next;
    },
    searchScenes: async (query, siteId) => {
      searched.push({ query, siteId });
      return candidates;
    },
  };
}

async function startHarness(): Promise<{ harness: Harness; stop: () => Promise<void> }> {
  // One temp directory per test holding the database, the library and the
  // trash. Tests that share a database share failures, and this suite exists
  // to isolate a cause.
  const workDir = await mkdtemp(join(tmpdir(), 'pickarr-e2e-'));
  const libraryRoot = join(workDir, 'library');
  const trashDir = join(workDir, 'trash');
  await mkdir(libraryRoot, { recursive: true });
  await mkdir(trashDir, { recursive: true });

  // Parsed rather than hand-built, so the harness cannot configure the app in
  // a shape `loadConfig` would refuse at boot.
  const config = configSchema.parse({
    database: { path: join(workDir, 'pickarr.db') },
    trashDir,
    plugins: { [SCENES_PACKAGE]: { libraryRoot } },
    downloadClients: [
      {
        id: 'fake',
        type: 'sabnzbd',
        url: 'http://download-client.invalid',
        apiKey: 'e2e-api-key-not-a-secret',
        category: 'pickarr-e2e',
        importMode: 'move',
      },
    ],
    feeds: [{ id: 'e2e', url: 'https://feed.invalid/rss', plugin: SCENES_PACKAGE }],
  });

  const clientConfig = config.downloadClients[0];
  const feed = config.feeds[0];
  if (clientConfig === undefined || feed === undefined) {
    throw new Error('harness config lost its download client or feed');
  }

  // `openDatabase` runs every migration, so a fresh file starts at the current
  // schema with no rows.
  const db = openDatabase(config.database.path);

  // The real registry, given the real plugin directly rather than through
  // `import()`: the workspace is not installed under its package name in a way
  // a bare import would resolve to source, and going through the factory is
  // what actually matters — a misconfigured `sites` list still throws here.
  const registry = await loadPlugins(config, async () => ({ default: createScenesPlugin }));

  const client = createFakeClient(clientConfig.id, clientConfig.importMode);
  const metadataClient = createFakeMetadataClient();

  // Shared with `runMetadataPass` below, so a poster a test caches through the
  // pass lands exactly where the poster route serves it from.
  const artworkDir = join(workDir, 'artwork');

  // Reconcile reports jobs in the client that Pickarr has no row for; the
  // scheduler holds that list in production and the server reads it back.
  // Nothing here schedules, so the last reconcile's list stands in.
  let untracked: UntrackedEntry[] = [];

  // Same mapping main.ts builds, for the same reason: feeds name their plugin
  // by package and the manual routes need it by feed id.
  const pluginsByFeed = new Map(
    config.feeds.map((entry) => [entry.id, registry.byPackage(entry.plugin)]),
  );

  const server = buildServer({
    db,
    defaultClient: client,
    untrackedFor: () => untracked,
    now: () => Date.now(),
    webRoot: webDist,
    registry,
    pluginForFeed: (feedId) => pluginsByFeed.get(feedId) ?? null,
    // Under the work directory like everything else the harness creates, so a
    // run leaves nothing behind. Nothing writes here unless a test caches a
    // poster; the poster route serves from it and 404s while it is empty.
    artworkDir,
  });

  // Port 0, then read back what the OS assigned. A fixed port collides between
  // parallel workers and between two developers on one machine. Loopback only:
  // nothing about this suite should be reachable off the box.
  const baseURL = await server.listen({ port: 0, host: '127.0.0.1' });

  const plugin = registry.byPackage(feed.plugin);
  let tick = 0;

  const harness: Harness = {
    baseURL,
    db,
    client,
    metadataClient,
    workDir,
    libraryRoot,
    feed,
    ingest(titles) {
      tick += 1;
      const now = CLOCK_ORIGIN + tick * 1000;
      const entries: FeedEntry[] = titles.map((title, index) => ({
        guid: `e2e-${String(tick)}-${String(index)}`,
        title,
        link: `https://indexer.invalid/${String(tick)}-${String(index)}.nzb`,
        publishedAt: now,
      }));
      return ingestEntries(db, plugin, feed, entries, now);
    },
    async reconcile() {
      const result = await reconcileClient({
        db,
        client,
        now: () => Date.now(),
        importDownload: (download) =>
          importDownload(
            {
              db,
              registry,
              importMode: client.importMode,
              trashDir: config.trashDir,
              now: () => Date.now(),
            },
            download,
          ),
      });
      untracked = result.untracked;
      return result;
    },
    runMetadataPass() {
      return runMetadataPass({
        db,
        client: metadataClient,
        // `byId`, never `byPackage`: `media_groups.plugin` stores the id
        // (see `main.ts`'s `pluginById`, which this mirrors), and a group
        // whose plugin has since left config resolves to `null` here exactly
        // as it would in production.
        pluginFor: (id) => registry.byId(id) ?? null,
        artwork: { dir: artworkDir, fetchImpl: fetch, log: () => undefined },
        // Comfortably above one, so a spec queuing a couple of groups in one
        // tick still clears them in a single call.
        perTick: 10,
        now: () => Date.now(),
        log: () => undefined,
      });
    },
  };

  return {
    harness,
    stop: async () => {
      await server.close();
      db.close();
      // `force` because a test that never opened the database still has a
      // directory to remove, and WAL/SHM siblings may or may not exist.
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

/**
 * The suite's `test`. Every test gets its own server, on its own port, against
 * its own database, serving the SPA `global-setup.ts` built for the run.
 */
export const test = base.extend<{ harness: Harness }>({
  // Playwright reads a fixture's dependencies out of this destructuring
  // pattern, so the pattern is required even when — as here — there are none.
  // The linter's worry (destructuring null) cannot happen: Playwright always
  // passes an object.
  // eslint-disable-next-line no-empty-pattern
  harness: async ({}, use) => {
    const { harness, stop } = await startHarness();
    try {
      await use(harness);
    } finally {
      await stop();
    }
  },

  // Overridden so `page.goto('/')` and the `request` fixture reach this test's
  // server without every spec repeating the port.
  baseURL: async ({ harness }, use) => {
    await use(harness.baseURL);
  },

  // Overridden so every spec inherits this without adding it itself. Before
  // this, nothing in the suite listened for either signal: `manual.spec`'s
  // duplicate-key bug happened to move the DOM (an orphaned card), which is
  // what its assertions actually caught, but a React warning — or any
  // uncaught exception in the SPA that does not move the DOM — passed
  // silently across all four specs.
  //
  // `pageerror` (an uncaught exception in the page) always fails the test:
  // there is no reading of "the SPA threw and that's fine".
  //
  // `console.error` also fails the test, which is a narrower call. React logs
  // dev warnings — including the duplicate-key warning this suite is named
  // for — through `console.error`, not `console.warn`, so leaving it out
  // would reopen exactly the gap this fixture exists to close. The obvious
  // risk with failing on it is a noisy third-party script tripping every
  // spec; that doesn't apply here, because the page under test is one SPA we
  // own, served with no third-party or ad script on it, so `console.error`
  // is a signal from our own code, not the browser's stray complaints. If
  // that ever stops being true, filter here rather than removing the check.
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(`uncaught page error: ${error.stack ?? error.message}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console.error: ${message.text()}`);
      }
    });

    await use(page);

    // Checked after the test body runs rather than as each event arrives, so
    // a spec's own assertion failure is what's reported when both happen —
    // and so one throw here reports every error the test triggered, not just
    // the first.
    if (errors.length > 0) {
      throw new Error(`browser reported ${String(errors.length)} error(s):\n${errors.join('\n')}`);
    }
  },
});

export { expect } from '@playwright/test';
