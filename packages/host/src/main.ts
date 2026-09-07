/**
 * Runs the host as a process: jobs run because it is up, driven by its own
 * dispatcher, rather than because something outside it claimed one job at
 * a time.
 *
 * Nothing here is a plugin's or a test's business but the host's own -- how
 * the database is opened, how a crash is recovered from, how the process
 * shuts down. Every export is a function and nothing runs at module scope,
 * so importing this file -- from `index.ts`, or from its own test -- opens
 * no database and installs no signal handler. The one thing that does run on
 * load is the entry-point check, and it lives in `bin.ts`, which is the file
 * the `start` script and the built `dist/bin.js` name; a bundler that
 * collapsed this module into `dist/index.js` therefore cannot turn the
 * library face of the package into a process that migrates a database.
 */
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaPlugin } from '@pickarr/contract';
import { createDownloadClients } from './clients/downloads.ts';
import { migrateHost } from './db/migrate.ts';
import { openDatabase } from './db/open.ts';
import { createHostFetch } from './fetch/queue.ts';
import { createHost } from './host.ts';
import type { Host } from './host.ts';
import type { Timers } from './jobs/dispatcher.ts';

/** `PICKARR_DATABASE`'s fallback -- the documented `/config` volume, exactly as 1.x's own default. */
const DEFAULT_DATABASE_PATH = '/config/pickarr.db';

function log(message: string): void {
  console.log(`[host] ${message}`);
}

/**
 * `artwork/` beside the database file -- 1.x's own default, `resolveArtworkDir`
 * in `packages/core/src/main.ts`, reproduced here rather than imported: host
 * production code must not depend on `@pickarr/core`, which this only
 * mirrors in shape. Unlike 1.x's version this takes no override argument --
 * there is deliberately no config surface in this slice (see the plan's
 * §1.2), so nothing could ever supply one.
 *
 * Exported, and tested on its own: this is the only thing standing between
 * artwork landing in the cache location `createArtworkStore` (via
 * `createHost`) is meant to write to and it landing somewhere unintended --
 * precisely the failure that made `Host`'s `artworkDir` a required
 * parameter with no default of its own.
 */
export function resolveArtworkDir(databasePath: string): string {
  return join(dirname(databasePath), 'artwork');
}

/**
 * Schedules a `poll` job for every `rss_feed` row already on file, and
 * returns the feed ids it scheduled (in the order `sqlite` returns them --
 * ascending by rowid, since nothing here orders the query). `schedulePoll`
 * is idempotent per feed, so this is safe to call on every boot: a feed that
 * already has a poll job `ready` or `running` gets no second one.
 *
 * It is only safe AFTER `host.start()`, though, and that is `main`'s
 * business, not this function's. A poll job a crash left `running` counts as
 * pending here, so this declines to schedule it -- and if `start()`'s sweep
 * then dead-letters that same row (which it does when the crash consumed its
 * last permitted attempt), the feed is left with no poll job in any runnable
 * state and nothing re-creates one. See `main`.
 *
 * Pulled out of `main` and tested on its own: this loop is what makes a
 * fresh boot actually poll anything. Drop its body and the process still
 * starts, opens its database, and logs cheerfully -- it would just never
 * poll a single feed, forever, with no test and no log line anywhere to say
 * so.
 */
export function scheduleKnownFeeds(host: Host, raw: DatabaseSync): readonly number[] {
  const feedIds = raw.prepare('SELECT id FROM rss_feed').all()
    .map((row) => Number((row as { id: unknown }).id));
  for (const feedId of feedIds) host.schedulePoll(feedId);
  return feedIds;
}

/**
 * The plugins the shipped process runs with: none, because no media plugin
 * ships inside `@pickarr/host` yet. This is where a later slice's plugin
 * wires in. An empty list is not a refusal: a poll's `rss_item.delivered_at`
 * stays null for anything `notifyNewRssItems` reports `unowned`, and
 * `feeds/reader.ts`'s `pollFeed` re-offers every undelivered row on every
 * later poll of that feed -- so the process boots and polls safely with no
 * plugin at all, and each feed's backlog is delivered in full the moment a
 * plugin registers for it.
 */
const SHIPPED_PLUGINS: readonly MediaPlugin[] = [];

/**
 * Builds the process's shutdown handler. `host.stop()` clears the
 * dispatcher's timer and safety interval and returns without waiting on
 * anything -- a handler already in flight is abandoned deliberately, its row
 * left `running` for the next `start()` to sweep (see `Host.stop()`'s own
 * doc) -- so there is nothing to `await` here at all: closing the database
 * and exiting follow immediately, in the same synchronous turn.
 *
 * Idempotent against a second signal arriving mid-shutdown -- a `SIGTERM`
 * landing while a `SIGINT` is already tearing down -- by closing over its
 * own `shuttingDown` flag rather than relying on the caller to ask only
 * once.
 *
 * Exported and tested directly, on the same reasoning as `scheduleKnownFeeds`
 * above: the property under test is "returns without waiting even when a
 * handler is hung", and routing that through a real `SIGINT` and a real
 * hung handler would mean asserting that something never happens by waiting
 * on real wall-clock time to *not* see it -- which this whole slice exists
 * to stop doing.
 */
export function createShutdown(
  host: Host,
  raw: DatabaseSync,
  deps: { exit?: (code: number) => void } = {},
): (reason: string) => void {
  const exit = deps.exit ?? process.exit;
  let shuttingDown = false;
  return (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason}, shutting down`);
    host.stop();
    raw.close();
    exit(0);
  };
}

/**
 * Composes and starts the host process.
 *
 * Starts with no plugin registered just as readily as with one. A poll
 * still inserts through `ON CONFLICT (feed_id, guid) DO NOTHING`, so an
 * item's identity is consumed by the first poll that sees it, but that no
 * longer destroys it: `rss_item.delivered_at` stays null for anything
 * `notifyNewRssItems` reports `unowned`, and `feeds/reader.ts`'s `pollFeed`
 * re-offers every undelivered row -- including ones from feeds no plugin
 * has ever owned -- on every later poll, capped per call by
 * `MAX_CATCHUP_PER_POLL` so a large backlog cannot crowd out a feed's newly
 * inserted items in the same batch. So a host with no plugin registered
 * boots, polls and accumulates undelivered rows safely, and delivers them
 * in full the moment a plugin registers for their feed.
 *
 * The order below is the whole of what this function decides, and it is not
 * interchangeable:
 *
 * 1. `migrateHost`, before any `register` -- `migratePlugin` writes to host
 *    tables.
 * 2. `host.register(...)` for each plugin, before anything can poll, so no
 *    item is ever inserted while its feed's owner is absent.
 * 3. `host.start()`, before `scheduleKnownFeeds`. `start()` sweeps every row
 *    a crash left `running` before it arms the dispatcher; `schedulePoll`
 *    counts a poll job left `running` as pending and declines to schedule a
 *    replacement, so scheduling first would leave a feed whose crashed poll
 *    used its last attempt with nothing runnable and nothing to notice.
 *    Sweeping first means `scheduleKnownFeeds` sees each row's true
 *    post-sweep state and schedules a fresh cycle wherever the sweep
 *    dead-lettered one. `main.test.ts` fails if these two are swapped.
 * 4. The signal handlers, last, so nothing can be asked to stop before the
 *    state above is settled.
 *
 * `argv` is accepted for parity with a conventional process entry point;
 * this slice has no argument surface beyond the `PICKARR_DATABASE`
 * environment variable (there is deliberately no config surface yet, see
 * the plan's §1.2), so nothing here reads it.
 *
 * `deps` is a test seam and nothing else: the shipped entry point (`bin.ts`)
 * passes none of it. `plugins` lets a test compose the process the way the
 * slice that ships a plugin will, and `timers` lets a test replace the
 * dispatcher's real `setTimeout`/`setInterval` (`jobs/dispatcher.ts`'s own
 * `Timers`) with a fake pair, so a test asserting the state `main` leaves
 * behind never depends on a real timer firing -- or, left armed with real
 * ones, on remembering to stop them again before the test ends.
 */
export async function main(
  argv: readonly string[],
  deps: { plugins?: readonly MediaPlugin[]; timers?: Timers } = {},
): Promise<void> {
  void argv;

  const plugins = deps.plugins ?? SHIPPED_PLUGINS;

  const databasePath = process.env['PICKARR_DATABASE'] ?? DEFAULT_DATABASE_PATH;
  const { raw, db } = openDatabase(databasePath);
  migrateHost(raw);

  const artworkDir = resolveArtworkDir(databasePath);
  const fetch = createHostFetch({ fetch: globalThis.fetch });
  const downloads = createDownloadClients({ raw, fetch, now: () => Date.now(), log });

  // Two shapes, not one object literal with `timers` always present:
  // `exactOptionalPropertyTypes` is on, so an explicit `timers: undefined`
  // is not the same thing as the property being absent, and `createHost`'s
  // own `timers?` means the latter when it wants its real default.
  const host = deps.timers === undefined
    ? createHost({
      raw,
      db,
      fetch,
      downloads,
      now: () => Date.now(),
      artworkDir,
    })
    : createHost({
      raw,
      db,
      fetch,
      downloads,
      now: () => Date.now(),
      artworkDir,
      timers: deps.timers,
    });

  for (const plugin of plugins) host.register(plugin);

  const recovered = host.start();
  const feedIds = scheduleKnownFeeds(host, raw);

  const shutdown = createShutdown(host, raw);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(`${signal} received`);
    });
  }

  log(
    `running: database ${databasePath}, artwork ${artworkDir}, `
    + `${recovered} job(s) recovered, ${feedIds.length} feed(s) scheduled`,
  );
}
