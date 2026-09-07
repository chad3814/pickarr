import type { QbittorrentBearerConfig } from './config.ts';
import { FetchFailedError } from '../fetch/queue.ts';
import type { QueuedFetch } from '../fetch/queue.ts';
import { redactHeaders } from './redact.ts';
import type { SubmitResult } from './sabnzbd.ts';

/**
 * The version that introduced API key auth (WebAPI 2.14.1). Named because
 * the error message below cites it -- an operator on 5.0 or 5.1 has a
 * plausible-looking key the server has no concept of, and a bare 401 or 403
 * tells them nothing about why. Matches 1.x's own constant
 * (`packages/core/src/clients/qbittorrent.ts`, `API_KEY_MIN_VERSION`).
 */
export const API_KEY_MIN_VERSION = '5.2.0';

const TORRENTS_ADD_PATH = '/api/v2/torrents/add';

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
 * qBittorrent's adapter, bearer-auth branch and magnet path only. `/torrents
 * /add` answers with a bare body and no identifier at all -- unlike
 * SABnzbd's `addurl`, there is nothing here to key a reference on. A magnet
 * link solves that for free: it already carries the infohash, and that
 * infohash *is* qBittorrent's own reference, so a magnet submission is one
 * request and needs no lookup afterwards.
 *
 * This sidesteps a race 1.x's `addUrl` has to handle
 * (`packages/core/src/clients/qbittorrent.ts`, around its own
 * `TORRENTS_INFO_PATH` lookup): qBittorrent has no metadata at add time and
 * reports the infohash as the *name* until metadata arrives, so a
 * name-keyed (or even tag-keyed) lookup can miss depending on swarm speed.
 * Reading the hash from the link itself never touches that lookup at all --
 * which is exactly why a `.torrent` url (Task 7) cannot use this path: it
 * carries no hash of its own to read.
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
      if (infohash === null) {
        // Task 7 replaces this refusal with a real `.torrent` lookup (by
        // tag, following 1.x's reasoning above). Falling through into a
        // lookup that does not exist yet would be worse than refusing by
        // name: it would fail far from this cause, or not at all.
        throw new Error(
          `qbittorrent client ${config.id} was given a link with no readable infohash ` +
          '(not a v1 magnet); the .torrent url path is not wired yet',
        );
      }

      const url = `${config.baseUrl}${TORRENTS_ADD_PATH}`;
      const headers = bearerHeaders(config);
      const body = new URLSearchParams({ urls: link, category: config.category, rename: name });

      try {
        await fetch.text(url, { method: 'POST', headers, body });
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
            `qbittorrent client ${config.id} refused the api key on ${TORRENTS_ADD_PATH} ` +
            `(HTTP ${err.status}), sent as ${JSON.stringify(redactHeaders(headers))}; api key ` +
            `authentication needs qBittorrent ${API_KEY_MIN_VERSION} (WebAPI 2.14.1) or newer -- ` +
            'an older server rejects the header no matter how valid the key is',
            { cause: err },
          );
        }
        throw err;
      }

      return { ref: infohash };
    },
  };
}
