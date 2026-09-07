import type { SabnzbdConfig } from './config.ts';
import type { QueuedFetch } from '../fetch/queue.ts';
import { redactUrl } from './redact.ts';

/**
 * What one submission gave back: the reference this client's own history
 * later answers questions about. For SABnzbd that reference is an
 * `nzo_id`; the field is named `ref` rather than `nzoId` so a caller that
 * also submits to qBittorrent (whose reference is a torrent hash) can treat
 * both clients' results the same way.
 */
export interface SubmitResult {
  ref: string;
}

/**
 * The shape `addurl` answers with on success. `nzo_ids` is typed as
 * `string[]` -- not `unknown[]` or `unknown` -- specifically so that
 * `noUncheckedIndexedAccess` turns indexing it into the compiler's own
 * reminder that the array might be empty: `nzo_ids[0]` is `string |
 * undefined`, not `string`, and `submit` below has to look at that
 * `undefined` rather than assert past it.
 */
interface AddUrlResponse {
  nzo_ids: string[];
}

/**
 * Builds the `addurl` request url, query parameters in the order SABnzbd's
 * own docs list them. Order has no effect on the server, but it does on
 * this codebase's tests: they assert against the url as a literal string,
 * not against this function's own output, so a stable order is what makes
 * that assertion meaningful rather than circular.
 *
 * The api key travels here, in the query, exactly as SABnzbd requires --
 * and every caller of this function that might let the built url reach an
 * error message must run it through `redactUrl` first. This function does
 * not redact its own output: it is called once per submission and its
 * result is handed straight to `fetch.json`, which redacts on its own
 * error paths already (see `queue.ts`); only code in *this* module that
 * builds a further error around that url has to remember to do the same.
 */
function buildAddUrlUrl(config: SabnzbdConfig, link: string, name: string): string {
  const query = new URLSearchParams();
  query.set('mode', 'addurl');
  query.set('name', link);
  query.set('cat', config.category);
  query.set('nzbname', name);
  query.set('apikey', config.apiKey);
  query.set('output', 'json');
  return `${config.baseUrl}/api?${query.toString()}`;
}

/**
 * SABnzbd's adapter: `addurl` is a single request that both submits the
 * nzb link and answers with the reference to remember it by, so there is
 * no separate "confirm" step the way there might be for a client whose
 * submit and lookup are two different endpoints.
 */
export function createSabnzbdClient(
  config: SabnzbdConfig,
  fetch: QueuedFetch,
): { submit(link: string, name: string): Promise<SubmitResult> } {
  return {
    async submit(link: string, name: string): Promise<SubmitResult> {
      const url = buildAddUrlUrl(config, link, name);
      const body = await fetch.json<AddUrlResponse>(url);
      const first = body.nzo_ids[0];
      if (first === undefined) {
        // A submission with no id is unrecognisable later -- nothing could
        // ever match a downloads row back to a job in SABnzbd's queue or
        // history. Writing '' as the ref would not fail loudly here; it
        // would instead record a row that looks submitted and can never be
        // reconciled, which is worse than refusing outright.
        throw new Error(
          `sabnzbd client ${config.id} submitted ${redactUrl(url)} but got no nzo id back`,
        );
      }
      return { ref: first };
    },
  };
}
