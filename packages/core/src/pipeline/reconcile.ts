import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClient } from '../clients/types.ts';
import { linkForRelease } from '../db/releases.ts';
import {
  activeDownloads,
  bumpAttempts,
  bumpMissingPolls,
  downloadLabel,
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
  state: 'downloading' | 'completed' | 'failed';
  percentage: number | null;
}

export interface ReconcileResult {
  untracked: UntrackedEntry[];
  advanced: number;
  failed: number;
  imported: number;
}

export interface ReconcileDeps {
  db: DatabaseSync;
  client: DownloadClient;
  now(): number;
  importDownload(download: DownloadRow): Promise<void>;
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
  if (actualName === expected) return;
  warnedLabelMismatch = true;
  console.warn(
    `pickarr: download ${download.id} is named '${actualName}' at the client, expected ` +
      `'${expected}'; label-based double-submit recovery will not work against this server.`,
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
  const result: ReconcileResult = { untracked: [], advanced: 0, failed: 0, imported: 0 };

  const snapshot = await client.snapshot();
  const queueByRef = new Map(snapshot.queue.map((entry) => [entry.ref, entry]));
  const historyByRef = new Map(snapshot.history.map((entry) => [entry.ref, entry]));

  // Keyed by the label a download was submitted under, not by anything the
  // client or the release supplied. Built from history first and queue
  // second, so a label present in both (a job caught mid-transition) resolves
  // to the still-active queue slot.
  const refByLabel = new Map<string, string>();
  for (const entry of snapshot.history) refByLabel.set(entry.name, entry.ref);
  for (const entry of snapshot.queue) refByLabel.set(entry.name, entry.ref);

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
      failDownload(db, row.id, (error as Error).message, now);
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

        try {
          const ref = await client.addUrl(link, label);
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

  return result;
}
