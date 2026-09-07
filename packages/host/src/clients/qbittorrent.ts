import type { QbittorrentBearerConfig } from './config.ts';
import { FetchFailedError } from '../fetch/queue.ts';
import type { QueuedFetch } from '../fetch/queue.ts';
import { redactHeaders } from './redact.ts';
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

/**
 * Matches `xt=urn:btih:<40 hex chars>` in a magnet link's query, the way
 * `redact.ts`'s own patterns key off `[?&]` rather than assuming which
 * parameter comes first. Deliberately narrow: a base32 `btih` (32
 * characters, not hex) and a v2 `btmh` magnet both fail to match, on
 * purpose -- `infohashFromMagnet` returns `null` for either, and `submit`
 * below refuses rather than passing a non-infohash value on as if it were
 * one. The trailing `(?![0-9a-fA-F])` stops a 41st hex character from being
 * silently dropped instead of making the match fail.
 */
const MAGNET_BTIH_PATTERN = /[?&]xt=urn:btih:([0-9a-fA-F]{40})(?![0-9a-fA-F])/i;

/**
 * The infohash from a magnet link, or `null` when the link is not a v1
 * hex-encoded magnet -- including a base32 `btih` or a v2 `btmh` magnet,
 * neither of which this returns a value for. Callers must not treat `null`
 * as "close enough": `submit` below refuses rather than guessing.
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
  return hash.toLowerCase();
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
 */
function normalizeCategory(category: string): string | null {
  return category === '' || category === 'None' ? null : category;
}

/**
 * True for a hash that is all zeros, at any length -- qBittorrent pads a
 * torrent's hash with zeros while its metadata is still arriving, and the
 * padding width is not a value this adapter should have to know. A hash
 * this shape identifies nothing yet; treating it as a hash of any other
 * value would record a reference this torrent does not actually have.
 */
function isZeroHash(hash: string): boolean {
  return hash !== '' && /^0+$/.test(hash);
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
  config: QbittorrentBearerConfig,
  path: string,
  headers: Record<string, string>,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (err) {
    if (err instanceof FetchFailedError && (err.status === 401 || err.status === 403)) {
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
 * Matching on name here does **not** repeat 1.x's own warning about doing
 * exactly that. 1.x's comment above its `TORRENTS_INFO_PATH` lookup says a
 * name-keyed lookup "would miss intermittently depending on swarm speed",
 * and the reason it gives is magnets: qBittorrent has no metadata for a
 * magnet at add time and reports the infohash as the *name* until it
 * arrives, so the name this adapter sent and the name the server reports
 * can disagree for a while. A `.torrent` file carries its own metadata, so
 * qBittorrent already knows the real name at add time -- the trap is
 * specific to magnets, and `createQbittorrentClient`'s magnet path (above)
 * performs no lookup at all, so it never meets this code either. Name
 * matching is sound exactly where it is used here.
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
  config: QbittorrentBearerConfig,
  fetch: QueuedFetch,
  name: string,
): Promise<string | null> {
  const category = normalizeCategory(config.category);
  const url = category === null
    ? `${config.baseUrl}${TORRENTS_INFO_PATH}`
    : `${config.baseUrl}${TORRENTS_INFO_PATH}?category=${encodeURIComponent(category)}`;
  const headers = bearerHeaders(config);

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
 * qBittorrent's adapter, bearer-auth branch only. `/torrents/add` answers
 * with a bare body and no identifier at all -- unlike SABnzbd's `addurl`,
 * there is nothing here to key a reference on. A magnet link solves that
 * for free: it already carries the infohash, and that infohash *is*
 * qBittorrent's own reference, so a magnet submission is one request and
 * needs no lookup afterwards. A `.torrent` url carries no hash of its own
 * to read, so its `submit` falls through to `findRegisteredRef` above
 * instead.
 *
 * This sidesteps a race 1.x's `addUrl` has to handle
 * (`packages/core/src/clients/qbittorrent.ts`, around its own
 * `TORRENTS_INFO_PATH` lookup): qBittorrent has no metadata at add time and
 * reports the infohash as the *name* until metadata arrives, so a
 * name-keyed (or even tag-keyed) lookup can miss depending on swarm speed.
 * Reading the hash from the link itself never touches that lookup at all.
 * See `findRegisteredRef` for why that same trap does not apply to the
 * `.torrent` path's own name-keyed lookup.
 *
 * Takes `QbittorrentBearerConfig` only. The login strategy
 * (`QbittorrentLoginConfig`) is a second, separate branch this function does
 * not implement -- Task 8 widens the parameter type to add it.
 */
export function createQbittorrentClient(
  config: QbittorrentBearerConfig,
  fetch: QueuedFetch,
): { submit(link: string, name: string): Promise<SubmitResult> } {
  return {
    async submit(link: string, name: string): Promise<SubmitResult> {
      const infohash = infohashFromMagnet(link);

      const url = `${config.baseUrl}${TORRENTS_ADD_PATH}`;
      const headers = bearerHeaders(config);
      const body = new URLSearchParams({ urls: link, category: config.category, rename: name });

      await guardAuthFailure(
        config,
        TORRENTS_ADD_PATH,
        headers,
        () => fetch.text(url, { method: 'POST', headers, body }),
      );

      if (infohash !== null) {
        return { ref: infohash };
      }

      const ref = await findRegisteredRef(config, fetch, name);
      return { ref };
    },
  };
}
