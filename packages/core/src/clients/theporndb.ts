import type { MetadataCandidate, MetadataPerformer } from '@pickarr/plugin-api';
import { abortRejection } from '../abort.ts';
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
 * Deadline for one HTTP request to the provider — the connect, the response
 * headers, and reading the JSON body, all counted against the same clock.
 *
 * Nothing downstream of `fetchImpl` sets its own timeout, so a host that
 * accepts the connection and then sends nothing hangs `searchScenes` or
 * `searchSites` forever. That is worse here than an ordinary slow request:
 * the metadata worker runs its pass under a `tryRun` mutex
 * (`pipeline/scheduler.ts`), so one hung lookup does not just delay itself —
 * every later tick finds the mutex held and silently drops, and metadata
 * stops for good with nothing logged. Twenty seconds matches this codebase's
 * other two outbound `fetch` timeouts (`feeds/fetch-feed.ts`,
 * `clients/sabnzbd.ts`) and is generous next to the provider's documented
 * slowness — `searchSites`'s one-word fallback queries report totals in the
 * hundreds per the `MAX_PAGES` comment above — while still being short
 * enough that one stalled page does not tie up a worker tick for minutes.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;

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
 * The give-away that a "poster" is not one.
 *
 * A scene with no portrait artwork of its own still answers `posters` with a
 * URL, because TPDB synthesises one on demand: its thumbnailer takes the
 * landscape *background* and returns a 800x1200 centre crop of it, sharpened,
 * upscaled, and stamped with the site's logo. Nothing in the payload says so
 * — the field is populated and the image loads — but the result is a blown-up
 * slice of a wider photo, which is worse artwork than the photo it came from.
 *
 * This substring is what distinguishes the two. `800x1200` is the crop
 * geometry and `smart` is the thumbnailer's content-aware focal mode; a real
 * poster is served straight off the CDN and passes through no thumbnailer at
 * all. Measured against this library's own 215 cached posters, the split is
 * exactly that clean: 213 carry the marker and every one of them decodes to a
 * `/background/` path, while the 2 that do not are plain
 * `cdn.theporndb.net/.../poster/...` URLs.
 *
 * Exported because the offline repair script matches stored `poster_url`s
 * against it — the rule for recognising one of these has to be stated once.
 */
export const BACKGROUND_CROP_MARKER = '/800x1200/smart/';

/** Origin the thumbnailer's source images are actually served from. */
const TPDB_CDN_ORIGIN = 'https://cdn.theporndb.net';

/** Whether this URL is a synthesised portrait crop rather than real artwork. */
export function isBackgroundCrop(url: string): boolean {
  return url.includes(BACKGROUND_CROP_MARKER);
}

/**
 * Recovers the original background image a portrait crop was cut from.
 *
 * The thumbnailer embeds its source as the last path segment, percent-encoded
 * whole — `scene%2Ff9%2F84%2F...%2Fbackground%2Fbg-....jpg` — so the original
 * needs no request to discover, only decoding and re-hosting on the CDN.
 * Taking the *last* segment matters: the `filters:...` segment before it
 * carries a `watermark(sites%2F...%2Flogo.png,...)` argument containing its
 * own encoded path, so counting segments from the left finds the site's logo
 * instead of the scene's background.
 *
 * Used two ways, and deliberately the same code for both: as the fallback
 * when a scene payload carries no `background` object, and as the *only*
 * source for the repair script, which has a stored URL and no payload left to
 * consult. Both must land on the same image.
 *
 * Returns null rather than a guess for anything that does not decode to a URL
 * on TPDB's own CDN. The decoded text steers a `fetch` and the filename bytes
 * get written to disk, so an absolute `https://elsewhere/x.jpg` smuggled into
 * that segment must not be followed — resolving against the CDN origin and
 * then re-checking the origin is what refuses it, since resolution alone
 * would happily adopt the foreign host.
 */
export function backgroundFromCrop(cropUrl: string): string | null {
  if (!isBackgroundCrop(cropUrl)) return null;

  let pathname: string;
  try {
    // Parsed rather than string-sliced so a query string or fragment cannot
    // end up inside the segment being decoded.
    pathname = new URL(cropUrl).pathname;
  } catch {
    return null;
  }

  const encoded = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (encoded.length === 0) return null;

  let resolved: URL;
  try {
    resolved = new URL(decodeURIComponent(encoded), `${TPDB_CDN_ORIGIN}/`);
  } catch {
    // Either a malformed percent-escape or a decoded value that is not a
    // usable URL reference. Both mean the same thing here: nothing to recover.
    return null;
  }
  return resolved.origin === TPDB_CDN_ORIGIN ? resolved.href : null;
}

/**
 * Reads one URL out of a `{ full, large, medium, small }` image object,
 * trying the given sizes in order. `posters`, `background` and
 * `background_back` all share this shape.
 */
function readSizedImage(value: unknown, sizes: readonly string[]): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const size of sizes) {
    const url = record[size];
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

/**
 * Poster sources in preference order.
 *
 * TPDB's own CDN first: the studio CDN fields (`image`, `poster_image`) point
 * at the site's own hosting, which is likelier to rotate paths or refuse a
 * foreign referrer. The documented `image` is 1279x719, so nothing downstream
 * may assume a portrait aspect ratio.
 */
function readOfferedPoster(record: Record<string, unknown>): string | null {
  const fromSet = readSizedImage(record['posters'], ['large', 'full']);
  if (fromSet !== null) return fromSet;
  for (const key of ['poster', 'image'] as const) {
    const url = record[key];
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

/**
 * The poster to store, preferring a real background over a crop of one.
 *
 * When the offered poster is synthesised (see `BACKGROUND_CROP_MARKER`), the
 * payload's own `background` is the better image by every measure available:
 * it is the full frame rather than a centre slice of it, at its native size
 * rather than upscaled, and without the logo the thumbnailer stamps on.
 * Nothing downstream assumes portrait — `readOfferedPoster` above already
 * documents that the plain `image` field is 1279x719 — so a landscape
 * background is a legitimate answer here, not a shape violation.
 *
 * `full` before `large`, the opposite of the poster preference above and for
 * the opposite reason: this branch is reached precisely because a downscaled,
 * re-cropped rendition was what went wrong, so it asks for the original.
 *
 * The two fallbacks matter for different failures. `backgroundFromCrop`
 * covers a payload with no `background` object at all, recovering the source
 * from the crop URL itself. Keeping the crop covers the case where even that
 * fails: a synthesised poster is poor artwork, but it is better than a card
 * with no image, and it stays recognisable to the repair script for a later
 * attempt.
 */
function readPosterUrl(record: Record<string, unknown>): string | null {
  const offered = readOfferedPoster(record);
  if (offered === null || !isBackgroundCrop(offered)) return offered;

  const background = readSizedImage(record['background'], ['full', 'large']);
  if (background !== null && !isBackgroundCrop(background)) return background;

  return backgroundFromCrop(offered) ?? offered;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads the performers off a scene, preferring each one's `parent`.
 *
 * A scene's `performers[]` are *site* performers: their slug is
 * site-prefixed (`6061-alice-maze`), and in the live payload their `image`,
 * `thumbnail` and `face` are all null. Everything worth showing — the
 * canonical slug and all three images — is on the nested `parent`. Reading
 * the outer object, which is what the field names invite, yields a card with
 * no avatars and links to alias pages.
 *
 * `face` is preferred for the thumbnail over `thumbnail`: it is a 500x500
 * smart crop centred on the face, where `thumbnail` is the poster scaled
 * down, and a full-body poster two lines high is unrecognisable.
 *
 * A performer with no slug is dropped rather than stored with an empty one:
 * the slug is the whole link, and the uuid it would be keyed on is likewise
 * absent in that case, so the row would collide with every other such
 * performer under `UNIQUE (source, source_uuid)`.
 *
 * `name`, never `full_name` — the latter carries a disambiguation suffix such
 * as `Jessica Jaymes (2005)`.
 */
function readPerformers(value: unknown): MetadataPerformer[] {
  if (!Array.isArray(value)) return [];
  const performers: MetadataPerformer[] = [];

  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const site = entry as Record<string, unknown>;
    const parentValue = site['parent'];
    const parent =
      parentValue !== null && typeof parentValue === 'object'
        ? (parentValue as Record<string, unknown>)
        : null;
    const source = parent ?? site;

    const slug = str(source, 'slug');
    const sourceUuid = str(source, 'id');
    const name = str(source, 'name') ?? str(site, 'name');
    if (slug === null || sourceUuid === null || name === null) continue;

    performers.push({
      sourceUuid,
      slug,
      name,
      kind: parent === null ? 'performer-site' : 'performer',
      faceUrl: str(source, 'face'),
      imageUrl: str(source, 'image'),
    });
  }
  return performers;
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
      performers: readPerformers(record['performers']),
      durationSeconds:
        typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
      synopsis: typeof synopsis === 'string' && synopsis.length > 0 ? synopsis : null,
      posterUrl: readPosterUrl(record),
      slug: str(record, 'slug'),
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
        // Fresh per page: each page gets its own full budget rather than
        // sharing one deadline across the whole walk, since a page that
        // legitimately took a while is not evidence the next one will too.
        const signal = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
        const timedOut = abortRejection(signal);

        let response: Response;
        try {
          // eslint-disable-next-line no-await-in-loop -- pages are sequential by nature, and each is only fetched when the previous one proved insufficient
          response = await Promise.race([
            fetchImpl(url, {
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                Accept: 'application/json',
              },
              signal,
            }),
            timedOut,
          ]);
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
          // eslint-disable-next-line no-await-in-loop -- see above; raced against
          // the same deadline as the fetch, since a connection that stalls after
          // headers arrive is exactly as silent as one that never connects.
          body = await Promise.race([response.json(), timedOut]);
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
      const signal = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
      const timedOut = abortRejection(signal);

      let response: Response;
      try {
        response = await Promise.race([
          fetchImpl(url, {
            headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
            signal,
          }),
          timedOut,
        ]);
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
        // Raced against the same deadline as the fetch above — see the
        // comment on the site-search loop for why headers arriving is not
        // enough to consider the request safe from stalling.
        body = await Promise.race([response.json(), timedOut]);
      } catch (error) {
        throw new Error(
          `scene search for "${query}" returned unreadable JSON: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      return readScenes(body);
    },
  };
}
