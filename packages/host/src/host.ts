import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, HostFetch, JobHandler, MediaPlugin, PluginContext } from '@pickarr/contract';
import type { HostDb } from './db/open.ts';
import { migratePlugin } from './db/migrate.ts';
import { createMediaWriter } from './media/writer.ts';
import { createRunner } from './jobs/runner.ts';
import type { Runner } from './jobs/runner.ts';

/**
 * Exponential, capped at a minute. Not an override knob: `backoffMs` is a
 * pure function of `attempts`, so a test controls retry timing through the
 * `now` this host is built with, not by tuning this curve.
 */
export const DEFAULT_BACKOFF_MS = (attempts: number): number => Math.min(1000 * 2 ** (attempts - 1), 60_000);

/** How many times a job may fail before it dead-letters. */
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface Host {
  /** Applies the plugin's migrations and registers its handlers. */
  register(plugin: MediaPlugin): void;
  /** Dispatches to the plugin owning the feed those items came from. */
  notifyNewRssItems(ids: readonly number[]): Promise<void>;
  requestDownload(rssItemId: number): Promise<void>;
  runOnce(): Promise<boolean>;
  recover(): number;
}

/** The `rss_feed` row an rss item belongs to names its owning plugin directly. */
function ownerPluginId(raw: DatabaseSync, rssItemId: number): string | undefined {
  const row = raw.prepare(`
    SELECT rss_feed.plugin_id AS plugin_id
      FROM rss_item JOIN rss_feed ON rss_feed.id = rss_item.feed_id
     WHERE rss_item.id = ?
  `).get(rssItemId);
  if (!row) return undefined;
  return String((row as { plugin_id: unknown }).plugin_id);
}

export function createHost(deps: {
  raw: DatabaseSync;
  db: HostDb;
  fetch: HostFetch;
  downloads: DownloadClients;
  now: () => number;
}): Host {
  // Plugins are wired explicitly via `register`, never discovered, so this
  // map is the host's whole notion of "who exists" — an id absent here is an
  // id nobody has registered, whether or not some `rss_feed` row names it.
  const plugins = new Map<string, MediaPlugin>();

  // Keyed by pluginId, then by kind, rather than by a composite string: two
  // plugins that both register kind "sync" get two independent inner maps,
  // so neither can overwrite the other's handler no matter what either one
  // is called.
  const handlers = new Map<string, Map<string, JobHandler>>();

  const runner: Runner = createRunner(deps.raw, {
    now: deps.now,
    backoffMs: DEFAULT_BACKOFF_MS,
    defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
  });

  // Shared across every plugin: `MediaWriter`'s methods all take the
  // writing plugin's id as a parameter, so one instance has nothing
  // per-plugin to close over.
  const media = createMediaWriter(deps.db, deps.now);

  function ctxFor(pluginId: string): PluginContext {
    return {
      db: deps.raw,
      media,
      // `Runner.enqueue` is sync and takes a `pluginId`; `JobQueue.enqueue` is
      // async and takes none. This adapter is the seam: it closes over the
      // plugin this context was built for, so that plugin can never name
      // another plugin's id when it enqueues its own work.
      jobs: {
        enqueue: async (job) => runner.enqueue(pluginId, job),
      },
      fetch: deps.fetch,
      downloads: deps.downloads,
      log: (message, detail) => {
        console.log(`[${pluginId}] ${message}`, detail ?? {});
      },
    };
  }

  return {
    register(plugin) {
      if (plugins.has(plugin.id)) {
        throw new Error(`plugin "${plugin.id}" is already registered`);
      }
      migratePlugin(deps.raw, plugin.id, plugin.migrations);
      plugins.set(plugin.id, plugin);
      handlers.set(plugin.id, new Map(Object.entries(plugin.jobs)));
    },

    async notifyNewRssItems(ids) {
      const grouped = new Map<string, { plugin: MediaPlugin; ids: number[] }>();
      // Ids whose feed names no plugin at all, or names one this host never
      // registered. Collected rather than dropped: a batch that silently lost
      // an item would look identical to one that never had it.
      const unowned: number[] = [];

      for (const id of ids) {
        const pluginId = ownerPluginId(deps.raw, id);
        const plugin = pluginId !== undefined ? plugins.get(pluginId) : undefined;
        if (pluginId === undefined || !plugin) {
          unowned.push(id);
          continue;
        }
        const entry = grouped.get(pluginId);
        if (entry) {
          entry.ids.push(id);
        } else {
          grouped.set(pluginId, { plugin, ids: [id] });
        }
      }

      // Each plugin sees its own whole batch in one call, not one call per
      // item: an item's position in the caller's array is not something a
      // plugin should have to reassemble from repeated single-item calls.
      // The plugins are independent of one another, so their calls run
      // concurrently rather than one after another in a loop.
      await Promise.all(
        Array.from(grouped.values(), ({ plugin, ids: ownIds }) => plugin.onNewRssItems(ownIds, ctxFor(plugin.id))),
      );

      if (unowned.length > 0) {
        // Reported by rejecting, after every owned group above has already
        // been dispatched: an id with no registered owner is a configuration
        // problem the caller must see, not a reason to withhold delivery from
        // the items that do have one.
        throw new Error(
          `rss item id(s) ${unowned.join(', ')} belong to a feed whose plugin is not registered`,
        );
      }
    },

    async requestDownload(rssItemId) {
      const pluginId = ownerPluginId(deps.raw, rssItemId);
      const plugin = pluginId !== undefined ? plugins.get(pluginId) : undefined;
      if (pluginId === undefined || !plugin) {
        throw new Error(`rss item id ${rssItemId} belongs to a feed whose plugin is not registered`);
      }
      await plugin.onDownloadRequest(rssItemId, ctxFor(plugin.id));
    },

    runOnce() {
      return runner.runOnce(
        (pluginId, kind) => handlers.get(pluginId)?.get(kind),
        (pluginId) => ctxFor(pluginId),
      );
    },

    recover() {
      return runner.recover();
    },
  };
}
