import type { DatabaseSync } from 'node:sqlite';
import { num, str, type SqlRow } from './row.ts';

export interface ReleaseRow {
  id: number;
  groupId: number;
  feedItemId: number;
  quality: string;
  score: number;
  createdAt: number;
}

function toReleaseRow(row: SqlRow): ReleaseRow {
  return {
    id: num(row, 'id'),
    groupId: num(row, 'group_id'),
    feedItemId: num(row, 'feed_item_id'),
    quality: str(row, 'quality'),
    score: num(row, 'score'),
    createdAt: num(row, 'created_at'),
  };
}

export interface NewRelease {
  groupId: number;
  feedItemId: number;
  quality: string;
  score: number;
  createdAt: number;
}

export function insertRelease(db: DatabaseSync, release: NewRelease): number {
  const result = db
    .prepare(
      `INSERT INTO releases (group_id, feed_item_id, quality, score, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      release.groupId,
      release.feedItemId,
      release.quality,
      release.score,
      release.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function getRelease(db: DatabaseSync, id: number): ReleaseRow | null {
  const row = db
    .prepare(
      'SELECT id, group_id, feed_item_id, quality, score, created_at FROM releases WHERE id = ?',
    )
    .get(id);
  return row === undefined ? null : toReleaseRow(row as SqlRow);
}

/** Returns null for a null id, so callers can pass an unset pointer directly. */
export function releaseScore(db: DatabaseSync, id: number | null): number | null {
  if (id === null) return null;
  return getRelease(db, id)?.score ?? null;
}

export function releasesForGroup(db: DatabaseSync, groupId: number): ReleaseRow[] {
  return db
    .prepare(
      `SELECT id, group_id, feed_item_id, quality, score, created_at
       FROM releases WHERE group_id = ? ORDER BY score DESC, id DESC`,
    )
    .all(groupId)
    .map((row) => toReleaseRow(row as SqlRow));
}

/**
 * Quality and score move together or not at all. `score` is the plugin's
 * function of `quality`, and every ordering in the system — the upgrade rule,
 * the browse list, the pick — reads the score, so a row where the two disagree
 * is a row that sorts by a quality it no longer claims.
 *
 * The caller re-derives the group's upgrade flag afterwards, through
 * `refreshUpgradeFlag` rather than `flagUpgrade`: a correction is not an
 * arrival and must not bump `list_rank_at`.
 */
export function updateReleaseQuality(
  db: DatabaseSync,
  release: { id: number; quality: string; score: number },
): void {
  db.prepare('UPDATE releases SET quality = ?, score = ? WHERE id = ?').run(
    release.quality,
    release.score,
    release.id,
  );
}

/**
 * Separate from `updateReleaseQuality` because a resolve stamps a release it
 * inserted rather than rewrote, and because a quality edit and its stamp are
 * two different facts about the row.
 */
export function markReleaseEdited(db: DatabaseSync, releaseId: number, editedAt: number): void {
  db.prepare('UPDATE releases SET edited_at = ? WHERE id = ?').run(editedAt, releaseId);
}

export function linkForRelease(db: DatabaseSync, releaseId: number): string | null {
  const row = db
    .prepare(
      `SELECT feed_items.link AS link
       FROM releases JOIN feed_items ON feed_items.id = releases.feed_item_id
       WHERE releases.id = ?`,
    )
    .get(releaseId);
  return row === undefined ? null : str(row as SqlRow, 'link');
}

/**
 * Which configured feed a release arrived on, or null when there is no such
 * release.
 *
 * The same join as `linkForRelease` and `titleForRelease` above, and it is
 * total for the same reason: `releases.feed_item_id` is `NOT NULL UNIQUE`, so
 * a release has exactly one feed item and that item names exactly one feed.
 * `null` therefore means the release id is unknown, never that a known release
 * has no feed.
 *
 * The feed is what decides which download client a pick is submitted to (see
 * `pickRelease`), and this join is the only path from a release back to it —
 * the `downloads` row records the client, not the feed, and by the time
 * anything reads that row the routing decision has already been made.
 */
export function feedIdForRelease(db: DatabaseSync, releaseId: number): string | null {
  const row = db
    .prepare(
      `SELECT feed_items.feed_id AS feed_id
       FROM releases JOIN feed_items ON feed_items.id = releases.feed_item_id
       WHERE releases.id = ?`,
    )
    .get(releaseId);
  return row === undefined ? null : str(row as SqlRow, 'feed_id');
}

/**
 * The feed's own raw title for a release, used as the readable half of the
 * job name sent to the download client (see `clientJobName` in
 * `db/downloads.ts`). Deliberately the raw feed title, not anything derived
 * from the group's display fields — a group can hold releases from several
 * differently-shaped listings, and the raw title is unambiguously this one
 * release's own name.
 */
export function titleForRelease(db: DatabaseSync, releaseId: number): string | null {
  const row = db
    .prepare(
      `SELECT feed_items.raw_title AS title
       FROM releases JOIN feed_items ON feed_items.id = releases.feed_item_id
       WHERE releases.id = ?`,
    )
    .get(releaseId);
  return row === undefined ? null : str(row as SqlRow, 'title');
}
