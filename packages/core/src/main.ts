import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import { loadConfig } from './config/load.ts';
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
import { runMetadataPass } from './pipeline/metadata.ts';
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
 * not throw at startup, or even on the first tick that matters: `byPackage`
 * would simply fail to find the id under any package name, so every group
 * would resolve to no plugin and every row would be silently answered
 * `'none'` — the feature running, doing nothing, and logging nothing that
 * looks like a failure.
 */
export function pluginById(registry: PluginRegistry): (id: string) => MediaTypePlugin | null {
  return (id) => registry.byId(id) ?? null;
}

async function main(): Promise<void> {
  const config = await loadConfig(CONFIG_PATH);
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
      dir: resolveArtworkDir(config.database.path, config.metadata.artworkDir),
      fetchImpl: fetch,
      log,
    };
    const pluginFor = pluginById(registry);
    runMetadata = async () => {
      await runMetadataPass({
        db,
        client,
        pluginFor,
        artwork,
        perTick: config.metadata.perTick,
        now: () => Date.now(),
        log,
      });
    };
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

  const server = buildServer({
    db,
    defaultClient,
    untrackedFor: (clientId) => scheduler.untrackedFor(clientId),
    now: () => Date.now(),
    webRoot,
    registry,
    pluginForFeed: (feedId) => pluginsByFeed.get(feedId) ?? null,
  });

  await server.listen({ port: config.server.port, host: '0.0.0.0' });
  log(`listening on ${config.server.port}`);

  scheduler.start();
  void scheduler.ingestAllNow();
  void scheduler.reconcileNow();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log(`${signal} received, shutting down`);
      scheduler.stop();
      void server.close().then(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}

// Guarded so this module can be imported — by tests, for the small pure
// functions above — without also booting the whole application. `argv[1]` is
// the script Node was actually asked to run; comparing it against this
// module's own URL is the standard way to tell "run directly" apart from
// "imported".
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error: Error) => {
    console.error(`[pickarr] fatal: ${error.message}`);
    process.exit(1);
  });
}
