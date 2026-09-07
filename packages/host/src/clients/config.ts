import type { DatabaseSync } from 'node:sqlite';

/** The transport a `download_client` row moves picks over. */
export type ClientType = 'torrent' | 'nzb';

/** The product behind a `download_client` row, distinct from `ClientType` (see `schema.ts`). */
export type Implementation = 'qbittorrent' | 'sabnzbd';

/** SABnzbd has one auth strategy: an api key, always. */
export interface SabnzbdConfig {
  kind: 'sabnzbd';
  id: number;
  baseUrl: string;
  apiKey: string;
  category: string;
}

/** qBittorrent's modern auth strategy: an api key sent as a bearer token. */
export interface QbittorrentBearerConfig {
  kind: 'qbittorrent-bearer';
  id: number;
  baseUrl: string;
  apiKey: string;
  category: string;
}

/** qBittorrent's legacy auth strategy: a form-posted username and password. */
export interface QbittorrentLoginConfig {
  kind: 'qbittorrent-login';
  id: number;
  baseUrl: string;
  username: string;
  password: string;
  category: string;
}

/**
 * A `download_client` row, decided down to its auth strategy. `kind` is not
 * `implementation` restated -- qBittorrent alone has two entries here,
 * because which credential it authenticates with is exactly the fact an
 * adapter must not re-derive on every request. Deciding it once, here, means
 * a request handler switches on `kind` and finds every field its branch
 * needs already present and already typed, rather than re-inspecting
 * `apiKey`/`username`/`password` for itself each time it runs.
 */
export type ClientConfig = SabnzbdConfig | QbittorrentBearerConfig | QbittorrentLoginConfig;

const IMPLEMENTATIONS: readonly Implementation[] = ['qbittorrent', 'sabnzbd'];

function isImplementation(value: string): value is Implementation {
  return (IMPLEMENTATIONS as readonly string[]).includes(value);
}

/**
 * The columns `readClientConfig` needs from `download_client`, narrowed once
 * per call rather than the row's shape being asserted wholesale -- each
 * field is pulled through its own `unknown`-typed accessor, the same idiom
 * `feeds/reader.ts`'s `feedRow` uses, so nothing here assumes the database
 * handed back a `SomeRow`-shaped value it never actually validated.
 *
 * `apiKey`, `username` and `password` are normalised the other way: the
 * columns are nullable, and an empty string is folded to `null` because for
 * a credential the two mean the same thing -- neither can authenticate
 * anything. `''` is what a blank form field saves as, so without this fold
 * a client configured with an empty api key would read as a perfectly valid
 * bearer config and then fail on every request with the client's own opaque
 * 401 -- exactly the failure-far-from-its-cause this function exists to
 * prevent.
 */
interface ClientRow {
  id: number;
  name: string;
  type: string;
  implementation: string;
  baseUrl: string;
  apiKey: string | null;
  username: string | null;
  password: string | null;
  category: string;
}

/**
 * Normalises one credential column. An absent credential and a blank one are
 * the same fact -- neither authenticates anything -- so both arrive as
 * `null` and every "has one" check downstream is a single null check.
 */
function credential(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

function readRow(raw: DatabaseSync, clientId: number): ClientRow {
  const row = raw.prepare(
    'SELECT id, name, type, implementation, url, api_key, username, password, category FROM download_client WHERE id = ?',
  ).get(clientId);
  if (!row) {
    throw new Error(`download client ${clientId} not found`);
  }
  const apiKey = (row as { api_key: unknown }).api_key;
  const username = (row as { username: unknown }).username;
  const password = (row as { password: unknown }).password;
  return {
    id: Number((row as { id: unknown }).id),
    name: String((row as { name: unknown }).name),
    type: String((row as { type: unknown }).type),
    implementation: String((row as { implementation: unknown }).implementation),
    baseUrl: String((row as { url: unknown }).url),
    apiKey: credential(apiKey),
    username: credential(username),
    password: credential(password),
    category: String((row as { category: unknown }).category),
  };
}

/**
 * Reads one `download_client` row into a `ClientConfig`, deciding its auth
 * strategy once here rather than leaving every caller to re-derive it.
 *
 * Two refusals happen at read time rather than at first submission:
 *
 * - `type`/`implementation` mismatch (a `torrent` row naming `sabnzbd`, or
 *   an `nzb` row naming `qbittorrent`) can never work, and finding that out
 *   here puts the failure next to its cause instead of at the far end of a
 *   submit call.
 * - qBittorrent with neither an api key nor a username and password has no
 *   way to authenticate at all, so there is nothing a request could still
 *   attempt.
 *
 * Every message below names the client's id (and, where already in hand,
 * its name) and the *value* that is wrong -- never the row, and never a
 * field that could hold a credential. `api_key`/`username`/`password`
 * appear in a thrown message only as the word "api key" or "username", the
 * label, never the row's value for it.
 */
export function readClientConfig(raw: DatabaseSync, clientId: number): ClientConfig {
  const row = readRow(raw, clientId);
  const implementation = row.implementation;

  if (!isImplementation(implementation)) {
    // The value alone, never the row: serialising the row would print
    // whatever api_key/username/password it holds alongside it.
    throw new Error(
      `download client ${row.id} has unknown implementation ${JSON.stringify(implementation)}`,
    );
  }

  switch (implementation) {
    case 'sabnzbd': {
      if (row.type !== 'nzb') {
        throw new Error(
          `download client ${row.id} (${row.name}) has type ${JSON.stringify(row.type)} ` +
          `but implementation 'sabnzbd', which cannot work`,
        );
      }
      if (row.apiKey === null) {
        throw new Error(`download client ${row.id} (${row.name}) is sabnzbd but has no api key`);
      }
      return { kind: 'sabnzbd', id: row.id, baseUrl: row.baseUrl, apiKey: row.apiKey, category: row.category };
    }
    case 'qbittorrent': {
      if (row.type !== 'torrent') {
        throw new Error(
          `download client ${row.id} (${row.name}) has type ${JSON.stringify(row.type)} ` +
          `but implementation 'qbittorrent', which cannot work`,
        );
      }
      // An api key present decides the strategy outright: qBittorrent's
      // bearer auth is the modern path, so a row that has a key uses it
      // even if a stale username/password also happens to be present.
      if (row.apiKey !== null) {
        return {
          kind: 'qbittorrent-bearer', id: row.id, baseUrl: row.baseUrl, apiKey: row.apiKey, category: row.category,
        };
      }
      if (row.username !== null && row.password !== null) {
        return {
          kind: 'qbittorrent-login',
          id: row.id,
          baseUrl: row.baseUrl,
          username: row.username,
          password: row.password,
          category: row.category,
        };
      }
      throw new Error(
        `download client ${row.id} (${row.name}) is qbittorrent but has neither an api key ` +
        `nor a username and password`,
      );
    }
    default: {
      // Unreachable given today's two-member `Implementation` union --
      // `isImplementation` above already refused anything else. Kept so
      // that adding a third implementation without adding a case here fails
      // to compile instead of falling through silently.
      const impossible: never = implementation;
      throw new Error(
        `download client ${row.id} has unknown implementation ${JSON.stringify(String(impossible))}`,
      );
    }
  }
}
