import type { DatabaseSync } from 'node:sqlite';
import type { Secrets } from '../secrets/instance.ts';

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
 *
 * `apiKey` and `password` carry the **resolved credential**, not the name the
 * row holds -- the indirection migration 14 introduced stops here, so no
 * adapter had to change when it landed.
 */
export type ClientConfig = SabnzbdConfig | QbittorrentBearerConfig | QbittorrentLoginConfig;

const IMPLEMENTATIONS: readonly Implementation[] = ['qbittorrent', 'sabnzbd'];

/**
 * Whether `value` names one of the products this host can drive.
 *
 * Exported for `clients/add.ts`, the writer: the reader and the writer
 * agreeing on what an implementation is has to be one list, not two. A
 * second copy over there would let a third implementation be *accepted* by
 * one and rejected by the other, which reads as "the client saved and then
 * vanished".
 */
export function isImplementation(value: string): value is Implementation {
  return (IMPLEMENTATIONS as readonly string[]).includes(value);
}

/**
 * The columns `readClientConfig` needs from `download_client`, narrowed once
 * per call rather than the row's shape being asserted wholesale -- each
 * field is pulled through its own `unknown`-typed accessor, the same idiom
 * `feeds/reader.ts`'s `feedRow` uses, so nothing here assumes the database
 * handed back a `SomeRow`-shaped value it never actually validated.
 *
 * **Since migration 14 this row holds no credential.**
 * `api_key_secret_name` and `password_secret_name` hold the *name* of a
 * secret -- a `randomUUID()` for a credential the migration moved, or
 * whatever an operator chose -- and the value lives in `secret` alone. A
 * name is safe to log; `readClientConfig` resolves it and the resolved value
 * is what must not be. `username` is plaintext, because a username is not a
 * credential.
 *
 * The three are normalised the other way: the columns are nullable, and an
 * empty string is folded to `null` because for a name the two mean the same
 * thing -- neither addresses a credential. `''` is what a blank form field
 * saves as, so without this fold a client configured with an empty api key
 * would read as a perfectly valid bearer config and then fail on a lookup of
 * the empty name, three links from "you did not configure an api key" --
 * exactly the failure-far-from-its-cause this function exists to prevent.
 */
interface ClientRow {
  id: number;
  name: string;
  type: string;
  implementation: string;
  baseUrl: string;
  apiKeySecretName: string | null;
  username: string | null;
  passwordSecretName: string | null;
  category: string;
}

/**
 * Normalises one nullable text column. An absent secret name and a blank one
 * are the same fact -- neither addresses a credential -- so both arrive as
 * `null` and every "has one" check downstream is a single null check. The
 * same holds for `username`: a blank one is not half of a usable pair.
 */
function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

function readRow(raw: DatabaseSync, clientId: number): ClientRow {
  const row = raw.prepare(
    'SELECT id, name, type, implementation, url, api_key_secret_name, username, password_secret_name, category '
    + 'FROM download_client WHERE id = ?',
  ).get(clientId);
  if (!row) {
    throw new Error(`download client ${clientId} not found`);
  }
  const apiKeySecretName = (row as { api_key_secret_name: unknown }).api_key_secret_name;
  const username = (row as { username: unknown }).username;
  const passwordSecretName = (row as { password_secret_name: unknown }).password_secret_name;
  return {
    id: Number((row as { id: unknown }).id),
    name: String((row as { name: unknown }).name),
    type: String((row as { type: unknown }).type),
    implementation: String((row as { implementation: unknown }).implementation),
    baseUrl: String((row as { url: unknown }).url),
    apiKeySecretName: optionalText(apiKeySecretName),
    username: optionalText(username),
    passwordSecretName: optionalText(passwordSecretName),
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
 * **The strategy is decided on a name, and only then is a secret resolved.**
 * Which credential a qBittorrent row authenticates with is settled by
 * whether `api_key_secret_name` is present -- exactly as it used to be
 * settled by whether `api_key` was -- so the decision needs no lookup at
 * all. Resolving after choosing means one `Secrets.get` per read, for the
 * one credential the chosen strategy will actually send, and a stale name
 * for the strategy *not* chosen cannot fail a read that would never have
 * used it.
 *
 * Every message below names the client's id (and, where already in hand,
 * its name) and the *value* that is wrong -- never the row. Since migration
 * 14 the row holds secret *names* rather than credentials, and a name is
 * safe to name; the resolved credential is what must never reach a message,
 * and it exists only in the returned config. `username` is plaintext and
 * still stays out of every message: `api_key`/`username`/`password` appear
 * in a thrown message only as the words "api key" or "username", the label,
 * never a value.
 */
export async function readClientConfig(
  raw: DatabaseSync,
  clientId: number,
  secrets: Secrets,
): Promise<ClientConfig> {
  const row = readRow(raw, clientId);
  const implementation = row.implementation;

  if (!isImplementation(implementation)) {
    // The value alone, never the row: serialising the row would print its
    // username, and a row's contents are nobody's business in an error even
    // now that the credentials themselves have moved out of it.
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
      if (row.apiKeySecretName === null) {
        throw new Error(`download client ${row.id} (${row.name}) is sabnzbd but has no api key`);
      }
      return {
        kind: 'sabnzbd',
        id: row.id,
        baseUrl: row.baseUrl,
        apiKey: await secrets.get(row.apiKeySecretName),
        category: row.category,
      };
    }
    case 'qbittorrent': {
      if (row.type !== 'torrent') {
        throw new Error(
          `download client ${row.id} (${row.name}) has type ${JSON.stringify(row.type)} ` +
          `but implementation 'qbittorrent', which cannot work`,
        );
      }
      // An api key *name* present decides the strategy outright: qBittorrent's
      // bearer auth is the modern path, so a row that has one uses it even if
      // a stale username and password name also happen to be present. The
      // name settles it, so nothing is resolved to reach this decision, and
      // the password name of the strategy not chosen is never looked up.
      if (row.apiKeySecretName !== null) {
        return {
          kind: 'qbittorrent-bearer',
          id: row.id,
          baseUrl: row.baseUrl,
          apiKey: await secrets.get(row.apiKeySecretName),
          category: row.category,
        };
      }
      if (row.username !== null && row.passwordSecretName !== null) {
        return {
          kind: 'qbittorrent-login',
          id: row.id,
          baseUrl: row.baseUrl,
          username: row.username,
          password: await secrets.get(row.passwordSecretName),
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
