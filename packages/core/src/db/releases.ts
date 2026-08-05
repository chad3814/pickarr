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
