import type { MetadataCandidate } from '@pickarr/plugin-api';
import type { SiteLookupConfig } from '../config/schema.ts';

/** One site as the metadata service describes it. */
export interface SiteSearchResult {
  /** Display spelling, e.g. `Bang Bros`. */
  readonly name: string;
  /** Separator-free spelling, e.g. `bangbros`. Often how releases write it. */
  readonly shortName: string;
  /**
   * The service's identifier for this site, recorded so a later feature can
   * address it directly rather than searching by name again. May be absent.
   */
  readonly sourceUuid: string | null;
  /**
   * The service's *integer* id for this site. `GET /scenes?site_id=` accepts
   * only this form, never the uuid, which is why both are kept.
   */
  readonly sourceId: number | null;
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
    const record = entry as {
      name?: unknown;
      short_name?: unknown;
      uuid?: unknown;
      id?: unknown;
    };
    const name = typeof record.name === 'string' ? record.name : '';
    const shortName = typeof record.short_name === 'string' ? record.short_name : '';
    const sourceUuid = typeof record.uuid === 'string' && record.uuid.length > 0 ? record.uuid : null;
    const rawId = record.id;
    const sourceId = typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : null;
    if (name.length > 0 || shortName.length > 0) sites.push({ name, shortName, sourceUuid, sourceId });
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

export interface SceneLookupClient {
  readonly source: string;
  /** `siteId` narrows the search; null when the site's integer id is unknown. */
  searchScenes(query: string, siteId: number | null): Promise<readonly MetadataCandidate[]>;
}

/**
 * A rate limit, distinguished from every other failure by its own type.
 *
 * The worker treats it differently: an ordinary failure defers one group, while
 * this one stops the whole pass. Five rows each spending a request to discover
 * the same limit is the thing being avoided, so the caller has to be able to
 * tell the two apart without parsing a message.
 */
export class RateLimited extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`rate limited for ${retryAfterMs}ms`);
    this.name = 'RateLimited';
    this.retryAfterMs = retryAfterMs;
  }
}

/** `Retry-After` in seconds, defaulting to a minute when absent or unreadable. */
function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
}

/**
 * Poster sources in preference order.
 *
 * TPDB's own CDN first: the studio CDN fields (`image`, `poster_image`) point
 * at the site's own hosting, which is likelier to rotate paths or refuse a
 * foreign referrer. The documented `image` is 1279x719, so nothing downstream
 * may assume a portrait aspect ratio.
 */
function readPosterUrl(record: Record<string, unknown>): string | null {
  const posters = record['posters'];
  if (posters !== null && typeof posters === 'object') {
    for (const size of ['large', 'full'] as const) {
      const url = (posters as Record<string, unknown>)[size];
      if (typeof url === 'string' && url.length > 0) return url;
    }
  }
  for (const key of ['poster', 'image'] as const) {
    const url = record[key];
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

function readPerformerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    // `name`, never `full_name` — the latter carries a disambiguation suffix
    // such as `Jessica Jaymes (2005)`.
    const name = (entry as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * Reads scenes out of a response body, tolerating everything we do not use.
 *
 * Note the id naming, which is inverted between the two objects and is not a
 * mistake to correct: on a **scene**, `id` is the uuid string and `_id` is the
 * integer; on the nested **site**, `uuid` is the uuid and `id` is the integer.
 */
function readScenes(body: unknown): MetadataCandidate[] {
  if (body === null || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const scenes: MetadataCandidate[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;

    const title = record['title'];
    if (typeof title !== 'string' || title.length === 0) continue;

    const site = record['site'];
    const siteRecord = site !== null && typeof site === 'object'
      ? (site as Record<string, unknown>)
      : {};
    const siteName = siteRecord['name'];
    const siteUuid = siteRecord['uuid'];
    const siteId = siteRecord['id'];
    const uuid = record['id'];
    const date = record['date'];
    const duration = record['duration'];
    const synopsis = record['description'];

    scenes.push({
      sourceUuid: typeof uuid === 'string' && uuid.length > 0 ? uuid : null,
      title,
      siteUuid: typeof siteUuid === 'string' && siteUuid.length > 0 ? siteUuid : null,
      siteId: typeof siteId === 'number' && Number.isInteger(siteId) ? siteId : null,
      siteName: typeof siteName === 'string' ? siteName : '',
      date: typeof date === 'string' && date.length > 0 ? date : null,
      performers: readPerformerNames(record['performers']),
      durationSeconds:
        typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
      synopsis: typeof synopsis === 'string' && synopsis.length > 0 ? synopsis : null,
      posterUrl: readPosterUrl(record),
    });
  }
  return scenes;
}

/** Searches sites and scenes in ThePornDB. */
export function createTpdbClient(
  config: SiteLookupConfig,
  fetchImpl: FetchImpl,
): SiteLookupClient & SceneLookupClient {
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

    /**
     * One page only, unlike `searchSites`. That walks up to `MAX_PAGES`
     * because one-word site queries return hundreds of results and the answer
     * can sit anywhere in them. A scene query is a full title plus a site
     * filter: a match that is not on page one is one the confirmation rule was
     * going to reject anyway, so paging would spend requests collecting
     * candidates we then discard.
     */
    async searchScenes(query: string, siteId: number | null) {
      if (query.trim().length === 0) return [];
      const site = siteId === null ? '' : `&site_id=${siteId}`;
      const url = `${base}/scenes?q=${encodeURIComponent(query)}${site}&per_page=${PER_PAGE}`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
        });
      } catch (error) {
        throw new Error(
          `scene search for "${query}" failed: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      if (response.status === 429) {
        throw new RateLimited(retryAfterMs(response.headers.get('retry-after')));
      }
      if (!response.ok) {
        throw new Error(
          `scene search for "${query}" returned HTTP ${response.status} ${response.statusText}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error(
          `scene search for "${query}" returned unreadable JSON: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      return readScenes(body);
    },
  };
}
