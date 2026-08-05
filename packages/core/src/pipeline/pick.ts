import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClient } from '../clients/types.ts';
import { getGroup, markPicked } from '../db/groups.ts';
import { getRelease, linkForRelease } from '../db/releases.ts';
import {
  downloadLabel,
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
}

/**
 * Marks the group picked and starts the download.
 *
 * `kind` is derived here, not accepted from the caller: a group already in
 * state 'picked' yields an upgrade, anything else yields an initial pick.
 * Accepting `kind` as an input made correctness depend on every caller
 * deriving it correctly — in particular, nothing stopped a second `initial`
 * pick of a *different* release on an already-picked group from silently
 * repointing picked_release_id and orphaning the first download. Deriving it
 * from the group's own state removes that failure mode outright rather than
 * adding a check for it.
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

  const kind: DownloadKind = group.state === 'picked' ? 'upgrade' : 'initial';

  let downloadId: number;
  db.exec('BEGIN');
  try {
    if (kind === 'initial') markPicked(db, request.groupId, request.releaseId);
    downloadId = insertDownload(db, {
      releaseId: request.releaseId,
      groupId: request.groupId,
      clientId: client.id,
      kind,
      createdAt: now,
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const link = linkForRelease(db, request.releaseId);
  if (link === null) throw new Error(`Release ${request.releaseId} has no feed item link`);

  // addUrl and the persist that follows it are recorded as distinguishable
  // failure modes. If addUrl throws, nothing was submitted — the row stays
  // exactly as an untried queued row looks, and a reconcile tick can safely
  // retry addUrl. If addUrl succeeds but persisting the ref throws, the
  // submission already happened; recording that identically to an addUrl
  // failure would make a naive reconcile retry addUrl and double-submit the
  // same nzb, so that case is recorded with a distinct message naming the
  // ref that was already accepted. addUrl is given downloadLabel(downloadId)
  // rather than anything derived from the release, so that if this call
  // succeeds and only the persist below fails, a reconcile tick can recover
  // the ref from the client's own queue/history by that same label instead
  // of submitting the nzb a second time.
  let clientRef: string;
  try {
    clientRef = await client.addUrl(link, downloadLabel(downloadId));
  } catch (error) {
    recordError(db, downloadId, (error as Error).message, now);
    return mustGetDownload(db, downloadId);
  }

  try {
    setClientRef(db, downloadId, clientRef, now);
  } catch (error) {
    recordError(
      db,
      downloadId,
      `Submitted to ${client.id} as ${clientRef} but failed to persist the reference: ${(error as Error).message}`,
      now,
    );
  }

  return mustGetDownload(db, downloadId);
}

function mustGetDownload(db: DatabaseSync, id: number): DownloadRow {
  const stored = getDownload(db, id);
  if (stored === null) throw new Error(`Download ${id} vanished immediately after insert`);
  return stored;
}
