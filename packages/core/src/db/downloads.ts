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

/**
 * The identifier a download's client-side job is submitted under, independent
 * of the release's own name. `addUrl` callers (pick.ts on the first attempt,
 * reconcile.ts on every retry) pass this as the client's job label so that a
 * job the client already accepted can be recognized again from the client's
 * own queue/history — never by matching against the release title, which is
 * exactly the kind of free-text matching that has cost this project multiple
 * fix rounds elsewhere (the scenes parser). Stable and derived from the
 * download's own id, so the same label is produced on every attempt without
 * needing to be stored anywhere new.
 */
export function downloadLabel(id: number): string {
  return `pickarr-${id}`;
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

/**
 * Every setter below issues a single-row `WHERE id = ?` update. A stale or
 * mistyped id must not silently no-op forever — the caller finds out
 * immediately, by name, rather than downstream when nothing happened. This
 * is safe against SQLite's own semantics: a row that matches `WHERE id = ?`
 * always reports `changes = 1` from an UPDATE, even when every assigned
 * column already held the value being written, so `changes === 0` here can
 * only mean "no row with this id" (verified empirically, not assumed).
 */
function requireAffected(helper: string, id: number, changes: number | bigint): void {
  if (Number(changes) === 0) throw new Error(`${helper}: no download with id ${id}`);
}

export function setClientRef(
  db: DatabaseSync,
  id: number,
  clientRef: string,
  now: number,
): void {
  const result = db
    .prepare(
      "UPDATE downloads SET client_ref = ?, status = 'downloading', error = NULL, updated_at = ? WHERE id = ?",
    )
    .run(clientRef, now, id);
  requireAffected('setClientRef', id, result.changes);
}

export function setStatus(
  db: DatabaseSync,
  id: number,
  status: DownloadStatus,
  now: number,
): void {
  const result = db
    .prepare('UPDATE downloads SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now, id);
  requireAffected('setStatus', id, result.changes);
}

export function setStoragePath(
  db: DatabaseSync,
  id: number,
  storagePath: string,
  now: number,
): void {
  const result = db
    .prepare('UPDATE downloads SET storage_path = ?, updated_at = ? WHERE id = ?')
    .run(storagePath, now, id);
  requireAffected('setStoragePath', id, result.changes);
}

export function failDownload(db: DatabaseSync, id: number, error: string, now: number): void {
  const result = db
    .prepare("UPDATE downloads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .run(error, now, id);
  requireAffected('failDownload', id, result.changes);
}

export function recordError(db: DatabaseSync, id: number, error: string, now: number): void {
  const result = db
    .prepare('UPDATE downloads SET error = ?, updated_at = ? WHERE id = ?')
    .run(error, now, id);
  requireAffected('recordError', id, result.changes);
}

export function bumpAttempts(db: DatabaseSync, id: number, now: number): number {
  const result = db
    .prepare('UPDATE downloads SET attempts = attempts + 1, updated_at = ? WHERE id = ?')
    .run(now, id);
  requireAffected('bumpAttempts', id, result.changes);
  const row = getDownload(db, id);
  if (row === null) throw new Error(`bumpAttempts: download ${id} vanished after its own update`);
  return row.attempts;
}

export function bumpMissingPolls(db: DatabaseSync, id: number, now: number): number {
  const result = db
    .prepare('UPDATE downloads SET missing_polls = missing_polls + 1, updated_at = ? WHERE id = ?')
    .run(now, id);
  requireAffected('bumpMissingPolls', id, result.changes);
  const row = getDownload(db, id);
  if (row === null) {
    throw new Error(`bumpMissingPolls: download ${id} vanished after its own update`);
  }
  return row.missingPolls;
}

/**
 * A no-op when missing_polls is already 0 is legitimate (idempotent reset,
 * not an error) and must not be confused with "no such id" — so a bad id is
 * detected with a separate existence check, not by the affected-row count.
 */
export function resetMissingPolls(db: DatabaseSync, id: number): void {
  const result = db
    .prepare('UPDATE downloads SET missing_polls = 0 WHERE id = ? AND missing_polls != 0')
    .run(id);
  if (result.changes === 0 && getDownload(db, id) === null) {
    throw new Error(`resetMissingPolls: no download with id ${id}`);
  }
}
