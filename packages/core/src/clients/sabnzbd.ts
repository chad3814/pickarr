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

  async function call(mode: string, params: Record<string, string>): Promise<JsonValue> {
    const response = await fetchImpl(endpoint({ mode, ...params }));
    if (!response.ok) {
      throw new Error(`SABnzbd ${mode} returned HTTP ${response.status}`);
    }
    return (await response.json()) as JsonValue;
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
