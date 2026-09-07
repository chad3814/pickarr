import type { SabnzbdConfig } from './config.ts';
import type { QueuedFetch } from '../fetch/queue.ts';
import { redactUrl } from './redact.ts';
import type { SubmitResult } from './types.ts';

/**
 * The shape `addurl` answers with -- both shapes, because SABnzbd answers a
 * rejection with HTTP 200 and a body saying otherwise: `{ status: false,
 * error: '...' }`, no `nzo_ids` at all. `fetch.json<T>` is an unchecked
 * cast, so declaring `nzo_ids` as always-present would not make it present;
 * it would only move the failure from a named refusal here to a bare
 * `TypeError` on a missing property. 1.x learned this in production
 * (`packages/core/src/clients/sabnzbd.ts` checks `status !== true` before it
 * reads any id) and this adapter follows it.
 *
 * Every field is therefore optional, and `nzo_ids`'s element type stays
 * `string` so `noUncheckedIndexedAccess` still makes `nzo_ids?.[0]` a
 * `string | undefined` that `submit` has to look at rather than assert past.
 */
interface AddUrlResponse {
  status?: boolean;
  error?: string;
  nzo_ids?: string[];
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
  // Sent exactly as configured, never normalised -- unlike qBittorrent's
  // adapter, which folds `''` and the literal `'None'` to "no category"
  // before sending or comparing (see `qbittorrent.ts`'s `normalizeCategory`
  // for its own reasoning, and why the two adapters disagree on purpose). A
  // qBittorrent config can accidentally hold the text `'None'`, which is not
  // a real category name there; SABnzbd has no such accident to guard
  // against on the way *out* -- `config.category` here is whatever an
  // operator configured, and `"None"` is not a spelling qBittorrent's
  // config form or this one would produce by accident. SABnzbd's own use of
  // `"None"` is on the way *back*: it is the literal text the server itself
  // answers with for a queue slot that has no category (1.x's
  // `readCategory`, `packages/core/src/clients/sabnzbd.ts`, ~line 296) --
  // this adapter never reads a slot's category back at all, so that
  // reasoning has nothing to apply to here.
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

      if (body.status !== true) {
        // SABnzbd rejects with HTTP 200 and `status: false`, so nothing in
        // the transport notices; this is the only place the rejection can be
        // turned into a real failure. `error` is SABnzbd's own wording and
        // routinely quotes back the request it rejected -- a request whose
        // query string is ours, api key included -- so it goes through
        // `redactUrl` exactly like a url would.
        const reason = body.error === undefined || body.error === ''
          ? 'no reason given'
          : redactUrl(body.error);
        throw new Error(`sabnzbd client ${config.id} rejected the submission: ${reason}`);
      }

      const first = body.nzo_ids?.[0];
      if (first === undefined || first === '') {
        // A submission with no id is unrecognisable later -- nothing could
        // ever match a downloads row back to a job in SABnzbd's queue or
        // history. Writing '' as the ref would not fail loudly here; it
        // would instead record a row that looks submitted and can never be
        // reconciled, which is worse than refusing outright. An empty-string
        // id is refused for the same reason as a missing one: it is not a
        // reference to anything, and 1.x rejects it too.
        throw new Error(
          `sabnzbd client ${config.id} submitted ${redactUrl(url)} but got no nzo id back`,
        );
      }
      return { ref: first };
    },
  };
}
