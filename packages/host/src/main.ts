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
import type { ReadServer, ReadServerDeps } from './api/server.ts';
import { DEFAULT_PORT, createReadServer } from './api/server.ts';
import { ensureClaimToken, isClaimed } from './auth/claim.ts';
import { createAuth } from './auth/instance.ts';
import { createDownloadClients } from './clients/downloads.ts';
import { ensureAuthSecret } from './db/host-state.ts';
import { migrateHost } from './db/migrate.ts';
import { openDatabase } from './db/open.ts';
import { createHostFetch } from './fetch/queue.ts';
import { createHost } from './host.ts';
import type { Host } from './host.ts';
import type { Timers } from './jobs/dispatcher.ts';

/** `PICKARR_DATABASE`'s fallback -- the documented `/config` volume, exactly as 1.x's own default. */
const DEFAULT_DATABASE_PATH = '/config/pickarr.db';

/**
 * A log line's structured half, as `key=value` pairs.
 *
 * Every value goes through `String`, and that is the safety property rather
 * than a formatting preference: `String` of a row, a config or any other
 * object is `[object Object]`, so a caller that broke the rule against
 * logging one could not spill its contents through here even by accident.
 * Only strings pass through this today -- `api/server.ts`'s failure line,
 * whose `error` has already been through `redactUrl`.
 *
 * Exported for its own test, because the claim above is the whole reason this
 * is a function and not an inline template.
 */
export function formatLogDetail(detail: Readonly<Record<string, unknown>>): string {
  return Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`).join(' ');
}

/** The process's own log line, and the `log` the read server is given. */
function log(message: string, detail?: Readonly<Record<string, unknown>>): void {
  const suffix = detail === undefined ? '' : ` ${formatLogDetail(detail)}`;
  console.log(`[host] ${message}${suffix}`);
}

/**
 * `artwork/` beside the database file -- 1.x's own default, `resolveArtworkDir`
 * in `packages/core/src/main.ts`, reproduced here rather than imported: host
 * production code must not depend on `@pickarr/core`, which this only
 * mirrors in shape. Unlike 1.x's version this takes no override argument --
 * there is deliberately no config surface in 2.0 yet (slice B's spec,
 * `docs/superpowers/specs/2026-09-03-feed-reader-artwork-design.md` §1.1:
 * 1.x's `PICKARR_CONFIG` json is not ported, feeds are seeded rows), so
 * nothing could ever supply one. Cited as the spec, because no plan in this
 * repo has numbered sections -- slice B's plan has an unnumbered
 * `## Global Constraints` and references the *spec's* §1.2 itself, which is
 * the exclusions list and says nothing about config.
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
 * Schedules a `reconcile` job for every `download_client` row already on
 * file, and returns the client ids it scheduled -- the same shape and the
 * same reasoning as `scheduleKnownFeeds`, one job kind over, and equally
 * only safe AFTER `host.start()`.
 *
 * Each client's `host.scheduleReconcile` call is independent -- it checks
 * and creates a job for one client id, touching no row any other client's
 * call would -- so this fires all of them at once with `Promise.all` rather
 * than an `await` inside a `for` loop: there is no ordering between clients
 * for a loop's own sequencing to preserve, and awaiting one at a time would
 * only make booting with many clients slower for no correctness gained.
 */
export async function scheduleKnownDownloadClients(host: Host, raw: DatabaseSync): Promise<readonly number[]> {
  const clientIds = raw.prepare('SELECT id FROM download_client').all()
    .map((row) => Number((row as { id: unknown }).id));
  await Promise.all(clientIds.map((clientId) => host.scheduleReconcile(clientId)));
  return clientIds;
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
 * The `pluginIdForType` the read API's `/api/media` and `/api/deletions`
 * routes resolve a `?type=` through: the plugin claiming that media type, or
 * `undefined` for a type nothing claims (which those routes answer 404 for).
 *
 * A function built here and passed in, rather than the server reaching for
 * the registry, and that is the whole point of its shape: `host.ts` owns the
 * registry, and nothing under `src/api` may import `host.ts` without putting
 * the read layer in a cycle with it. `main` already holds the plugin list, so
 * it is the one place that can answer this without anyone importing anything.
 *
 * **Two plugins claiming one media type is refused here, loudly.** It is a
 * configuration error with no correct resolution: picking either one would
 * route every read of that type to whichever was listed first, and the other
 * plugin's library would simply appear empty -- a silent, total failure of
 * one plugin that looks like missing data rather than like a misconfiguration.
 * Refusing at construction means the process does not start, which is the
 * only outcome that gets it fixed. `Host.register` does not catch this: it
 * refuses a duplicate plugin *id*, and two plugins with different ids can
 * still name the same media type.
 */
export function createPluginIdForType(
  plugins: readonly MediaPlugin[],
): (type: string) => string | undefined {
  const byType = new Map<string, string>();
  for (const plugin of plugins) {
    const claimed = byType.get(plugin.mediaType);
    if (claimed !== undefined) {
      throw new Error(
        `two plugins claim media type "${plugin.mediaType}": "${claimed}" and "${plugin.id}"`,
      );
    }
    byType.set(plugin.mediaType, plugin.id);
  }
  return (type: string): string | undefined => byType.get(type);
}

/** A port as an environment variable may spell one: digits only, so nothing is coerced. */
const PORT_DIGITS = /^\d+$/;

/**
 * Deliberately **not** `PICKARR_PORT`: 1.x reads that variable for its own
 * server (`packages/core/src/config/load.ts`), and 1.x is still running. One
 * name for two servers means either they fight for a port or 2.0 silently
 * takes the one 1.x was configured with -- and the whole point of the
 * `pickarr-2` branch is that both run side by side until 2.0 reaches parity.
 *
 * The port the read API listens on: `PICKARR_READ_API_PORT` when set to one, and
 * `DEFAULT_PORT` otherwise.
 *
 * Takes the variable's value rather than reading `process.env` itself, so it
 * is testable without mutating the environment the whole process shares.
 *
 * Stricter than 1.x's `resolveServerPort` (`packages/core/src/config/load.ts`)
 * on purpose: that one uses `Number.parseInt`, which reads `'80abc'` as 80 and
 * `'0x50'` as 0, so a typo becomes a port nobody asked for and the process
 * listens somewhere nothing polls. Digits only, and inside the range a
 * listener can actually bind, or the process refuses to start.
 */
export function resolveReadPort(configured: string | undefined): number {
  if (configured === undefined || configured === '') return DEFAULT_PORT;
  if (!PORT_DIGITS.test(configured)) {
    throw new Error(`PICKARR_READ_API_PORT is not a port number: ${configured}`);
  }
  const port = Number(configured);
  // 0 is excluded deliberately, even though `listen(0)` is legal and is what
  // every test binds: a *process* told to listen on an arbitrary free port
  // would answer on an address nothing could be configured to poll.
  if (port < 1 || port > 65535) {
    throw new Error(`PICKARR_READ_API_PORT is not a port number: ${configured}`);
  }
  return port;
}

/**
 * The interface the read API binds: `PICKARR_READ_API_HOST` when set to
 * anything, and `undefined` -- which `createReadServer` reads as its own
 * `DEFAULT_HOST`, every interface -- otherwise.
 *
 * **The default is deliberately not restated here.** One name for it, in the
 * module that does the binding, is what keeps this from being a second place
 * that could disagree about what the shipped process listens on. What this
 * function decides is only whether the operator said anything.
 *
 * Nothing is validated beyond that: what can be bound is the listener's
 * question, and `createReadServer` already rejects a bind that fails rather
 * than leaving a process that looks started and serves nothing.
 *
 * **An empty variable is an unset one**, exactly as it is for the port -- and
 * here that is load-bearing rather than tidy. `PICKARR_READ_API_HOST=` is
 * what a compose file with the key and no value passes, and
 * `listen(port, '')` binds the IPv6 wildcard `::` (measured on node 26), not
 * the documented `0.0.0.0`: a different family, reported back as a different
 * address, for a variable the operator never meant to set.
 *
 * Takes the variable's value rather than reading `process.env` itself, so it
 * is testable without mutating the environment the whole process shares.
 */
export function resolveReadHost(configured: string | undefined): string | undefined {
  return configured === undefined || configured === '' ? undefined : configured;
}

/**
 * `PICKARR_PUBLIC_URL`: the externally reachable origin, for a host behind a
 * reverse proxy. `undefined` when unset or empty, which is the ordinary case
 * -- no proxy, and the address the listener bound is the origin.
 *
 * **Refused at boot when it is not an http origin**, rather than carried into
 * `baseURL`, because the failure it would otherwise cause is both silent and
 * total: Better Auth compares every state-changing request's `Origin` against
 * `baseURL` (the auth slice's §2, measured), so a malformed value refuses
 * every sign-in with a 403 whose reason appears in no log -- on the slice
 * where a session is the only thing protecting this socket. A host comes with
 * the scheme rather than being a second rule: `http:` and `https:` are
 * special schemes, so a url with no host does not parse at all (`http://` is
 * a parse failure, measured). What the host resolves to, and whether anything
 * answers there, is not this process's business and could not be known here
 * anyway.
 *
 * **An origin is the whole of what this variable may hold**, so a path, a
 * query string or a fragment is refused here too -- the scheme was once the
 * whole of what was checked, and that left the failure this function exists to
 * prevent wide open. Measured, all three the same way: with `baseURL`
 * `http://127.0.0.1:<port>/pickarr`, `…/?x=1` or `…/#frag`, Better Auth mounts
 * itself under that path and every auth route answers **404** on the path
 * `api/server.ts` forwards -- so nobody can sign in, sign up or sign out,
 * sessions issued earlier keep working because the guard calls
 * `auth.api.getSession` in-process, and `/api/health` answers **200** so a
 * container health check reports the host healthy. Nothing is logged.
 * `https://host/pickarr` is a reverse proxy on a subpath, which is an
 * ordinary arrangement and a *feature* this slice does not have; refusing it
 * at boot says so, where reducing it to its origin would give that operator a
 * half-working install (cookies and redirects at the wrong path) instead of
 * an answer.
 *
 * **A trailing slash is not a path**: `https://host/` has pathname `/`, is
 * accepted, and works -- Better Auth normalizes it when it composes the
 * mount (measured, and the one prediction the review got backwards).
 *
 * **No failure below names the value.** Nothing this repo emits may carry a
 * url, and a boot that dies on an unreadable environment variable is exactly
 * where a url would otherwise reach a log: the message names the variable and
 * the rule it broke, which is all the operator needs to fix it.
 *
 * The value is returned as it was written rather than normalized, which after
 * the checks above means at most a trailing slash. Better Auth compares
 * origins, and `auth/instance.ts`'s `publicOrigin` is what reduces that to an
 * origin -- in the one place that does the comparing.
 */
export function resolvePublicUrl(configured: string | undefined): string | undefined {
  if (configured === undefined || configured === '') return undefined;
  if (!URL.canParse(configured)) {
    throw new Error('PICKARR_PUBLIC_URL is not a url');
  }
  const url = new URL(configured);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PICKARR_PUBLIC_URL is not an http or https url');
  }
  if (url.pathname !== '/') {
    throw new Error('PICKARR_PUBLIC_URL must have no path: its pathname must be /');
  }
  if (url.search !== '') {
    throw new Error('PICKARR_PUBLIC_URL must have no query string');
  }
  if (url.hash !== '') {
    throw new Error('PICKARR_PUBLIC_URL must have no fragment');
  }
  return configured;
}

/**
 * The Better Auth signing secret this host will sign cookies with:
 * `BETTER_AUTH_SECRET` when the operator set it to anything, and the secret
 * `db/host-state.ts` persists (generating it once, on first boot) otherwise.
 *
 * **The variable has to win, because §6 documents it as the only way to
 * rotate a secret.** It used to do nothing at all: Better Auth's own fallback
 * chain is `options.secret || env.BETTER_AUTH_SECRET || …`, `options.secret`
 * wins, and `createAuth` is always passed one -- so an operator who suspected
 * a compromise could set the documented variable, restart, and have every
 * session stay valid for its full `Max-Age=604800` with nothing saying
 * otherwise. Measured before the fix: a cookie issued under the persisted
 * secret was still accepted by a host booted with a *different*
 * `BETTER_AUTH_SECRET`.
 *
 * **Setting it, changing it or removing it logs everyone out**, which is the
 * point of having it and is also why §6 documents the hazard next to it: the
 * cookie signature is what every session is checked against, so a stray value
 * in the environment invalidates them all. Nothing is logged here either way
 * -- the value is a credential and cannot be named in a log line, and "the
 * secret changed" is not something this process can know without holding both.
 *
 * **The persisted row is left exactly as it is.** It is not read, not written
 * and not deleted while the variable is set, so removing the variable later
 * returns the host to the secret it already had rather than to a fresh one.
 * The row's other property -- generated once even under a race, so a restart
 * does not log everyone out -- is `ensureGeneratedValue`'s and is untouched.
 *
 * **An empty variable is an unset one**, as it is for the port, the host and
 * the public url: `BETTER_AUTH_SECRET=` is what a compose file with the key
 * and no value passes, and signing every cookie with the empty string is not
 * what that operator asked for.
 *
 * Takes the variable's value rather than reading `process.env` itself, so the
 * precedence is testable without mutating the environment the whole process
 * shares -- and so the plural `BETTER_AUTH_SECRETS`, which the library reads
 * on its own and which this function has no part in, stays the library's
 * business (§6 documents it).
 */
export function resolveAuthSecret(configured: string | undefined, raw: DatabaseSync, at: number): string {
  if (configured !== undefined && configured !== '') return configured;
  return ensureAuthSecret(raw, at);
}

/**
 * Builds the process's shutdown handler. `host.stop()` clears the
 * dispatcher's timer and safety interval and returns without waiting on
 * anything -- a handler already in flight is abandoned deliberately, its row
 * left `running` for the next `start()` to sweep (see `Host.stop()`'s own
 * doc) -- so there is nothing to `await` here at all: closing the database
 * and exiting follow immediately, in the same synchronous turn.
 *
 * `server.close()` runs **first**, before `host.stop()`, so no read is
 * accepted against a host that has already been told to stop. Its promise is
 * deliberately not awaited, on exactly the same reasoning as `stop()`: the
 * listener and every open connection are gone by the time `close()` yields,
 * and what the promise is waiting for is nothing this process needs to see
 * before exiting. An in-flight read is abandoned, which costs its client one
 * retry.
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
  server: ReadServer,
  deps: { exit?: (code: number) => void } = {},
): (reason: string) => void {
  const exit = deps.exit ?? process.exit;
  let shuttingDown = false;
  return (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason}, shutting down`);
    // Not awaited, and the ordering still holds: `close()` stops the listener
    // and drops open connections synchronously, before it returns the promise
    // this is discarding.
    void server.close();
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
 * 3. `host.start()`, before `scheduleKnownFeeds` and
 *    `scheduleKnownDownloadClients`. `start()` sweeps every row a crash
 *    left `running` before it arms the dispatcher; `schedulePoll` and
 *    `scheduleReconcile` each count their own job left `running` as pending
 *    and decline to schedule a replacement, so scheduling first would leave
 *    a feed or client whose crashed cycle used its last attempt with
 *    nothing runnable and nothing to notice. Sweeping first means both
 *    scheduling calls see each row's true post-sweep state and schedule a
 *    fresh cycle wherever the sweep dead-lettered one. `main.test.ts` fails
 *    if these are reordered.
 * 4. `createReadServer`, after `host.start()`. The socket must not answer a
 *    read against a database whose crashed rows have not been swept yet, and
 *    it is opened after both scheduling calls as well, so nothing is served
 *    until the process has finished deciding what it will do. `main.test.ts`
 *    fails if the server is built before `start()`.
 * 5. The signal handlers, after the server, so nothing can be asked to stop
 *    before the state above is settled.
 * 6. The claim-token line, last of all, and only while the install is
 *    unclaimed. Last because it is the thing an owner starting this process
 *    has to read, and the bottom of the output is where they are looking --
 *    the auth slice's §6 asks for it on every boot, which is why it is a
 *    property of `isClaimed` rather than of having just generated a token.
 *    It is also the **one place anything prints the token**, and nothing
 *    anywhere prints the signing secret.
 *
 * `argv` is accepted for parity with a conventional process entry point;
 * this slice has no argument surface beyond the `PICKARR_DATABASE`,
 * `PICKARR_READ_API_PORT`, `PICKARR_READ_API_HOST`, `PICKARR_PUBLIC_URL` and
 * `BETTER_AUTH_SECRET` environment variables (there is deliberately no config
 * surface yet -- slice B's spec §1.1, cited in full on `resolveArtworkDir`
 * above), so nothing here reads it. `BETTER_AUTH_SECRETS`, the plural, is
 * read by the library itself and by nothing in this package; the auth slice's
 * §6 documents both.
 *
 * `deps` is a test seam and nothing else: the shipped entry point (`bin.ts`)
 * passes none of it. `plugins` lets a test compose the process the way the
 * slice that ships a plugin will, and `timers` lets a test replace the
 * dispatcher's real `setTimeout`/`setInterval` (`jobs/dispatcher.ts`'s own
 * `Timers`) with a fake pair, so a test asserting the state `main` leaves
 * behind never depends on a real timer firing -- or, left armed with real
 * ones, on remembering to stop them again before the test ends.
 *
 * `createReadServer` is the third, and a test running `main` should supply
 * it: the real one binds a real port, and `main` returns no handle to close
 * it with, so a test that lets it bind leaves a listener behind for every
 * later test to trip over. It is also the only way to observe *when* the
 * server was built relative to `host.start()`, which is the ordering above.
 * Supplying it does not have to mean faking it -- `main.test.ts` also passes
 * a wrapper around the real one, which is how `authFor` below is covered at
 * all: that closure is called by the listener rather than by anything here,
 * so a fake server never runs it.
 */
export async function main(
  argv: readonly string[],
  deps: {
    plugins?: readonly MediaPlugin[];
    timers?: Timers;
    createReadServer?: (serverDeps: ReadServerDeps) => Promise<ReadServer>;
  } = {},
): Promise<void> {
  void argv;

  const plugins = deps.plugins ?? SHIPPED_PLUGINS;

  // Before the database is opened, before anything is migrated: two plugins
  // claiming one media type is a configuration error, and the earliest
  // possible refusal is the one that touches least on its way out.
  const pluginIdForType = createPluginIdForType(plugins);
  const port = resolveReadPort(process.env['PICKARR_READ_API_PORT']);
  const readHost = resolveReadHost(process.env['PICKARR_READ_API_HOST']);
  const publicUrl = resolvePublicUrl(process.env['PICKARR_PUBLIC_URL']);

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
  const clientIds = await scheduleKnownDownloadClients(host, raw);

  const server = await (deps.createReadServer ?? createReadServer)({
    raw,
    pluginIdForType,
    host: readHost,
    port,
    // Built from the address the listener bound rather than here, because
    // `baseURL` has to be the origin requests arrive at and `port` may be 0 --
    // see `ReadServerDeps.authFor`.
    //
    // **`PICKARR_PUBLIC_URL` wins over the bound address when it is set**, and
    // it has to: behind a reverse proxy the origin a browser reaches is the
    // proxy's, not this listener's, and Better Auth refuses every
    // state-changing request whose `Origin` is neither `baseURL` nor a trusted
    // origin (the auth slice's §2, measured). It is passed as `publicUrl` as
    // well, so `trustedOrigins` names it too and `createAuth` knows it does
    // not need to warn about a deployment that has told it nothing.
    //
    // **The secret is never logged**, here or anywhere it travels; it is
    // decided by `resolveAuthSecret` above -- `BETTER_AUTH_SECRET` when the
    // operator set it, else the row `ensureAuthSecret` generates once and
    // persists -- so the host boots configured either way. Read per
    // construction rather than once at the top of `main`, on the same
    // reasoning as `baseURL`: this closure is what the listener calls, and
    // there is exactly one instance per process.
    authFor: (baseURL) => createAuth({
      raw,
      db,
      secret: resolveAuthSecret(process.env['BETTER_AUTH_SECRET'], raw, Date.now()),
      baseURL: publicUrl ?? baseURL,
      publicUrl,
      log,
    }),
    log,
  });

  const shutdown = createShutdown(host, raw, server);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(`${signal} received`);
    });
  }

  log(
    `running: database ${databasePath}, artwork ${artworkDir}, `
    + `read api on http://${server.host}:${server.port}, `
    + `${recovered} job(s) recovered, ${feedIds.length} feed(s) scheduled, `
    + `${clientIds.length} download client(s) scheduled`,
  );

  // Last, and only while there is something to claim -- see the order above.
  // `isClaimed` is asked first so a claimed install neither prints a token nor
  // mints one: `ensureClaimToken` would happily write a fresh row on an
  // install whose token was spent months ago, and printing that row would be
  // printing a credential for an account that already exists.
  if (!isClaimed(raw)) {
    log(
      'this install is unclaimed: the first sign-up must carry claim token '
      + `${ensureClaimToken(raw, Date.now())} -- it is single-use, spent only by a sign-up that `
      + 'succeeds, so a refused attempt leaves it usable, and it is printed on every boot until '
      + 'an account exists',
    );
  }
}
