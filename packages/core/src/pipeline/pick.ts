import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClient } from '../clients/types.ts';
import { getGroup, markPicked } from '../db/groups.ts';
import { getRelease } from '../db/releases.ts';
import { str, type SqlRow } from '../db/row.ts';
import {
  getDownload,
  inFlightForRelease,
  insertDownload,
  recordError,
  setClientRef,
  type DownloadKind,
  type DownloadRow,
} from '../db/downloads.ts';

export interface PickRequest {
  groupId: number;
  releaseId: number;
  kind: DownloadKind;
}

/**
 * Marks the group picked and starts the download.
 *
 * picked_release_id is written here rather than at import time because the
 * ingest rule compares incoming releases against it, and needs something to
 * compare against while a download is still in flight. An upgrade leaves it
 * alone — the replacement repoints it only once the new file is on disk.
 *
 * An unreachable download client must never block a pick, so an addUrl failure
 * leaves the row queued for the reconcile tick to retry.
 */
export async function pickRelease(
  db: DatabaseSync,
  client: DownloadClient,
  request: PickRequest,
  now: number,
): Promise<DownloadRow> {
  const group = getGroup(db, request.groupId);
  if (group === null) throw new Error(`No such group: ${request.groupId}`);

  const release = getRelease(db, request.releaseId);
  if (release === null) throw new Error(`No such release: ${request.releaseId}`);
  if (release.groupId !== request.groupId) {
    throw new Error(`Release ${request.releaseId} does not belong to group ${request.groupId}`);
  }

  const existing = inFlightForRelease(db, request.releaseId);
  if (existing !== null) {
    throw new Error(`Release ${request.releaseId} already has download ${existing.id}`);
  }

  let downloadId: number;
  db.exec('BEGIN');
  try {
    if (request.kind === 'initial') markPicked(db, request.groupId, request.releaseId);
    downloadId = insertDownload(db, {
      releaseId: request.releaseId,
      groupId: request.groupId,
      clientId: client.id,
      kind: request.kind,
      createdAt: now,
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const feedItem = db
    .prepare('SELECT link FROM feed_items WHERE id = ?')
    .get(release.feedItemId);
  const link = feedItem === undefined ? null : str(feedItem as SqlRow, 'link');
  if (link === null) throw new Error(`Release ${request.releaseId} has no feed item link`);

  try {
    const clientRef = await client.addUrl(link);
    setClientRef(db, downloadId, clientRef, now);
  } catch (error) {
    recordError(db, downloadId, (error as Error).message, now);
  }

  const stored = getDownload(db, downloadId);
  if (stored === null) throw new Error(`Download ${downloadId} vanished immediately after insert`);
  return stored;
}
