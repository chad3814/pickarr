import type { FetchImpl } from '../clients/theporndb.ts';
import type { FeedConfig } from '../config/schema.ts';
import { parseRss, type FeedEntry } from './parse-rss.ts';

const FETCH_TIMEOUT_MS = 30_000;

/**
 * How a feed's indexer wants to be paged, which Pickarr is told rather than
 * works out — see the design note for why detection was rejected. Mirrors the
 * `backfill` block of `feedSchema`, narrowed to the two fields composing a URL
 * needs.
 */
export interface FeedPagination {
  style: 'newznab' | 'page';
  pageSize: number;
}

export interface FetchFeedOptions {
  /**
   * Zero-based page index. 0 means the page the feed serves by default and
   * composes no parameters at all, so the live poll's request is byte-identical
   * to the one made before pagination existed — an indexer is entitled to treat
   * `offset=0` as different from no offset, and the poll must not find out.
   */
  page?: number;
  /** Required to page past 0; without it a page index has nothing to compose. */
  pagination?: FeedPagination;
  fetchImpl?: FetchImpl;
}

/**
 * The requested page's URL.
 *
 * Built through `URL` rather than by concatenation, unlike
 * `theporndb.ts`'s walk, and the difference is the input: that client owns its
 * base URL, while a feed URL is a user's and already carries the indexer's own
 * query — `?t=6000&apikey=…`. Appending `&offset=` happens to work there and
 * would be wrong here the moment a URL arrives without a query, which is exactly
 * the case a bare RSS feed presents. `searchParams.set` also overwrites rather
 * than appends, so a `page` a user pinned by hand does not end up sent twice with
 * the indexer choosing between them.
 */
function pageUrl(feed: FeedConfig, page: number, pagination: FeedPagination | undefined): string {
  if (page === 0 || pagination === undefined) return feed.url;

  const url = new URL(feed.url);
  if (pagination.style === 'newznab') {
    url.searchParams.set('offset', String(page * pagination.pageSize));
    // Sent alongside the offset, not instead of it: offsets are computed from
    // `pageSize`, so an indexer whose own default page size is something else
    // would hand back pages that do not line up with the arithmetic.
    url.searchParams.set('limit', String(pagination.pageSize));
  } else {
    // One-based, because `?page=0` is not how anything spells "the first page".
    // The stored position stays a zero-based index for both styles, so this is
    // the only place the two disagree.
    url.searchParams.set('page', String(page + 1));
  }
  return url.toString();
}

export async function fetchFeed(
  feed: FeedConfig,
  options: FetchFeedOptions = {},
): Promise<FeedEntry[]> {
  const request = options.fetchImpl ?? fetch;
  const response = await request(pageUrl(feed, options.page ?? 0, options.pagination), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/rss+xml, application/xml, text/xml' },
  });

  if (!response.ok) {
    throw new Error(`Feed ${feed.id} returned HTTP ${response.status}`);
  }

  return parseRss(await response.text());
}
