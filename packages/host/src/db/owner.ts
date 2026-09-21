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

/**
 * Which media item an rss item resolved to, or `null` if it resolved to
 * none.
 *
 * Here beside `ownerPluginId` because delivery asks both questions about the
 * same row at the same moment, and for the same reason: `clients/deliver.ts`
 * cannot import `host.ts`.
 *
 * **One `null` for two conditions, deliberately.** An rss item with a NULL
 * `media_item_id` and an rss item that does not exist both answer `null`,
 * where `ownerPluginId` distinguishes the second with `undefined`. That
 * asymmetry is not an oversight: the caller needs the distinction for the
 * owner because "no owner" means nobody to deliver to, and it does not need
 * it here because "no media item" is already a state delivery handles --
 * design spec §6's unmatched release. Delivery also never reaches this
 * without an owner, so the missing-row case cannot arrive through it.
 */
export function mediaItemIdForRssItem(raw: DatabaseSync, rssItemId: number): number | null {
  const row = raw.prepare('SELECT media_item_id FROM rss_item WHERE id = ?').get(rssItemId);
  if (!row) return null;
  const value = (row as { media_item_id: unknown }).media_item_id;
  // The null is tested before the conversion, not after: `Number(null)` is
  // 0, and a 0 here reads as a media item this release matched.
  //
  // This is not the only reader of this column narrowed this way, and the
  // first version of this comment wrongly claimed it was. `api/reads.ts`
  // projects the same `rss_item.media_item_id` at :633 through its own
  // `asNumberOrNull`, whose body is this same null-before-convert test --
  // one of thirteen uses of that helper and its `asTextOrNull` twin, all in
  // that one file. The two are not deduplicated onto one function because
  // `asNumberOrNull` is module-private there and exporting a two-line
  // narrowing across the `api`/`db` boundary buys less than it couples;
  // they are cross-referenced instead, so a reader who changes one knows
  // the other exists.
  if (value === null || value === undefined) return null;
  return Number(value);
}
