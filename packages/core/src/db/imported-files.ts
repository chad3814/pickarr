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

/**
 * A group's live rows, optionally excluding one download's own.
 *
 * The exclusion exists because the only caller that acts on this list —
 * `trashLiveFiles` — is invoked *by* an import, to clear the way for that
 * import's own output. "Live files of this group" and "files this import is
 * superseding" are the same set only on a first attempt: the moment an import
 * retries (a crash between the transfer and the status write, a boot recovery
 * that resets `importing` to `completed`, an operator-triggered retry), rows
 * this same download inserted on an earlier attempt are live too, and trashing
 * them destroys the very files the retry is about to claim it wrote. Excluding
 * the download doing the work makes the list mean what the caller needs —
 * *other* downloads' files — rather than what it happened to mean the first
 * time through. In production the superseded file's row always belongs to an
 * earlier download, so it is still returned and still trashed.
 */
export function liveFilesForGroup(
  db: DatabaseSync,
  groupId: number,
  excludeDownloadId: number | null = null,
): ImportedFileRow[] {
  if (excludeDownloadId === null) {
    return db
      .prepare(`${SELECT} WHERE group_id = ? AND trashed_at IS NULL ORDER BY id`)
      .all(groupId)
      .map((row) => toRow(row as SqlRow));
  }
  return db
    .prepare(
      `${SELECT} WHERE group_id = ? AND trashed_at IS NULL AND download_id != ? ORDER BY id`,
    )
    .all(groupId, excludeDownloadId)
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

/**
 * `trashPath` is nullable: when the file this row describes was already
 * absent by the time it was checked, no filesystem move happened, and there
 * is no location to record. Recording a guessed path (such as the path this
 * attempt *would* have used) would tell an operator to look somewhere the
 * file never was — which is worse than telling them, honestly, that its
 * location is unknown and to search `trashDir` directly.
 */
export function markTrashed(
  db: DatabaseSync,
  id: number,
  trashPath: string | null,
  now: number,
): void {
  db.prepare('UPDATE imported_files SET trashed_at = ?, trash_path = ? WHERE id = ?').run(
    now,
    trashPath,
    id,
  );
}

/** Every row for a group, live or already trashed — for inspection/tests. */
export function filesForGroup(db: DatabaseSync, groupId: number): ImportedFileRow[] {
  return db
    .prepare(`${SELECT} WHERE group_id = ? ORDER BY id`)
    .all(groupId)
    .map((row) => toRow(row as SqlRow));
}
