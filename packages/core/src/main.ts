import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/load.ts';
import { openDatabase } from './db/open.ts';
import { loadPlugins } from './plugins/registry.ts';
import { createSabnzbdClient } from './clients/sabnzbd.ts';
import type { DownloadClient } from './clients/types.ts';
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
      return ingestEntries(db, plugin, feed, await fetchFeed(feed), Date.now());
    },
    reconcile: async (clientId) => {
      const client = clients.get(clientId);
      if (client === undefined) throw new Error(`No such client: ${clientId}`);
      return reconcileClient({
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
