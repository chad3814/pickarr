import type { QbittorrentClientConfig } from '../config/schema.ts';
import { applyPathMappings } from './path-mappings.ts';
import type { ClientSnapshot, DownloadClient, FetchLike } from './types.ts';

const TIMEOUT_MS = 20_000;

/** The version that introduced API key auth. Named because the error message cites it. */
const API_KEY_MIN_VERSION = '5.2.0';

const LOGIN_PATH = '/api/v2/auth/login';
const TORRENTS_INFO_PATH = '/api/v2/torrents/info';

/**
 * One request against the server, already carrying whichever credential the
 * config holds. `body` present means POST, absent means GET. Resolves only
 * for a response the server called successful — every other outcome throws,
 * so no caller has to remember to check `response.ok`.
 */
type Request = (path: string, body?: URLSearchParams) => Promise<Response>;

/**
 * Why an error from `fetchImpl` is reported without a word of its own text,
 * and why there is no redactor in this file.
 *
 * SABnzbd can redact: its api key travels in the query string, so a leak has a
 * delimiter (`?apikey=`) to key a rewrite off, and `clients/sabnzbd.ts` does
 * exactly that — rewrite, then verify, then withhold if verification fails.
 * None of that transfers here. qBittorrent's api key is an
 * `Authorization: Bearer` header and its password is a form body field, and
 * both are handed to `fetchImpl`, which is an injectable seam: an instrumented
 * or proxying wrapper routinely quotes the request — headers and body included
 * — in the error it throws. There is no shape to redact around, so redacting
 * after the fact would protect nothing.
 *
 * The rule this file follows instead is that the credential must never reach
 * an error in the first place: nothing the client throws is built from the
 * headers, the request init, the config, or any text a foreign error wrote.
 * The cost is real — a genuine `ECONNREFUSED` is reduced to "the request
 * failed" — and it is the right trade, because the alternative is a filter
 * that has to anticipate every shape a stranger might quote a header in.
 */
const WITHHELD_REASON =
  'the underlying error is withheld because it can quote the request, and this ' +
  'client sends its credential in a request header and form body';

function requestFailed(path: string): Error {
  // Only `path` — never the full URL. `config.url` is not itself a secret, but
  // keeping the message to strings this file wrote is what makes the rule above
  // checkable by reading it rather than by tracing every input.
  return new Error(`qbittorrent request to ${path} failed: ${WITHHELD_REASON}`);
}

function httpFailed(path: string, status: number): Error {
  // The status and the path, and deliberately not the body: the body is the
  // server's own text, which on an authenticating proxy in front of
  // qBittorrent can echo the credentialed request back at us.
  return new Error(`qbittorrent request to ${path} returned HTTP ${status}`);
}

/**
 * The `SID=...` pair to send back, or null when the response carried none.
 *
 * `getSetCookie()` is the correct reader — `Headers.get('set-cookie')` folds
 * multiple cookies into one comma-joined string — with `get` kept as a
 * fallback for a hand-rolled `Response`-alike that only implements the older
 * shape. Only the `name=value` pair is kept: the attributes (`path`,
 * `HttpOnly`) describe how a browser should store it and are not part of what
 * a `Cookie` request header carries.
 */
function readSidCookie(response: Response): string | null {
  const single = response.headers.get('set-cookie');
  const emitted = response.headers.getSetCookie();
  const candidates = emitted.length > 0 ? emitted : single === null ? [] : [single];
  for (const candidate of candidates) {
    const pair = (candidate.split(';', 1)[0] ?? '').trim();
    if (pair.startsWith('SID=') && pair.length > 'SID='.length) return pair;
  }
  return null;
}

async function send(
  fetchImpl: FetchLike,
  base: string,
  path: string,
  headers: Record<string, string>,
  body: URLSearchParams | undefined,
): Promise<Response> {
  const init: RequestInit =
    body === undefined
      ? { method: 'GET', headers }
      : {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        };
  try {
    return await fetchImpl(`${base}${path}`, init);
  } catch {
    // The thrown value is deliberately not bound: see WITHHELD_REASON. Binding
    // it would put the one object that can carry the credential within reach of
    // whoever next edits this catch.
    throw requestFailed(path);
  }
}

/**
 * The api-key strategy: a bearer header on every request, and nothing else.
 *
 * No login, no cookie, no session and — the part worth stating — no 403
 * re-login branch, because an api key cannot call the auth endpoints at all.
 * A retry there could only ever spend a second request to fail the same way,
 * and it would bury the one message that explains the likely cause.
 */
function keyRequest(fetchImpl: FetchLike, base: string, apiKey: string): Request {
  return async (path, body) => {
    const response = await send(fetchImpl, base, path, { authorization: `Bearer ${apiKey}` }, body);
    if (response.status === 401 || response.status === 403) {
      // An operator on 5.0 or 5.1 has a plausible-looking key that the server
      // has no concept of, and the bare status gives them nothing to go on.
      throw new Error(
        `qbittorrent refused the api key on ${path} (HTTP ${response.status}); api key ` +
          `authentication needs qBittorrent ${API_KEY_MIN_VERSION} (WebAPI 2.14.1) or newer — ` +
          'an older server rejects the header no matter how valid the key is',
      );
    }
    if (!response.ok) throw httpFailed(path, response.status);
    return response;
  };
}

/**
 * The username/password strategy: log in on demand, carry the `SID` cookie,
 * and re-login exactly once when the server stops accepting it.
 *
 * The session expires on the server's schedule, so a 403 on a request that
 * worked an hour ago is routine rather than exceptional. One retry, never a
 * loop: a second 403 means the credentials are being refused, and retrying
 * that is a login storm against a server that has already answered.
 */
function cookieRequest(
  fetchImpl: FetchLike,
  base: string,
  username: string,
  password: string,
): Request {
  let cookie: string | null = null;

  async function login(): Promise<string> {
    const response = await send(
      fetchImpl,
      base,
      LOGIN_PATH,
      {},
      new URLSearchParams({ username, password }),
    );
    if (!response.ok) throw httpFailed(LOGIN_PATH, response.status);

    const sid = readSidCookie(response);
    if (sid === null) {
      // qBittorrent answers a wrong username or password with HTTP 200 and the
      // body `Fails.`, so the absence of the cookie — not the status — is what
      // says the login failed. The body is not read: it is the server's text,
      // and this message can say everything useful without it.
      throw new Error(
        `qbittorrent answered ${LOGIN_PATH} without a SID cookie, which is how it reports a ` +
          'username or password it will not accept',
      );
    }
    cookie = sid;
    return sid;
  }

  return async (path, body) => {
    let response = await send(fetchImpl, base, path, { cookie: cookie ?? (await login()) }, body);
    if (response.status === 403) {
      cookie = null;
      response = await send(fetchImpl, base, path, { cookie: await login() }, body);
      if (response.status === 403) {
        throw new Error(
          `qbittorrent returned HTTP 403 for ${path} again after a fresh login; the configured ` +
            'username and password are being refused',
        );
      }
    }
    if (!response.ok) throw httpFailed(path, response.status);
    return response;
  };
}

export function createQbittorrentClient(
  config: QbittorrentClientConfig,
  fetchImpl: FetchLike = (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
): DownloadClient {
  const base = config.url.replace(/\/+$/, '');

  // The strategy is chosen once, here, rather than branched on per request:
  // the two are different shapes, not one shape with a different credential,
  // and a per-request `if` would put a login and a retry branch on the path
  // that provably cannot use either.
  const { apiKey, username, password } = config;
  let request: Request;
  if (apiKey !== undefined) {
    request = keyRequest(fetchImpl, base, apiKey);
  } else if (username !== undefined && password !== undefined) {
    request = cookieRequest(fetchImpl, base, username, password);
  } else {
    // Unreachable through `parseConfig`, which settles that exactly one
    // credential is present. Stated anyway, because the alternative to stating
    // it is a `?? ''` that logs in as the empty user and reports the result as
    // a 403 — the credential check happening at the first request, an hour into
    // a run, which is exactly what `parseConfig` moved to boot time.
    throw new Error(
      `Download client ${config.id} has neither an apiKey nor a username and password`,
    );
  }

  return {
    id: config.id,
    importMode: config.importMode,
    category: config.category,

    // No `remove`. qBittorrent's /torrents/delete drops the job whether or not
    // files are deleted, which stops the seed and abandons the ratio — see
    // `DownloadClient.remove` for why the method is absent rather than present
    // and refusing.

    addUrl(): Promise<string> {
      throw new Error('qbittorrent: submitting a download is not wired up yet');
    },

    async snapshot(): Promise<ClientSnapshot> {
      // One unfiltered GET, matching the contract that a snapshot is everything
      // the server holds so `complete` can mean something.
      const response = await request(TORRENTS_INFO_PATH);

      // Draining is not optional even though nothing reads the body yet: an
      // unconsumed `Response` body keeps its socket checked out of undici's
      // connection pool for the lifetime of the process.
      await response.text();

      // Reading those torrents into queue and history entries — the state
      // table — is the change that follows this one. Until it lands the
      // snapshot reports itself incomplete, which is the safe half of the
      // contract: an incomplete snapshot may advance rows it contains, and may
      // never be read as an absence.
      return { queue: [], history: [], complete: false };
    },

    mapPath(clientPath) {
      return applyPathMappings(config.pathMappings, clientPath);
    },
  };
}
