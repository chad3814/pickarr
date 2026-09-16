/**
 * Serves the built browser bundle: `/assets/<file>` by its own bytes, and
 * anything else that is not `/api/*` as `index.html`, so a client-side route
 * survives a refresh.
 *
 * The shape is `artwork-route.ts`'s, deliberately not a second one (design
 * spec §2.2, and Task 1's own brief): an injected `readFile` and `stat`,
 * never `node:fs`'s real ones directly, so a test needs no filesystem at
 * all -- see that module's docblock for why the pair is async and why a
 * weak `W/"<mtimeMs>-<size>"` ETag is the honest one to hand back rather
 * than a strong one; the same reasoning applies here unchanged; it is not
 * repeated. What differs from artwork is the content type -- chosen from the
 * file's own extension, because a built bundle's files are named by a
 * bundler that already encodes their type in the suffix, where artwork's
 * cache path carries a fixed, meaningless `.bin` suffix instead and has to
 * be sniffed (see `artwork-route.ts`'s module doc for why) -- and that a
 * miss falls back to `index.html` instead of a 404, because this route also
 * carries the client-side router's deep links.
 *
 * **`/api` never falls through to `index.html`.** A typo'd endpoint
 * answering HTML is a client that parses markup as JSON and reports a
 * nonsense error, which is worse than a 404 by exactly the time it takes to
 * find (design spec §3). This module refuses an `/api` path before it ever
 * touches the filesystem, so the rule holds even if this function is ever
 * reached directly rather than through `server.ts`'s routing.
 *
 * **Path traversal is refused after normalisation, not before.** The
 * pathname handed in has already been through `new URL(...).pathname`,
 * which decodes and collapses `.` and `..` segments -- but leaves an
 * *encoded* slash (`%2f`) alone, precisely so a path segment cannot be
 * confused with a separator. That is what makes `%2e%2e%2f` safe at that
 * stage and dangerous one step later: this module still has to
 * `decodeURIComponent` each segment itself, to recover a real filename that
 * happens to need escaping (a space, a `#`), and *that* decode turns
 * `%2e%2e%2f` into a genuine `../`. Checking the string for `..` before this
 * second decode would check the wrong string -- `%2e%2e%2fetc` contains no
 * literal `..` at all. So the check here is not a string match; it is
 * "resolve the candidate path against the root, then confirm the result is
 * still inside it", which catches the traversal however it was spelled.
 *
 * **No answer this module returns carries a filesystem path.** Every
 * refusal is a fixed constant; the one value derived from a real path --
 * the byte content of a real file -- is the point of the successful case,
 * never the failure ones. See the plan's Global Constraints.
 */

import { extname, join, resolve, sep } from 'node:path';

/** What one request for the bundle answers, before anything is written to a socket. */
export interface StaticResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

/** The filesystem calls `staticAnswer` needs, injected exactly as `readArtwork`'s are. */
export interface StaticDeps {
  /** The built bundle's own directory -- `server.webRoot`, already resolved by `main`. */
  webRoot: string;
  readFile: (path: string) => Promise<Uint8Array>;
  stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
}

/**
 * Whether `pathname` belongs to the read API rather than to the bundle.
 *
 * Exported so `server.ts`'s route table can exclude the same set of paths
 * from the static route's own match, rather than restating the rule as a
 * second regular expression that could drift from this one.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** The fixed 404 an `/api` miss and a refused traversal both answer -- `server.ts`'s own `UNKNOWN_ROUTE`, restated here rather than imported, so this module has no dependency on the router it is routed by. */
const UNKNOWN_ROUTE: StaticResponse = {
  status: 404,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: new TextEncoder().encode(JSON.stringify({ error: 'unknown route' })),
};

/** The plain 404 an absent or unreadable web root answers -- no body, since there is nothing to say that does not name a path. */
const NOT_FOUND: StaticResponse = { status: 404, headers: {}, body: null };

/**
 * Content type by extension, not by sniffing -- unlike `artwork-route.ts`'s
 * `sniffImageType`. A built bundle's files are named by the bundler that
 * wrote them, so the suffix already says what they are; sniffing would be
 * answering a question the filename already answered, for files this host
 * did not just receive from a third party the way artwork bytes are.
 *
 * Anything unrecognised is `application/octet-stream`, the same refusal to
 * fail loudly over an unfamiliar file that `sniffImageType` makes for an
 * unfamiliar signature.
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPE_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The real filesystem path `pathname` names under `root`, or `null` when
 * the decoded, resolved result would land outside `root`.
 *
 * `root` is assumed already `resolve`d -- callers pass it that way exactly
 * once per request, in `staticAnswer` -- so this only has to resolve the
 * candidate, not both sides. `join`, not `resolve`, combines the two:
 * `resolve(root, '/etc/passwd')` discards `root` entirely because a second
 * absolute argument overrides everything before it, where `join` always
 * concatenates first and normalises after -- which is what lets the
 * containment check below see a `..` that walked past `root` rather than
 * never noticing `root` was ignored.
 */
function withinRoot(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A `%` not followed by two hex digits: not a path this filesystem could
    // ever have been given a name matching, so it is refused the same way an
    // escaping one is, rather than reaching `join` with `%` in it verbatim.
    return null;
  }
  const candidate = resolve(join(root, decoded));
  if (candidate === root || candidate.startsWith(root + sep)) return candidate;
  return null;
}

/**
 * One file, read and answered with a weak ETag and a 304 -- `readArtwork`'s
 * shape exactly, with the content type read from the extension rather than
 * sniffed. `null` when the file cannot be served at all (missing, a
 * directory, unreadable), which is the caller's cue to try the next
 * candidate rather than the request's final answer.
 */
async function fileAnswer(
  deps: Pick<StaticDeps, 'readFile' | 'stat'>,
  path: string,
  ifNoneMatch: string | undefined,
): Promise<StaticResponse | null> {
  let info: { mtimeMs: number; size: number };
  try {
    info = await deps.stat(path);
  } catch {
    return null;
  }

  // Weak by construction, exactly as `readArtwork`'s is and for a related
  // reason spelled out there: `mtimeMs` and `size` are what `stat` actually
  // knows, and no more -- there is no stored hash of these bytes to assert
  // identity with instead.
  const etag = `W/"${info.mtimeMs}-${info.size}"`;
  const lastModified = new Date(info.mtimeMs).toUTCString();

  if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
    return { status: 304, headers: { ETag: etag, 'Last-Modified': lastModified }, body: null };
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(path);
  } catch {
    // `stat` succeeded and `readFile` did not -- a directory is the ordinary
    // way this happens (`stat` succeeds on one; reading one as a file
    // rejects `EISDIR`). Treated the same as "no such file": there is
    // nothing here to serve as bytes, so the caller falls back exactly as
    // it would for a plain miss.
    return null;
  }

  return {
    status: 200,
    headers: { 'Content-Type': contentTypeFor(path), ETag: etag, 'Last-Modified': lastModified },
    body: bytes,
  };
}

/**
 * Answers one request against the built bundle: the asset `pathname` names
 * if one exists under `deps.webRoot`, else `index.html`, else the plain 404
 * that means "there is nothing here to serve" -- never a throw, so a
 * missing or unreadable web root leaves every `/api` route answering
 * exactly as it did before this route existed (design spec §3).
 *
 * `ifNoneMatch` is a fifth-parameter-shaped optional argument rather than a
 * `deps` field, on `readArtwork`'s own reasoning: `deps` is the pair of
 * filesystem calls a test replaces, and the caller's request header is not
 * one of those.
 */
export async function staticAnswer(
  deps: StaticDeps,
  pathname: string,
  ifNoneMatch?: string,
): Promise<StaticResponse> {
  if (isApiPath(pathname)) return UNKNOWN_ROUTE;

  const root = resolve(deps.webRoot);
  const requested = withinRoot(root, pathname);
  if (requested === null) return UNKNOWN_ROUTE;

  const asset = await fileAnswer(deps, requested, ifNoneMatch);
  if (asset !== null) return asset;

  // No real file at that path: either a client-side route with no file of
  // its own (`/`, `/library/42`, ...), or a traversal target that resolved
  // inside `root` but names nothing real there. Both get the same fallback
  // a browser needs to survive a refresh on a deep link -- `index.html`.
  const index = await fileAnswer(deps, join(root, 'index.html'), ifNoneMatch);
  return index ?? NOT_FOUND;
}

/**
 * Checked once, at boot, never per request: whether `webRoot` is there at
 * all. `main` calls this after resolving `server.webRoot` and before it
 * starts accepting connections, and awaits nothing else about it -- a
 * missing bundle is not fatal (design spec §3), so this never throws, only
 * logs.
 *
 * **Logged once because `main` calls this once.** There is no per-request
 * deduping here to get wrong, because there is no per-request call: every
 * static request that finds nothing under a missing root already answers
 * gracefully on its own, via `staticAnswer`'s fallback chain above, with no
 * log line of its own to repeat.
 *
 * The message names neither `webRoot` nor any other path -- the Global
 * Constraint applies to a boot log exactly as it does to a response body --
 * and says what an operator running headless, or a developer running the
 * host without ever having built `@pickarr/web`, should do about it: nothing,
 * if this is a development host, because `packages/web`'s own dev server
 * proxies `/api` here and never asks this host for a static file at all
 * (design spec §3's context); build the bundle and set `server.webRoot`, or
 * accept an API-only host, otherwise.
 */
export async function warnIfWebRootMissing(
  webRoot: string,
  stat: (path: string) => Promise<unknown>,
  log: (message: string) => void,
): Promise<void> {
  try {
    await stat(webRoot);
  } catch {
    log(
      'no web bundle found at the configured server.webRoot; serving the api only. '
      + 'if this is a development host, run the web package\'s own dev server '
      + 'separately -- it proxies /api to this host and never asks it for a static '
      + 'file. otherwise, build @pickarr/web and point server.webRoot at its dist '
      + 'directory.',
    );
  }
}
