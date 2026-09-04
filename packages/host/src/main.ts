/**
 * Runs the host as a process: jobs run because it is up, rather than because
 * a test called `runOnce`.
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
import type { DownloadClients, MediaPlugin } from '@pickarr/contract';
import { migrateHost } from './db/migrate.ts';
import { openDatabase } from './db/open.ts';
import { createHostFetch } from './fetch/queue.ts';
import { createHost } from './host.ts';
import type { Host } from './host.ts';

/** `PICKARR_DATABASE`'s fallback -- the documented `/config` volume, exactly as 1.x's own default. */
const DEFAULT_DATABASE_PATH = '/config/pickarr.db';

/** How long the pump waits before asking again, once nothing was ready. */
const DEFAULT_IDLE_MS = 1000;

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
 * No download client is wired to the host process in this slice. See
 * `DownloadClients`'s own doc comment in `@pickarr/contract`: "the clients
 * themselves ... are a later slice." `onDownloadRequest` is still a required
 * plugin entry point, so this exists to fail loudly, by name, the moment
 * anything actually calls it, rather than let a plugin's `ctx.downloads.submit`
 * hang or throw something unrelated.
 */
const downloadClientsNotWired: DownloadClients = {
  submit: async () => {
    throw new Error('download clients are not wired to the host process in this slice');
  },
};

export interface Pump {
  /** Lets the pump's current claim finish, then stops it from claiming another. */
  stop(): void;
  /** Resolves once the pump has actually stopped -- after any in-flight claim finishes. */
  done: Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Claims jobs until stopped. Sleeps when nothing is ready. That is all it
 * does: recovering the jobs a crash left `running` is `main`'s job, done
 * before it schedules anything (see `main`), and not this function's --
 * doing it here hid the one ordering in the process that has to be right,
 * and made it unassertable from the call site.
 *
 * A rejected `runOnce` is caught and treated as "nothing claimed" rather
 * than left to end the pump: `Runner.runOnce` already turns a rejected
 * handler into a backoff or a dead-letter row and resolves `true`/`false`
 * either way, never rejecting, so a rejection reaching here is a defect in
 * whatever `Host` this pump was given. Nothing supervises this loop, so
 * letting that one rejection escape would turn one bad tick into an outage
 * no restart fixes -- a handler's own failure is the runner's business, not
 * the pump's.
 */
export function startPump(
  host: Host,
  deps: { idleMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Pump {
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const sleep = deps.sleep ?? defaultSleep;
  // A boxed flag, not a bare `let`: `stop()` below flips it from outside the
  // loop, and a linter that only looks for a reassignment textually inside
  // the loop body cannot see that -- `state.running` is read the same way
  // regardless of which closure last wrote it.
  const state = { running: true };

  const done = (async () => {
    while (state.running) {
      let ranSomething: boolean;
      try {
        // eslint-disable-next-line no-await-in-loop -- claiming and running one job at a time is the whole of what the pump does; there is nothing here to parallelise it against
        ranSomething = await host.runOnce();
      } catch (err) {
        console.error('[host] runOnce rejected; the pump keeps running', err);
        ranSomething = false;
      }
      if (!ranSomething && state.running) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await sleep(idleMs);
      }
    }
  })();

  return {
    stop() {
      state.running = false;
    },
    done,
  };
}

/**
 * Schedules a `poll` job for every `rss_feed` row already on file, and
 * returns the feed ids it scheduled (in the order `sqlite` returns them --
 * ascending by rowid, since nothing here orders the query). `schedulePoll`
 * is idempotent per feed, so this is safe to call on every boot: a feed that
 * already has a poll job `ready` or `running` gets no second one.
 *
 * It is only safe AFTER `host.recover()`, though, and that is `main`'s
 * business, not this function's. A poll job a crash left `running` counts as
 * pending here, so this declines to schedule it -- and if `recover` then
 * dead-letters that same row (which it does when the crash consumed its last
 * permitted attempt), the feed is left with no poll job in any runnable
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
 * wires in, and until then `main` refuses to start at all -- see the guard
 * at the top of it for why an empty list is a refusal rather than a
 * degraded mode.
 */
const SHIPPED_PLUGINS: readonly MediaPlugin[] = [];

/**
 * Composes and starts the host process.
 *
 * Refuses to start with no plugin registered. That is not pedantry: a poll
 * inserts through `ON CONFLICT (feed_id, guid) DO NOTHING`, so an item's
 * identity is consumed by the first poll that sees it, and
 * `notifyNewRssItems` can only report it as `unowned`. No later poll
 * re-offers it and nothing rescans `resolution = 'pending'`, so every item
 * on every feed's front page would be destroyed on the first cycle,
 * permanently and invisibly. Refusing loudly is the honest description of
 * this slice: the machinery works and there is no plugin yet. Re-offering
 * undelivered rows is a real mechanism that belongs to the slice which
 * ships a plugin, and is deliberately not improvised here.
 *
 * The order below is the whole of what this function decides, and it is not
 * interchangeable:
 *
 * 1. `migrateHost`, before any `register` -- `migratePlugin` writes to host
 *    tables.
 * 2. `host.register(...)` for each plugin, before anything can poll, so no
 *    item is ever inserted while its feed's owner is absent.
 * 3. `host.recover()`, before `scheduleKnownFeeds`. A poll job a crash left
 *    `running` counts as pending to `schedulePoll`, which therefore declines
 *    to schedule a replacement; `recover` then dead-letters that very row if
 *    the crash used its last attempt, leaving the feed with nothing runnable
 *    and nothing to notice. Recovering first means `scheduleKnownFeeds` sees
 *    the true state and schedules a fresh cycle. `main.test.ts` fails if
 *    these two are swapped.
 * 4. `startPump`, last, so no job can be claimed before the state above is
 *    settled.
 *
 * `argv` is accepted for parity with a conventional process entry point;
 * this slice has no argument surface beyond the `PICKARR_DATABASE`
 * environment variable (there is deliberately no config surface yet, see
 * the plan's §1.2), so nothing here reads it.
 *
 * `deps` is a test seam and nothing else: the shipped entry point (`bin.ts`)
 * passes none of it. `plugins` lets a test compose the process the way the
 * slice that ships a plugin will, and `startPump` lets it assert the state
 * this function leaves behind without a real pump claiming jobs and
 * reaching the network mid-assertion.
 */
export async function main(
  argv: readonly string[],
  deps: { plugins?: readonly MediaPlugin[]; startPump?: (host: Host) => Pump } = {},
): Promise<void> {
  void argv;

  const plugins = deps.plugins ?? SHIPPED_PLUGINS;
  // Checked before the database is opened, so a refusal leaves nothing
  // behind -- no file, no migration, no signal handler.
  if (plugins.length === 0) {
    throw new Error(
      'refusing to start with no media plugin registered: a poll consumes each item\'s identity through '
      + 'the (feed_id, guid) dedup index, so every item polled before a plugin owns its feed would be '
      + 'destroyed rather than delivered, and no later poll re-offers it',
    );
  }

  const databasePath = process.env['PICKARR_DATABASE'] ?? DEFAULT_DATABASE_PATH;
  const { raw, db } = openDatabase(databasePath);
  migrateHost(raw);

  const artworkDir = resolveArtworkDir(databasePath);
  const fetch = createHostFetch({ fetch: globalThis.fetch });

  const host = createHost({
    raw,
    db,
    fetch,
    downloads: downloadClientsNotWired,
    now: () => Date.now(),
    artworkDir,
  });

  for (const plugin of plugins) host.register(plugin);

  const recovered = host.recover();
  const feedIds = scheduleKnownFeeds(host, raw);

  const pump = (deps.startPump ?? startPump)(host);

  // A second trigger during teardown -- a SIGTERM arriving while a SIGINT is
  // already tearing down -- must not start a second drain.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason}, shutting down`);
    pump.stop();
    // `pump.done` never rejects -- `startPump` already turns a rejected
    // `runOnce` into a logged, swallowed no-op -- so there is no failure
    // branch here to mirror 1.x's `server.close().catch(...)` with.
    void pump.done.then(() => {
      raw.close();
      process.exit(0);
    });
  };

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
