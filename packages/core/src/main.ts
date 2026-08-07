import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/load.ts';
import { openDatabase } from './db/open.ts';
import { loadPlugins } from './plugins/registry.ts';
import { createSabnzbdClient } from './clients/sabnzbd.ts';
import { createTpdbClient, type SiteLookupClient } from './clients/theporndb.ts';
import type { DownloadClient } from './clients/types.ts';
import { knownSiteNames } from './db/sites.ts';
import { resolveSitesForBatch } from './pipeline/resolve-sites.ts';
import { fetchFeed } from './feeds/fetch-feed.ts';
import { ingestEntries } from './ingest/ingest.ts';
import { reconcileClient } from './pipeline/reconcile.ts';
import { importDownload } from './pipeline/import.ts';
import { recoverInterruptedWork } from './pipeline/recover.ts';
import { createScheduler } from './pipeline/scheduler.ts';
import { buildServer } from './http/server.ts';

const CONFIG_PATH = process.env['PICKARR_CONFIG'] ?? '/config/config.json';

function log(message: string): void {
  console.log(`[pickarr] ${message}`);
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

  let siteLookup: SiteLookupClient | undefined;
  if (config.siteLookup === undefined) {
    log('site lookup: not configured; date-at-end names use their first word as the site');
  } else {
    siteLookup = createTpdbClient(config.siteLookup, fetch);
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

  const scheduler = createScheduler({
    db,
    feeds: config.feeds,
    clientIds: [...clients.keys()],
    log,
    ingestFeed: async (feed) => {
      const plugin = registry.byPackage(feed.plugin);
      const entries = await fetchFeed(feed);

      // Before parsing, not after: an identity key outlives the tick, so a
      // site learned too late cannot be applied without re-keying a group the
      // user may already have picked.
      const sites = await resolveSitesForBatch(
        { db, plugin, client: siteLookup, now: () => Date.now(), log },
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

  const server = buildServer({
    db,
    defaultClient,
    untrackedFor: (clientId) => scheduler.untrackedFor(clientId),
    now: () => Date.now(),
    webRoot,
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

main().catch((error: Error) => {
  console.error(`[pickarr] fatal: ${error.message}`);
  process.exit(1);
});
