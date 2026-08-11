import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClient } from '../clients/types.ts';
import { getGroup, markPicked } from '../db/groups.ts';
import { liveFilesForGroup } from '../db/imported-files.ts';
import { getRelease, linkForRelease, titleForRelease } from '../db/releases.ts';
import {
  clientJobName,
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
 * `kind` is derived here, not accepted from the caller. Accepting it as an
 * input made correctness depend on every caller deriving it correctly — in
 * particular, nothing stopped a second `initial` pick of a *different* release
 * on an already-picked group from silently repointing picked_release_id and
 * orphaning the first download. Deriving it here removes that failure mode
 * outright rather than adding a check for it.
 *
 * What it is derived *from* is whether the group has a file on disk, not
 * whether it is in state 'picked'. An upgrade means "replace the file you
 * have": it defers moving the pick until the replacement imports, and on
 * import it trashes what it superseded. A group whose only download failed is
 * still 'picked' — a failed download does not release the pick, the user still
 * wants the content — but it holds nothing, so neither behaviour applies and
 * both are actively wrong: there is no file to trash, and deferring the
 * pointer would leave the group pointed at the release that just failed.
 * `liveFilesForGroup` is the question asked, so trashed rows do not count;
 * the file they describe is gone.
 *
 * This also changes a case beyond the failed one, and changes it on disk, not
 * merely in a pointer: picking a second release while the first is still
 * downloading is now 'initial' rather than 'upgrade'. If both then import, the
 * old rule trashed the first file as the second superseded it; the new one
 * leaves **both files live** in the library under one group. That is a real
 * regression in that ordering, accepted here because the reverse ordering —
 * second import first, then the first — already left both files live under the
 * old rule, so this is a pre-existing hole being widened rather than opened,
 * and it is filed separately. Nothing in this function cancels the abandoned
 * download, which is the actual missing step. What the change does buy is that
 * the group ends up pointed at what the user last asked for instead of at a
 * release they moved off.
 *
 * Choosing a *lower*-scoring release while holding a file is still an upgrade,
 * because it does replace that file.
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

  const kind: DownloadKind =
    liveFilesForGroup(db, request.groupId).length > 0 ? 'upgrade' : 'initial';

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
  const title = titleForRelease(db, request.releaseId) ?? link;

  // addUrl and the persist that follows it are recorded as distinguishable
  // failure modes. If addUrl throws, nothing was submitted — the row stays
  // exactly as an untried queued row looks, and a reconcile tick can safely
  // retry addUrl. If addUrl succeeds but persisting the ref throws, the
  // submission already happened; recording that identically to an addUrl
  // failure would make a naive reconcile retry addUrl and double-submit the
  // same nzb, so that case is recorded with a distinct message naming the
  // ref that was already accepted. addUrl is given clientJobName(title,
  // downloadId), which carries downloadLabel(downloadId) as a bracketed
  // marker rather than anything else derived from the release, so that if
  // this call succeeds and only the persist below fails, a reconcile tick
  // can recover the ref from the client's own queue/history by that same
  // marker instead of submitting the nzb a second time.
  let clientRef: string;
  try {
    clientRef = await client.addUrl(link, clientJobName(title, downloadId));
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
