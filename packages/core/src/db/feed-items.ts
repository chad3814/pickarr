import type { DatabaseSync } from 'node:sqlite';

export interface NewFeedItem {
  feedId: string;
  guid: string;
  rawTitle: string;
  link: string;
  publishedAt: number | null;
  firstSeenAt: number;
}

/** Returns the new row id, or null when this guid was already seen. */
export function insertFeedItem(db: DatabaseSync, item: NewFeedItem): number | null {
  const result = db
    .prepare(
      `INSERT INTO feed_items (feed_id, guid, raw_title, link, published_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
    )
    .run(item.feedId, item.guid, item.rawTitle, item.link, item.publishedAt, item.firstSeenAt);

  return result.changes === 0 ? null : Number(result.lastInsertRowid);
}

export function setParseError(db: DatabaseSync, feedItemId: number, error: string): void {
  db.prepare('UPDATE feed_items SET parse_error = ? WHERE id = ?').run(error, feedItemId);
}
