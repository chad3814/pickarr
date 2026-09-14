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
import type { DownloadClients, MediaPlugin } from '@pickarr/contract';
import { API_KEY_SECRET } from '@pickarr/openmetadata';
import { createMoviePlugin } from '@pickarr/plugin-movie';
import { createTvPlugin } from '@pickarr/plugin-tv';
import { createXxxPlugin } from '@pickarr/plugin-xxx';
import type { ReadServer, ReadServerDeps } from './api/server.ts';
import { createReadServer } from './api/server.ts';
import { ensureClaimToken, isClaimed } from './auth/claim.ts';
import { createAuth } from './auth/instance.ts';
import { createDownloadClients } from './clients/downloads.ts';
import { createSecrets } from './secrets/instance.ts';
import type { Secrets } from './secrets/instance.ts';
import type { Config } from './config/instance.ts';
import { openConfig } from './config/instance.ts';
import { DEFAULT_CONFIG_PATH, databaseConfigSchema, secretsConfigSchema, serverConfigSchema } from './config/schemas.ts';
import { ensureAuthSecret } from './db/host-state.ts';
import { migrateHost } from './db/migrate.ts';
import { openDatabase } from './db/open.ts';
import { createHostFetch } from './fetch/queue.ts';
import { createHost } from './host.ts';
import type { Host } from './host.ts';
import type { Timers } from './jobs/dispatcher.ts';
import { assertOriginOnly } from './origin.ts';
import { envNameFor } from './secrets/names.ts';
import { createSyncRegistry } from './sync/registry.ts';

/**
 * A log line's structured half, as `key=value` pairs.
 *
 * Every value goes through `String`, and that is the safety property rather
 * than a formatting preference: `String` of a row, a config or any other
 * object is `[object Object]`, so a caller that broke the rule against
 * logging one could not spill its contents through here even by accident.
 *
 * **Six call sites pass a detail today, and their values are not all
 * strings.** `api/server.ts` has two (`read failed`, `read response
 * failed`), whose `error` has already been through `redactUrl`;
 * `clients/downloads.ts` has four, all sharing one
 * `{rssItemId: number, downloadClientId: number, kind: string}` -- `main`'s
 * `log` is handed to `createDownloadClients` as well as to the read server.
 * So `String` here is load-bearing for numbers as much as for objects. (The
 * `log` that `clients/reconcile.ts`, `clients/deliver.ts` and
 * `artwork/store.ts` call is `host.ts`'s `hostLog`, which does not come
 * through this function at all.)
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
 * the config file this slice adds (`config/schemas.ts`) has no `artwork`
 * namespace, and feeds are seeded rows rather than config (slice B's spec,
 * `docs/superpowers/specs/2026-09-03-feed-reader-artwork-design.md` §1.1),
 * so nothing could ever supply one. Cited as the spec, because no plan in
 * this repo has numbered sections -- slice B's plan has an unnumbered
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
 * The plugins the shipped process runs with.
 *
 * A function rather than a const, because each plugin needs `now`, the base
 * url and the secret resolver injected -- and because nothing in this module
 * may run at module scope. `main` calls it; a test passes `deps.plugins`
 * instead and never reaches it.
 *
 * Three plugins, three media types, three wire categories. `createPluginIdForType`
 * in `host.ts` refuses two plugins claiming one media type, so this list
 * cannot grow a duplicate unnoticed.
 */
export function shippedPlugins(deps: {
  now: () => number;
  resolveSecret: Secrets['get'];
  baseUrl: string;
}): readonly MediaPlugin[] {
  return [createTvPlugin(deps), createMoviePlugin(deps), createXxxPlugin(deps)];
}

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
 * The port the read API listens on, once `resolveSettings` has already
 * decided the operator set `PICKARR_READ_API_PORT` to something: this
 * validates that string and nothing else. **It carries no default of its
 * own** -- `config/schemas.ts`'s `serverConfigSchema` does, and
 * `resolveSettings` reaches for that (via the config file's `server`
 * namespace) when the variable is unset, so this function is called only
 * when there is a string to validate. A default in both places is one that
 * could disagree with itself; `schemas.test.ts` asserts the one that remains.
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
export function resolveReadPort(configured: string): number {
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
 * The interface the read API binds, once `resolveSettings` has already
 * decided the operator set `PICKARR_READ_API_HOST` to something: this is
 * that string, unchanged.
 *
 * **The default is not this function's to carry.** `config/schemas.ts`'s
 * `serverConfigSchema` holds the one copy (`0.0.0.0`, applied via the
 * config file's `server` namespace), and `resolveSettings` reaches for it
 * when the variable is unset -- so this function decides nothing beyond
 * "the operator set a value, and here it is."
 *
 * Nothing is validated beyond that: what can be bound is the listener's
 * question, and `createReadServer` already rejects a bind that fails rather
 * than leaving a process that looks started and serves nothing.
 *
 * Takes the variable's value rather than reading `process.env` itself, so it
 * is testable without mutating the environment the whole process shares.
 */
export function resolveReadHost(configured: string): string {
  return configured;
}

/**
 * `PICKARR_PUBLIC_URL`: the externally reachable origin, for a host behind a
 * reverse proxy. `undefined` when unset or empty, which is the ordinary case
 * -- no proxy, and the address the listener bound is the origin.
 *
 * **Refused at boot when it is not a bare origin**, rather than carried into
 * `baseURL`, because the failure it would otherwise cause is both silent and
 * total: Better Auth compares every state-changing request's `Origin` against
 * `baseURL` (the auth slice's §2, measured), so a malformed value refuses
 * every sign-in with a 403 whose reason appears in no log -- on the slice
 * where a session is the only thing protecting this socket. The checks
 * themselves -- what counts as an origin, what a path/query string/fragment
 * does to Better Auth's mount, why a trailing slash is not a path, and why no
 * failure names the value -- live in `origin.ts`'s `assertOriginOnly`, which
 * this variable shares with the config file's `server.publicUrl`
 * (`config/schemas.ts`): one function both callers refuse the same value
 * through, rather than two copies that could drift.
 *
 * The value is returned as it was written rather than normalized, which after
 * `assertOriginOnly` means at most a trailing slash. Better Auth compares
 * origins, and `auth/instance.ts`'s `publicOrigin` is what reduces that to an
 * origin -- in the one place that does the comparing.
 */
export function resolvePublicUrl(configured: string | undefined): string | undefined {
  if (configured === undefined || configured === '') return undefined;
  assertOriginOnly(configured, 'PICKARR_PUBLIC_URL');
  return configured;
}

/** Every value the boot needs from the environment and the config file, with the environment winning. */
export interface HostSettings {
  readHost: string;
  port: number;
  publicUrl: string | undefined;
  databasePath: string;
  secretsBaseDir: string;
  /** Where the lookup plugins ask. See {@link resolveOpenmetadataUrl}. */
  openmetadataUrl: string;
  config: Config;
}

/**
 * The value an operator actually set, or `undefined` for one they did not.
 *
 * Empty and unset are the same thing, for **every** variable `main` reads --
 * not just `publicUrl`, which was the only one that used to apply this rule.
 * A compose file that declares a key with no value passes exactly an empty
 * string, and "the operator configured emptiness" is never what that means.
 * Measured on this Node, for the interface case specifically:
 *
 *     listen(port, '')        -> address '::'       family IPv6
 *     listen(port, '0.0.0.0') -> address '0.0.0.0'  family IPv4
 *     listen(port, undefined) -> address '::'       family IPv6
 *
 * so an empty `PICKARR_READ_API_HOST` reaching the listener unchanged binds
 * the IPv6 wildcard where `0.0.0.0` is documented -- silently, on a
 * different address family, for a variable the operator never meant to set.
 * Checking only `=== undefined` would also make an empty
 * `PICKARR_READ_API_PORT` throw (`resolveReadPort` validates digits, and
 * `''` has none) instead of falling back, an empty `PICKARR_DATABASE`
 * resolve to an empty path instead of the file's or the schema's, and an
 * empty `PICKARR_CONFIG` mean "there is no config file" instead of "use the
 * default one" -- which was this rule's own first defect, because it was
 * written per variable at four call sites and the fifth was missed.
 *
 * **One function, every variable.** Do not inline `?? default` or
 * `=== undefined` for a new variable: a rule that differs by variable is the
 * shape that produced this twice.
 */
function configuredEnvValue(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * Which file `resolveSettings` reads: `PICKARR_CONFIG`, else
 * {@link DEFAULT_CONFIG_PATH}.
 *
 * Separate from `resolveSettings` because it is the one of the five
 * variables whose effect is not observable in the returned settings -- an
 * empty `PICKARR_CONFIG` used to reach `readFile('')`, which rejects
 * `ENOENT`, which `readConfigDocument` correctly reads as "no file on a
 * first boot". So the config file was ignored in its entirety, the database
 * was opened wherever the *default* said rather than where `database.path`
 * pointed, `migrateHost` ran against that other file, and the host booted
 * clean on an empty library with nothing logged as wrong. Exported so that
 * decision has a test of its own, the way `resolveReadPort` and
 * `resolveReadHost` do.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  return configuredEnvValue(env['PICKARR_CONFIG']) ?? DEFAULT_CONFIG_PATH;
}

/**
 * Environment, then config file, then the schema's default.
 *
 * The environment has to keep winning: every deployment that exists today
 * sets these variables and nothing else, so a file that overrode them would
 * change a running install on upgrade. The schema carries the default, and
 * the resolvers below only validate a string an operator actually set --
 * a default in both places is one that can disagree with itself.
 *
 * All five variables this function reads go through {@link
 * configuredEnvValue}, so "empty is unset" is decided once rather than per
 * variable. `BETTER_AUTH_SECRET` is `main`'s sixth and does not come through
 * here -- it has no config-file counterpart to fall back to -- but it goes
 * through the same {@link configuredEnvValue} at its own call site, in
 * `main` itself.
 */
export async function resolveSettings(env: NodeJS.ProcessEnv): Promise<HostSettings> {
  const config = await openConfig({ path: resolveConfigPath(env) });
  const server = config.register('server', serverConfigSchema);
  const database = config.register('database', databaseConfigSchema);
  const secrets = config.register('secrets', secretsConfigSchema);

  const portRaw = configuredEnvValue(env['PICKARR_READ_API_PORT']);
  const hostRaw = configuredEnvValue(env['PICKARR_READ_API_HOST']);
  const publicUrlRaw = configuredEnvValue(env['PICKARR_PUBLIC_URL']);
  const databasePathRaw = configuredEnvValue(env['PICKARR_DATABASE']);
  const openmetadataUrlRaw = configuredEnvValue(env['PICKARR_OPENMETADATA_URL']);

  return {
    readHost: hostRaw === undefined ? server.current.host : resolveReadHost(hostRaw),
    port: portRaw === undefined ? server.current.port : resolveReadPort(portRaw),
    publicUrl: publicUrlRaw === undefined ? server.current.publicUrl : resolvePublicUrl(publicUrlRaw),
    databasePath: databasePathRaw ?? database.current.path,
    secretsBaseDir: secrets.current.baseDir,
    openmetadataUrl: resolveOpenmetadataUrl(openmetadataUrlRaw),
    config,
  };
}

/** The lookup service's origin when nothing says otherwise. */
const DEFAULT_OPENMETADATA_URL = 'https://openmetadata.nexus';

/**
 * `PICKARR_OPENMETADATA_URL`: where the lookup service lives, for a test
 * deployment or a proxy. The default is the real service.
 *
 * **Refused at boot when it is not a bare http origin**, on the same
 * reasoning as `resolvePublicUrl`: the plugins append `/api/v1/lookup` to
 * this, so a value carrying a path builds a url nobody configured, and a
 * value that is not a url at all fails every lookup job with a message about
 * `fetch` rather than about configuration. A trailing slash is trimmed rather
 * than refused -- it is what an operator types, and it changes nothing.
 *
 * **No failure below names the value**, exactly as `resolvePublicUrl` above
 * documents in bold and for a sharper reason than that one has: a url may
 * carry userinfo, so `PICKARR_OPENMETADATA_URL=https://svc:s3cret@proxy/api`
 * would print a credential into the boot log -- on the slice whose headline
 * invariant is that the lookup key is never logged. The message names the
 * variable and the rule it broke, which is all the operator needs.
 *
 * **Userinfo is refused rather than dropped.** `parsed.origin` discards it
 * silently, so an operator who put credentials in the url would get a host
 * that booted cleanly and then answered 401 to every lookup, with nothing
 * anywhere connecting the two. This host authenticates to the service with
 * the resolver's key and by no other means; a url that carries one is a
 * misconfiguration, and saying so at boot is the only outcome that gets it
 * fixed.
 *
 * Takes the variable's value rather than reading `process.env` itself, so it
 * is testable without mutating the environment the whole process shares.
 */
export function resolveOpenmetadataUrl(configured: string | undefined): string {
  if (configured === undefined || configured === '') return DEFAULT_OPENMETADATA_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('PICKARR_OPENMETADATA_URL is not a url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PICKARR_OPENMETADATA_URL is not an http or https url');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'PICKARR_OPENMETADATA_URL must carry no username or password: userinfo in this url would be '
      + `dropped rather than sent, and the lookup key is set through ${envNameFor(API_KEY_SECRET)}`,
    );
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('PICKARR_OPENMETADATA_URL must be an origin with no path, query string or fragment');
  }
  return parsed.origin;
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
 * **An empty variable is an unset one, same as every other variable `main`
 * reads** -- but that rule is not this function's own anymore. Its caller
 * passes `configuredEnvValue(process.env['BETTER_AUTH_SECRET'])`, so `''`
 * has already become `undefined` by the time it reaches here: `configured`
 * means "the value an operator actually set", exactly {@link
 * configuredEnvValue}'s own contract, and this function trusts it rather
 * than checking `=== ''` a second time. This function used to carry that
 * check itself, alongside {@link configuredEnvValue}'s -- two copies of the
 * same rule, which is the shape {@link configuredEnvValue}'s own doc names
 * as the thing to avoid, because a rule written twice is a rule that can be
 * fixed in one copy and left broken in the other.
 *
 * Takes the variable's value rather than reading `process.env` itself, so the
 * precedence is testable without mutating the environment the whole process
 * shares -- and so the plural `BETTER_AUTH_SECRETS`, which the library reads
 * on its own and which this function has no part in, stays the library's
 * business (§6 documents it).
 */
export function resolveAuthSecret(configured: string | undefined, raw: DatabaseSync, at: number): string {
  if (configured !== undefined) return configured;
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
 *    the auth slice's §3 asks for it on every boot ("stored in `host_state`,
 *    cleared once claimed, and re-printed on every boot while the install is
 *    still unclaimed"), which is why it is a property of `isClaimed` rather
 *    than of having just generated a token. Cited as §6 here until the
 *    whole-branch review checked it: §6 is the configuration table and says
 *    nothing about the claim token.
 *    It is also the **one place anything prints the token**, and nothing
 *    anywhere prints the signing secret.
 *
 * `argv` is accepted for parity with a conventional process entry point;
 * this slice has no argument surface beyond `resolveSettings`'s environment
 * variables (`PICKARR_CONFIG`, `PICKARR_DATABASE`, `PICKARR_READ_API_PORT`,
 * `PICKARR_READ_API_HOST`, `PICKARR_PUBLIC_URL`), the lookup plugins'
 * `PICKARR_OPENMETADATA_URL` (the lookup key reaches the plugins through the
 * secret store, not through a variable this module reads), and
 * `BETTER_AUTH_SECRET`, so nothing here reads it. `BETTER_AUTH_SECRETS`, the
 * plural, is read by the library itself and by nothing in this package; the
 * auth slice's §6 documents both.
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


  // Config path from `PICKARR_CONFIG` (default `DEFAULT_CONFIG_PATH`) →
  // config file → database path → database handle → secrets (`raw` plus
  // `baseDir`). Config never depends on secrets, so there is no cycle
  // (design spec §6.6) -- and `settings.databasePath` is why the file must
  // be read before `openDatabase` rather than after.
  const settings = await resolveSettings(process.env);
  const { raw, db } = openDatabase(settings.databasePath);
  migrateHost(raw);

  const secrets = createSecrets({ raw, baseDir: settings.secretsBaseDir });

  // **After the store, not before it.** Two plugins claiming one media type
  // is a configuration error and `createPluginIdForType` is what refuses it,
  // so this used to run before the database was opened -- the earliest
  // refusal touches least on its way out. It cannot any more: a plugin is
  // handed `secrets.get`, and the store's chain ends at the `secret` table,
  // so it does not exist until there is a connection to build it on. The
  // refusal now lands after the schema is migrated and before anything is
  // registered or polled, which is the earliest point that still has a
  // resolver to hand.
  const plugins = deps.plugins ?? shippedPlugins({
    now: () => Date.now(),
    // The store's own `get`, passed as the means of obtaining the key and
    // never the key itself. It resolves per request, through the chain the
    // store owns -- environment, then the secrets directory, then the
    // `secret` table -- so nothing here decides where the credential lives.
    resolveSecret: secrets.get,
    baseUrl: settings.openmetadataUrl,
  });
  const pluginIdForType = createPluginIdForType(plugins);

  // Asked once, at boot, and only when the three real plugins were built --
  // a caller that injected its own has nothing to authenticate.
  //
  // §2.3 resolves the credential per request and that stands; what it never
  // weighed is that per-request resolution alone means a deployment with no
  // key configured boots perfectly, logs `running:`, schedules every feed,
  // and then dead-letters every lookup job minutes later, with the diagnosis
  // in a job row rather than on the console.
  //
  // Asked **through the store** rather than by reading one variable, because
  // the store is what decides where a credential may come from: an operator
  // who put the key in the secrets directory or the `secret` table is
  // configured correctly, and a check that only knew about the environment
  // would warn at them anyway. The resolved value is discarded unread and
  // never bound to anything -- what is wanted here is whether the chain can
  // answer, not what it answers with, and the line below names the variable
  // rather than the value.
  //
  // A warning, not a refusal: a host serving reads with one plugin
  // misconfigured is the right behaviour, and it is the operator who needs
  // telling, not the process that needs stopping.
  if (deps.plugins === undefined) {
    try {
      await secrets.get(API_KEY_SECRET);
    } catch {
      log(
        `no ${API_KEY_SECRET} is configured (set ${envNameFor(API_KEY_SECRET)}, or store it): the `
        + 'tv, movie and xxx plugins will fail every lookup until one is, leaving each new feed '
        + 'item unidentified with its job dead-lettered',
      );
    }
  }
  const artworkDir = resolveArtworkDir(settings.databasePath);
  const fetch = createHostFetch({ fetch: globalThis.fetch });
  // A factory, not a built object: `createHost` supplies the `Secrets` it
  // will also give the reconcile handler, so the two cannot be different
  // instances. See `createHost`'s own `downloads` doc for why that matters.
  const downloads = (hostSecrets: Secrets): DownloadClients =>
    createDownloadClients({ raw, fetch, secrets: hostSecrets, now: () => Date.now(), log });

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
      secrets,
      now: () => Date.now(),
      artworkDir,
    })
    : createHost({
      raw,
      db,
      fetch,
      downloads,
      secrets,
      now: () => Date.now(),
      artworkDir,
      timers: deps.timers,
    });

  for (const plugin of plugins) host.register(plugin);

  // After every `register`, never before: `createSyncRegistry` checks each
  // declared table's primary key against the real schema
  // (`assertIntegerIdKey`), and a plugin's own tables do not exist until its
  // migrations have run inside `register` above.
  const registry = createSyncRegistry(raw, plugins);

  const recovered = host.start();
  const feedIds = scheduleKnownFeeds(host, raw);
  const clientIds = await scheduleKnownDownloadClients(host, raw);

  const server = await (deps.createReadServer ?? createReadServer)({
    raw,
    pluginIdForType,
    registry,
    host: settings.readHost,
    port: settings.port,
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
    // decided by `resolveAuthSecret` above, from `BETTER_AUTH_SECRET` run
    // through `configuredEnvValue` first -- so an empty variable reaches it
    // as `undefined`, same as the other five -- else the row
    // `ensureAuthSecret` generates once and persists -- so the host boots
    // configured either way. Read per construction rather than once at the
    // top of `main`, on the same reasoning as `baseURL`: this closure is
    // what the listener calls, and there is exactly one instance per
    // process.
    authFor: (baseURL) => createAuth({
      raw,
      db,
      secret: resolveAuthSecret(configuredEnvValue(process.env['BETTER_AUTH_SECRET']), raw, Date.now()),
      baseURL: settings.publicUrl ?? baseURL,
      publicUrl: settings.publicUrl,
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
    `running: database ${settings.databasePath}, artwork ${artworkDir}, `
    + `lookups to ${settings.openmetadataUrl}, `
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
