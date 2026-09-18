/**
 * The 2.0 browser harness: a real Chromium driving the real built SPA
 * against a real in-process host, over a real socket.
 *
 * **Boots `createReadServer` directly, not `main`.** `main` is the shipped
 * process entry point -- it opens the database, migrates it, registers the
 * three real plugins, arms the job dispatcher, and only then builds the read
 * server -- and it returns nothing a test could close: no handle to the
 * server, none to the dispatcher's timers, and it installs a `SIGINT`/`SIGTERM`
 * listener per call that nothing ever removes. Calling it once per spec would
 * leak a listener and a live dispatcher per test and could keep the whole
 * `npm run e2e` process from exiting. `createReadServer` is exported from
 * `@pickarr/host` for exactly this: this harness assembles the same
 * `ReadServerDeps` `main` does, by hand, and gets back a `close()` it can
 * actually call.
 *
 * **No plugin is registered, and none is needed.** `media_item` -- the one
 * table the shell's three counts read (`useCounts.ts`'s `CATEGORIES`) -- is a
 * *host* synced table (`HOST_SYNCED_TABLES`), synced with no plugin involved
 * at all. `seedMediaItem` below inserts into it directly, the same seam
 * `packages/host/test/api/sync-route.test.ts`'s own `seedMediaItem` uses, so
 * a spec can grow the replica's source of truth with no feed, no lookup
 * service and no job to produce one.
 *
 * **The claim token is read from the database, not from a boot log.** The
 * task brief for this harness said to capture it off `main`'s stdout; that
 * premise does not hold here, on two independent grounds. First, this
 * harness boots `createReadServer` directly and never calls `main`, so there
 * is no boot log to scrape in the first place. Second, even where `main` does
 * run, `ensureClaimToken(raw, at)` -- exported from `@pickarr/host` for this
 * reason -- generates the token on first call and re-offers the same one on
 * every call after, until `spendClaimToken` spends it (its own docblock,
 * `auth/claim.ts`); the boot log's line is one more caller of that same
 * function, not a second source of truth. Reading it directly is also the
 * only choice that does not couple this suite to the wording of a log line.
 *
 * **Bound to `127.0.0.1`, not the wildcard `0.0.0.0` `main` binds by
 * default.** A browser has to *connect* to whatever address this reports,
 * and a listener told to bind every interface is not guaranteed to answer a
 * loopback connection identically on every platform this suite might run on
 * -- `127.0.0.1` is unambiguous.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test as base } from '@playwright/test';
import {
  createAuth,
  createReadServer,
  createSyncRegistry,
  ensureClaimToken,
  ensureSyncGeneration,
  migrateHost,
  openDatabase,
  type ReadServer,
} from '@pickarr/host';
import { webDist } from './paths.ts';

/**
 * Obviously synthetic, and not a real secret -- see
 * `packages/host/test/api/server.test.ts`'s own doc on constants shaped like
 * this one. Fixed rather than random: nothing here needs a secret that
 * differs per test, since every test gets its own database and therefore its
 * own cookie jar under it regardless.
 */
const AUTH_SECRET = 'placeholder-not-a-real-signing-secret-for-e2e-tests';

/** A `log` that drops every line. Nothing in this suite asserts on the host's own log. */
const dropLine = (): void => {};

/** The three categories the shell has tabs for (`shell/useCounts.ts`'s `CATEGORIES`). */
export type Category = 'tv' | 'movie' | 'xxx';

export interface Harness {
  /** The origin the in-process host bound. Every navigation in a spec starts here. */
  origin: string;
  /**
   * This install's claim token -- see this module's doc for why it is read
   * this way rather than from a log.
   */
  claimToken: string;
  /**
   * Inserts one `media_item` row directly and returns its id. `pluginId` is
   * one of the shell's three real categories, not the host suite's synthetic
   * `'alpha'`: `useCounts.ts` only ever calls `countByPlugin('media_item',
   * category)` for `category` in `CATEGORIES` (`'tv' | 'movie' | 'xxx'`), so
   * a row under any other `pluginId` value matches none of the three
   * `by_table_plugin_updated` key ranges those calls count over, and would
   * be counted by none of the three tabs.
   */
  seedMediaItem(pluginId: Category, title: string): number;
}

interface Booted {
  raw: DatabaseSync;
  dir: string;
  server: ReadServer;
}

/**
 * One database, one listener, per test -- never shared, so one spec's rows
 * and one spec's session can never leak into another's assertions.
 */
async function boot(): Promise<Booted> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-e2e-'));
  const { raw, db } = openDatabase(join(dir, 'pickarr.db'));
  migrateHost(raw);

  // Empty plugin list: see this module's doc for why `media_item` needs none.
  const registry = createSyncRegistry(raw, []);
  const generation = ensureSyncGeneration(raw, Date.now());

  const server = await createReadServer({
    raw,
    pluginIdForType: () => undefined,
    registry,
    generation,
    host: '127.0.0.1',
    port: 0,
    webRoot: webDist,
    // A function of the bound origin, exactly as `main` builds it -- see
    // `ReadServerDeps.authFor`'s own doc for why `baseURL` cannot be known
    // until the listener has bound.
    authFor: (baseURL) => createAuth({
      raw,
      db,
      secret: AUTH_SECRET,
      baseURL,
      publicUrl: undefined,
      log: dropLine,
    }),
    log: dropLine,
  });

  return { raw, dir, server };
}

/**
 * Playwright's own `test`, extended with one fixture: a fresh host, a fresh
 * temp database, and this install's claim token, torn down after the test
 * whether it passed or failed.
 *
 * **Depends on `context`, not just on being handed `page` inside a test
 * body.** Without that dependency, this fixture's own teardown and
 * Playwright's built-in `page`/`context` teardown race each other with no
 * defined order -- measured directly (a task 8 fix-round review), by
 * instrumenting both: this fixture's `finally` ran, then the tab actually
 * closed **38ms later**. In that window a still-open tab's own sync loop can
 * fire one more request into a server whose database this fixture has
 * already closed underneath it. The request fails with `ERR_INVALID_STATE`,
 * and Better Auth's own internal logger -- which bypasses the `log: dropLine`
 * this file injects, the same way `packages/host/src/auth/instance.ts`'s
 * `AuthDeps.log` doc already documents it bypassing other message kinds --
 * prints the failing query and **its bound parameters, including a live
 * session token**, straight to the console. That is a Global Constraint
 * violation ("no credential in any message or log"), reproducible, in code
 * this task wrote.
 *
 * The fix is to make this fixture responsible for quiescing the browser side
 * itself, rather than leaving it to whichever of two independent teardowns
 * happens to run first: depending on `context` guarantees `context` outlives
 * this fixture (a dependency always tears down after its dependent), so this
 * fixture's own `finally` can call `context.close()` -- which closes every
 * page open in it, not just the fixture's own `page`, so it also covers a
 * spec that opened a second tab by hand (`context.newPage()`, the "two tabs"
 * spec) -- and know nothing in the browser can issue a further request once
 * that resolves. Playwright's own later `page`/`context` teardown then finds
 * both already closed, which is harmless (`close()` is idempotent).
 *
 * This narrows the window to nothing observable rather than closing a
 * theoretical one: a request already dispatched into the server's socket
 * before `context.close()` was called could in principle still be mid-flight
 * when `raw.close()` runs a line later. Nothing in this suite has reproduced
 * that after this fix across many runs (see the task report for the count),
 * and `context.close()` first is what removes the dominant, actually-observed
 * trigger -- a tab's own live timer firing a *new* request during teardown.
 */
export const test = base.extend<{ harness: Harness }>({
  harness: async ({ context }, use) => {
    const { raw, dir, server } = await boot();
    try {
      const claimToken = ensureClaimToken(raw, Date.now());
      await use({
        origin: `http://${server.host}:${server.port}`,
        claimToken,
        seedMediaItem(pluginId, title) {
          const at = Date.now();
          const info = raw.prepare(
            'INSERT INTO media_item (plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?)',
          ).run(pluginId, at, at, title);
          return Number(info.lastInsertRowid);
        },
      });
    } finally {
      // Every page this test has open, closed first -- see this fixture's
      // own doc for why this has to run before the server and the database
      // do, and why `context.close()` rather than `page.close()`.
      await context.close();
      await server.close();
      raw.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
});
