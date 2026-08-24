import type { QbittorrentClientConfig } from '../config/schema.ts';
import { asJsonArray, asJsonObject, asText, type JsonValue } from '../json.ts';
import { applyPathMappings } from './path-mappings.ts';
import type {
  ClientHistoryEntry,
  ClientQueueEntry,
  ClientSnapshot,
  DownloadClient,
  FetchLike,
} from './types.ts';

const TIMEOUT_MS = 20_000;

/** The version that introduced API key auth. Named because the error message cites it. */
const API_KEY_MIN_VERSION = '5.2.0';

const LOGIN_PATH = '/api/v2/auth/login';
const TORRENTS_INFO_PATH = '/api/v2/torrents/info';
const TORRENTS_ADD_PATH = '/api/v2/torrents/add';

/**
 * Where each qBittorrent state lands. An explicit table with a warning for
 * anything outside it, the same discipline `historyOutcome` in sabnzbd.ts
 * follows and for the same reason: reading an unknown state as a failure is
 * what marked ordinary multi-part downloads failed while SABnzbd was still
 * unpacking them.
 *
 * Both `paused*` and `stopped*` are here, and the documentation did not settle
 * which is right. The WebUI API 5.0 wiki lists `pausedUP`/`pausedDL` and does
 * not mention `stopped*`; qBittorrent 5.0 renamed the concept to Stop in its
 * user interface and the docs do not say whether the API followed. Two extra
 * rows against a completed torrent reading as unrecognised is not a close call.
 * Trim this once a real server has answered — the warning below is what tells
 * you which it emits.
 *
 * A seeding torrent is `completed`: from Pickarr's side the download finished
 * when the data arrived, and that the client goes on uploading is the client's
 * business. Reading `uploading` as queue would leave the row downloading
 * forever.
 */
const STATE_READING: Record<string, 'queue' | 'completed' | 'failed'> = {
  downloading: 'queue', metaDL: 'queue', stalledDL: 'queue', queuedDL: 'queue',
  forcedDL: 'queue', allocating: 'queue', checkingDL: 'queue',
  checkingResumeData: 'queue', moving: 'queue', pausedDL: 'queue', stoppedDL: 'queue',
  uploading: 'completed', stalledUP: 'completed', queuedUP: 'completed',
  forcedUP: 'completed', checkingUP: 'completed', pausedUP: 'completed',
  stoppedUP: 'completed',
  error: 'failed', missingFiles: 'failed',
};

/**
 * States `STATE_READING` has not seen before. A `Set` rather than one
 * `resetReconcileWarningsForTests`-style boolean: the table above is
 * deliberately uncertain about two spellings at once (`paused*` vs
 * `stopped*`), so more than one unrecognised state could plausibly turn up in
 * one run, and each deserves its own first mention rather than the first one
 * ever silencing the rest.
 */
const warnedStates = new Set<string>();

/**
 * Test-only escape hatch, mirroring `resetReconcileWarningsForTests` in
 * `pipeline/reconcile.ts`: node:test runs every test in one file inside a
 * single process/module instance, so the "already warned" set above persists
 * across tests unless a test resets it first.
 */
export function resetQbittorrentWarningsForTests(): void {
  warnedStates.clear();
}

/**
 * The reading for `state`, warning once per process (per unrecognised state,
 * not globally) when it is not in `STATE_READING`. `queue` is the reading
 * that changes nothing about a row Pickarr already has: `ClientSnapshot` is
 * explicit that a snapshot may never be used to conclude absence, and `queue`
 * is the one reading that cannot be mistaken for either kind of conclusion —
 * unlike `failed`, which is exactly the wrong guess that turned ordinary
 * SABnzbd downloads into false failures while they were still unpacking.
 */
function readState(state: string): 'queue' | 'completed' | 'failed' {
  const reading = STATE_READING[state];
  if (reading !== undefined) return reading;
  if (!warnedStates.has(state)) {
    warnedStates.add(state);
    console.warn(
      `pickarr: qbittorrent reported torrent state '${state}', which is not in STATE_READING ` +
        '(clients/qbittorrent.ts); reading it as queue rather than risking a false failure. If ' +
        'this is a real qBittorrent state — most plausibly whichever of paused*/stopped* the ' +
        'table above turns out not to need — add it to STATE_READING.',
    );
  }
  return 'queue';
}

/**
 * `category` arrives as the empty string when a torrent carries none — never
 * an absent field. See `ClientQueueEntry.category` for why every client
 * normalises its own spelling of "no category" to `null` here rather than
 * leaving it to whoever compares against a real category name later.
 */
function readCategory(category: string): string | null {
  return category === '' ? null : category;
}

/**
 * `progress` arrives as a fraction (0-1), not a whole percentage: unlike
 * `content_path` and `category`, there is no sentinel to normalise, only a
 * shape a malformed response could fail to have. Unreadable reads as 0 rather
 * than throwing — a torrent this shape does not describe is not a reason to
 * fail the whole snapshot.
 */
function readProgress(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

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
 * `getSetCookie()` is the only reader, and the only correct one:
 * `Headers.get('set-cookie')` folds every cookie in the response into one
 * comma-joined string, which cannot be split back apart safely because cookie
 * values may themselves contain commas. There is no `get` fallback — `FetchLike`
 * is typed to return a real `Response`, so a reader that only exists for a
 * hypothetical `Response`-alike would be dead code that the line above it would
 * have thrown before reaching anyway.
 *
 * Only the `name=value` pair is kept: the attributes (`path`, `HttpOnly`)
 * describe how a browser should store the cookie and are not part of what a
 * `Cookie` request header carries.
 */
function readSidCookie(response: Response): string | null {
  for (const candidate of response.headers.getSetCookie()) {
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

  /**
   * GETs `path` through `request` — so it carries the same credential and
   * 403-retry handling as every other call — and parses the body as JSON.
   */
  async function json(path: string): Promise<JsonValue> {
    const response = await request(path);
    return (await response.json()) as JsonValue;
  }

  return {
    id: config.id,
    importMode: config.importMode,
    category: config.category,

    // No `remove`. qBittorrent's /torrents/delete drops the job whether or not
    // files are deleted, which stops the seed and abandons the ratio — see
    // `DownloadClient.remove` for why the method is absent rather than present
    // and refusing.

    async addUrl(url: string, name: string, label: string): Promise<string> {
      await request(TORRENTS_ADD_PATH, new URLSearchParams({
        urls: url,
        category: config.category,
        rename: name,
        tags: label,
      }));

      // The tag identifies the job, not the name, and the reason is magnets:
      // qBittorrent has no metadata at add time and reports the infohash as the
      // name until it arrives (the `metaDL` state), so a lookup keyed on the
      // name we sent would miss intermittently depending on swarm speed. A tag
      // is set at add time and does not depend on metadata.
      //
      // The marker is per-installation salted (#28), so two Pickarr instances
      // against one qBittorrent do not read each other's torrents.
      const found = asJsonArray(await json(`${TORRENTS_INFO_PATH}?tag=${encodeURIComponent(label)}`));
      const first = asJsonObject(found[0]);
      if (found.length !== 1 || first === null) {
        // Zero means the add has not registered yet — recoverable, because the
        // next reconcile finds the job by its marker and adopts it. Two means
        // two downloads share a marker, which is a bug elsewhere and must not
        // be resolved by picking arbitrarily.
        throw new Error(
          `qbittorrent: expected exactly one torrent tagged ${label}, found ${found.length}`,
        );
      }
      return asText(first['hash']);
    },

    async snapshot(): Promise<ClientSnapshot> {
      // One unfiltered GET, matching the contract that a snapshot is everything
      // the server holds so `complete` can mean something.
      const torrents = asJsonArray(await json(TORRENTS_INFO_PATH));

      const queue: ClientQueueEntry[] = [];
      const history: ClientHistoryEntry[] = [];

      for (const raw of torrents) {
        const torrent = asJsonObject(raw);
        if (torrent === null) continue;

        const ref = asText(torrent['hash']);
        if (ref === '') continue;

        const name = asText(torrent['name']);
        const category = readCategory(asText(torrent['category']));
        const state = asText(torrent['state']);
        const reading = readState(state);

        if (reading === 'queue') {
          queue.push({
            ref,
            name,
            // 0-1 from the wire, 0-100 on the interface — see readProgress and
            // ClientQueueEntry.percentage's consumers (sabnzbd.ts parses an
            // int; Downloads.tsx renders `{percentage}%`).
            percentage: Math.round(readProgress(torrent['progress']) * 100),
            category,
          });
          continue;
        }

        history.push({
          ref,
          name,
          category,
          outcome: reading,
          // `content_path`, not `save_path`: `save_path` is the containing
          // directory qBittorrent downloads into, `content_path` is this
          // torrent's own file or folder within it — what the importer needs
          // to list. Only set for a completed entry, matching sabnzbd.ts's
          // `storagePath`: a failed job has nothing worth pointing an import at.
          storagePath: reading === 'completed' ? asText(torrent['content_path']) || null : null,
          failMessage: reading === 'failed' ? `qbittorrent reports state '${state}'` : null,
        });
      }

      // Unlike SABnzbd's history, there is no paging here and no reported
      // total to compare the returned count against: `/torrents/info` with no
      // filter answers with everything in one response, so a successful
      // request is, by construction, complete.
      return { queue, history, complete: true };
    },

    mapPath(clientPath) {
      return applyPathMappings(config.pathMappings, clientPath);
    },
  };
}
