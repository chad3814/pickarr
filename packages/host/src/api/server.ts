/**
 * The read API on a socket: `node:http`, six routes, bound to loopback.
 *
 * Everything this file does is routing. Parse a request, call one function
 * from `./reads.ts` or `./artwork-route.ts`, write what came back.
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
 * **No response body carries a url, a path or a query string.** A thrown
 * error becomes a 500 with a fixed message; the thrown message goes through
 * `redactUrl` on its way to the log and never into the response at all. The
 * one caller-supplied value any body repeats is a media type, which the
 * brief requires an unknown type to name -- and `MEDIA_TYPE` below is what
 * keeps that from becoming a way to get a path echoed back.
 *
 * **Unauthenticated.** Loopback binding is the whole of the protection (see
 * the plan's §8): anything that can reach the port can read every media
 * item, feed item and download. A reverse proxy or a container publishing
 * this port exposes the library, and auth is a later slice's.
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { redactUrl } from '../clients/redact.ts';
import type { ArtworkKind, ArtworkResponse } from './artwork-route.ts';
import { readArtwork } from './artwork-route.ts';
import { decodeCursor, decodeUnionCursor } from './cursor.ts';
import { deletionsSince, downloadsSince, mediaItemsSince, rssItemsSince } from './reads.ts';

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
 * Loopback, and a literal rather than a parameter. The spec's §6 makes the
 * bind address the whole of this API's access control, so a caller able to
 * pass `0.0.0.0` would be a caller able to publish an unauthenticated read
 * of the library. Nothing needs to bind anything else; when something does,
 * it can argue for it then.
 */
const LOOPBACK = '127.0.0.1';

/**
 * A listening read API.
 *
 * `host` and `family` are read back from `server.address()` rather than
 * echoed from what was asked for, and they are on this interface for a
 * reason the brief's shape did not have room for: the loopback property is
 * only testable by asserting *what the listener bound*. A test that instead
 * probed an external interface and found nothing would pass on a machine
 * with no route to that interface, which proves nothing at all about the
 * bind.
 */
export interface ReadServer {
  /** The address the listener actually bound -- `127.0.0.1`. */
  host: string;
  /** The port it actually bound, which is the assigned one when 0 was asked for. */
  port: number;
  /** Its address family, so an IPv6 wildcard cannot pass for loopback. */
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
  /** 0 asks the kernel for a free port, which `ReadServer.port` then reports. */
  port: number;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * What a route answers, before anything is written to a socket.
 *
 * Two shapes because artwork is the one route that does not answer JSON, and
 * it already returns a status/headers/body triple of its own
 * (`ArtworkResponse`) that this module has no business reinterpreting.
 * Keeping routing separate from writing is what lets every route be a
 * function of its request.
 */
type Answer =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'artwork'; artwork: ArtworkResponse };

function json(status: number, body: unknown): Answer {
  return { kind: 'json', status, body };
}

/** The fixed 404 every unrecognised path and every unparseable one answers. */
const UNKNOWN_ROUTE = json(404, { error: 'unknown route' });

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
 * The six routes, as a function of one request.
 *
 * Read-only, so anything but a GET is refused by its method rather than
 * routed as though it were one -- a router that looked only at the path
 * would answer a POST with a page of data, which is not a thing this API
 * should ever appear to accept.
 */
async function answerFor(deps: ReadServerDeps, request: IncomingMessage): Promise<Answer> {
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });

  const target = targetOf(request.url);
  if (target === null) return UNKNOWN_ROUTE;
  const { pathname, searchParams } = target;

  if (pathname === '/api/health') {
    return json(200, { ok: true, version: API_VERSION });
  }

  if (pathname === '/api/media') {
    const resolved = pluginFor(searchParams, deps.pluginIdForType);
    if ('refusal' in resolved) return resolved.refusal;
    return json(200, mediaItemsSince(deps.raw, resolved.pluginId, decodeCursor(since(searchParams))));
  }

  if (pathname === '/api/rss-items') {
    // Not type-scoped, deliberately: a feed's `plugin_id` says who polls it,
    // not who may read what it found. See `rssItemsSince`.
    return json(200, rssItemsSince(deps.raw, decodeCursor(since(searchParams))));
  }

  if (pathname === '/api/downloads') {
    // The union pair, not the plain one: `id` is a per-table rowid, so a
    // two-part cursor cannot say which table's row was already served. See
    // `UnionCursor`.
    return json(200, downloadsSince(deps.raw, decodeUnionCursor(since(searchParams))));
  }

  if (pathname === '/api/deletions') {
    // Type-scoped, unlike the spec's own route sketch, and it has to be: a
    // tombstone carries the `plugin_id` that owned the row precisely because
    // there is no `media_item` left to join to, and `deletionsSince` reads
    // only one plugin's. Without a type there is no plugin id to pass, and
    // serving every plugin's tombstones from one unscoped route would hand a
    // client ids the scoped media route never showed it.
    const resolved = pluginFor(searchParams, deps.pluginIdForType);
    if ('refusal' in resolved) return resolved.refusal;
    const page = deletionsSince(deps.raw, resolved.pluginId, decodeCursor(since(searchParams)));
    // `ids`, not `items`, per the spec's §5: the page carries ids and nothing
    // else, and calling them `items` would suggest rows a client could read.
    return json(200, { ids: page.items, cursor: page.cursor, done: page.done });
  }

  if (pathname.startsWith('/api/artwork/')) {
    const ifNoneMatch = request.headers['if-none-match'];
    return artworkAnswer(deps.raw, pathname, ifNoneMatch);
  }

  return UNKNOWN_ROUTE;
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
  // Written exactly as `readArtwork` composed it, including a 404 or a 304
  // carrying no body at all: that function has already decided what the
  // caller may know, and it deliberately names neither the path it looked
  // for nor whether the row or the file was the thing missing.
  response.writeHead(answer.artwork.status, answer.artwork.headers);
  response.end(answer.artwork.body ?? undefined);
}

/** An error's message, whatever was thrown -- a non-`Error` stringifies rather than vanishing. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers one request, and answers a failure the same way whatever failed.
 *
 * The 500's body is a fixed string: the thrown message can name a feed url,
 * an artwork path or a client's api key (SQLite's own messages name tables
 * and constraints; a client adapter's name whatever url it was reaching), and
 * none of that is a caller's to see. The message is written down instead --
 * through `redactUrl`, so a credential in a url does not reach the log
 * either -- against the request's *path*, never its query string.
 */
async function handle(deps: ReadServerDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    write(response, await answerFor(deps, request));
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
 * Binds the read API and starts answering.
 *
 * Resolves once the listener is up, so a caller that awaits this knows the
 * port is open -- and rejects if the bind fails, rather than leaving a
 * process that looks started and serves nothing.
 */
export async function createReadServer(deps: ReadServerDeps): Promise<ReadServer> {
  const server = createServer((request, response) => {
    handle(deps, request, response).catch((error: unknown) => {
      // `handle` answers its own failures, so reaching here means the
      // *answering* threw -- a socket that died mid-write, say. Logged rather
      // than swallowed, because the alternative is an empty catch that hides
      // a real defect in `handle`.
      deps.log('read response failed', { error: redactUrl(messageOf(error)) });
      response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, LOOPBACK, () => {
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
