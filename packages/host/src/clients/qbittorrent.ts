import type { QbittorrentBearerConfig, QbittorrentLoginConfig } from './config.ts';
import { FetchFailedError } from '../fetch/queue.ts';
import type { QueuedFetch } from '../fetch/queue.ts';
import { redactFormBody, redactHeaders } from './redact.ts';
import type { SubmitResult } from './types.ts';

/**
 * The version that introduced API key auth (WebAPI 2.14.1). Named because
 * the error message below cites it -- an operator on 5.0 or 5.1 has a
 * plausible-looking key the server has no concept of, and a bare 401 or 403
 * tells them nothing about why. Matches 1.x's own constant
 * (`packages/core/src/clients/qbittorrent.ts`, `API_KEY_MIN_VERSION`).
 */
export const API_KEY_MIN_VERSION = '5.2.0';

const TORRENTS_ADD_PATH = '/api/v2/torrents/add';
const TORRENTS_INFO_PATH = '/api/v2/torrents/info';
const LOGIN_PATH = '/api/v2/auth/login';

/**
 * Matches `xt=urn:btih:<40 hex chars>` in a magnet link's query, the way
 * `redact.ts`'s own patterns key off `[?&]` rather than assuming which
 * parameter comes first. Deliberately narrow: a base32 `btih` (32
 * characters, not hex) and a v2 `btmh` magnet both fail to match, on
 * purpose -- `infohashFromMagnet` returns `null` for either, and `submit`
 * below falls through to `findRegisteredRef`'s lookup rather than passing a
 * non-infohash value on as if it were one. The trailing `(?![0-9a-fA-F])`
 * stops a 41st hex character from being silently dropped instead of making
 * the match fail.
 */
const MAGNET_BTIH_PATTERN = /[?&]xt=urn:btih:([0-9a-fA-F]{40})(?![0-9a-fA-F])/i;

/**
 * True for a hash that is all zeros, at any length -- qBittorrent pads a
 * torrent's hash with zeros while its metadata is still arriving, and the
 * padding width is not a value this adapter should have to know. A hash
 * this shape identifies nothing yet; treating it as a hash of any other
 * value would record a reference this torrent does not actually have.
 * Used by both `infohashFromMagnet` below and `findRegisteredRef` further
 * down, so the two agree on the one question they'd otherwise answer
 * separately and could answer differently.
 */
function isZeroHash(hash: string): boolean {
  return hash !== '' && /^0+$/.test(hash);
}

/**
 * The infohash from a magnet link, or `null` when the link is not a v1
 * hex-encoded magnet -- including a base32 `btih` or a v2 `btmh` magnet,
 * neither of which this returns a value for -- or when the hex it did match
 * is all zeros. Callers must not treat `null` as "close enough": `submit`
 * below does not guess at a reference for it, it falls through to
 * `findRegisteredRef`'s name-keyed lookup instead, the same path a
 * `.torrent` url always takes.
 *
 * The all-zero check agrees with `findRegisteredRef`'s own `isZeroHash`
 * below on purpose -- both answer the same question, "does this hash
 * identify a real torrent", and a magnet padded with zeros (unusual, but
 * not forbidden by the spec) identifies nothing yet for exactly the same
 * reason a zeroed `/torrents/info` entry does not: qBittorrent has not
 * received this torrent's metadata.
 */
export function infohashFromMagnet(link: string): string | null {
  if (!link.toLowerCase().startsWith('magnet:')) return null;
  const match = MAGNET_BTIH_PATTERN.exec(link);
  if (!match) return null;
  const hash = match[1];
  if (hash === undefined) return null;
  // Lowercased deliberately: a magnet may spell the hash in either case, and
  // two spellings of one hash are two distinct values to the unique index on
  // (download_client_id, client_ref) -- storing whichever case the link
  // happened to use would let the same torrent be recorded twice.
  const lowered = hash.toLowerCase();
  return isZeroHash(lowered) ? null : lowered;
}

/**
 * Builds the bearer header qBittorrent's api-key auth expects. Kept as its
 * own function so `submit`'s catch block can redact the exact object that
 * was sent, rather than reconstructing it from `config.apiKey` a second
 * time -- which would be one more place a future edit could forget to keep
 * the token out of a message.
 */
function bearerHeaders(config: QbittorrentBearerConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

/**
 * The `SID=...` pair from a login response, or `null` when the response
 * carried none. `getSetCookie()` is the only correct reader here:
 * `Headers.get('set-cookie')` folds every cookie in a response into one
 * comma-joined string that cannot be split back apart safely, because a
 * cookie's own value may itself contain a comma. Matches 1.x's own
 * `readSidCookie` (`packages/core/src/clients/qbittorrent.ts`), which this
 * file does not import from -- 1.x is deployed and not to be touched, so
 * the same small function is written again here rather than shared.
 *
 * Only the `name=value` pair is kept: the attributes (`Path`, `HttpOnly`)
 * describe how a browser should store the cookie and are not part of what a
 * `Cookie` request header carries back.
 */
function readSidCookie(response: Response): string | null {
  for (const candidate of response.headers.getSetCookie()) {
    const pair = (candidate.split(';', 1)[0] ?? '').trim();
    if (pair.startsWith('SID=') && pair.length > 'SID='.length) return pair;
  }
  return null;
}

/**
 * Logs in once and returns the `SID` cookie pair every later request
 * replays. **The only request in this adapter outside the fetch queue**,
 * and deliberately so: `QueuedFetch`'s methods (`json`/`bytes`/`text`) hand
 * back only a parsed body, never the `Response` itself, so no caller of
 * `fetch` can reach `Set-Cookie` -- the one place the `SID` cookie lives.
 * `loginFetch` is therefore a bare `fetch`, unpaced by `createHostFetch`'s
 * per-hostname concurrency budget and untimed by its timeout; every request
 * after this one -- the add, and for a `.torrent` url, the lookup that
 * follows it -- replays the cookie this returns through `fetch`, the queue,
 * like everything else in this slice.
 *
 * qBittorrent answers a **wrong username or password with HTTP 200** and
 * the body `Fails.`, so the absence of the `SID` cookie -- never the
 * response's status -- is what says the login failed (matches 1.x's own
 * comment on this trap, on `cookieRequest`'s `login` in
 * `packages/core/src/clients/qbittorrent.ts`). The body is never read: it
 * is the server's own text, and the message below says everything useful
 * about the failure without it.
 */
async function login(
  config: QbittorrentLoginConfig,
  loginFetch: typeof globalThis.fetch,
): Promise<string> {
  const body = new URLSearchParams({ username: config.username, password: config.password });
  const response = await loginFetch(`${config.baseUrl}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    // The body *sent*, not the body received: this is the request this
    // process built, so redacting it before it can reach a message is this
    // file's job -- unlike the response body above, which is never read at
    // all. `redactFormBody` keeps `config.password` out of this message the
    // same way `redactHeaders` keeps a bearer token out of
    // `guardAuthFailure`'s.
    throw new Error(
      `qbittorrent client ${config.id} login failed with HTTP ${response.status} ` +
      `${response.statusText}, POSTing ${redactFormBody(body.toString())} to ${LOGIN_PATH}`,
    );
  }

  const sid = readSidCookie(response);
  if (sid === null) {
    throw new Error(
      `qbittorrent client ${config.id} logged in but received no SID cookie, which is how ` +
      'qbittorrent reports a username or password it will not accept',
    );
  }
  return sid;
}

/**
 * Builds the function `submit` and `findRegisteredRef` both call for a
 * request's auth headers, deciding once, at creation, which of the two
 * strategies this config uses -- never re-decided per request. A bearer
 * config's headers never change, so the returned function always answers
 * the same value; a login config's do, exactly once, which is what `cached`
 * below exists for.
 *
 * `cached` is scoped to this one call, which is scoped to one
 * `createQbittorrentClient` -- one client instance, one login, no matter
 * how many requests a single submission ends up needing (the add, and for
 * a `.torrent` url, the lookup afterwards too). There is deliberately no
 * retry on a stale cookie here, unlike 1.x's `cookieRequest`
 * (`packages/core/src/clients/qbittorrent.ts`), which re-logs-in once
 * because its client is long-lived and a session can expire on the
 * server's own schedule hours into that lifetime. `createDownloadClients`'s
 * `submit` method (`clients/downloads.ts`) builds a fresh adapter per
 * submission, so a client instance here lives exactly one submit and cannot
 * outlive the cookie it obtains
 * within it -- there is no "session expired an hour in" case for a retry to
 * exist for, and a retry loop would be unreachable through any real path.
 * Whoever later caches a client instance across submissions is what
 * invalidates that assumption, and is what would need to add a retry here
 * to match.
 */
function createAuthHeadersResolver(
  config: QbittorrentBearerConfig | QbittorrentLoginConfig,
  loginFetch: typeof globalThis.fetch,
): () => Promise<Record<string, string>> {
  if (config.kind === 'qbittorrent-bearer') {
    const headers = bearerHeaders(config);
    return () => Promise.resolve(headers);
  }

  let cached: Promise<string> | undefined;
  return async () => {
    cached ??= login(config, loginFetch);
    return { Cookie: await cached };
  };
}

/**
 * `''` and the literal text `'None'` both mean "no category assigned" --
 * neither names a real category, no matter how much `'None'` looks like
 * one (design spec §8). A `download_client` row can hold either spelling
 * depending on how it was saved, and conflating one of them with an actual
 * category would go wrong in two different directions: sending `'None'` as
 * `?category=` asks the server for torrents in a category literally named
 * "None" (which may not exist, or worse, may exist and be someone else's),
 * and comparing a response entry's own `''` against a configured `'None'`
 * would never match even though both mean the same absence. Normalising
 * both to `null` before anything compares is what makes every later
 * comparison a single, honest null check.
 *
 * This is deliberately not what `sabnzbd.ts`'s `buildAddUrlUrl` does with
 * its own `config.category` -- that one is sent as-is, unnormalised, and
 * that is correct too (see the comment on its `cat` parameter). The two
 * disagree because the value each is guarding against disagrees: here,
 * `'None'` is a *configured* value this codebase chose to store, a
 * spelling any category-shaped field could pick up by accident; SABnzbd's
 * own `"None"` (1.x's `readCategory`, `packages/core/src/clients/
 * sabnzbd.ts`, ~line 296) is the *server's* vocabulary for "no category" on
 * a queue slot, never a name a maintainer or a config form would have
 * written down for a real category. One is a value worth folding away
 * before comparing; the other is a category name like any other,
 * indistinguishable from a real one at this layer.
 *
 * Also deliberately not merged with `snapshot.ts`'s
 * `normalizeClientCategory`, the read-side counterpart this function's own
 * callers pair with when comparing against a response entry. That one
 * takes `string | null | undefined` because a client's response may omit
 * the field entirely; this one takes plain `string` because `config.
 * category` is a config value that is always present -- adding
 * `undefined` handling here would be handling a case this path cannot
 * produce.
 */
function normalizeCategory(category: string): string | null {
  return category === '' || category === 'None' ? null : category;
}

/**
 * The one field `findRegisteredRef` reads off each `/torrents/info` entry,
 * plus the two it matches on. Every field optional, matching
 * `sabnzbd.ts`'s `AddUrlResponse`: `fetch.json<T>` is an unchecked cast, so
 * declaring a field always-present would not make it present, only move a
 * malformed entry's failure from a value this function already checks to a
 * bare `TypeError` reading past it.
 */
interface TorrentInfoEntry {
  hash?: string;
  name?: string;
  category?: string;
}

/**
 * Guards one request against qBittorrent refusing the bearer token, giving
 * both the add and the lookup below the same translation from a bare
 * 401/403 to a message that names the minimum version -- see
 * `API_KEY_MIN_VERSION`. `path` and `headers` are the caller's own, so the
 * message names whichever endpoint actually failed rather than always
 * naming the add.
 */
async function guardAuthFailure<T>(
  config: QbittorrentBearerConfig | QbittorrentLoginConfig,
  path: string,
  headers: Record<string, string>,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (err) {
    if (err instanceof FetchFailedError && (err.status === 401 || err.status === 403)) {
      if (config.kind === 'qbittorrent-bearer') {
        // Matches 1.x's `keyRequest` intent: an operator on 5.0 or 5.1 has
        // a plausible-looking key the server has no concept of, so naming
        // the minimum version is the only useful thing a bare 401/403
        // could be turned into. `headers` goes through `redactHeaders`
        // even here, where the value sent is not secret information this
        // process didn't already choose to send -- so a later edit adding
        // a second header to this request cannot accidentally start
        // leaking it through this message.
        throw new Error(
          `qbittorrent client ${config.id} refused the api key on ${path} ` +
          `(HTTP ${err.status}), sent as ${JSON.stringify(redactHeaders(headers))}; api key ` +
          `authentication needs qBittorrent ${API_KEY_MIN_VERSION} (WebAPI 2.14.1) or newer -- ` +
          'an older server rejects the header no matter how valid the key is',
          { cause: err },
        );
      }
      // The login strategy's session cookie has stopped being accepted --
      // expired, or revoked server-side. `headers` here is `{ Cookie:
      // <sid> }`, a session token rather than the username/password
      // `login` guards, but it is still not named in this message: there
      // is nothing a maintainer needs from its value, only from the fact
      // that it was refused. No retry: see `createAuthHeadersResolver`
      // for why a fresh login here could only ever run once more against
      // a client instance already past its one submission.
      throw new Error(
        `qbittorrent client ${config.id} was refused on ${path} (HTTP ${err.status}); the ` +
        'session cookie this client logged in with is no longer accepted',
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Finds the torrent a `.torrent` url just added, once its add has
 * registered, matching on category *and* name (design spec §7). Category
 * alone cannot identify it: a category holds many torrents at once, and
 * without a second field, any of them would look like an equally good
 * match. 1.x solves the same problem with a per-installation salted tag
 * (`packages/core/src/clients/qbittorrent.ts`, `addUrl`) -- a marker set at
 * add time that does not depend on metadata ever arriving. 2.0 deliberately
 * drops that tag (#28's per-installation salt existed only to keep two
 * Pickarr installs from adopting each other's jobs, a problem this task
 * does not have), which leaves name as the only field left to distinguish
 * with.
 *
 * Matching on name here is sound for a `.torrent` url, but that is not the
 * only link that reaches this lookup. 1.x's comment above its own
 * `TORRENTS_INFO_PATH` lookup says a name-keyed lookup "would miss
 * intermittently depending on swarm speed", and the reason it gives is
 * magnets: qBittorrent has no metadata for a magnet at add time and
 * reports the infohash as the *name* until it arrives, so the name this
 * adapter sent and the name the server reports can disagree for a while. A
 * `.torrent` file carries its own metadata, so qBittorrent already knows
 * the real name at add time, which is why the trap does not apply there --
 * but `infohashFromMagnet` returns `null` for a magnet it cannot parse (a
 * base32 `btih`, or a v2 `btmh`), and `submit` below routes that `null`
 * straight into this same lookup, on the very name qBittorrent will keep
 * reporting until metadata arrives. This function does not tell the two
 * cases apart -- it cannot, from a name-and-category lookup alone -- so an
 * unmatched magnet is exactly why an unmatched lookup below answers `null`
 * rather than an error: it may simply be too soon.
 *
 * Returns `null`, not an error, for either of two readings that look like
 * failures and are not:
 *
 * - **No match** -- zero entries, or none with this name -- means the add
 *   has not registered with the server yet. The caller leaves the
 *   download `submitting` with no `last_error` so a later retry can find
 *   it; treating this as failed would abandon a download about to appear.
 * - **A hash of all zeros** means qBittorrent has not received this
 *   torrent's metadata yet, so there is nothing to key a reference on. It
 *   is treated exactly like no match at all.
 */
async function findRegisteredRef(
  config: QbittorrentBearerConfig | QbittorrentLoginConfig,
  fetch: QueuedFetch,
  name: string,
  authHeaders: () => Promise<Record<string, string>>,
): Promise<string | null> {
  const category = normalizeCategory(config.category);
  const url = category === null
    ? `${config.baseUrl}${TORRENTS_INFO_PATH}`
    : `${config.baseUrl}${TORRENTS_INFO_PATH}?category=${encodeURIComponent(category)}`;
  const headers = await authHeaders();

  const torrents = await guardAuthFailure(
    config,
    TORRENTS_INFO_PATH,
    headers,
    () => fetch.json<TorrentInfoEntry[]>(url, { headers }),
  );

  const match = torrents.find(
    (torrent) => torrent.name === name && normalizeCategory(torrent.category ?? '') === category,
  );
  if (match === undefined) return null;

  const hash = match.hash;
  if (hash === undefined || hash === '' || isZeroHash(hash)) return null;
  // Lowercased for the same reason `infohashFromMagnet` lowercases: two
  // spellings of one hash are two distinct values to the unique index on
  // (download_client_id, client_ref).
  return hash.toLowerCase();
}

/**
 * True only for qBittorrent's own refusal marker on `/torrents/add`: the
 * literal text `Fails.`, with or without the trailing period, compared
 * trimmed and case-insensitively so trailing whitespace or a differently
 * cased server build cannot hide it. Every other body -- including an
 * empty one, and one this adapter has never seen -- is treated as success.
 * Requiring the body equal `Ok.` instead would fail closed: a server
 * version that answers with wording this adapter does not recognise would
 * then refuse every submission, not only the ones qBittorrent itself
 * refused.
 *
 * 1.x discards this same body (`packages/core/src/clients/qbittorrent.ts`,
 * `addUrl`) and gets away with it, because 1.x always runs a tag lookup
 * afterwards -- an add it can never confirm just stays unconfirmed, never
 * recorded as submitted. The magnet path below deliberately skips that
 * lookup (see `createQbittorrentClient`'s own comment), which is exactly
 * why this body is the only evidence of a refusal left to check -- and
 * checking it costs nothing extra, since it is already in hand.
 */
function isAddRefusalBody(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  return normalized === 'fails.' || normalized === 'fails';
}

/**
 * qBittorrent's adapter, either auth strategy. `/torrents/add` answers with
 * a bare body and no identifier at all -- unlike SABnzbd's `addurl`, there
 * is nothing here to key a reference on. A **v1 hex** magnet solves that for
 * free: it already carries the infohash, and that infohash *is*
 * qBittorrent's own reference, so such a submission is one request and needs
 * no lookup afterwards.
 *
 * Everything else falls through to `findRegisteredRef` above and takes two:
 * a `.torrent` url, which carries no hash of its own to read -- and also any
 * magnet this adapter cannot read a hash out of, which `infohashFromMagnet`
 * reports as `null` (a base32 `btih`, a v2 `btmh`, an all-zero hash). "A
 * magnet is one request" is therefore true of the magnets we can parse, not
 * of magnets; the distinction is `infohashFromMagnet`'s return value, never
 * the `magnet:` scheme.
 *
 * This sidesteps a race 1.x's `addUrl` has to handle
 * (`packages/core/src/clients/qbittorrent.ts`, around its own
 * `TORRENTS_INFO_PATH` lookup): qBittorrent has no metadata at add time and
 * reports the infohash as the *name* until metadata arrives, so a
 * name-keyed (or even tag-keyed) lookup can miss depending on swarm speed.
 * Reading the hash from the link itself never touches that lookup at all --
 * when there is a hash to read. See `findRegisteredRef` for why that same
 * trap does not apply to the `.torrent` path's own name-keyed lookup.
 *
 * `loginFetch` defaults to the real, global `fetch` and is only ever given
 * anything else by a test: it is the one escape from `fetch: QueuedFetch`
 * this function needs, so `login` (via `createAuthHeadersResolver`) can
 * reach a login response's headers, which `QueuedFetch` cannot expose. See
 * `login` for why that request has to bypass the queue in the first place.
 */
export function createQbittorrentClient(
  config: QbittorrentBearerConfig | QbittorrentLoginConfig,
  fetch: QueuedFetch,
  loginFetch: typeof globalThis.fetch = globalThis.fetch,
): { submit(link: string, name: string): Promise<SubmitResult> } {
  const authHeaders = createAuthHeadersResolver(config, loginFetch);

  return {
    async submit(link: string, name: string): Promise<SubmitResult> {
      const infohash = infohashFromMagnet(link);

      const url = `${config.baseUrl}${TORRENTS_ADD_PATH}`;
      const headers = await authHeaders();
      // Normalised on the way *out*, not only on the way back: sending
      // `category=None` would ask qBittorrent to file this torrent under a
      // category literally named "None", creating one on a server that had
      // none. The lookup would still find it -- it normalises the response's
      // category too -- so nothing here would fail, and the only evidence
      // would be a junk category appearing in someone's qBittorrent. Where a
      // value is *sent* matters more than where it is compared.
      //
      // Built in one expression so the parameter order stays `urls`,
      // `category`, `rename` whether or not a category is sent. The order has
      // no effect on the server, but the tests assert the body as a literal
      // string, which is what makes those assertions non-circular.
      const addCategory = normalizeCategory(config.category);
      const body = new URLSearchParams({
        urls: link,
        ...(addCategory === null ? {} : { category: addCategory }),
        rename: name,
      });

      const addBody = await guardAuthFailure(
        config,
        TORRENTS_ADD_PATH,
        headers,
        () => fetch.text(url, { method: 'POST', headers, body }),
      );

      // qBittorrent answers a refused add with HTTP 200, same as its
      // login trap (see `login` above) -- a bad save path, a disk error,
      // or a link it could not parse all come back this way. On the
      // magnet path there is no lookup afterwards to catch that (see
      // `isAddRefusalBody`), so this is the only chance to refuse before
      // the caller records a reference this client does not actually
      // hold.
      if (isAddRefusalBody(addBody)) {
        throw new Error(`qbittorrent client ${config.id} refused the add on ${TORRENTS_ADD_PATH}`);
      }

      if (infohash !== null) {
        return { ref: infohash };
      }

      const ref = await findRegisteredRef(config, fetch, name, authHeaders);
      return { ref };
    },
  };
}
