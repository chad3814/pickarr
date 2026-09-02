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

/**
 * A whole page's worth of feed items, keyed by id, in one query — the same
 * batching discipline `groupsByIds` and `metadataForGroups` follow, applied to
 * the other namespace `/api/browse` now merges in. Hydrating a merged page's
 * failed rows one `getFeedItem` at a time is exactly the per-row pattern
 * issues #31 and #33 both name.
 *
 * A missing id is simply absent from the map, the same fact a `get` returning
 * null carried before.
 */
export function feedItemsByIds(db: DatabaseSync, ids: readonly number[]): Map<number, FeedItemRow> {
  const found = new Map<number, FeedItemRow>();
  if (ids.length === 0) return found;
  const holes = ids.map(() => '?').join(', ');
  for (const row of db.prepare(`${SELECT} WHERE id IN (${holes})`).all(...ids)) {
    const item = toFeedItemRow(row as SqlRow);
    found.set(item.id, item);
  }
  return found;
}

export interface DismissedQuery {
  cursor: { firstSeenAt: number; id: number } | null;
  limit: number;
}

/**
 * The Dismissed list: names the parser refused that a person waved off,
 * newest first. The open half of the same failures — never dismissed — is no
 * longer this function's concern; `browse-page.ts` queries `feed_items`
 * itself for those, as one branch of the merged Browse union.
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
export function dismissedFeedItems(db: DatabaseSync, query: DismissedQuery): FeedItemRow[] {
  const conditions = ['parse_error IS NOT NULL', 'dismissed_at IS NOT NULL'];
  const params: number[] = [];

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
 * legitimate change of mind — reachable through the Dismissed tab, whose Fix…
 * form this same function is called from — and leaving the dismissal behind
 * would hide an item that now holds a perfectly good release from Browse's
 * own list forever.
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
