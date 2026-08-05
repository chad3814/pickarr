import type { DatabaseSync } from 'node:sqlite';
import { maybeNum, num, str, type SqlRow } from './row.ts';

export type GroupState = 'new' | 'picked';

export interface GroupRow {
  id: number;
  plugin: string;
  identityKey: string;
  display: string;
  searchText: string;
  state: GroupState;
  pickedReleaseId: number | null;
  upgradeReleaseId: number | null;
  createdAt: number;
  listRankAt: number;
}

const SELECT = `
  SELECT id, plugin, identity_key, display, search_text, state,
         picked_release_id, upgrade_release_id, created_at, list_rank_at
  FROM media_groups
`;

export function toGroupRow(row: SqlRow): GroupRow {
  const state = str(row, 'state');
  return {
    id: num(row, 'id'),
    plugin: str(row, 'plugin'),
    identityKey: str(row, 'identity_key'),
    display: str(row, 'display'),
    searchText: str(row, 'search_text'),
    state: state === 'picked' ? 'picked' : 'new',
    pickedReleaseId: maybeNum(row, 'picked_release_id'),
    upgradeReleaseId: maybeNum(row, 'upgrade_release_id'),
    createdAt: num(row, 'created_at'),
    listRankAt: num(row, 'list_rank_at'),
  };
}

export function findGroup(
  db: DatabaseSync,
  plugin: string,
  identityKey: string,
): GroupRow | null {
  const row = db.prepare(`${SELECT} WHERE plugin = ? AND identity_key = ?`).get(plugin, identityKey);
  return row === undefined ? null : toGroupRow(row as SqlRow);
}

export function getGroup(db: DatabaseSync, id: number): GroupRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toGroupRow(row as SqlRow);
}

export interface NewGroup {
  plugin: string;
  identityKey: string;
  display: string;
  searchText: string;
  createdAt: number;
}

export function insertGroup(db: DatabaseSync, group: NewGroup): number {
  const result = db
    .prepare(
      `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      group.plugin,
      group.identityKey,
      group.display,
      group.searchText,
      group.createdAt,
      group.createdAt,
    );
  return Number(result.lastInsertRowid);
}

/**
 * The invariant `upgrade_release_id` is supposed to express: the
 * highest-scoring release in the group that is strictly better than
 * `picked_release_id`, or NULL when there is none.
 *
 * Deriving it, rather than remembering whichever arrival last noticed
 * something better, is what makes the flag survive the two writes that change
 * the *other* side of the comparison. `completeUpgrade` used to clear it
 * unconditionally, discarding a different, better release flagged while the
 * download was in flight; `markPicked` never set it at all, so picking the
 * worse of two releases a group already held left the better one unflagged and
 * dropped the group out of browse entirely (browse shows `state = 'new' OR
 * upgrade_release_id IS NOT NULL`), with nothing left that could ever surface
 * it again. Both are the same defect — a fact treated as an event — and one
 * rule replaces both mechanisms.
 *
 * Ties do not count: `score > picked` is strict, so an equal-scoring
 * alternative is not an upgrade. A picked release that no longer exists makes
 * the subquery NULL, and `score > NULL` is NULL, so the result is correctly
 * "nothing flagged" rather than "everything is better".
 */
function deriveUpgradeReleaseId(
  db: DatabaseSync,
  groupId: number,
  pickedReleaseId: number | null,
): number | null {
  if (pickedReleaseId === null) return null;
  const row = db
    .prepare(
      `SELECT id FROM releases
       WHERE group_id = ? AND score > (SELECT score FROM releases WHERE id = ?)
       ORDER BY score DESC, id DESC LIMIT 1`,
    )
    .get(groupId, pickedReleaseId);
  return row === undefined ? null : num(row as SqlRow, 'id');
}

/**
 * Re-derives the flag *and* moves list_rank_at — the only write in the system
 * that does the latter. Ingest calls this when a newly arrived release beats
 * both the pick and anything already flagged, which is the sole event the spec
 * says should lift a group back to the top of the browse list. The flag itself
 * is recomputed from the same rule every other write uses, so this is that
 * rule plus a bump, not a second mechanism that could disagree with it.
 */
export function flagUpgrade(db: DatabaseSync, groupId: number, now: number): void {
  const group = getGroup(db, groupId);
  const upgrade =
    group === null ? null : deriveUpgradeReleaseId(db, groupId, group.pickedReleaseId);
  db.prepare('UPDATE media_groups SET upgrade_release_id = ?, list_rank_at = ? WHERE id = ?').run(
    upgrade,
    now,
    groupId,
  );
}

/**
 * Deliberately leaves list_rank_at alone: re-deriving a flag is not a new
 * release arriving, and only a new arrival earns a group a place at the top of
 * the list.
 */
export function markPicked(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = ?, upgrade_release_id = ? WHERE id = ?",
  ).run(releaseId, deriveUpgradeReleaseId(db, groupId, releaseId), groupId);
}

/** Same rule, same silence on list_rank_at, as markPicked above. */
export function completeUpgrade(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    'UPDATE media_groups SET picked_release_id = ?, upgrade_release_id = ? WHERE id = ?',
  ).run(releaseId, deriveUpgradeReleaseId(db, groupId, releaseId), groupId);
}

export interface BrowseQuery {
  cursor: { listRankAt: number; id: number } | null;
  limit: number;
  search: string | null;
}

/**
 * One query serves both cases from the spec: unpicked groups, and picked
 * groups with something better available. Keyset pagination on
 * (list_rank_at, id) keeps paging stable while ingest is writing.
 */
export function browseGroups(db: DatabaseSync, query: BrowseQuery): GroupRow[] {
  const conditions = ["(state = 'new' OR upgrade_release_id IS NOT NULL)"];
  const params: (string | number)[] = [];

  if (query.search !== null) {
    conditions.push('search_text LIKE ?');
    params.push(`%${query.search.toLowerCase()}%`);
  }
  if (query.cursor !== null) {
    conditions.push('(list_rank_at < ? OR (list_rank_at = ? AND id < ?))');
    params.push(query.cursor.listRankAt, query.cursor.listRankAt, query.cursor.id);
  }
  params.push(query.limit);

  return db
    .prepare(
      `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY list_rank_at DESC, id DESC LIMIT ?`,
    )
    .all(...params)
    .map((row) => toGroupRow(row as SqlRow));
}

export function pickedGroups(db: DatabaseSync): GroupRow[] {
  return db
    .prepare(`${SELECT} WHERE state = 'picked' ORDER BY list_rank_at DESC, id DESC`)
    .all()
    .map((row) => toGroupRow(row as SqlRow));
}
