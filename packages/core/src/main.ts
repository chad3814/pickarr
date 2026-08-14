import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import { loadConfig, readConfigDocument } from './config/load.ts';
import { openDatabase } from './db/open.ts';
import { loadPlugins, type PluginRegistry } from './plugins/registry.ts';
import { createSabnzbdClient } from './clients/sabnzbd.ts';
import { createTpdbClient, type SceneLookupClient, type SiteLookupClient } from './clients/theporndb.ts';
import type { DownloadClient } from './clients/types.ts';
import { knownSiteNames } from './db/sites.ts';
import { resolveSitesForBatch } from './pipeline/resolve-sites.ts';
import { fetchFeed } from './feeds/fetch-feed.ts';
import { ingestEntries } from './ingest/ingest.ts';
import { reconcileClient } from './pipeline/reconcile.ts';
import { importDownload } from './pipeline/import.ts';
import { recoverInterruptedWork } from './pipeline/recover.ts';
import { createScheduler } from './pipeline/scheduler.ts';
import { createMetadataRunner } from './pipeline/metadata.ts';
import type { ArtworkDeps } from './media/artwork.ts';
import { buildServer } from './http/server.ts';

const CONFIG_PATH = process.env['PICKARR_CONFIG'] ?? '/config/config.json';

function log(message: string): void {
  console.log(`[pickarr] ${message}`);
}

/**
 * `metadata.artworkDir`'s default when the config omits it: an `artwork/`
 * directory beside the SQLite database. That path already sits inside the
 * `/config` volume in the documented Docker setup, so cached posters survive
 * a container recreation without asking anyone for a new mount. Resolved
 * here rather than in the schema because it needs `database.path`, which
 * `metadataSchema` cannot see in isolation.
 */
export function resolveArtworkDir(databasePath: string, configured: string | undefined): string {
  return configured ?? join(dirname(databasePath), 'artwork');
}

/**
 * Resolves the plugin a metadata queue row's group actually belongs to.
 *
 * `media_groups.plugin` holds `plugin.id` (see commit.ts, which writes
 * `plugin: plugin.id`), never a package name, so this must go through
 * `registry.byId` — never `registry.byPackage`, which throws on a lookup key
 * it does not recognise as a package name. Wiring this to `byPackage` would
 * not fail quietly: it throws on every single row, `lookUpOne`'s catch turns
 * that into a deferral logged as `unexpected failure: ...`, and only once a
 * row has retried and failed `MAX_METADATA_ATTEMPTS` times does it finally
 * get answered `'none'`. The bug is real either way — every group ends up
 * with no plugin — but it announces itself as fifty rounds of retried
 * failures per row instead of as a crash, which is exactly the shape of
 * thing a glance at the logs is likely to miss.
 */
export function pluginById(registry: PluginRegistry): (id: string) => MediaTypePlugin | null {
  return (id) => registry.byId(id) ?? null;
}

async function main(): Promise<void> {
  const config = await loadConfig(CONFIG_PATH);
  // Captured before the server can rewrite the file, and parsed rather than
  // held as text: `restartRequired` asks whether the *settings* changed, and a
  // reindent is not a settings change. Read through `readConfigDocument`
  // rather than a second `readFile` + `JSON.parse` here — that function
  // exists precisely so the "unreadable" and "not valid JSON" messages boot
  // and the config routes produce cannot drift, and a second copy of the
  // read-then-parse logic is exactly how they would.
  const bootConfigDocument = await readConfigDocument(CONFIG_PATH);
  const db = openDatabase(config.database.path);
  const registry = await loadPlugins(config);

  const clients = new Map<string, DownloadClient>();
  for (const clientConfig of config.downloadClients) {
    clients.set(clientConfig.id, createSabnzbdClient(clientConfig));
  }

  const firstClientConfig = config.downloadClients[0];
  if (firstClientConfig === undefined) {
    throw new Error('downloadClients: at least one download client must be configured');
  }
  const defaultClient = clients.get(firstClientConfig.id);
  if (defaultClient === undefined) {
    throw new Error(`downloadClients: no client registered for id ${firstClientConfig.id}`);
  }

  // One client, used for both site lookup and scene metadata: `createTpdbClient`
  // already returns an object satisfying both `SiteLookupClient` and
  // `SceneLookupClient`, and both features read the same `siteLookup`
  // credentials, so a second instance would just be a second, redundant
  // holder of the same api key.
  let tpdbClient: (SiteLookupClient & SceneLookupClient) | undefined;
  if (config.siteLookup === undefined) {
    log('site lookup: not configured; date-at-end names use their first word as the site');
  } else {
    tpdbClient = createTpdbClient(config.siteLookup, fetch);
    log(`site lookup: ${config.siteLookup.type}`);
  }

  // Sites confirmed on previous runs are handed back to their plugins before
  // any feed is read, so a restart does not re-ask about what it already knows
  // and — more importantly — does not parse a name with less site information
  // than the run before it had.
  const seeded = knownSiteNames(db);
  if (seeded.length > 0) {
    for (const plugin of registry.all()) plugin.learnSites?.(seeded);
    log(`site lookup: seeded ${seeded.length} known site(s) from previous runs`);
  }

  const recovery = recoverInterruptedWork(db, Date.now());
  log(
    `recovery: ${recovery.importsReset} imports reset, ${recovery.pendingAddUrl} awaiting addurl`,
  );

  // Resolved unconditionally, not just when the worker is wired up: the HTTP
  // poster route needs to know this directory regardless of whether metadata
  // is currently enabled, since a poster cached during an earlier run must
  // stay servable after the feature is turned off.
  const artworkDir = resolveArtworkDir(config.database.path, config.metadata.artworkDir);

  // `runMetadata` stays `undefined` — and the scheduler never gets a third
  // timer — when the feature is off or there is no client to ask, exactly as
  // an absent `runMetadata` already means "don't register this timer" to
  // `createScheduler`. The "idle for want of credentials" case is logged
  // once, right here at startup, rather than from inside a tick that would
  // otherwise repeat it forever.
  let runMetadata: (() => Promise<void>) | undefined;
  if (!config.metadata.enabled) {
    log('metadata: disabled');
  } else if (tpdbClient === undefined) {
    log(
      'metadata: enabled but idle — no siteLookup client configured, so there are no ' +
        'ThePornDB credentials to look scenes up with',
    );
  } else {
    const client = tpdbClient;
    const artwork: ArtworkDeps = {
      dir: artworkDir,
      fetchImpl: fetch,
      log,
    };
    const pluginFor = pluginById(registry);
    // `createMetadataRunner` holds the cooldown a 429 sets across ticks, in
    // its own closure — see its doc comment in pipeline/metadata.ts for why
    // that has to happen here rather than being recomputed inside
    // `runMetadataPass` itself, which has no memory of the previous tick.
    runMetadata = createMetadataRunner({
      db,
      client,
      pluginFor,
      artwork,
      perTick: config.metadata.perTick,
      now: () => Date.now(),
      log,
    });
    log(`metadata: enabled, every ${config.metadata.intervalSeconds}s, ${config.metadata.perTick} per tick`);
  }

  const scheduler = createScheduler({
    db,
    feeds: config.feeds,
    clientIds: [...clients.keys()],
    log,
    // `exactOptionalPropertyTypes` forbids assigning `metadataIntervalMs:
    // undefined` outright, so the pair is spread in together rather than
    // listed as plain properties.
    ...(runMetadata === undefined
      ? {}
      : { runMetadata, metadataIntervalMs: config.metadata.intervalSeconds * 1000 }),
    ingestFeed: async (feed) => {
      const plugin = registry.byPackage(feed.plugin);
      const entries = await fetchFeed(feed);

      // Before parsing, not after: an identity key outlives the tick, so a
      // site learned too late cannot be applied without re-keying a group the
      // user may already have picked.
      const sites = await resolveSitesForBatch(
        { db, plugin, client: tpdbClient, now: () => Date.now(), log },
        entries.map((entry) => entry.title),
      );
      if (sites.queried > 0 || sites.confirmed.length > 0) {
        log(
          `site lookup ${feed.id}: ${sites.confirmed.length} confirmed ` +
            `(${sites.queried} queried, ${sites.cached} cached)`,
        );
      }
      for (const title of sites.unresolved) {
        log(
          `site lookup ${feed.id}: unresolved, filing under its first word — ${title}. ` +
            'This identity key is durable; it will not change once lookups recover.',
        );
      }

      return ingestEntries(db, plugin, feed, entries, Date.now());
    },
    reconcile: async (clientId) => {
      const client = clients.get(clientId);
      if (client === undefined) throw new Error(`No such client: ${clientId}`);
      return reconcileClient({
        db,
        client,
        now: () => Date.now(),
        log,
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
    },
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = process.env['PICKARR_WEB_ROOT'] ?? resolve(join(here, 'web'));

  // Feeds name their plugin by package and the manual routes need it by feed
  // id, a mapping only configuration holds. Resolved once here rather than per
  // request: `loadConfig` has already refused any feed naming a package that is
  // not configured, and `loadPlugins` registered every configured package, so
  // every lookup below succeeds.
  const pluginsByFeed = new Map<string, MediaTypePlugin>(
    config.feeds.map((feed) => [feed.id, registry.byPackage(feed.plugin)]),
  );

  // `server` does not exist until `buildServer` below returns, so `shutdown`
  // (declared here, closing over a `server` binding it does not read until it
  // actually runs) cannot be built from it directly. `requestRestart` below
  // instead takes an arrow that calls `shutdown` by name, so the binding only
  // has to be resolved once `POST /api/restart` actually fires — by which
  // point `shutdown` is long since assigned.
  //
  // Declared and assigned *here* — before `buildServer` and `server.listen()`
  // — rather than after `server.listen()`, which is where this used to live.
  // A `const` is in its temporal dead zone from the top of the enclosing
  // block until its own initializer runs; the invariant this ordering
  // guarantees is that every path that can reach `requestRestart` (any
  // request the now-listening server accepts) finds `shutdown` already
  // assigned. Declaring it after `server.listen()` instead relied on there
  // being no `await` between that line and here to open a window where a
  // request could arrive first — true only by accident, and only until the
  // next `await` lands between them.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    // A second trigger during teardown — a SIGTERM arriving while a requested
    // restart is already tearing down — must not start a second
    // `server.close()`.
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason}, shutting down`);
    scheduler.stop();
    // `close` is only ever called once from either branch below — not once
    // more if it also throws — because a database that already failed to
    // close is not fixed by asking it again, and a `catch` that could itself
    // throw would escape this handler.
    let dbClosed = false;
    const closeDb = (): void => {
      if (dbClosed) return;
      dbClosed = true;
      db.close();
    };
    void server
      .close()
      .then(() => {
        closeDb();
        // Zero, not one: this is a clean, intentional stop. Under the documented
        // `restart: unless-stopped` compose policy that is a restart; under
        // `restart: on-failure` it would not be, which is why the UI presents
        // this as an explicit action rather than something a save does silently.
        process.exit(0);
      })
      .catch((error: Error) => {
        // Without this, a rejected `close()` would leave `shuttingDown` true
        // forever: `db.close()` and `process.exit` above never run, so every
        // later signal or restart request is silently ignored. Exiting
        // non-zero (rather than falling through to the 0 above) does not
        // change anything about `restart: unless-stopped`, which restarts on
        // any exit code regardless — it matters for logs and monitoring,
        // which can tell a failed teardown from a clean one this way, and for
        // a deployment using `restart: on-failure` instead, where the exit
        // code is exactly what decides whether this container comes back.
        log(`shutdown failed: ${error.message}`);
        closeDb();
        process.exit(1);
      });
  };

  const server = buildServer({
    db,
    defaultClient,
    untrackedFor: (clientId) => scheduler.untrackedFor(clientId),
    now: () => Date.now(),
    webRoot,
    registry,
    pluginForFeed: (feedId) => pluginsByFeed.get(feedId) ?? null,
    artworkDir,
    // The same decision that governs whether the scheduler gets a metadata
    // timer at all: `runMetadata` stays `undefined` exactly when there is no
    // worker that could ever drain a `metadata_queue` row. Derived once, here,
    // rather than a second time from `config.metadata`/`tpdbClient` — two
    // copies of that decision are how they eventually disagree.
    metadataAvailable: runMetadata !== undefined,
    configPath: CONFIG_PATH,
    bootConfigDocument,
    databasePath: config.database.path,
    requestRestart: () => shutdown('restart requested'),
  });

  await server.listen({ port: config.server.port, host: '0.0.0.0' });
  log(`listening on ${config.server.port}`);

  scheduler.start();
  void scheduler.ingestAllNow();
  void scheduler.reconcileNow();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown(`${signal} received`));
  }
}

/**
 * Fallback for `import.meta.main` on a Node build where it is not yet a
 * boolean (see `isEntryPoint` below) — the same "is this the script Node was
 * actually asked to run" question, answered by comparing `argv[1]` against
 * this module's own path instead.
 *
 * Both sides are realpathed before comparing. `import.meta.url` already
 * names this module with symlinks resolved; `argv[1]` does not, so running
 * through a symlink (`node /some/link/main.js` pointing at this file) would
 * otherwise compare a resolved path against an unresolved one, find them
 * unequal, and boot into "imported, do nothing" — the worst outcome here,
 * since the process still exits 0 having started nothing.
 *
 * Wrapped in a `try`/`catch` so a missing or unreadable `argv[1]` cannot
 * itself throw during startup; either failure mode conservatively answers
 * "not the entry point" rather than crashing on what should be a yes/no
 * question.
 *
 * `realpathSync`, not `fs.promises.realpath`: this runs once at module load,
 * before anything else is on the event loop to be blocked by it — the same
 * exception this project's async-over-sync rule already carves out for
 * build-time and startup-time work that has nothing else to wait on.
 */
export function entryFromArgv(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// `import.meta.main` is symlink-correct and is what Node itself recommends
// for this check, but this package's `engines` field only requires Node
// >=24, and `import.meta.main` is `undefined` — not `false` — on 24.0 and
// 24.1, before it shipped. Trusting it unconditionally would make
// `isEntryPoint` falsy everywhere on those versions and the application
// would never start; checked at runtime with `typeof`, not by version
// number, since that is what actually determines whether the value means
// anything.
const isEntryPoint =
  typeof import.meta.main === 'boolean' ? import.meta.main : entryFromArgv();

if (isEntryPoint) {
  main().catch((error: Error) => {
    console.error(`[pickarr] fatal: ${error.message}`);
    process.exit(1);
  });
}
