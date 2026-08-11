import type { DatabaseSync } from 'node:sqlite';
import { refreshUpgradeFlag } from './groups.ts';
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
 *
 * This id is unique only within one Pickarr installation's own database — it
 * carries no per-installation salt. Two Pickarr instances sharing one
 * SABnzbd server *and* one category will eventually mint the same label for
 * two different downloads, and reconcile's label-based recovery would then
 * attach the wrong ref to a row rather than merely double-submitting.
 * Avoiding this is a deployment constraint, not something this function
 * enforces: each Pickarr instance must be configured with its own SABnzbd
 * category (see the `category` field in config/schema.ts).
 */
export function downloadLabel(id: number): string {
  return `pickarr-${id}`;
}

/**
 * The structural delimiter `extractLabel` anchors on: a `downloadLabel`
 * wrapped in brackets at the very end of a client-reported name. Anchoring on
 * this rather than scanning for the label as a substring, or matching against
 * the release title, is deliberate — free-text matching against a release
 * title is exactly what has cost this project multiple fix rounds elsewhere
 * (the scenes parser).
 */
const LABEL_MARKER_PATTERN = /\[(pickarr-\d+)\]\s*$/;

/**
 * The name pickarr sends the client as a job's display name: the release
 * title, for legibility in the client's own UI (SABnzbd's queue/history
 * otherwise shows every job as an unreadable `pickarr-<id>`), with
 * `downloadLabel(id)` appended as a bracketed marker `extractLabel` can pull
 * back out deterministically. The marker goes at the end rather than
 * anywhere else in the string so it survives a client that reflows or
 * re-punctuates the title ahead of it — as long as the client does not
 * truncate the name outright, which is exactly the failure `extractLabel`
 * returning null is meant to surface (see `warnIfLabelMismatch` in
 * `pipeline/reconcile.ts`).
 */
export function clientJobName(title: string, id: number): string {
  return `${title} [${downloadLabel(id)}]`;
}

/**
 * The inverse of `clientJobName`: pulls the label back out of a
 * client-reported name, or `null` if there is no well-formed trailing marker
 * — the client sanitised, reflowed past, or truncated it away. A `null`
 * result is exactly what should make label-based recovery treat the entry as
 * unrecognized and `warnIfLabelMismatch` fire.
 */
export function extractLabel(name: string): string | null {
  return LABEL_MARKER_PATTERN.exec(name)?.[1] ?? null;
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

/**
 * Re-derives the group's upgrade flag as well as writing the status, because
 * failing is one of the writes that changes a side of that comparison:
 * `deriveUpgradeReleaseId` will not flag a release whose latest download
 * failed, and `upgrade_release_id` is a stored column that only says so once
 * something recomputes it.
 *
 * Without this the exclusion took effect at an arbitrary later moment — the
 * next unrelated write that happened to call `refreshUpgradeFlag`, perhaps a
 * quality edit days afterwards — at which point the group dropped off Browse
 * for a reason having nothing to do with the edit that triggered it. Doing it
 * here makes the two halves one instant: the group stops being advertised on
 * Browse with the release that just failed, and appears at the top of Picks
 * with that release marked, on the same write. Evicted from one screen and
 * surfaced on another, rather than quietly absent from both.
 *
 * That is a claim about the *eviction* direction only, and only that direction
 * is fixed. The inverse still lags: `resetForRetry` makes a failed release
 * eligible again without re-deriving, so between a retry and the next unrelated
 * write the release is advertised on neither screen. That window is correct
 * rather than merely tolerated — it coincides exactly with "already
 * downloading", and picking a mid-download release is refused anyway
 * (`inFlightForRelease`, which excludes only 'failed'), so there is nothing to
 * advertise while it lasts.
 *
 * It lives in this function rather than at the seven `failDownload` call sites
 * in reconcile.ts for the reason `deriveUpgradeReleaseId` exists at all: an
 * invariant re-derived by whichever caller remembers is an invariant that holds
 * on some paths. This is the only writer of `status = 'failed'` in the package,
 * so every failure path inherits the re-derivation by construction.
 *
 * Both statements go in one transaction so the "one instant" above is true of a
 * crash too, not merely of a reader — nothing here awaits, so no query can
 * observe the gap, but a process that died between them would leave exactly the
 * stale flag this exists to prevent. No caller holds a transaction open
 * (reconcile, the only one, opens none), so this is never nested.
 *
 * The re-derivation reads the row back for its `group_id` instead of taking one
 * from the caller — the id it must use is the one the download itself records,
 * and a second parameter would be a second thing that could be wrong.
 */
export function failDownload(db: DatabaseSync, id: number, error: string, now: number): void {
  db.exec('BEGIN');
  try {
    const result = db
      .prepare("UPDATE downloads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, now, id);
    requireAffected('failDownload', id, result.changes);
    const download = getDownload(db, id);
    // `requireAffected` has already thrown if no row matched, so this cannot be
    // null. It is the type system's branch, not a real one — same shape, and
    // the same wording, as `bumpAttempts` uses for the same impossibility.
    if (download === null) {
      throw new Error(`failDownload: download ${id} vanished after its own update`);
    }
    refreshUpgradeFlag(db, download.groupId);
    db.exec('COMMIT');
  } catch (error_) {
    db.exec('ROLLBACK');
    throw error_;
  }
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

/**
 * Resumes from the furthest point already reached: a row that has a storage
 * path only needs its import redone, everything else restarts from queued.
 */
export function resetForRetry(db: DatabaseSync, id: number, now: number): DownloadRow | null {
  const download = getDownload(db, id);
  if (download === null) return null;

  const status: DownloadStatus = download.storagePath === null ? 'queued' : 'completed';
  db.prepare(
    `UPDATE downloads
     SET status = ?, error = NULL, attempts = 0, missing_polls = 0,
         client_ref = CASE WHEN ? = 'queued' THEN NULL ELSE client_ref END,
         updated_at = ?
     WHERE id = ?`,
  ).run(status, status, now, id);

  return getDownload(db, id);
}
