/**
 * The read API on a socket: `node:http`, ten routes -- eight behind a
 * session and two open (`/api/health` and the static bundle) -- bound by
 * default to every interface.
 *
 * The split is spelled out because the line that used to stand here said "six
 * routes behind a session", which the paragraph on the guard below -- and
 * `ROUTES` itself, where exactly two entries are `open: true` -- contradicts.
 * A one-line summary disagreeing with its own file is the whole class of
 * defect the comments here are written against. (The count grew to eight
 * when the client-sync slice added `/api/sync` and `/api/sync/backfill`, to
 * nine when it added `/api/sync/bootstrap`, and to ten when the shell slice
 * added the static route -- guarded like the other eight except `/api/health`
 * and that one; the shape of the sentence is what matters and has not
 * changed.)
 *
 * Everything this file does is routing. Parse a request, call one function
 * from `./reads.ts`, `./artwork-route.ts` or `./static-route.ts`, write what
 * came back.
 *
 * **No SQL here.** Every read is a `reads.ts` call, so the keyset predicates,
 * the page size and the plan-tested statements live in one module with one
 * set of tests over them, rather than being restated by whatever happens to
 * be answering a request. A query written here would also be a query no
 * `EXPLAIN QUERY PLAN` test covers.
 *
 * **Nothing here imports `host.ts`.** The media route needs to know which
 * plugin owns a media type, and `host.ts` owns that registry -- so the
 * mapping arrives as a *function*, `pluginIdForType`, built by `main` from
 * the plugin list it already holds. Importing the registry instead would put
 * `src/api` in a cycle with `host.ts`, and slice D spent real time breaking
 * two of those.
 *
 * **No response body this file composes carries a url, a path or a query
 * string.** A thrown error becomes a 500 with a fixed message; the thrown
 * message goes through `redactUrl` on its way to the log and never into the
 * response at all. The one caller-supplied value any body repeats is a media
 * type, which the brief requires an unknown type to name -- and `MEDIA_TYPE`
 * below is what keeps that from becoming a way to get a path echoed back.
 *
 * **The auth dispatch's bodies are not this file's, and two of them do carry
 * urls.** That sentence was once unqualified, and `handle` now forwards
 * `/api/auth/*` to `toNodeHandler` ahead of everything, so it has to be
 * scoped. Measured: anonymously, `GET /api/auth/error?error=…` renders a
 * **9,302-byte HTML page** carrying `https://better-auth.com/docs/reference/
 * errors/<error>` **twice** (a plain `href` and an `?askai=` variant) and
 * echoing the caller's own `error` parameter into both -- gated on
 * `/^['A-Za-z0-9_-]+$/`, so anything else becomes `UNKNOWN`, which is why it
 * is garbled markup at worst and not reflected XSS (the library escapes and
 * `encodeURIComponent`s it; a `"><svg/onload=…>` payload does not appear in
 * the body in any form). With `NODE_ENV=production` -- which the Dockerfile's
 * runtime stage sets, and which the library reads at module load, so a probe
 * that set it later could not see this -- the same route answers **302** with
 * an empty body instead. `GET /api/auth/callback/:id` is **302** either way,
 * and every one of those redirects carries a url *and* a query string in its
 * `Location` header (`…/api/auth/error?error=state_not_found`).
 *
 * None of that is a credential and none of it is this host's own urls: it is
 * the library's documentation links plus a caller-supplied code echoed back to
 * that same caller. It is recorded rather than suppressed because the
 * constraint is about bodies this repo emits, and the module doc had stopped
 * being true of the responses that leave this socket.
 *
 * **Every route requires a session except `/api/health` and the static
 * bundle.** Slice E shipped this API unauthenticated, with loopback binding
 * as the whole of the protection; the auth slice's §5 closes it -- and its
 * §6 then reverses the bind, so a session is not the second of two defences
 * but the only one (see `DEFAULT_HOST`). The guard is `refusalFor` below, and
 * it tests the *value* `auth.api.getSession` resolves to, never a status
 * code -- an unauthenticated session check answers `200` with a body of
 * `null` (that slice's §2, measured against better-auth 1.7.3), so a guard
 * written against the status lets every anonymous caller through. Health
 * stays open so a container health check needs no credential; the static
 * route (the shell slice's Task 1) stays open for a different reason -- it
 * is the same bytes for every caller, and it is what a browser has to load
 * before it can render a sign-in form at all, so guarding it would make
 * signing in impossible rather than merely inconvenient. Those are the only
 * two: *which* routes are open is a property of `ROUTES` below rather than
 * of a list written anywhere else, and the tests enumerate that table so a
 * route added later is guarded or the test fails.
 *
 * **The guard is taken in `handle`, ahead of the router.** A table can only
 * speak for the routes in it, and a route mounted beside the auth dispatch is
 * not in it -- measured, by mounting one there and watching all 22 tests
 * pass. Guarding before routing is what makes the next mount inherit the
 * guard by construction.
 *
 * **`/api/auth/*` is dispatched before the guard**, by `toNodeHandler`. It
 * has to be: the route that issues a session cannot require one.
 *
 * **What the session now protects is not only "the library".**
 * `/api/rss-items` serves `RssItemRead.link` unredacted, which for a private
 * tracker or indexer *is* a credential -- it carries the passkey. Behind the
 * guard that, plus every download's `clientRef`, `infohash` and `lastError`,
 * plus artwork bytes for any media item id, plus every media item of every
 * type, is reachable by a session holder and by nobody else. It is still all
 * reachable *to* a session holder: `?type=` is how a caller picks a plugin,
 * not a check on which one it may have, and the `MediaReader` scoping in
 * `../media/reader.ts` is a boundary between plugins inside the process that
 * says nothing about this socket. Auth changed who can read it, not what is
 * served.
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Auth } from '../auth/instance.ts';
import { redactUrl } from '../clients/redact.ts';
import type { SyncRegistry } from '../sync/registry.ts';
import type { ArtworkKind, ArtworkResponse } from './artwork-route.ts';
import { readArtwork } from './artwork-route.ts';
import { decodeCursor, decodeUnionCursor } from './cursor.ts';
import { deletionsSince, downloadsSince, mediaItemsSince, rssItemsSince } from './reads.ts';
import type { StaticResponse } from './static-route.ts';
import { isApiPath, staticAnswer } from './static-route.ts';
import { backfillAnswer, bootstrapAnswer, syncAnswer } from './sync-route.ts';

/**
 * The port the shipped process listens on when `PICKARR_READ_API_PORT` says nothing.
 * 8787 rather than 1.x's 8080 so a 2.0 host and a 1.x install can run on one
 * machine without either having to be told a port.
 */
export const DEFAULT_PORT = 8787;

/**
 * The read API's own contract version, as `/api/health` reports it -- not the
 * package version.
 *
 * A client polls this to know whether the routes and shapes it was written
 * against are the ones being served, and that question is answered by the
 * *API's* compatibility, not by the release number of the process: a patch
 * release changes the second and must not change the first. Reading
 * `package.json` at runtime was the alternative and is worse in both
 * directions -- it is a filesystem read that can fail, and it would report a
 * number that moves for reasons no client cares about.
 */
export const API_VERSION = 1;

/**
 * Every interface, and the default the shipped process binds when
 * `PICKARR_READ_API_HOST` says nothing.
 *
 * **This reverses slice E's loopback bind, deliberately.** That slice bound
 * `127.0.0.1` and argued for it, on the grounds that the API was
 * unauthenticated and the bind was therefore the whole of its access control.
 * It is not any more: every route but the health check requires a session
 * (see the module doc), and a host reachable only from the machine it runs on
 * cannot serve the client it exists for. The auth slice's §6 configures the
 * interface and its §8 records the consequence in the plainest terms it has
 * -- a session is now the *only* boundary rather than the second of two, so a
 * session-handling defect or a weak password is exposed to whatever network
 * this host sits on.
 *
 * A parameter now, because something has asked to bind something else:
 * `ReadServerDeps.host` overrides this, and that is what
 * `PICKARR_READ_API_HOST` reaches.
 */
export const DEFAULT_HOST = '0.0.0.0';

/**
 * A listening read API.
 *
 * `host` and `family` are read back from `server.address()` rather than
 * echoed from what was asked for, and they are on this interface for a
 * reason the brief's shape did not have room for: what a listener bound is
 * only testable by asserting *what the listener bound*. A test that instead
 * probed an interface would prove nothing either way -- finding nothing on an
 * external interface passes on a machine with no route to it, and finding
 * something asserts the machine's routing table rather than this bind. That
 * reasoning is slice E's, from when the expected value was loopback, and it
 * survives the default having been reversed: only the value changed.
 */
export interface ReadServer {
  /** The address the listener actually bound -- `DEFAULT_HOST`, unless `ReadServerDeps.host` asked for another. */
  host: string;
  /** The port it actually bound, which is the assigned one when 0 was asked for. */
  port: number;
  /** Its address family, so an IPv6 wildcard cannot pass for the IPv4 one. */
  family: string;
  /**
   * Stops the listener. Does **not** drain in-flight requests: open
   * connections are dropped and the promise resolves without waiting for
   * either the drain or the socket teardown. The same choice `Host.stop()`
   * makes about in-flight jobs, for the same reason -- an abandoned read
   * costs a client one retry, and waiting on readers is exactly the coupling
   * the job slice removed.
   *
   * Idempotent. A second call does nothing, rather than asking node to close
   * a server that is not listening -- which, with no callback to hand the
   * resulting `ERR_SERVER_NOT_RUNNING` to, emits an unhandled `'error'` event
   * and takes the process down.
   */
  close(): Promise<void>;
}

/** What `createReadServer` needs, and nothing else it could reach for. */
export interface ReadServerDeps {
  raw: DatabaseSync;
  /**
   * The plugin owning a media type, or `undefined` for a type nothing claims.
   * A function rather than a table because the registry is `host.ts`'s -- see
   * the module doc.
   */
  pluginIdForType: (type: string) => string | undefined;
  /**
   * Host tables plus every plugin's declared tables, as one lookup --
   * `sync/registry.ts`'s `createSyncRegistry(raw, plugins)`. What `/api/sync`
   * and `/api/sync/backfill` read current state through; see `sync-route.ts`.
   *
   * Built by `main`, from the same plugin list `pluginIdForType` is built
   * from, and passed in rather than reached for here -- `createSyncRegistry`
   * is `sync/registry.ts`'s, not `host.ts`'s, but importing it from
   * `src/api` directly would still mean two independent constructions of the
   * same lookup, from the same list, on every boot. One construction, held
   * here, is what keeps them from ever disagreeing about what a plugin
   * declared.
   */
  registry: SyncRegistry;
  /**
   * This database's sync generation, on the body of all three sync routes and
   * on none of the others -- `db/host-state.ts`'s `ensureSyncGeneration`, and
   * `sync-route.ts`'s `GenerationDeps` for what a client does with it.
   *
   * **Resolved once by `main` and held here, not read per request.** It
   * cannot change while this process holds the database open -- it is minted
   * on first read and persisted, and a value that changed would mean a
   * different database -- so reading it per request would be one query per
   * sync request for a constant a client polls for.
   *
   * A `string` and not the reader itself, for the same reason: there is
   * nothing here to defer. `authFor` is a function because `baseURL` is not
   * known until the listener has bound; this is known before it.
   */
  generation: string;
  /**
   * The interface to bind, or `undefined` for `DEFAULT_HOST`.
   *
   * **`main` no longer passes `undefined` here.** `HostSettings.readHost`
   * (`main.ts`'s `resolveSettings`) is typed as a plain `string`: an unset
   * `PICKARR_READ_API_HOST` now resolves through the config file's `server.host`
   * and, absent that, `serverConfigSchema`'s own default -- which is this
   * same value, `'0.0.0.0'`, carried in exactly one place. `undefined`
   * remains a legal value on this type for any other caller that wants the
   * listener's own default without naming it (a test, for instance); it is
   * simply not one `main` reaches for any more.
   *
   * Required-but-nullable rather than optional: `exactOptionalPropertyTypes`
   * is on, so an optional property would make "absent" and "explicitly
   * undefined" two different things for a caller forwarding a value it read
   * from the environment, and there is only one thing they could mean here.
   */
  host: string | undefined;
  /** 0 asks the kernel for a free port, which `ReadServer.port` then reports. */
  port: number;
  /**
   * The built bundle's own directory, as `static-route.ts`'s `staticAnswer`
   * reads it -- `server.webRoot`, already resolved to a concrete string.
   *
   * `main` never passes an absent value here, the same way it no longer
   * passes one for `host`: `HostSettings.webRoot` derives a default (`web`
   * beside the host's own `dist`) when the config file names none, so this
   * is always a real path to try, even on a development host where that
   * derived path does not exist -- see `warnIfWebRootMissing`, which `main`
   * calls once at boot precisely because this field cannot say "there is no
   * bundle" on its own. A required `string` rather than `string | undefined`
   * for the same reason `generation` below is a plain `string`: nothing here
   * would do anything useful with an absent value that `staticAnswer`'s own
   * graceful fallback does not already do with a present-but-wrong one.
   */
  webRoot: string;
  /**
   * Better Auth, built **from the origin the listener actually bound**.
   *
   * A function rather than an instance because of an ordering constraint the
   * auth slice's §2 measured: Better Auth refuses every state-changing request
   * whose `Origin` is not `baseURL`'s, so the reachable address has to be known
   * before `betterAuth()` is constructed -- and with `port: 0` it is not known
   * until the listener has bound. So `createReadServer` listens first, reads
   * `server.address()`, and calls this back with `http://<host>:<port>`.
   *
   * That is not a test artifact. Production has the same problem in the same
   * order, and solves it the same way; what production adds is that `main`
   * prefers `PICKARR_PUBLIC_URL` over the address passed here when the host is
   * behind a proxy, which is a decision for the caller of this rather than for
   * the listener.
   */
  authFor: (baseURL: string) => Auth;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * What a route answers, before anything is written to a socket.
 *
 * Three shapes because artwork and the static bundle are the two routes that
 * do not answer JSON, and each already returns a status/headers/body triple
 * of its own (`ArtworkResponse`, `StaticResponse`) that this module has no
 * business reinterpreting. Keeping routing separate from writing is what
 * lets every route be a function of its request.
 */
type Answer =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'artwork'; artwork: ArtworkResponse }
  | { kind: 'static'; file: StaticResponse };

function json(status: number, body: unknown): Answer {
  return { kind: 'json', status, body };
}

/** The fixed 404 every unrecognised path and every unparseable one answers. */
const UNKNOWN_ROUTE = json(404, { error: 'unknown route' });

/**
 * The fixed 401 every guarded route answers a caller with no session.
 *
 * One sentence, carrying no url, path or query string -- the same discipline
 * the 500 below follows, and for the same reason: the request that was
 * refused is the request of someone who has not identified themselves, so
 * nothing derived from it may be echoed back. It does not say *why* either;
 * an expired session and no session at all are the same answer, because a
 * client's only useful response to both is to sign in again.
 */
const UNAUTHORIZED = json(401, { error: 'unauthorized' });

/**
 * What a media type may look like for an unknown one to be named back at the
 * caller.
 *
 * The `/api/media` and `/api/deletions` routes are required to answer an
 * unknown type by naming it, and the type is a value the caller chose -- so
 * without this, `?type=/etc/passwd` or `?type=x?apikey=k` would be a way to
 * get a path or a query string into a response body, which is the one thing
 * no body here may carry. A real media type is a short word (`movie`,
 * `show`, `scene`); anything outside that is refused *without* being
 * repeated, so the rule holds for every possible input rather than for the
 * inputs that were thought of.
 */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** An artwork id, as a path segment: digits only, so nothing else reaches a query parameter. */
const DIGITS = /^\d+$/;

/**
 * Only `readArtwork`'s two filesystem calls, and the real ones -- the async
 * `node:fs/promises` pair, never the `*Sync` twins: this server shares its
 * event loop with the job dispatcher, and a synchronous read of a poster
 * would stall every job and every other request with it.
 *
 * At module scope rather than built per request or per server: it closes over
 * nothing, and `unicorn(consistent-function-scoping)` is right that a
 * function which captures nothing does not belong inside another.
 */
const ARTWORK_FILES = {
  readFile,
  stat: async (path: string): Promise<{ mtimeMs: number; size: number }> => {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  },
};

/**
 * `staticAnswer`'s pair, on the same reasoning as `ARTWORK_FILES` -- real,
 * async, never the `*Sync` twins, and a separate object rather than the same
 * one because these serve the built bundle, not artwork, even though the
 * wrapped calls happen to be identical.
 */
const STATIC_FILES = {
  readFile,
  stat: async (path: string): Promise<{ mtimeMs: number; size: number }> => {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  },
};

/**
 * The base a request target is resolved against. A request line carries a
 * path, not an absolute url, and `new URL` needs one; nothing reads the host
 * back off this -- only `pathname` and `searchParams` are ever used.
 */
const REQUEST_BASE = 'http://127.0.0.1';

/** `null` for a target `new URL` cannot parse, which is answered as an unknown route rather than a 500. */
function targetOf(url: string | undefined): URL | null {
  try {
    return new URL(url ?? '/', REQUEST_BASE);
  } catch {
    return null;
  }
}

/** A cursor as it arrived on the query string: absent and empty are both "no cursor". */
function since(params: URLSearchParams): string | undefined {
  const raw = params.get('since');
  return raw === null || raw === '' ? undefined : raw;
}

/**
 * The plugin a request's `type` names, or the reply that says why there
 * isn't one. A 400 for a missing type and a 404 for a type nothing claims
 * are genuinely different answers: the first is a malformed request that
 * every poll will repeat until the client is fixed, the second is a
 * well-formed question about a type this host does not serve.
 */
function pluginFor(
  params: URLSearchParams,
  pluginIdForType: (type: string) => string | undefined,
): { pluginId: string } | { refusal: Answer } {
  const type = params.get('type');
  if (type === null || type === '') {
    return { refusal: json(400, { error: 'a type query parameter is required' }) };
  }
  // Refused before it could be echoed -- see `MEDIA_TYPE`.
  if (!MEDIA_TYPE.test(type)) {
    return { refusal: json(404, { error: 'unknown media type' }) };
  }
  const pluginId = pluginIdForType(type);
  if (pluginId === undefined) {
    return { refusal: json(404, { error: `unknown media type: ${type}` }) };
  }
  return { pluginId };
}

function isArtworkKind(value: string): value is ArtworkKind {
  return value === 'poster' || value === 'background' || value === 'logo';
}

/**
 * `/api/artwork/:kind/:mediaItemId`, or the unknown-route 404 for anything
 * shaped differently.
 *
 * Every segment is read by index and checked, never `!`-asserted:
 * `noUncheckedIndexedAccess` types each one `string | undefined`, and a path
 * with the right number of slashes and an empty segment is a real request a
 * client can send. An id that is not a safe integer is refused here too --
 * `Number('9'.repeat(30))` is a float, and handing a float to a parameter
 * bound against an `INTEGER PRIMARY KEY` is a 500 for a request that only
 * ever meant "not found".
 */
async function artworkAnswer(
  raw: DatabaseSync,
  pathname: string,
  ifNoneMatch: string | undefined,
): Promise<Answer> {
  const segments = pathname.split('/');
  if (segments.length !== 5) return UNKNOWN_ROUTE;
  const kind = segments[3];
  const id = segments[4];
  if (kind === undefined || id === undefined) return UNKNOWN_ROUTE;
  if (!isArtworkKind(kind) || !DIGITS.test(id)) return UNKNOWN_ROUTE;

  const mediaItemId = Number(id);
  if (!Number.isSafeInteger(mediaItemId)) return UNKNOWN_ROUTE;

  return {
    kind: 'artwork',
    artwork: await readArtwork(raw, kind, mediaItemId, ARTWORK_FILES, ifNoneMatch),
  };
}

/**
 * `/*` -- everything `routeFor` reaches this route for, which `matchesPath`
 * has already confined to paths outside `/api` (see that function). Wraps
 * `static-route.ts`'s `staticAnswer` into an `Answer` the same way
 * `artworkAnswer` wraps `readArtwork`: the filesystem shape lives one file
 * over, tested without a socket, and this is only the routing glue.
 */
async function staticRouteAnswer(
  webRoot: string,
  pathname: string,
  ifNoneMatch: string | undefined,
): Promise<Answer> {
  return {
    kind: 'static',
    file: await staticAnswer({ webRoot, readFile: STATIC_FILES.readFile, stat: STATIC_FILES.stat }, pathname, ifNoneMatch),
  };
}

/**
 * Where Better Auth is mounted, spelled as it arrives on the wire -- Better
 * Auth's own `basePath` default, which `createAuth` does not override.
 */
const AUTH_BASE = '/api/auth';

/**
 * Whether a path belongs to Better Auth rather than to this module.
 *
 * The trailing slash is load-bearing: without it a route named
 * `/api/authors` would be handed to Better Auth, which knows nothing about
 * it. The base itself is included so `/api/auth` is Better Auth's 404 rather
 * than this module's.
 *
 * **Measured, and pinned.** Under `return pathname.startsWith(AUTH_BASE)` the
 * whole `/api/auth*` prefix space escapes the guard: anonymous
 * `GET /api/authx` answers the library's 404 instead of this module's 401.
 * That mutation passed the entire suite until
 * `test/api/server.test.ts`'s `AUTH_PREFIX_PROBE` test existed -- the nearest
 * test used `/api/rss-items-v2`, which does not share the prefix and so
 * exercises the router rather than this function. It is the one surviving
 * mutation the whole-branch review found, and it is now the single failure
 * under it.
 */
function isAuthPath(pathname: string): boolean {
  return pathname === AUTH_BASE || pathname.startsWith(`${AUTH_BASE}/`);
}

/**
 * Everything one request is answered against.
 *
 * Separate from `ReadServerDeps` because the auth instance cannot exist when
 * the deps are assembled: it is built from the address the listener bound, so
 * it comes into being between `listen` and the first request. See
 * `ReadServerDeps.authFor`.
 */
interface Serving {
  deps: ReadServerDeps;
  auth: Auth;
  /**
   * `toNodeHandler(auth)`, built once rather than per request -- it writes the
   * response itself, which is why the auth mount is not an `Answer`.
   */
  dispatchAuth: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

/** One request, as the route that answers it needs to see it. */
interface RouteRequest {
  deps: ReadServerDeps;
  request: IncomingMessage;
  /** The path, already parsed -- the artwork route reads its own segments back off it. */
  pathname: string;
  /** The query string, which is where every route but artwork takes its arguments. */
  params: URLSearchParams;
}

/**
 * One route: the path it answers, whether it answers a caller with no
 * session, and the answer.
 *
 * **This table is the only statement of which routes are guarded**, and the
 * tests enumerate it rather than listing paths of their own -- so a route
 * added by a later slice is either marked here or it is refused, and a
 * hand-written list of six paths cannot go quietly stale beside a seventh
 * route nobody guarded. This codebase has produced ten stale-documentation
 * defects; a list of routes kept in a test is the same failure in test form.
 */
interface Route {
  /**
   * The path, with `:name` for a segment the route reads back rather than
   * matches. Compared segment by segment, so `/api/artwork/poster/1` matches
   * `/api/artwork/:kind/:mediaItemId` and `/api/artwork/poster` -- one
   * segment short -- matches nothing and is an unknown route.
   */
  readonly path: string;
  /**
   * Whether a caller with no session may reach it. `true` on exactly two
   * routes, and the tests assert that count rather than trusting it.
   */
  readonly open: boolean;
  readonly answer: (route: RouteRequest) => Answer | Promise<Answer>;
}

/**
 * The static route's own `path`, in `ROUTES` -- a sentinel `matchesPath`
 * recognises and handles before its ordinary segment comparison ever runs,
 * not a template built from `:name` segments the way every other route's is
 * (see that function). `probeFor` in the tests also sends it as a literal
 * request path, which is harmless: `/*` names no real file under any web
 * root, so `staticAnswer` answers it with `index.html`, exactly as it would
 * any other path nothing on disk matches.
 */
const STATIC_ROUTE_PATH = '/*';

/**
 * The ten routes.
 *
 * Exported because the tests derive their request set from it; nothing else
 * reads it, and nothing may mutate it.
 */
export const ROUTES: readonly Route[] = [
  {
    path: '/api/health',
    // One of two open routes: a container health check has no credential to
    // offer, and the body it answers names nothing a caller could not guess.
    // **No `generation` here**, deliberately: it is on all three sync routes
    // and it is an install fingerprint, so serving it without a session would
    // let a scanner tell two hosts apart and notice a rebuild. See
    // `sync-route.ts`'s `GenerationDeps`.
    open: true,
    answer: () => json(200, { ok: true, version: API_VERSION }),
  },
  {
    path: '/api/media',
    open: false,
    answer: ({ deps, params }) => {
      const resolved = pluginFor(params, deps.pluginIdForType);
      if ('refusal' in resolved) return resolved.refusal;
      return json(200, mediaItemsSince(deps.raw, resolved.pluginId, decodeCursor(since(params))));
    },
  },
  {
    path: '/api/rss-items',
    open: false,
    // Not type-scoped, deliberately: a feed's `plugin_id` says who polls it,
    // not who may read what it found. See `rssItemsSince`.
    answer: ({ deps, params }) => json(200, rssItemsSince(deps.raw, decodeCursor(since(params)))),
  },
  {
    path: '/api/downloads',
    open: false,
    // The union pair, not the plain one: `id` is a per-table rowid, so a
    // two-part cursor cannot say which table's row was already served. See
    // `UnionCursor`.
    //
    // Not type-scoped either, for the reason `/api/rss-items` gives: a
    // download hangs off an rss item, which hangs off a feed, and a feed's
    // `plugin_id` is who polls it. Every client syncs one download stream.
    answer: ({ deps, params }) => json(200, downloadsSince(deps.raw, decodeUnionCursor(since(params)))),
  },
  {
    path: '/api/deletions',
    open: false,
    answer: ({ deps, params }) => {
      // Type-scoped, unlike the spec's own route sketch, and it has to be: a
      // tombstone carries the `plugin_id` that owned the row precisely because
      // there is no `media_item` left to join to, and `deletionsSince` reads
      // only one plugin's. Without a type there is no plugin id to pass, and
      // serving every plugin's tombstones from one unscoped route would hand a
      // client ids the scoped media route never showed it.
      const resolved = pluginFor(params, deps.pluginIdForType);
      if ('refusal' in resolved) return resolved.refusal;
      const page = deletionsSince(deps.raw, resolved.pluginId, decodeCursor(since(params)));
      // `ids`, not `items`, per slice E's §5: the page carries ids and nothing
      // else, and calling them `items` would suggest rows a client could read.
      return json(200, { ids: page.items, cursor: page.cursor, done: page.done });
    },
  },
  {
    path: '/api/artwork/:kind/:mediaItemId',
    open: false,
    // No `type`, and no ownership check on the media item id: an accepted
    // consequence rather than an omission, and slice E's §5 records it.
    // Scoping it would confine nobody -- artwork is not on `MediaReader` at
    // all, and `ctx.db` is the raw connection. What it adds is a
    // 404-versus-200 existence oracle by integer id, which
    // `/api/media?type=<each of four>` already answers outright to the same
    // caller.
    //
    // **And that caller now holds a session.** Slice E accepted the oracle
    // because every route was equally open; the auth slice's §5 keeps it
    // accepted for a different reason -- an unauthenticated caller cannot
    // reach this route at all, which is the point of guarding it.
    answer: ({ deps, request, pathname }) => artworkAnswer(
      deps.raw,
      pathname,
      request.headers['if-none-match'],
    ),
  },
  {
    path: '/api/sync',
    open: false,
    // A replica of the whole library is exactly what the session guard
    // exists to protect (design spec §5) -- this route and the next are as
    // guarded as every other, never a special case.
    answer: ({ deps, params }) => {
      const answer = syncAnswer(
        { raw: deps.raw, registry: deps.registry, generation: deps.generation },
        params,
      );
      return json(answer.status, answer.body);
    },
  },
  {
    path: '/api/sync/bootstrap',
    open: false,
    // Where an empty client starts both cursors. Guarded like the two it
    // feeds: the answer is two log positions and the sync generation, but a
    // caller with no session has no business being handed a way into the
    // replica -- nor, for the generation, an install fingerprint.
    answer: ({ deps }) => {
      const answer = bootstrapAnswer({ raw: deps.raw, generation: deps.generation });
      return json(answer.status, answer.body);
    },
  },
  {
    path: '/api/sync/backfill',
    open: false,
    // Two segments under `/api/sync`, one literal and one -- see
    // `matchesPath` -- which is what keeps this from shadowing or being
    // shadowed by the route above: `matchesPath` compares segment *counts*
    // first, so a three-segment request never matches this four-segment
    // template and a four-segment request never matches that three-segment
    // one. `/api/artwork/:kind/:mediaItemId` is the existing precedent for a
    // multi-segment path coexisting with shorter ones in this same table.
    answer: ({ deps, params }) => {
      const answer = backfillAnswer(
        { raw: deps.raw, registry: deps.registry, generation: deps.generation },
        params,
      );
      return json(answer.status, answer.body);
    },
  },
  {
    path: STATIC_ROUTE_PATH,
    // The other of two open routes (design spec §3, and the shell slice's
    // Task 1). It has to be: the bundle is the same bytes for every caller,
    // and it is what a browser must load and run *before* it can render the
    // sign-in form that would otherwise establish a session -- guarding it
    // would not protect anything, since there is nothing caller-specific in
    // an `index.html` or a hashed asset file, and it would make signing in
    // to a fresh install impossible rather than merely inconvenient.
    //
    // `matchesPath` excludes every `/api` path from this template already,
    // so an unmatched `/api/*` request still falls through to "no route
    // claims this", which `refusalFor` guards -- exactly as it did before
    // this route existed. `staticAnswer` refuses `/api` again on its own,
    // defensively, in case it is ever called from somewhere that skipped
    // that exclusion.
    open: true,
    answer: ({ deps, request, pathname }) => staticRouteAnswer(
      deps.webRoot,
      pathname,
      request.headers['if-none-match'],
    ),
  },
];

/**
 * Whether `pathname` is the route `template` describes.
 *
 * `STATIC_ROUTE_PATH` is handled first and separately, because it is not a
 * segment template at all: it matches every path of any depth *except* one
 * under `/api`, which the segment-count comparison below has no way to
 * express (a fixed template only ever matches paths of its own segment
 * count). Excluding `/api` here, rather than leaving it to `staticAnswer`
 * alone, is what keeps an unmatched `/api/*` path guarded exactly as it was
 * before this route existed: `routeFor` finding no match for it is what
 * sends it to `refusalFor`'s "a path no route claims is guarded" branch,
 * where `staticAnswer`'s own defensive check on the same rule never runs at
 * all because `staticAnswer` is never called for it.
 *
 * For every other template, segment counts must match, every literal
 * segment must be equal, and a `:name` segment matches anything but the
 * empty string -- a path with the right number of slashes and an empty
 * segment is a real request a client can send, and it is not this route.
 */
function matchesPath(template: string, pathname: string): boolean {
  if (template === STATIC_ROUTE_PATH) return !isApiPath(pathname);
  const wanted = template.split('/');
  const got = pathname.split('/');
  if (wanted.length !== got.length) return false;
  return wanted.every((segment, index) => {
    // `noUncheckedIndexedAccess`: the lengths were compared above, but the
    // compiler types this as possibly-absent and an assertion would be a
    // claim rather than a check.
    const actual = got[index];
    if (actual === undefined) return false;
    return segment.startsWith(':') ? actual !== '' : segment === actual;
  });
}

/** The route a path names, or `undefined` for a path no route claims. */
function routeFor(pathname: string): Route | undefined {
  return ROUTES.find((route) => matchesPath(route.path, pathname));
}

/**
 * The refusal this request gets before anything is routed, or `null` when it
 * may proceed.
 *
 * **This runs in `handle`, ahead of the router, and that is the whole
 * point.** Deriving the guarded set from `ROUTES` is right and is not
 * sufficient: a route mounted in `handle` *beside* the auth dispatch is
 * outside the table altogether, so it inherits nothing. That is not
 * hypothetical -- an unguarded `/api/rss-items-v2` serving real rows was
 * mounted there and all 22 tests passed. Nothing but `/api/auth/*` is
 * mounted beside the dispatch today, so nothing was exposed; what this
 * closes is the next mount, which now inherits the guard by construction
 * rather than by whoever adds it remembering to.
 *
 * Read-only, so anything but a GET is refused by its method rather than
 * routed as though it were one -- a router that looked only at the path
 * would answer a POST with a page of data, which is not a thing this API
 * should ever appear to accept. That check stays ahead of the guard, and
 * costs nothing: every non-GET path answers the same 405 whether or not the
 * caller has a session, so the ordering tells an anonymous caller nothing it
 * could not have worked out from "the API is read-only". Better Auth's own
 * POSTs never reach here -- `handle` dispatched them already.
 *
 * **The guard tests the value the session check resolves to.** Not its
 * status: an unauthenticated check answers `200` with a body of `null` (the
 * auth slice's §2, measured), so `getSession` resolving `null` is the only
 * thing that distinguishes a caller with a session from one without. The
 * check goes through `auth.api`, never through SQL of this module's own --
 * the same rule the rest of this file follows for reads.
 *
 * Open is a property of `ROUTES`, read here: a path no route claims is
 * guarded, and so is a request target that would not parse. Answering 404
 * first would tell a caller with no session which paths exist, which is a
 * question they have no standing to ask.
 */
async function refusalFor(serving: Serving, target: URL | null, request: IncomingMessage): Promise<Answer | null> {
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
  if (target !== null && routeFor(target.pathname)?.open === true) return null;
  const session = await serving.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  return session === null ? UNAUTHORIZED : null;
}

/**
 * One request, routed. **Guarded already** -- `handle` has the refusal above
 * ahead of this call, so nothing here asks about a session and nothing added
 * here can forget to.
 */
function answerFor(serving: Serving, target: URL | null, request: IncomingMessage): Answer | Promise<Answer> {
  if (target === null) return UNKNOWN_ROUTE;
  const { pathname, searchParams } = target;

  const route = routeFor(pathname);
  if (route === undefined) return UNKNOWN_ROUTE;

  return route.answer({ deps: serving.deps, request, pathname, params: searchParams });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

function write(response: ServerResponse, answer: Answer): void {
  if (answer.kind === 'json') {
    writeJson(response, answer.status, answer.body);
    return;
  }
  if (answer.kind === 'artwork') {
    // Written exactly as `readArtwork` composed it, including a 404 or a 304
    // carrying no body at all: that function has already decided what the
    // caller may know, and it deliberately names neither the path it looked
    // for nor whether the row or the file was the thing missing.
    response.writeHead(answer.artwork.status, answer.artwork.headers);
    response.end(answer.artwork.body ?? undefined);
    return;
  }
  // `answer.kind === 'static'`, written exactly as `staticAnswer` composed
  // it, on the same reasoning as the artwork branch above.
  response.writeHead(answer.file.status, answer.file.headers);
  response.end(answer.file.body ?? undefined);
}

/** An error's message, whatever was thrown -- a non-`Error` stringifies rather than vanishing. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers one request, and answers a failure the same way whatever failed.
 *
 * **The auth routes are dispatched first, ahead of the guard and ahead of
 * the method check.** Sign-in is a POST, and it is the request that *issues*
 * a session -- routed any later it would be refused for not carrying the
 * thing it exists to hand out, and nobody could ever sign in to this host.
 * Everything under `/api/auth/` is Better Auth's own; this module neither
 * inspects those requests nor writes their responses.
 *
 * **Everything after that dispatch is guarded, by position.** The refusal is
 * taken here rather than inside the router, so a mount added below it
 * inherits the guard whether or not whoever adds it thinks about the guard at
 * all. That is the one structural difference between this and deriving the
 * guarded set from `ROUTES`: the table cannot speak for a route that is not
 * in it, and a route mounted beside this dispatch is not in it. See
 * `refusalFor`.
 *
 * The 500's body is a fixed string: the thrown message can name a feed url,
 * an artwork path or a client's api key (SQLite's own messages name tables
 * and constraints; a client adapter's name whatever url it was reaching), and
 * none of that is a caller's to see. The message is written down instead --
 * through `redactUrl`, so a credential in a url does not reach the log
 * either -- against the request's *path*, never its query string. A throw out
 * of the auth handler is answered the same way, for the same reason.
 */
async function handle(serving: Serving, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { deps } = serving;
  try {
    const target = targetOf(request.url);
    if (target !== null && isAuthPath(target.pathname)) {
      await serving.dispatchAuth(request, response);
      return;
    }
    const refusal = await refusalFor(serving, target, request);
    if (refusal !== null) {
      write(response, refusal);
      return;
    }
    // Past the guard. Anything mounted from here down is guarded by having
    // been written below this line, rather than by being marked in `ROUTES`.
    write(response, await answerFor(serving, target, request));
  } catch (error) {
    const route = targetOf(request.url)?.pathname ?? '(unparseable)';
    deps.log('read failed', { route, error: redactUrl(messageOf(error)) });
    if (response.headersSent) {
      // Nothing safe left to say -- the status line is already gone. Dropping
      // the connection is what tells a client the response is incomplete;
      // appending an error to a half-written body would corrupt it instead.
      response.destroy();
      return;
    }
    writeJson(response, 500, { error: 'read failed' });
  }
}

/**
 * The origin of the address a listener bound, which is what
 * `ReadServerDeps.authFor` is handed.
 *
 * **One origin this listener answers at, not the only one.** With the default
 * wildcard bind it is `http://0.0.0.0:<port>`. Finishing that is the caller's
 * job and `main` does it in two ways: it prefers `PICKARR_PUBLIC_URL` as
 * `baseURL` when a proxy is in front, and `auth/instance.ts`'s
 * `trustedOrigins` accepts a request whose `Origin` names `localhost` or an
 * address in a private, loopback, link-local or unique-local block -- block
 * membership, not this machine's own networks, which it reads nothing about.
 * What this function is for is the case with neither -- a host reached
 * directly at the address it bound.
 *
 * **`http://0.0.0.0:<port>` reaches this host, and it works only because it
 * arrives here.** That url is a real one a client on the machine can use --
 * every request in `test/api/server.test.ts` targets it -- so it is an origin
 * a browser can genuinely be on, and `0.0.0.0` being the default bind is what
 * makes that ordinary rather than exotic. It is *not* a placeable origin:
 * `isPrivateIPv4` matches `127`, `10`, `172.16/12`, `192.168` and `169.254`,
 * and `0` is none of them, so `trustedOrigins` never returns it. Measured: a
 * sign-up carrying `Origin: http://0.0.0.0:<port>` against some other
 * `baseURL` is refused `403 INVALID_ORIGIN`, and the same request succeeds
 * when this function's value *is* the `baseURL` -- Better Auth puts
 * `baseURL`'s origin in its trusted list implicitly. So this path is held
 * open by that implicit trust and by nothing in the origin policy. Anything
 * that stops passing the bound address as `baseURL` closes it, which is worth
 * knowing before `PICKARR_PUBLIC_URL` is made mandatory or this value is
 * normalized to something "nicer".
 *
 * An IPv6 address is bracketed, because `http://::1:8787` is not a url and
 * `http://[::1]:8787` is: `address.address` reports the bare address, and an
 * origin that will not parse would refuse every state-changing request
 * against it rather than fail visibly at construction.
 */
function originOf(address: AddressInfo): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

/**
 * Binds the read API and starts answering.
 *
 * Resolves once the listener is up, so a caller that awaits this knows the
 * port is open -- and rejects if the bind fails, rather than leaving a
 * process that looks started and serves nothing.
 *
 * **It listens before it builds the auth instance, and has to.** `baseURL`
 * must be the origin requests actually arrive at or Better Auth refuses every
 * POST (the auth slice's §2), and with `port: 0` that origin is not known
 * until the kernel has assigned a port -- so the request listener is attached
 * *after* the address is read, rather than passed to `createServer`. Nothing
 * is dropped in between: node cannot emit a `'request'` event until a later
 * turn of the loop, and everything from the bind to the attach below runs
 * without yielding.
 */
export async function createReadServer(deps: ReadServerDeps): Promise<ReadServer> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host ?? DEFAULT_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    // A pipe or an unbound server: neither is something this can report a
    // port for, and a caller told "started" would then poll an address that
    // does not exist. Only reachable if `listen` is ever given something
    // other than a port, which `deps.port` being a number rules out.
    server.close();
    throw new Error('the read api bound no tcp address');
  }

  const auth = deps.authFor(originOf(address));
  const serving: Serving = { deps, auth, dispatchAuth: toNodeHandler(auth) };
  server.on('request', (request, response) => {
    handle(serving, request, response).catch((error: unknown) => {
      // `handle` answers its own failures, so reaching here means the
      // *answering* threw -- a socket that died mid-write, say. Logged rather
      // than swallowed, because the alternative is an empty catch that hides
      // a real defect in `handle`.
      deps.log('read response failed', { error: redactUrl(messageOf(error)) });
      response.destroy();
    });
  });

  let closed = false;
  return {
    host: address.address,
    port: address.port,
    family: address.family,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      // `close()` stops the listener; `closeAllConnections()` drops what is
      // already open. Neither is awaited: `server.close(callback)` fires its
      // callback only once every connection has ended, which is precisely
      // the drain this must not wait for -- and a client holding a request
      // half-sent would otherwise delay shutdown indefinitely.
      server.close();
      server.closeAllConnections();
    },
  };
}
