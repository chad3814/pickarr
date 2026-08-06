import type { SiteLookupConfig } from '../config/schema.ts';

/** One site as the metadata service describes it. */
export interface SiteSearchResult {
  /** Display spelling, e.g. `Bang Bros`. */
  readonly name: string;
  /** Separator-free spelling, e.g. `bangbros`. Often how releases write it. */
  readonly shortName: string;
}

/**
 * Searches a site-metadata service.
 *
 * Deliberately returns results rather than a verdict. Deciding *which* result
 * is the site needs the release name the query came from, which this client
 * does not have: nothing is named `2 Chicks`, yet searching it is how you find
 * `2 Chicks Same Time`. An empty array is a cacheable negative; a thrown error
 * means the question could not be asked and must not be cached as one.
 */
export interface SiteLookupClient {
  readonly source: string;
  searchSites(query: string): Promise<readonly SiteSearchResult[]>;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Results per request. 100 is the service's ceiling — asking for more returns
 * an empty body rather than a larger page.
 */
const PER_PAGE = 100;

/**
 * How many pages one search will walk.
 *
 * A single page is not always enough. Measured against the live service, the
 * one-word fallback queries run long: `free` reports 149 matches, `anal` 352,
 * `teen` 349, `big` 649. The site being looked for can sit anywhere in that,
 * so stopping at page one silently loses it. Ten pages covers every realistic
 * query with headroom.
 *
 * The cost is paid once per prefix ever, because both hits and misses are
 * cached, and only by queries whose results exceed a page — in practice the
 * one-word fallback, not the two-word query that usually settles it first.
 */
const MAX_PAGES = 10;

/**
 * A result count past which the query is too broad to be a site name.
 *
 * `a` reports 87,955 matches — 880 pages. Walking that to look for an exact
 * name match is pointless work, and a query that unspecific is not a site
 * lookup in any useful sense. Page one is still examined, because an exact
 * match tends to rank first, but the walk stops there.
 */
const MAX_TOTAL_TO_WALK = 1_000;

/**
 * Pulls the fields we compare out of a response body, tolerating everything
 * else about it.
 *
 * Written defensively rather than with a strict schema: this is a third-party
 * API whose unrelated fields may change, and a new optional field on a site
 * object is not a reason to stop resolving sites. Anything structurally wrong
 * enough that no site can be read yields an empty list, which reads as "no
 * match" — never as a confirmation.
 */
function readSites(body: unknown): SiteSearchResult[] {
  if (body === null || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const sites: SiteSearchResult[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as { name?: unknown; short_name?: unknown };
    const name = typeof record.name === 'string' ? record.name : '';
    const shortName = typeof record.short_name === 'string' ? record.short_name : '';
    if (name.length > 0 || shortName.length > 0) sites.push({ name, shortName });
  }
  return sites;
}

/** `meta.total` when the body reports one, for deciding whether to page on. */
function readTotal(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  const meta = (body as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object') return null;
  const total = (meta as { total?: unknown }).total;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/**
 * Removes the bearer token from anything on its way to a log or an error.
 *
 * The key only ever travels in a request header, so it cannot appear in a URL
 * the way SABnzbd's does — but `fetch` failures and proxy errors have been
 * observed to echo request headers back in their messages, and this client's
 * errors are logged verbatim. Rewriting is cheap; discovering afterwards that
 * a key reached a log file is not.
 */
function redactToken(message: string, apiKey: string): string {
  const withoutHeader = message.replace(/(Bearer\s+)\S+/gi, '$1***');
  return apiKey.length === 0 ? withoutHeader : withoutHeader.replaceAll(apiKey, '***');
}

/** Searches sites in ThePornDB. */
export function createTpdbClient(config: SiteLookupConfig, fetchImpl: FetchImpl): SiteLookupClient {
  const base = config.baseUrl.replace(/\/+$/, '');

  return {
    source: 'theporndb',

    async searchSites(query: string): Promise<readonly SiteSearchResult[]> {
      if (query.trim().length === 0) return [];

      const collected: SiteSearchResult[] = [];

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${base}/sites?q=${encodeURIComponent(query)}&page=${page}&per_page=${PER_PAGE}`;

        let response: Response;
        try {
          // eslint-disable-next-line no-await-in-loop -- pages are sequential by nature, and each is only fetched when the previous one proved insufficient
          response = await fetchImpl(url, {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              Accept: 'application/json',
            },
          });
        } catch (error) {
          throw new Error(
            `site search for "${query}" failed: ${redactToken((error as Error).message, config.apiKey)}`,
          );
        }

        if (!response.ok) {
          throw new Error(
            `site search for "${query}" returned HTTP ${response.status} ${response.statusText}`,
          );
        }

        let body: unknown;
        try {
          // eslint-disable-next-line no-await-in-loop -- see above
          body = await response.json();
        } catch (error) {
          throw new Error(
            `site search for "${query}" returned unreadable JSON: ${redactToken((error as Error).message, config.apiKey)}`,
          );
        }

        const pageSites = readSites(body);
        collected.push(...pageSites);

        // Stop as soon as this page was not full, or the reported total is
        // already covered. A body we could not read yields no sites, which
        // also stops the walk rather than requesting the same page again.
        if (pageSites.length < PER_PAGE) break;
        const total = readTotal(body);
        if (total !== null && collected.length >= total) break;
        if (total !== null && total > MAX_TOTAL_TO_WALK) break;
      }

      return collected;
    },
  };
}
