/**
 * The two calls this tree makes to the lookup service.
 *
 * Always the batch shape, even for one name: a batch answers HTTP 200 with a
 * per-entry state where a single lookup can answer 202, so sending one shape
 * means reading one shape and there is no 202 path anywhere above this.
 */
import type { HostFetch } from '@pickarr/contract';
import type {
  LookupBatchEntry,
  LookupCategory,
  LookupEnvelope,
  SecretResolver,
} from './types.ts';
import { API_KEY_SECRET } from './types.ts';
import { readBatchResponse, readEnvelope } from './validate.ts';

/** The document's own ceiling: `LookupBatchRequest.items` is `maxItems: 100`. */
export const MAX_BATCH = 100;

const LOOKUP_PATH = '/api/v1/lookup';

export interface LookupClient {
  /**
   * Every name's answer, in the order the names were given -- across chunks,
   * so a caller never learns where a chunk boundary fell.
   */
  batch(category: LookupCategory, names: readonly string[]): Promise<readonly LookupBatchEntry[]>;
  poll(lookupId: string): Promise<LookupEnvelope>;
}

export interface LookupClientDeps {
  fetch: HostFetch;
  baseUrl: string;
  resolveSecret: SecretResolver;
  /** The dispatcher's per-job signal, forwarded so a job near its ceiling unwinds. */
  signal?: AbortSignal;
}

export function createLookupClient(deps: LookupClientDeps): LookupClient {
  const origin = deps.baseUrl.replace(/\/+$/, '');

  /**
   * Resolved per request rather than once per client: a store that rotates a
   * credential is the reason `SecretResolver` is async, and a value read once
   * would defeat it. The header is built here and nowhere else, so there is
   * one place a credential is ever attached to a request.
   */
  async function headers(extra?: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    const key = await deps.resolveSecret(API_KEY_SECRET);
    return { authorization: `Bearer ${key}`, ...extra };
  }

  /**
   * `exactOptionalPropertyTypes` is on, so an explicit `signal: undefined` is
   * not the same as the property being absent -- two shapes rather than one
   * literal, the same way `main.ts` builds `createHost`'s options.
   */
  function init(base: { method: string; headers: Record<string, string>; body?: string }): RequestInit {
    return deps.signal === undefined ? base : { ...base, signal: deps.signal };
  }

  async function chunk(
    category: LookupCategory,
    names: readonly string[],
  ): Promise<readonly LookupBatchEntry[]> {
    const body = await deps.fetch.json<unknown>(`${origin}${LOOKUP_PATH}`, init({
      method: 'POST',
      headers: await headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ items: names.map((name) => ({ category, name })) }),
    }));
    const { results } = readBatchResponse(body);
    // The answers carry no echoed name, so position is the only thing tying
    // them to what was asked. A length mismatch would silently shift one
    // item's identity onto another; refused here instead.
    if (results.length !== names.length) {
      throw new Error(
        `openmetadata: asked about ${names.length} names and got ${results.length} answers`,
      );
    }
    return results;
  }

  return {
    async batch(category, names) {
      const answers: LookupBatchEntry[] = [];
      for (let start = 0; start < names.length; start += MAX_BATCH) {
        // eslint-disable-next-line no-await-in-loop -- chunks are sequential on purpose: the per-hostname fetch queue would serialise them anyway, and ordering the requests keeps the answers in the caller's order without a sort
        answers.push(...await chunk(category, names.slice(start, start + MAX_BATCH)));
      }
      return answers;
    },

    async poll(lookupId) {
      // `GET /api/v1/lookup/{id}` answers a bare envelope -- not wrapped in a
      // `result` key, which is where the host's own test double differs.
      const body = await deps.fetch.json<unknown>(
        `${origin}${LOOKUP_PATH}/${encodeURIComponent(lookupId)}`,
        init({ method: 'GET', headers: await headers() }),
      );
      return readEnvelope(body);
    },
  };
}
