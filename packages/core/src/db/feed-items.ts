import type { DatabaseSync } from 'node:sqlite';
import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';

export interface FeedItemRow {
  id: number;
  feedId: string;
  guid: string;
  rawTitle: string;
  link: string;
  publishedAt: number | null;
  firstSeenAt: number;
  parseError: string | null;
  dismissedAt: number | null;
}

const SELECT = `
  SELECT id, feed_id, guid, raw_title, link, published_at, first_seen_at,
         parse_error, dismissed_at
  FROM feed_items
`;

export function toFeedItemRow(row: SqlRow): FeedItemRow {
  return {
    id: num(row, 'id'),
    feedId: str(row, 'feed_id'),
    guid: str(row, 'guid'),
    rawTitle: str(row, 'raw_title'),
    link: str(row, 'link'),
    publishedAt: maybeNum(row, 'published_at'),
    firstSeenAt: num(row, 'first_seen_at'),
    parseError: maybeStr(row, 'parse_error'),
    dismissedAt: maybeNum(row, 'dismissed_at'),
  };
}

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

export function getFeedItem(db: DatabaseSync, id: number): FeedItemRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toFeedItemRow(row as SqlRow);
}

export interface FailedQuery {
  cursor: { firstSeenAt: number; id: number } | null;
  limit: number;
  includeDismissed: boolean;
}

/**
 * The Failed list: everything the parser could not decode, newest first.
 *
 * Keyset pagination on (first_seen_at, id) rather than OFFSET, so a page stays
 * stable while ingest is inserting ahead of it — the same reason and the same
 * shape as `browseGroups`.
 *
 * The tiebreak on `id` is ascending, not descending, and this is not a typo.
 * Every item ingest inserts in one tick shares that tick's `first_seen_at`,
 * and RSS serves newest-first, so ingest reaches the newest item first and it
 * takes the lowest id in the batch. Ascending id inside a tie therefore
 * already *is* newest-first. (`published_at` is the feed's own claim about
 * recency and would be the more honest sort key, but it is nullable, so it
 * would still need this fallback behind it — and the list would then order
 * some rows by one rule and some by another.)
 *
 * The cursor comparison's tiebreak has to mirror the ORDER BY's: with `id`
 * ascending inside a tie, the next page holds ids *greater* than the cursor's.
 */
export function failedFeedItems(db: DatabaseSync, query: FailedQuery): FeedItemRow[] {
  const conditions = ['parse_error IS NOT NULL'];
  const params: number[] = [];

  if (!query.includeDismissed) conditions.push('dismissed_at IS NULL');
  if (query.cursor !== null) {
    conditions.push('(first_seen_at < ? OR (first_seen_at = ? AND id > ?))');
    params.push(query.cursor.firstSeenAt, query.cursor.firstSeenAt, query.cursor.id);
  }
  params.push(query.limit);

  return db
    .prepare(
      `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY first_seen_at DESC, id ASC LIMIT ?`,
    )
    .all(...params)
    .map((row) => toFeedItemRow(row as SqlRow));
}

export function setParseError(db: DatabaseSync, feedItemId: number, error: string): void {
  db.prepare('UPDATE feed_items SET parse_error = ? WHERE id = ?').run(error, feedItemId);
}

/**
 * Clears `dismissed_at` alongside the error, because an item cannot be both
 * dismissed and resolved. Fixing something previously waved off is a
 * legitimate change of mind — reachable through the list's `includeDismissed`
 * view — and leaving the dismissal behind would hide an item that now holds a
 * perfectly good release from the default view forever.
 */
export function clearParseError(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE feed_items SET parse_error = NULL, dismissed_at = NULL WHERE id = ?').run(id);
}

/**
 * Named for the column it writes rather than for the act, because the
 * operation layer above owns a `dismissFeedItem` that also enforces the
 * preconditions. Two functions with one name and different arities across two
 * layers is how an import alias becomes a bug.
 */
export function setDismissedAt(db: DatabaseSync, id: number, dismissedAt: number): void {
  db.prepare('UPDATE feed_items SET dismissed_at = ? WHERE id = ?').run(dismissedAt, id);
}
