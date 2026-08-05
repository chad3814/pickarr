import type { FeedConfig } from '../config/schema.ts';
import { parseRss, type FeedEntry } from './parse-rss.ts';

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchFeed(feed: FeedConfig): Promise<FeedEntry[]> {
  const response = await fetch(feed.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/rss+xml, application/xml, text/xml' },
  });

  if (!response.ok) {
    throw new Error(`Feed ${feed.id} returned HTTP ${response.status}`);
  }

  return parseRss(await response.text());
}
