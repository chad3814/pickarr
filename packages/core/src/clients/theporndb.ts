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

/** How many results one query asks for. The match is exact, so one page is plenty. */
const PER_PAGE = 100;

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

      const url = `${base}/sites?q=${encodeURIComponent(query)}&page=1&per_page=${PER_PAGE}`;

      let response: Response;
      try {
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
        body = await response.json();
      } catch (error) {
        throw new Error(
          `site search for "${query}" returned unreadable JSON: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      return readSites(body);
    },
  };
}
