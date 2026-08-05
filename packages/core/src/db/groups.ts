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

/** The only write in the system that moves list_rank_at. */
export function flagUpgrade(
  db: DatabaseSync,
  groupId: number,
  releaseId: number,
  now: number,
): void {
  db.prepare('UPDATE media_groups SET upgrade_release_id = ?, list_rank_at = ? WHERE id = ?').run(
    releaseId,
    now,
    groupId,
  );
}

export function markPicked(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = ? WHERE id = ?",
  ).run(releaseId, groupId);
}

export function completeUpgrade(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    'UPDATE media_groups SET picked_release_id = ?, upgrade_release_id = NULL WHERE id = ?',
  ).run(releaseId, groupId);
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
