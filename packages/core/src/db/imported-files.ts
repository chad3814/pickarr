import type { DatabaseSync } from 'node:sqlite';
import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';

export interface ImportedFileRow {
  id: number;
  downloadId: number;
  groupId: number;
  sourcePath: string;
  destPath: string;
  sizeBytes: number;
  trashedAt: number | null;
  trashPath: string | null;
  createdAt: number;
}

const SELECT = `
  SELECT id, download_id, group_id, source_path, dest_path, size_bytes,
         trashed_at, trash_path, created_at
  FROM imported_files
`;

function toRow(row: SqlRow): ImportedFileRow {
  return {
    id: num(row, 'id'),
    downloadId: num(row, 'download_id'),
    groupId: num(row, 'group_id'),
    sourcePath: str(row, 'source_path'),
    destPath: str(row, 'dest_path'),
    sizeBytes: num(row, 'size_bytes'),
    trashedAt: maybeNum(row, 'trashed_at'),
    trashPath: maybeStr(row, 'trash_path'),
    createdAt: num(row, 'created_at'),
  };
}

export interface NewImportedFile {
  downloadId: number;
  groupId: number;
  sourcePath: string;
  destPath: string;
  sizeBytes: number;
  createdAt: number;
}

export function insertImportedFile(db: DatabaseSync, file: NewImportedFile): number {
  const result = db
    .prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      file.downloadId,
      file.groupId,
      file.sourcePath,
      file.destPath,
      file.sizeBytes,
      file.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function liveFilesForGroup(db: DatabaseSync, groupId: number): ImportedFileRow[] {
  return db
    .prepare(`${SELECT} WHERE group_id = ? AND trashed_at IS NULL ORDER BY id`)
    .all(groupId)
    .map((row) => toRow(row as SqlRow));
}

export function findLiveByDest(
  db: DatabaseSync,
  groupId: number,
  destPath: string,
): ImportedFileRow | null {
  const row = db
    .prepare(`${SELECT} WHERE group_id = ? AND dest_path = ? AND trashed_at IS NULL`)
    .get(groupId, destPath);
  return row === undefined ? null : toRow(row as SqlRow);
}

export function markTrashed(
  db: DatabaseSync,
  id: number,
  trashPath: string,
  now: number,
): void {
  db.prepare('UPDATE imported_files SET trashed_at = ?, trash_path = ? WHERE id = ?').run(
    now,
    trashPath,
    id,
  );
}
