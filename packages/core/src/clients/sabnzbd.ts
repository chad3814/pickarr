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
   * Replaces every occurrence of the api key with a placeholder. Uses
   * replaceAll rather than replace: the key can appear more than once in a
   * URL-bearing message (e.g. a wrapped fetch error that logs its own retry
   * history). Guarded against an empty key, which would otherwise splice the
   * placeholder between every character of the message.
   */
  function redact(message: string): string {
    return config.apiKey.length === 0 ? message : message.replaceAll(config.apiKey, '***');
  }

  /**
   * Wraps an error from an injectable dependency (fetchImpl itself, or a
   * Response's .json()) so nothing it says can leak the api key. The
   * property must hold regardless of how a caller ends up logging or
   * inspecting the resulting error — via .message, String(error),
   * error.cause, or util.inspect — so the original is never attached
   * verbatim as `cause`; a redacted stand-in is attached instead, preserving
   * the original's name and message content (minus the secret) for
   * debugging.
   */
  function sanitize(prefix: string, error: Error): Error {
    const sanitizedCause = new Error(redact(error.message));
    sanitizedCause.name = error.name;
    return new Error(prefix, { cause: sanitizedCause });
  }

  async function call(mode: string, params: Record<string, string>): Promise<JsonValue> {
    const url = endpoint({ mode, ...params });
    let response: Response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      // fetchImpl is an injectable seam; some implementations (instrumented or
      // proxying fetch wrappers) embed the request URL in their thrown error.
      throw sanitize(`SABnzbd ${mode} request failed`, error as Error);
    }
    if (!response.ok) {
      throw new Error(`SABnzbd ${mode} returned HTTP ${response.status}`);
    }
    try {
      return (await response.json()) as JsonValue;
    } catch (error) {
      // Same seam as above: a Response implementation's .json() can throw
      // whatever it likes, including a message that echoes the request URL.
      throw sanitize(`SABnzbd ${mode} returned an unparsable response`, error as Error);
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
        const reason = body === null ? 'malformed response' : text(body['error']) || 'unknown error';
        throw new Error(`SABnzbd rejected the download: ${reason}`);
      }

      const ids = asArray(body['nzo_ids']);
      const first = ids[0];
      if (typeof first !== 'string' || first.length === 0) {
        throw new Error('SABnzbd accepted the download but returned no nzo id');
      }
      return first;
    },

    async snapshot(): Promise<ClientSnapshot> {
      const [queueBody, historyBody] = await Promise.all([
        call('queue', { category: config.category }),
        call('history', { category: config.category }),
      ]);

      const queue: ClientQueueEntry[] = [];
      for (const raw of asArray(asRecord(asRecord(queueBody)?.['queue'])?.['slots'])) {
        const slot = asRecord(raw);
        if (slot === null) continue;
        const ref = text(slot['nzo_id']);
        if (ref === '') continue;
        queue.push({
          ref,
          name: text(slot['filename']),
          percentage: Number.parseInt(text(slot['percentage']), 10) || 0,
        });
      }

      const history: ClientHistoryEntry[] = [];
      for (const raw of asArray(asRecord(asRecord(historyBody)?.['history'])?.['slots'])) {
        const slot = asRecord(raw);
        if (slot === null) continue;
        const ref = text(slot['nzo_id']);
        if (ref === '') continue;

        const status = text(slot['status']).toLowerCase();
        // Anything not explicitly completed is a failure; sabnzbd uses several
        // terminal labels and treating an unknown one as success would import
        // a partial download.
        const outcome = status === 'completed' ? 'completed' : 'failed';
        const storage = text(slot['storage']);
        const failMessage = text(slot['fail_message']);

        history.push({
          ref,
          name: text(slot['name']),
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
