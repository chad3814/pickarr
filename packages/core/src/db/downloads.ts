import type { DatabaseSync } from 'node:sqlite';
import { maybeStr, num, str, type SqlRow } from './row.ts';

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'importing'
  | 'imported'
  | 'failed';

export type DownloadKind = 'initial' | 'upgrade';

export const TERMINAL_STATUSES: DownloadStatus[] = ['imported', 'failed'];

export interface DownloadRow {
  id: number;
  releaseId: number;
  groupId: number;
  clientId: string;
  clientRef: string | null;
  kind: DownloadKind;
  status: DownloadStatus;
  storagePath: string | null;
  error: string | null;
  attempts: number;
  missingPolls: number;
  createdAt: number;
  updatedAt: number;
}

const SELECT = `
  SELECT id, release_id, group_id, client_id, client_ref, kind, status,
         storage_path, error, attempts, missing_polls, created_at, updated_at
  FROM downloads
`;

const STATUSES = new Set<string>([
  'queued',
  'downloading',
  'completed',
  'importing',
  'imported',
  'failed',
]);

function toDownloadRow(row: SqlRow): DownloadRow {
  const status = str(row, 'status');
  if (!STATUSES.has(status)) throw new Error(`Unknown download status in database: ${status}`);
  return {
    id: num(row, 'id'),
    releaseId: num(row, 'release_id'),
    groupId: num(row, 'group_id'),
    clientId: str(row, 'client_id'),
    clientRef: maybeStr(row, 'client_ref'),
    kind: str(row, 'kind') === 'upgrade' ? 'upgrade' : 'initial',
    status: status as DownloadStatus,
    storagePath: maybeStr(row, 'storage_path'),
    error: maybeStr(row, 'error'),
    attempts: num(row, 'attempts'),
    missingPolls: num(row, 'missing_polls'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
  };
}

export interface NewDownload {
  releaseId: number;
  groupId: number;
  clientId: string;
  kind: DownloadKind;
  createdAt: number;
}

export function insertDownload(db: DatabaseSync, download: NewDownload): number {
  const result = db
    .prepare(
      `INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      download.releaseId,
      download.groupId,
      download.clientId,
      download.kind,
      download.createdAt,
      download.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function getDownload(db: DatabaseSync, id: number): DownloadRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toDownloadRow(row as SqlRow);
}

export function allDownloads(db: DatabaseSync): DownloadRow[] {
  return db
    .prepare(`${SELECT} ORDER BY created_at DESC, id DESC`)
    .all()
    .map((row) => toDownloadRow(row as SqlRow));
}

export function activeDownloads(db: DatabaseSync, clientId: string): DownloadRow[] {
  return db
    .prepare(`${SELECT} WHERE client_id = ? AND status NOT IN ('imported', 'failed')`)
    .all(clientId)
    .map((row) => toDownloadRow(row as SqlRow));
}

/**
 * Whether releaseId already has a download that a fresh pick would collide
 * with. Excludes only 'failed' — not just the actively-running statuses —
 * because a release that has already reached 'imported' must not be
 * downloaded a second time either; the exclusion set here is "safe to start
 * over", not "currently in progress".
 */
export function inFlightForRelease(db: DatabaseSync, releaseId: number): DownloadRow | null {
  const row = db
    .prepare(`${SELECT} WHERE release_id = ? AND status != 'failed' LIMIT 1`)
    .get(releaseId);
  return row === undefined ? null : toDownloadRow(row as SqlRow);
}

export function setClientRef(
  db: DatabaseSync,
  id: number,
  clientRef: string,
  now: number,
): void {
  db.prepare(
    "UPDATE downloads SET client_ref = ?, status = 'downloading', error = NULL, updated_at = ? WHERE id = ?",
  ).run(clientRef, now, id);
}

export function setStatus(
  db: DatabaseSync,
  id: number,
  status: DownloadStatus,
  now: number,
): void {
  db.prepare('UPDATE downloads SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
}

export function setStoragePath(
  db: DatabaseSync,
  id: number,
  storagePath: string,
  now: number,
): void {
  db.prepare('UPDATE downloads SET storage_path = ?, updated_at = ? WHERE id = ?').run(
    storagePath,
    now,
    id,
  );
}

export function failDownload(db: DatabaseSync, id: number, error: string, now: number): void {
  db.prepare("UPDATE downloads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
    error,
    now,
    id,
  );
}

export function recordError(db: DatabaseSync, id: number, error: string, now: number): void {
  db.prepare('UPDATE downloads SET error = ?, updated_at = ? WHERE id = ?').run(error, now, id);
}

export function bumpAttempts(db: DatabaseSync, id: number, now: number): number {
  db.prepare('UPDATE downloads SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(
    now,
    id,
  );
  return getDownload(db, id)?.attempts ?? 0;
}

export function bumpMissingPolls(db: DatabaseSync, id: number, now: number): number {
  db.prepare(
    'UPDATE downloads SET missing_polls = missing_polls + 1, updated_at = ? WHERE id = ?',
  ).run(now, id);
  return getDownload(db, id)?.missingPolls ?? 0;
}

export function resetMissingPolls(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE downloads SET missing_polls = 0 WHERE id = ? AND missing_polls != 0').run(id);
}
