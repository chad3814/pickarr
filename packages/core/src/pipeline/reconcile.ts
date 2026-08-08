import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClient } from '../clients/types.ts';
import { linkForRelease, titleForRelease } from '../db/releases.ts';
import {
  activeDownloads,
  bumpAttempts,
  bumpMissingPolls,
  clientJobName,
  downloadLabel,
  extractLabel,
  failDownload,
  getDownload,
  recordError,
  resetMissingPolls,
  setClientRef,
  setStatus,
  setStoragePath,
  type DownloadRow,
} from '../db/downloads.ts';

export const MAX_ADDURL_ATTEMPTS = 5;
export const MAX_MISSING_POLLS = 3;

export interface UntrackedEntry {
  ref: string;
  name: string;
  state: 'downloading' | 'completed' | 'failed' | 'in-progress';
  percentage: number | null;
}

export interface ReconcileResult {
  untracked: UntrackedEntry[];
  advanced: number;
  failed: number;
  imported: number;
  /** Finished jobs dropped from the client, freeing their download directory. */
  removed: number;
}

export interface ReconcileDeps {
  db: DatabaseSync;
  client: DownloadClient;
  now(): number;
  importDownload(download: DownloadRow): Promise<void>;
  /** Optional; only used to surface cleanup failures, which are not fatal. */
  log?(message: string): void;
  /** Injectable for tests, as `rename` is in import.ts. Defaults to the real one. */
  rm?: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
}

/**
 * The directory the client made for this job, or `null` when nothing at the
 * storage path can be *proved* to be it.
 *
 * SABnzbd deletes the files it knows about and leaves the folder standing, so
 * removing the folder is Pickarr's job — and it is the one piece of cleanup
 * that can destroy something it did not create. The proof required is the
 * label Pickarr itself put in the job name: `clientJobName` appends
 * `[pickarr-<id>]`, SABnzbd names the folder after the job, and this checks
 * that the folder in hand carries *this* download's label.
 *
 * Both shapes of storage path are covered, because both occur: the directory
 * itself, and — for a job that unpacked to a single file — the file inside it,
 * whose parent is then the directory. The label is what tells them apart, not
 * a filesystem probe.
 *
 * What the check is really guarding against is a client configured to put
 * completed files straight into the category directory with no per-job folder.
 * The storage path is then `<category>/scene.mp4`, whose parent is a directory
 * shared with every other job — including other people's. That parent carries
 * no label, so it is refused, and the worst case is a folder left behind
 * rather than a category wiped out.
 */
function jobDirectory(id: number, storagePath: string | null): string | null {
  if (storagePath === null) return null;
  const label = downloadLabel(id);
  const path = storagePath.replace(/\/+$/, '');
  if (path.length === 0) return null;
  if (extractLabel(basename(path)) === label) return path;
  const parent = dirname(path);
  return extractLabel(basename(parent)) === label ? parent : null;
}

/**
 * Whether the process has already emitted the "client does not honor our
 * label" warning below. Recovery depends on the client surfacing the label a
 * download was submitted under verbatim as that entry's name; if it doesn't
 * (a server that renames jobs once the nzb is fetched, say), `refByLabel`
 * will simply never match and every retry falls back to the pre-fix
 * double-submit risk — silently, since nothing here throws. The warning
 * makes that failure visible instead. It is deliberately global-once rather
 * than once per tick: a short poll interval would otherwise flood the log
 * with the same fact restated every few seconds.
 */
let warnedLabelMismatch = false;

/**
 * Test-only escape hatch. node:test runs every test in one file inside a
 * single process/module instance, so the "once per process" flag above
 * persists across tests in the same file unless a test resets it first.
 */
export function resetLabelMismatchWarningForTests(): void {
  warnedLabelMismatch = false;
}

function warnIfLabelMismatch(download: DownloadRow, actualName: string): void {
  if (warnedLabelMismatch) return;
  const expected = downloadLabel(download.id);
  if (extractLabel(actualName) === expected) return;
  warnedLabelMismatch = true;
  console.warn(
    `pickarr: download ${download.id} is named '${actualName}' at the client, expected ` +
      `a name ending '[${expected}]'; label-based double-submit recovery will not work ` +
      'against this server.',
  );
}

/**
 * One poll of a client's category, reconciled against the database.
 *
 * Polling by category rather than per download means a fixed two requests per
 * tick, and gives untracked visibility for free. Untracked entries are never
 * imported and never persisted: SABnzbd prunes history on its own schedule and
 * orphan rows would accumulate forever.
 *
 * A `queued` row with a null `client_ref` is ambiguous on its face — it looks
 * identical whether `addUrl` was never attempted, or it succeeded and only the
 * write of the ref was lost (a crash between the two, or the persist failure
 * `pick.ts` records with a distinct message naming the ref that was already
 * accepted). Retrying `addUrl` unconditionally for that row would double-submit
 * the nzb whenever the ambiguous case is the true one, leaving one submission
 * permanently untracked in the client. So every `addUrl` call this loop makes
 * — the very first, from `pick.ts`, and every retry here — is given
 * `downloadLabel(id)` as the client's job label, and before calling `addUrl`
 * again this loop checks the very snapshot it already fetched for an entry
 * already carrying that label. Finding one means the submission already
 * happened somewhere between then and now; the ref is recovered from it and no
 * second `addUrl` call is made, and — because the entry came out of this same
 * snapshot — the rest of this tick's queue/history handling applies to it
 * immediately rather than waiting a further poll. Not finding one means
 * nothing has reached the client under this download's name, and a retry is
 * safe. The label is ours, chosen from the download's own id — never the
 * release's own name, which is exactly the kind of free-text matching that
 * cost this project multiple fix rounds elsewhere (the scenes parser).
 */
export async function reconcileClient(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { db, client } = deps;
  const now = deps.now();
  const result: ReconcileResult = { untracked: [], advanced: 0, failed: 0, imported: 0, removed: 0 };

  const snapshot = await client.snapshot();
  const queueByRef = new Map(snapshot.queue.map((entry) => [entry.ref, entry]));
  const historyByRef = new Map(snapshot.history.map((entry) => [entry.ref, entry]));

  // Keyed by the label a download was submitted under, extracted from
  // whatever name the client reports rather than matched against it as a
  // whole — the client-reported name now carries the release title ahead of
  // the marker (see `clientJobName` in `db/downloads.ts`), so an exact-string
  // match against the bare label would never hit. An entry whose name has no
  // well-formed marker (`extractLabel` returns null) contributes nothing
  // here; that is the case `warnIfLabelMismatch` exists to surface. Built
  // from history first and queue second, so a label present in both (a job
  // caught mid-transition) resolves to the still-active queue slot.
  const refByLabel = new Map<string, string>();
  for (const entry of snapshot.history) {
    const label = extractLabel(entry.name);
    if (label !== null) refByLabel.set(label, entry.ref);
  }
  for (const entry of snapshot.queue) {
    const label = extractLabel(entry.name);
    if (label !== null) refByLabel.set(label, entry.ref);
  }

  // Every ref this client has ever been given, terminal or not — an imported
  // download still sitting in history is ours, not a stranger's.
  const knownRefs = new Set<string>(
    db
      .prepare('SELECT client_ref FROM downloads WHERE client_id = ? AND client_ref IS NOT NULL')
      .all(client.id)
      .map((row) => String(row['client_ref'])),
  );

  /**
   * The single place an import is attempted, so the two routes into it — a
   * job observed finishing during this tick, and a row already sitting in
   * `completed` from an earlier one — cannot drift apart in how they record
   * success or failure.
   */
  async function attemptImport(row: DownloadRow): Promise<void> {
    try {
      await deps.importDownload(row);
      result.imported += 1;
    } catch (error) {
      const message = (error as Error).message;
      failDownload(db, row.id, message, now);
      // The row carries this message and the UI shows it, but a failure only
      // one screen knows about is a failure nobody is told about: the first
      // ENOTDIR from a single-file storage path was found by looking at the
      // UI, with the log saying nothing at all.
      deps.log?.(`reconcile ${client.id}: import failed for download ${row.id}: ${message}`);
      result.failed += 1;
    }
  }

  for (const download of activeDownloads(db, client.id)) {
    // A `completed` row that already has a storage path is waiting on us, not
    // on the client: the transfer finished, the path is recorded, and the only
    // step left is the import. Driving that from the row's own state — rather
    // than only as a side effect of finding the job in the client's history —
    // is what makes it survive the client forgetting about the job. SABnzbd
    // prunes history on its own schedule, and once the entry is gone a
    // history-driven import never fires again: the row matches neither queue
    // nor history, so it accrues missing polls and is eventually failed as
    // 'disappeared-from-client' having never been imported once. Retrying that
    // row reproduces it exactly, because the condition that failed it (an
    // empty history) is the same condition the retry runs under. Exempting
    // these rows from missing-poll accounting falls out of handling them here:
    // "the client no longer lists it" is the expected steady state for a
    // download that is already off the client's books.
    if (download.status === 'completed' && download.storagePath !== null) {
      await attemptImport(download);
      continue;
    }

    let clientRef = download.clientRef;
    let status = download.status;

    if (clientRef === null) {
      const label = downloadLabel(download.id);
      const recovered = refByLabel.get(label);

      if (recovered !== undefined) {
        // The client already has this job under our label — nothing to
        // submit. Recorded here without touching `attempts`: this is a
        // recovery of an existing submission, not a new attempt at one.
        //
        // This can make `advanced` and `failed`/`imported` both increment
        // for the same download in the same tick (recovering the ref below,
        // then discovering below that the recovered job already failed or
        // completed) — that is two separate true events, not one event
        // double-counted, so the counters are not meant to be mutually
        // exclusive within a tick.
        setClientRef(db, download.id, recovered, now);
        knownRefs.add(recovered);
        result.advanced += 1;
        clientRef = recovered;
        status = 'downloading';
        // Falls through rather than `continue`ing: `recovered` was read out
        // of this same snapshot, so the queue/history lookup just below is
        // guaranteed to find it.
      } else {
        const attempts = bumpAttempts(db, download.id, now);
        const link = linkForRelease(db, download.releaseId);
        if (link === null) {
          failDownload(db, download.id, 'addurl-failed: release has no link', now);
          result.failed += 1;
          continue;
        }
        const title = titleForRelease(db, download.releaseId) ?? link;

        try {
          const ref = await client.addUrl(link, clientJobName(title, download.id));
          setClientRef(db, download.id, ref, now);
          knownRefs.add(ref);
          result.advanced += 1;
        } catch (error) {
          const message = (error as Error).message;
          if (attempts >= MAX_ADDURL_ATTEMPTS) {
            failDownload(
              db,
              download.id,
              `addurl-failed after ${attempts} attempts: ${message}`,
              now,
            );
            result.failed += 1;
          } else {
            recordError(db, download.id, message, now);
          }
        }
        // The snapshot was taken before this call could possibly have
        // reached the client (success or failure), so checking queue/history
        // against it now would only read as a false disappearance. Left for
        // the next tick either way.
        continue;
      }
    }

    // Not reachable at runtime — every path above either assigns a non-null
    // clientRef or `continue`s — but the type checker cannot see across the
    // try/catch above, so this is kept purely to narrow `clientRef` to
    // `string` for the rest of the loop body.
    if (clientRef === null) continue;

    const queued = queueByRef.get(clientRef);
    if (queued !== undefined) {
      warnIfLabelMismatch(download, queued.name);
      resetMissingPolls(db, download.id);
      if (status !== 'downloading') {
        setStatus(db, download.id, 'downloading', now);
        result.advanced += 1;
      }
      continue;
    }

    const historic = historyByRef.get(clientRef);
    if (historic !== undefined) {
      warnIfLabelMismatch(download, historic.name);
      resetMissingPolls(db, download.id);

      // A transient post-processing state (extracting, moving, repairing,
      // verifying...) is not a failure and not a state change — the job is
      // still being worked on by the client. We saw it this tick, which is
      // why missing_polls was just reset above, but nothing else about the
      // row changes; the next tick re-reads it fresh.
      if (historic.outcome === 'in-progress') {
        continue;
      }

      if (historic.outcome === 'failed') {
        failDownload(db, download.id, historic.failMessage ?? 'download failed at client', now);
        result.failed += 1;
        continue;
      }

      if (historic.storagePath === null) {
        failDownload(db, download.id, 'client reported success with no storage path', now);
        result.failed += 1;
        continue;
      }

      setStoragePath(db, download.id, client.mapPath(historic.storagePath), now);
      setStatus(db, download.id, 'completed', now);
      result.advanced += 1;

      // Imported here rather than left for the completed-row branch on the
      // next tick: a download that finishes while we are watching should land
      // in the library now, not ten seconds from now. The branch above is the
      // safety net for every other way a row can reach `completed`, not a
      // replacement for this.
      const ready = getDownload(db, download.id);
      if (ready === null) continue;
      await attemptImport(ready);
      continue;
    }

    const misses = bumpMissingPolls(db, download.id, now);
    if (misses >= MAX_MISSING_POLLS) {
      failDownload(db, download.id, 'disappeared-from-client', now);
      result.failed += 1;
    }
  }

  for (const entry of snapshot.queue) {
    if (knownRefs.has(entry.ref)) continue;
    result.untracked.push({
      ref: entry.ref,
      name: entry.name,
      state: 'downloading',
      percentage: entry.percentage,
    });
  }
  for (const entry of snapshot.history) {
    if (knownRefs.has(entry.ref)) continue;
    result.untracked.push({
      ref: entry.ref,
      name: entry.name,
      state: entry.outcome,
      percentage: null,
    });
  }

  // --- Cleanup ---------------------------------------------------------------
  //
  // An imported download's job has served its purpose: the file Pickarr wanted
  // is in the library and what is left under the client's storage path is
  // spent. Nothing else reclaims that space, and nothing else stops the
  // client's history growing for the lifetime of the installation.
  //
  // Driven from the history snapshot rather than from a column, which makes it
  // self-healing for free: while an entry is still listed it is still ours and
  // still imported, so a tick that could not reach the client simply tries
  // again on the next one. `activeDownloads` excludes imported rows, so there
  // is no other pass that would ever revisit them.
  //
  // Runs last, after every status change this tick, so a download imported a
  // few lines above is cleaned up in the same tick rather than the next.
  const removeDir = deps.rm ?? rm;
  const importedJobs = new Map<string, { id: number; directory: string | null }>(
    db
      .prepare(
        `SELECT id, client_ref, storage_path FROM downloads
         WHERE client_id = ? AND status = 'imported' AND client_ref IS NOT NULL`,
      )
      .all(client.id)
      .map((row) => {
        const id = Number(row['id']);
        const storagePath = row['storage_path'];
        return [
          String(row['client_ref']),
          { id, directory: jobDirectory(id, storagePath === null ? null : String(storagePath)) },
        ] as const;
      }),
  );

  for (const entry of snapshot.history) {
    // Ours, and finished with. A stranger's job in a shared category is never
    // touched, and a failure is left where it is — deleting it would destroy
    // the evidence for why it failed.
    const job = importedJobs.get(entry.ref);
    if (job === undefined) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- one call per finished job, and the list is short
      await client.remove(entry.ref, true);
      result.removed += 1;
    } catch (error) {
      // Never a download failure: the import already succeeded and the file is
      // in place. The cost of giving up here is disk space, not data.
      deps.log?.(`reconcile ${client.id}: could not remove ${entry.ref}: ${(error as Error).message}`);
      continue;
    }

    // `del_files` reclaims the files; the folder itself is left standing, so
    // this is what actually frees the job's directory. Recursive, because the
    // point is to leave nothing behind — and safe to be recursive only because
    // `jobDirectory` has already proved the folder is this download's own.
    // `force`, so a directory a previous tick already removed is not an error.
    if (job.directory === null) {
      // Once per job, not once per tick: the entry is gone from history now,
      // so this loop will not see it again.
      deps.log?.(
        `reconcile ${client.id}: removed ${entry.ref} but left its directory in place; ` +
          `nothing at its storage path carries the ${downloadLabel(job.id)} label`,
      );
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- paired with the removal above
      await removeDir(job.directory, { recursive: true, force: true });
    } catch (error) {
      // Disk space again, not data: the import is done and the client's entry
      // is already gone, so there is nothing to retry and nothing at risk.
      deps.log?.(
        `reconcile ${client.id}: could not remove ${job.directory}: ${(error as Error).message}`,
      );
    }
  }

  return result;
}
