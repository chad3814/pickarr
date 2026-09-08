import type { DatabaseSync } from 'node:sqlite';

/**
 * Which plugin owns an rss item, read from the feed it came from.
 *
 * Its own module rather than `host.ts`'s: `clients/deliver.ts` needs it to
 * find who to hand a finished file to, and `host.ts` builds the job that
 * calls into `deliver.ts`, so keeping this in `host.ts` made the two import
 * each other. Every caller shares this one query rather than a second copy
 * -- `notifyNewRssItems`, `requestDownload` and delivery all ask the same
 * question of the same two tables.
 */
export function ownerPluginId(raw: DatabaseSync, rssItemId: number): string | undefined {
  const row = raw.prepare(`
    SELECT rss_feed.plugin_id AS plugin_id
      FROM rss_item JOIN rss_feed ON rss_feed.id = rss_item.feed_id
     WHERE rss_item.id = ?
  `).get(rssItemId);
  if (!row) return undefined;
  return String((row as { plugin_id: unknown }).plugin_id);
}
