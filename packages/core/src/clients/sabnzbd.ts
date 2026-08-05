import type { DownloadClientConfig } from '../config/schema.ts';
import {
  asJsonArray as asArray,
  asJsonObject as asRecord,
  asText as text,
  type JsonValue,
} from '../json.ts';
import type {
  ClientHistoryEntry,
  ClientQueueEntry,
  ClientSnapshot,
  DownloadClient,
  FetchLike,
} from './types.ts';

const TIMEOUT_MS = 20_000;

/**
 * What a string becomes when redaction cannot produce a version of it that is
 * *provably* free of the api key.
 *
 * This is the load-bearing idea in this file. Rewriting a secret out of text
 * somebody else wrote is a blocklist, and a blocklist has to anticipate every
 * shape the secret might take; three previous attempts at this each closed one
 * shape and left another open. So the rewrite is no longer trusted on its own:
 * whatever it produces is checked, and text that still yields the key under
 * routine decoding is dropped whole rather than emitted. Failing to anticipate
 * an encoding then costs a diagnostic, not the key.
 */
const WITHHELD = '[withheld: carried the api key in a form this client will not rewrite]';

/**
 * How many rounds of decoding a consumer is assumed to be willing to apply.
 * Each round can percent-decode and/or form-decode, so this covers
 * multiply-encoded text; four is far past anything a real client or log
 * pipeline does and the search terminates as soon as decoding stops changing
 * the string, which is after one round for ordinary text.
 */
const MAX_DECODE_ROUNDS = 4;

/**
 * Strips the value of an `apikey` query parameter wherever one appears in a
 * string, regardless of how the value itself is encoded. This is what keeps
 * the common case (a URL echoed back at us) legible, because it keys off the
 * structural delimiters (`?`/`&` before, `&`/whitespace/end-of-string after)
 * rather than the literal value. It is not, on its own, a safety guarantee —
 * it only fires where those delimiters survive.
 */
function redactApiKeyParam(message: string): string {
  return message.replace(/([?&]apikey=)[^&\s]*/gi, '$1***');
}

/**
 * Decodes each maximal run of `%XX` escapes, leaving anything undecodable
 * alone. Deliberately not a plain `decodeURIComponent` on the whole string:
 * that throws on a lone `%` (routine in stack traces and Windows paths), and a
 * check that can be switched off by prefixing one `%` is not a check.
 */
function percentDecode(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Every reading of `value` that a consumer could arrive at with routine
 * decoding — repeated percent-decoding, `+`-for-space form decoding (which
 * `decodeURIComponent` does not do, and which `URLSearchParams` produces for
 * any key containing a space), and any interleaving of the two.
 *
 * This is the definition of "recoverable" the safety check below is stated
 * against. It does not cover an actively hostile peer that re-encodes the key
 * in a scheme of its own invention (base64, a cipher); no in-band filter can.
 */
function decodings(value: string): Set<string> {
  const views = new Set<string>([value]);
  let frontier = [value];
  for (let round = 0; round < MAX_DECODE_ROUNDS && frontier.length > 0; round += 1) {
    const next: string[] = [];
    for (const view of frontier) {
      for (const candidate of [percentDecode(view), view.replaceAll('+', ' ')]) {
        if (!views.has(candidate)) {
          views.add(candidate);
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }
  return views;
}

export function createSabnzbdClient(
  config: DownloadClientConfig,
  fetchImpl: FetchLike = (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
): DownloadClient {
  const base = config.url.replace(/\/+$/, '');

  /** Never include the built URL in an error — it carries the api key. */
  function endpoint(params: Record<string, string>): string {
    const query = new URLSearchParams({ ...params, apikey: config.apiKey, output: 'json' });
    return `${base}/api?${query.toString()}`;
  }

  /**
   * The spellings of the key this client knows how to rewrite in place: as
   * written, percent-encoded, and form-encoded (which differs from
   * percent-encoding for a key containing a space — `+` versus `%20`, and
   * `URLSearchParams` emits the former). Anything outside this set is caught
   * by carriesSecret and costs the whole string, so this list exists for
   * legibility, not for safety. An empty key is not a secret and is filtered
   * out, which also stops `replaceAll('', ...)` splicing `***` between every
   * character.
   */
  const spellings = [
    ...new Set([
      config.apiKey,
      encodeURIComponent(config.apiKey),
      new URLSearchParams({ apikey: config.apiKey }).toString().slice('apikey='.length),
    ]),
  ].filter((spelling) => spelling.length > 0);

  /**
   * Rewrites the spellings above wherever they appear, including outside a
   * query string — inside an error's `name`, a bracketed URL, a sentence.
   */
  function redactKnownSpellings(message: string): string {
    let out = message;
    for (const spelling of spellings) out = out.replaceAll(spelling, '***');
    return out;
  }

  /**
   * The safety predicate: can the key be read out of this text by anyone
   * willing to decode it? Everything the client emits is checked against this
   * *after* rewriting, so the guarantee does not depend on the rewrite having
   * anticipated the right encoding.
   */
  function carriesSecret(message: string): boolean {
    if (config.apiKey.length === 0) return false;
    for (const view of decodings(message)) {
      if (view.includes(config.apiKey)) return true;
    }
    return false;
  }

  /**
   * The one door every string the client did not write itself passes through
   * before it can reach a message, a return value, or a caller's log. Rewrite
   * first for legibility, then verify; withhold if verification fails.
   */
  function redact(message: string): string {
    const rewritten = redactKnownSpellings(redactApiKeyParam(message));
    return carriesSecret(rewritten) ? WITHHELD : rewritten;
  }

  /** `asText`, but nothing comes out of a response body unredacted. */
  function safeText(value: JsonValue | undefined): string {
    return redact(text(value));
  }

  /**
   * Wraps an error from an injectable dependency (fetchImpl itself, or a
   * Response's .json()) so nothing it says can leak the api key. The
   * property must hold regardless of how a caller ends up logging or
   * inspecting the resulting error — via .message, String(error),
   * error.cause, or util.inspect — so the original is never attached
   * verbatim as `cause`; a redacted stand-in is attached instead. Both
   * `.message` and `.name` are redacted: nothing copied off an untrusted
   * error may skip the redactor, since either field can carry the key.
   */
  function sanitize(prefix: string, error: Error): Error {
    const sanitizedCause = new Error(redact(error.message));
    sanitizedCause.name = redact(error.name);
    return new Error(prefix, { cause: sanitizedCause });
  }

  async function call(mode: string, params: Record<string, string>): Promise<JsonValue> {
    const url = endpoint({ mode, ...params });
    let response: Response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      // fetchImpl is an injectable seam; some implementations (instrumented or
      // proxying fetch wrappers) embed the request URL in their thrown error,
      // and some may not throw an Error at all — coerce rather than assume.
      throw sanitize(`SABnzbd ${mode} request failed`, error instanceof Error ? error : new Error(String(error)));
    }
    if (!response.ok) {
      throw new Error(`SABnzbd ${mode} returned HTTP ${response.status}`);
    }
    try {
      return (await response.json()) as JsonValue;
    } catch (error) {
      // Same seam as above: a Response implementation's .json() can throw
      // whatever it likes, including a message that echoes the request URL.
      throw sanitize(
        `SABnzbd ${mode} returned an unparsable response`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  // Longest prefix first, so a nested mapping wins over its parent.
  const mappings = [...config.pathMappings].sort((a, b) => b.from.length - a.from.length);

  return {
    id: config.id,
    importMode: config.importMode,

    async addUrl(url) {
      const body = asRecord(await call('addurl', { name: url, cat: config.category }));
      if (body === null || body['status'] !== true) {
        // `error` is SABnzbd's own wording and routinely quotes the request it
        // rejected — request that SABnzbd built no part of, and whose query
        // string is ours, api key included.
        const reason =
          body === null ? 'malformed response' : safeText(body['error']) || 'unknown error';
        throw new Error(`SABnzbd rejected the download: ${reason}`);
      }

      const ids = asArray(body['nzo_ids']);
      const first = ids[0];
      if (typeof first !== 'string' || first.length === 0) {
        throw new Error('SABnzbd accepted the download but returned no nzo id');
      }
      return redact(first);
    },

    async snapshot(): Promise<ClientSnapshot> {
      const [queueBody, historyBody] = await Promise.all([
        call('queue', { category: config.category }),
        call('history', { category: config.category }),
      ]);

      // Everything below reads through safeText, never asText. These strings
      // are *returned* rather than thrown, so none of the error-path defences
      // apply to them, and a caller logging a snapshot would print them
      // straight off the wire. SABnzbd's fail_message in particular quotes
      // the failing request.
      const queue: ClientQueueEntry[] = [];
      for (const raw of asArray(asRecord(asRecord(queueBody)?.['queue'])?.['slots'])) {
        const slot = asRecord(raw);
        if (slot === null) continue;
        const ref = safeText(slot['nzo_id']);
        if (ref === '') continue;
        queue.push({
          ref,
          name: safeText(slot['filename']),
          percentage: Number.parseInt(safeText(slot['percentage']), 10) || 0,
        });
      }

      const history: ClientHistoryEntry[] = [];
      for (const raw of asArray(asRecord(asRecord(historyBody)?.['history'])?.['slots'])) {
        const slot = asRecord(raw);
        if (slot === null) continue;
        const ref = safeText(slot['nzo_id']);
        if (ref === '') continue;

        const status = safeText(slot['status']).toLowerCase();
        // Anything not explicitly completed is a failure; sabnzbd uses several
        // terminal labels and treating an unknown one as success would import
        // a partial download.
        const outcome = status === 'completed' ? 'completed' : 'failed';
        const storage = safeText(slot['storage']);
        const failMessage = safeText(slot['fail_message']);

        history.push({
          ref,
          name: safeText(slot['name']),
          outcome,
          storagePath: outcome === 'completed' && storage !== '' ? storage : null,
          failMessage: failMessage === '' ? null : failMessage,
        });
      }

      return { queue, history };
    },

    mapPath(clientPath) {
      for (const mapping of mappings) {
        if (clientPath === mapping.from || clientPath.startsWith(`${mapping.from}/`)) {
          return mapping.to + clientPath.slice(mapping.from.length);
        }
      }
      return clientPath;
    },
  };
}
