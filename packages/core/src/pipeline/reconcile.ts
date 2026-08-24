import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ClientHistoryEntry,
  ClientQueueEntry,
  ClientSnapshot,
  DownloadClient,
} from '../clients/types.ts';
import { installLabelToken, type InstallLabelToken } from '../db/app-state.ts';
import { linkForRelease, titleForRelease } from '../db/releases.ts';
import {
  activeDownloads,
  bumpAttempts,
  clearAbsent,
  clientJobName,
  downloadLabel,
  extractLabel,
  failDownload,
  getDownload,
  indexDownloadsForClient,
  labelsFor,
  markAbsent,
  type LabelledDownload,
  reattachClientRef,
  recordError,
  setClientRef,
  setStatus,
  setStoragePath,
  type DownloadRow,
} from '../db/downloads.ts';

export const MAX_ADDURL_ATTEMPTS = 5;

/**
 * The one failure a `failed` row may be re-attached to a client job from.
 *
 * Nothing in this file writes this error any more — absence is an observation
 * now, never a verdict — so the clause matches only rows failed by the code
 * this replaced, and retires itself as those rows are recovered or retried.
 * It is matched exactly rather than by substring: a row that failed to repair,
 * failed to import, or exhausted its `addurl` attempts stays failed, because
 * resurrecting *those* is a different decision with different risks, and the
 * user already has an explicit retry for them.
 */
const RECOVERABLE_FAILURE = 'disappeared-from-client';

export interface UntrackedEntry {
  /**
   * Which configured download client is holding this job.
   *
   * Required, not optional. `ref` is the client's own id for a job and is
   * unique only *within* that client, so once more than one is configured —
   * which is what #34 made reachable — two entries from two clients can carry
   * the same `ref`. Anything collecting these into one list (the scheduler's
   * map, `/api/downloads`, the Downloads screen's keys) needs the pair, and a
   * field the producer might omit would leave those callers guessing.
   */
  clientId: string;
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
  /**
   * Rows this tick found missing from a snapshot known to be complete —
   * every one of them, not only the ones whose mark is new, so the number
   * answers "how much does the client not have" rather than "how much
   * changed". Zero when the snapshot was incomplete, because absence is not
   * something an incomplete snapshot can establish.
   */
  absent: number;
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
 * A queue slot and a history slot reduced to the one shape the matching loop
 * reads, so that loop can be written once over both lists rather than twice,
 * once per list. The two are not interchangeable to the client — a queue slot
 * has a percentage and no outcome, a history slot the reverse — but they are
 * interchangeable to matching, which cares only about the ref, the name and
 * what the client says is happening.
 */
interface SnapshotEntry {
  ref: string;
  name: string;
  category: string | null;
  /**
   * `downloading` is a queue slot: the client still has work to do on it,
   * whatever the reason (fetching, paused, waiting on another job). The other
   * three are history's own readings — see `ClientHistoryEntry.outcome`.
   */
  outcome: 'downloading' | 'completed' | 'failed' | 'in-progress';
  /** Only a queue slot has one; history reports no progress. */
  percentage: number | null;
  storagePath: string | null;
  failMessage: string | null;
}

function fromQueue(entry: ClientQueueEntry): SnapshotEntry {
  return {
    ref: entry.ref,
    name: entry.name,
    category: entry.category,
    outcome: 'downloading',
    percentage: entry.percentage,
    storagePath: null,
    failMessage: null,
  };
}

function fromHistory(entry: ClientHistoryEntry): SnapshotEntry {
  return {
    ref: entry.ref,
    name: entry.name,
    category: entry.category,
    outcome: entry.outcome,
    percentage: null,
    storagePath: entry.storagePath,
    failMessage: entry.failMessage,
  };
}

/**
 * The client's whole picture as one entry per ref, with the queue winning any
 * ref that appears in both lists.
 *
 * Collapsing is not a tidiness measure, it is a correctness one. A job caught
 * mid-transition is listed in history as `Completed` *and* still held in the
 * queue, so a loop that walked history and then the queue would import it on
 * the history reading and then set the very same row back to `downloading` on
 * the queue reading, in one tick — a row that reads as still downloading
 * something it has already imported. One entry per ref makes that
 * unrepresentable, and the queue wins because a job the client is still
 * holding work for is still active: acting a tick late on a completion is
 * harmless, acting early on one is not.
 */
function collapse(snapshot: ClientSnapshot): Map<string, SnapshotEntry> {
  const entries = new Map<string, SnapshotEntry>();
  for (const entry of snapshot.history) entries.set(entry.ref, fromHistory(entry));
  for (const entry of snapshot.queue) entries.set(entry.ref, fromQueue(entry));
  return entries;
}

/**
 * The directory the client made for this job, or `null` when nothing at the
 * storage path can be *proved* to be it.
 *
 * SABnzbd deletes the files it knows about and leaves the folder standing, so
 * removing the folder is Pickarr's job — and it is the one piece of cleanup
 * that can destroy something it did not create. The proof required is the
 * label Pickarr itself put in the job name: `clientJobName` appends
 * `[pickarr-<token>-<id>]`, SABnzbd names the folder after the job, and this
 * checks that the folder in hand carries *this* download's label. It takes
 * the whole row rather than an id because `labelsFor` needs the row's age to
 * decide whether the pre-#28 unsalted marker is admissible for it — a folder
 * made for a job submitted before the token was minted still carries that
 * one, and refusing it would leave those directories behind forever.
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
function jobDirectory(
  scheme: InstallLabelToken,
  download: LabelledDownload,
  storagePath: string | null,
): string | null {
  if (storagePath === null) return null;
  const labels = labelsFor(scheme, download);
  const path = storagePath.replace(/\/+$/, '');
  if (path.length === 0) return null;
  const carriesOurLabel = (candidate: string): boolean => {
    const label = extractLabel(basename(candidate));
    return label !== null && labels.includes(label);
  };
  if (carriesOurLabel(path)) return path;
  const parent = dirname(path);
  return carriesOurLabel(parent) ? parent : null;
}

/**
 * Whether the process has already emitted the "client does not honor our
 * label" warning below. Recovery depends on the client surfacing the label a
 * download was submitted under verbatim as that entry's name; if it doesn't
 * (a server that renames jobs once the nzb is fetched, say), the label will
 * simply never match and every retry falls back to the pre-fix double-submit
 * risk — silently, since nothing here throws. The warning makes that failure
 * visible instead. It is deliberately global-once rather than once per tick:
 * a short poll interval would otherwise flood the log with the same fact
 * restated every few seconds.
 *
 * It is also deliberately checked for *every* matched entry now, not only for
 * the rows that reach the null-ref double-submit guard. The label is a general
 * matching key under this design (a lost or changed ref is recoverable from it),
 * so a client that mangles names breaks more than resubmission — and the sooner
 * that is said, the better. Still once per process, so the wider scope costs
 * nothing in log volume.
 */
let warnedLabelMismatch = false;

/**
 * The same once-per-process treatment for the other way matching can go
 * wrong: an entry whose `nzo_id` names one download while its marker label
 * names another. The ref wins (see `resolve`), so this is not a failure —
 * but it means one of the two keys is lying about which download a job
 * belongs to. A second installation sharing the category used to be the
 * likely cause and is no longer one: labels carry this installation's salt
 * (#28), so a foreign job's label resolves to no row of ours at all. What is
 * left is a `client_ref` written against the wrong row, which is not
 * diagnosable from the outcome, so it is said out loud.
 */
let warnedRefLabelDisagreement = false;

/**
 * Test-only escape hatch. node:test runs every test in one file inside a
 * single process/module instance, so the "once per process" flags above
 * persist across tests in the same file unless a test resets them first.
 */
export function resetReconcileWarningsForTests(): void {
  warnedLabelMismatch = false;
  warnedRefLabelDisagreement = false;
}

function warnIfLabelMismatch(
  scheme: InstallLabelToken,
  download: DownloadRow,
  actualName: string,
): void {
  if (warnedLabelMismatch) return;
  const labels = labelsFor(scheme, download);
  const actual = extractLabel(actualName);
  if (actual !== null && labels.includes(actual)) return;
  // The salted label, not whichever of `labels` happened to be admissible:
  // it is the one every new submission is made under, so it is the one an
  // operator comparing against their client's queue should be looking for.
  const expected = downloadLabel(scheme.token, download.id);
  warnedLabelMismatch = true;
  console.warn(
    `pickarr: download ${download.id} is named '${actualName}' at the client, expected ` +
      `a name ending '[${expected}]'; label-based double-submit recovery will not work ` +
      'against this server.',
  );
}

function warnRefLabelDisagreement(ref: string, byRef: DownloadRow, byLabel: DownloadRow): void {
  if (warnedRefLabelDisagreement) return;
  warnedRefLabelDisagreement = true;
  console.warn(
    `pickarr: client job ${ref} matches download ${byRef.id} by ref but download ` +
      `${byLabel.id} by label; taking the ref. One of the two is wrong — a client_ref ` +
      'has been written against the wrong download row.',
  );
}

/**
 * One poll of a download client, reconciled against the database.
 *
 * The tick iterates the *client* and asks the database what it believes about
 * each job the client is holding. The inverse ordering — walk the active rows,
 * look each one up in the client — is what made the 2026-08-15 incident
 * unrecoverable rather than merely wrong: a row this code had already failed
 * was gone from `activeDownloads`, so nothing ever asked the client about it
 * again, even though SABnzbd was still holding the finished job the whole
 * time. Client-first means a job the client has is reconciled against
 * whatever Pickarr believes about it, including "nothing" and including
 * "failed", so a mistaken verdict is recoverable instead of terminal.
 *
 * The tick is, in order:
 *
 *   1. snapshot the client — queue and history, unfiltered, and carrying
 *      whether it is the client's whole picture (`ClientSnapshot.complete`);
 *   2. submit anything not yet submitted;
 *   3. walk the snapshot, reconciling each entry against its download;
 *   4. sweep the rows the snapshot did not account for;
 *   5. clean up the jobs of downloads already imported.
 *
 * Step 2 runs *after* the snapshot, never before. A `queued` row with a null
 * `client_ref` is ambiguous on its face — it looks identical whether `addUrl`
 * was never attempted, or it succeeded and only the write of the ref was lost
 * (a crash between the two, or the persist failure `pick.ts` records with a
 * distinct message naming the ref that was already accepted). Retrying
 * `addUrl` unconditionally for that row would double-submit the nzb whenever
 * the ambiguous case is the true one, leaving one submission permanently
 * untracked in the client. So every `addUrl` call — the very first, from
 * `pick.ts`, and every retry here — is given `downloadLabel(token, id)` as
 * the client's job label, and before calling `addUrl` again this looks in the
 * snapshot it has *already fetched* for an entry carrying that label. A
 * submission pass that ran first would have nothing to look in and would
 * resubmit every download whose ref write was lost. Finding one means the
 * submission already happened; the ref is recovered from it, no second
 * `addUrl` is made, and step 3 reconciles the entry in this same tick rather
 * than a poll later. The label is ours, derived from the download's own id —
 * never the release's name, which is exactly the free-text matching that has
 * cost this project multiple fix rounds elsewhere (the scenes parser).
 *
 * Untracked entries are never imported and never persisted: SABnzbd prunes
 * history on its own schedule and orphan rows would accumulate forever.
 */
export async function reconcileClient(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { db, client } = deps;
  const now = deps.now();
  // Read once for the whole tick rather than per call site: the token is
  // write-once, so a second read could only ever answer the same thing, and
  // every pass below has to agree about which labels are ours.
  const scheme = installLabelToken(db, now);
  const result: ReconcileResult = {
    untracked: [],
    advanced: 0,
    failed: 0,
    imported: 0,
    removed: 0,
    absent: 0,
  };

  const snapshot = await client.snapshot();

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

  // --- Submission -------------------------------------------------------------
  //
  // Keyed by the label a download was submitted under, extracted from
  // whatever name the client reports rather than matched against it as a
  // whole — the client-reported name carries the release title ahead of the
  // marker (see `clientJobName` in `db/downloads.ts`), so an exact-string
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

  // Rows handed to the client during this tick. Their refs were minted after
  // the snapshot was taken, so the snapshot cannot possibly list them and
  // their absence from it means nothing at all — the sweep in step 4 must not
  // read it as one.
  const submitted = new Set<number>();

  for (const download of activeDownloads(db, client.id)) {
    if (download.clientRef !== null) continue;

    // Salted first, legacy second, and only for a row old enough to have
    // been submitted under a legacy label (`labelsFor`). A foreign
    // installation's job matches neither, so it is left where it is and
    // reported as untracked rather than adopted — which is the whole of #28.
    const recovered = labelsFor(scheme, download)
      .map((label) => refByLabel.get(label))
      .find((ref) => ref !== undefined);
    if (recovered !== undefined) {
      // The client already has this job under our label — nothing to submit.
      // Recorded here without touching `attempts`: this is a recovery of an
      // existing submission, not a new attempt at one. No `submitted` entry
      // either, because the ref came out of the snapshot rather than being
      // added to the client after it: step 3 will find that entry and
      // reconcile the row against it in this same tick.
      //
      // This can make `advanced` and `failed`/`imported` both increment for
      // the same download in the same tick (recovering the ref here, then
      // discovering in step 3 that the recovered job already failed or
      // completed) — that is two separate true events, not one event
      // double-counted, so the counters are not meant to be mutually
      // exclusive within a tick. The `advanced` this increments is the real
      // transition `queued` → `downloading`: this row had no ref at all and
      // now has one, which is exactly what `advanced` is for.
      //
      // This is emphatically *not* a licence for step 3's own re-attachment to
      // count itself as well. That case starts from a row that already has a
      // ref and a status, and the status it ends in is the one the entry
      // dictates; counting the correction and then the transition would report
      // one recovery twice. See the re-attachment comment in step 3.
      setClientRef(db, download.id, recovered, now);
      result.advanced += 1;
      continue;
    }

    const attempts = bumpAttempts(db, download.id, now);
    const link = linkForRelease(db, download.releaseId);
    if (link === null) {
      failDownload(db, download.id, 'addurl-failed: release has no link', now);
      result.failed += 1;
      continue;
    }
    const title = titleForRelease(db, download.releaseId) ?? link;

    try {
      const label = downloadLabel(scheme.token, download.id);
      // eslint-disable-next-line no-await-in-loop -- one submission at a time, deliberately
      const ref = await client.addUrl(link, clientJobName(scheme.token, title, download.id), label);
      setClientRef(db, download.id, ref, now);
      result.advanced += 1;
    } catch (error) {
      const message = (error as Error).message;
      if (attempts >= MAX_ADDURL_ATTEMPTS) {
        failDownload(db, download.id, `addurl-failed after ${attempts} attempts: ${message}`, now);
        result.failed += 1;
      } else {
        recordError(db, download.id, message, now);
      }
    }
    // Whether that call reached the client or not, this row's state at the
    // client postdates the snapshot in hand. Nothing more can be learned
    // about it until the next poll.
    submitted.add(download.id);
  }

  // --- Matching ---------------------------------------------------------------
  //
  // Both reads happen after the submission pass above, so a ref adopted or
  // minted there is already in them and needs no separate bookkeeping.
  //
  // `index` deliberately excludes `imported` rows and deliberately includes
  // `failed` ones (see `indexDownloadsForClient`). `knownRefs` filters by no
  // status at all, which is what lets an entry belonging to an imported row be
  // recognised as ours rather than reported as an orphan.
  const index = indexDownloadsForClient(db, client.id, scheme);
  const knownRefs = new Set<string>(
    db
      .prepare('SELECT client_ref FROM downloads WHERE client_id = ? AND client_ref IS NOT NULL')
      .all(client.id)
      .map((row) => String(row['client_ref'])),
  );

  /**
   * The download a client entry belongs to: its `nzo_id` against
   * `client_ref`, falling back to the `[pickarr-<token>-<id>]` label parsed
   * out of its name. The ref is the primary key and correct in every observed
   * case; the label exists because a ref can be lost or, in principle,
   * change, and a ref that cannot be corrected is a download that can never
   * be reconciled again. Matching is not filtered by category, so a job of ours
   * re-categorised at the client is still found — that was one of the blind
   * spots this design set out to remove.
   */
  function resolve(entry: SnapshotEntry): DownloadRow | undefined {
    const byRef = index.byRef.get(entry.ref);
    const label = extractLabel(entry.name);
    const byLabel = label === null ? undefined : index.byLabel.get(label);
    if (byRef !== undefined && byLabel !== undefined && byRef.id !== byLabel.id) {
      warnRefLabelDisagreement(entry.ref, byRef, byLabel);
    }
    return byRef ?? byLabel;
  }

  // Rows this tick's snapshot accounted for, in either direction: reconciled
  // against an entry below, or found to be one the client is still working
  // on. What is left over is what step 4 sweeps.
  const seen = new Set<number>();

  for (const entry of collapse(snapshot).values()) {
    const download = resolve(entry);

    // Unknown is decided here, before anything branches on what the client
    // says is happening to the job. A `completed` entry with no matching row
    // must never reach the import below — unknownness is a property of the
    // match, not of the status — and the two ways an entry can fail to match
    // are not the same thing:
    if (download === undefined) {
      // Ours, and already imported: `index` omits exactly that status, and
      // the cleanup pass at the end of this tick is what owns those rows. Not
      // untracked — conflating "no active row" with "not ours" would report
      // every imported job as an orphan.
      if (knownRefs.has(entry.ref)) continue;
      // Not ours. The snapshot is unfiltered — that is what makes its
      // completeness checkable — so it holds every job on the server,
      // including other applications'. Reporting is filtered to our own
      // category here instead, and an entry with no category at all is not
      // ours by definition.
      if (entry.category !== client.category) continue;
      result.untracked.push({
        clientId: client.id,
        ref: entry.ref,
        name: entry.name,
        state: entry.outcome,
        percentage: entry.percentage,
      });
      continue;
    }

    // Two entries resolving to one row happens only when the client holds two
    // jobs carrying the same label — a double submission this code works hard
    // to prevent, but cannot rule out for jobs submitted before it existed.
    // The first entry wins and the rest are left for later ticks, because the
    // alternative is importing one download twice in one tick: the second
    // attempt would run against files the first already moved and would fail
    // a row that had in fact just succeeded.
    if (seen.has(download.id)) continue;

    // A failure that was not this code's own mistaken absence verdict stays a
    // failure. See `RECOVERABLE_FAILURE`.
    if (download.status === 'failed' && download.error !== RECOVERABLE_FAILURE) continue;

    seen.add(download.id);
    warnIfLabelMismatch(scheme, download, entry.name);

    // Re-attachment, reached two ways: a ref that is wrong (the label matched
    // and the ref did not), and a row failed as `disappeared-from-client` whose
    // job the client turns out to have had all along — which is how the 35
    // downloads of the incident recover with no repair script.
    //
    // It writes the ref and clears the stranding error, and deliberately does
    // *not* write the status: the status this row should end up in is whatever
    // the entry says below, and routing it through `downloading` first would
    // write a status no reader ever observes and count one recovery as two
    // advances. So no `advanced` here either — the branches below own both the
    // status write and the counter, and `advanced` keeps meaning "transitions",
    // not "rows touched".
    //
    // Which entry gets to correct a ref is Map-insertion-order dependent when
    // the client holds two jobs carrying the same `[pickarr-N]` label: the
    // first one `collapse` yields wins (see the `seen` guard above), and that
    // order comes from the snapshot's own history-then-queue ordering. That is
    // known and accepted rather than overlooked. Input that ambiguous has no
    // right answer — both entries claim to be the same download — and neither
    // choice loses anything: the row ends up attached to one real job, and the
    // other is reconciled on a later tick if it is still there.
    if (download.clientRef !== entry.ref || download.status === 'failed') {
      reattachClientRef(db, download.id, entry.ref, now);
    }

    if (entry.outcome === 'failed') {
      // The client's own wording, not ours: it is the only account of why
      // that exists.
      failDownload(db, download.id, entry.failMessage ?? 'download failed at client', now);
      clearAbsent(db, download.id);
      result.failed += 1;
      continue;
    }

    if (entry.outcome === 'completed') {
      if (entry.storagePath === null) {
        failDownload(db, download.id, 'client reported success with no storage path', now);
        clearAbsent(db, download.id);
        result.failed += 1;
        continue;
      }

      clearAbsent(db, download.id);
      // Both writes are conditional, for two different reasons. The path is
      // written whenever it disagrees with the client, which covers a row that
      // reached `completed` without one (a crash between the two writes below,
      // or a retry that reset the row) as well as a client that moved the job.
      // The status write is what `advanced` counts, so it is guarded on being
      // a real transition rather than restated on every tick a finished entry
      // lingers in history.
      const mapped = client.mapPath(entry.storagePath);
      if (download.storagePath !== mapped) setStoragePath(db, download.id, mapped, now);
      if (download.status !== 'completed') {
        setStatus(db, download.id, 'completed', now);
        result.advanced += 1;
      }

      // Imported here rather than left for step 4 on the next tick: a
      // download that finishes while we are watching should land in the
      // library now, not ten seconds from now. Step 4's own import branch is
      // the safety net for every other way a row can reach `completed`, not a
      // replacement for this.
      const ready = getDownload(db, download.id);
      if (ready === null) continue;
      // eslint-disable-next-line no-await-in-loop -- imports are deliberately serial
      await attemptImport(ready);
      continue;
    }

    // Queued, downloading, or in a transient post-processing state
    // (extracting, moving, repairing, verifying...). None of those is a
    // failure and none is news: the client is still working on the job. The
    // one thing that *is* news is that we saw it, which retracts any absence
    // recorded for it. The status write is guarded so `advanced` still counts
    // real transitions rather than every tick a healthy download continues to
    // exist.
    clearAbsent(db, download.id);
    if (download.status !== 'downloading') {
      setStatus(db, download.id, 'downloading', now);
      result.advanced += 1;
    }
  }

  // --- The rows the snapshot did not account for -------------------------------
  //
  // Read fresh rather than reused from `index`, so every status step 3 wrote
  // is already reflected here: a row it failed or imported is no longer
  // active and is not swept.
  let loggedIncompleteSnapshot = false;
  for (const download of activeDownloads(db, client.id)) {
    if (seen.has(download.id)) continue;

    // A `completed` row that already has a storage path is waiting on us, not
    // on the client: the transfer finished, the path is recorded, and the only
    // step left is the import. Driving that from the row's own state — rather
    // than only as a side effect of finding the job in the client's history —
    // is what makes it survive the client forgetting about the job. SABnzbd
    // prunes history on its own schedule, and once the entry is gone a
    // history-driven import never fires again. Absence is the *expected*
    // steady state for a download already off the client's books, which is
    // why this branch comes before the sweep rather than after it.
    if (download.status === 'completed' && download.storagePath !== null) {
      // eslint-disable-next-line no-await-in-loop -- imports are deliberately serial
      await attemptImport(download);
      continue;
    }

    // Nothing the client could have listed, so nothing its silence says. The
    // row was either never submitted (a `queued` row whose `addUrl` has not
    // succeeded yet) or submitted during this very tick, after the snapshot
    // was taken.
    if (download.clientRef === null || submitted.has(download.id)) continue;

    if (!snapshot.complete) {
      // The invariant the whole client-first design exists to establish: a
      // view whose completeness could not be established may advance the rows
      // it *does* contain, and may never be read as evidence that anything is
      // missing. The incident was precisely this inference — SABnzbd had
      // silently truncated history to ten entries, and 35 healthy downloads
      // were failed for being absent from a list that was never the whole
      // list. Rows keep whatever absence state they already had; nothing here
      // writes.
      if (!loggedIncompleteSnapshot) {
        loggedIncompleteSnapshot = true;
        deps.log?.(
          `reconcile ${client.id}: snapshot incomplete, skipping the absence sweep; ` +
            'rows missing from it keep the state they already had',
        );
      }
      continue;
    }

    // An observation, never a verdict. `markAbsent` records when absence
    // *began* and leaves an existing mark alone, and nothing anywhere fails a
    // download for it: the row keeps its real status, stays in the active set,
    // and is looked for again on every tick from here to forever. If the job
    // reappears — post-processing finishes, the user un-pauses it, the client
    // comes back, SABnzbd's `work_name` skip stops hiding it — step 3 finds it
    // and clears the mark with no intervention. The cost is that a job
    // genuinely deleted at the client sits as `downloading` and keeps its
    // release from being picked again; that is accepted deliberately, and paid
    // for by surfacing `absent_since` through the API so a stuck row is a
    // visible work item rather than an invisible one.
    markAbsent(db, download.id, now);
    result.absent += 1;
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
        // `created_at` is selected for `jobDirectory`, which needs the row's
        // age to decide whether a directory carrying the pre-#28 unsalted
        // marker is admissible for it.
        `SELECT id, client_ref, storage_path, created_at FROM downloads
         WHERE client_id = ? AND status = 'imported' AND client_ref IS NOT NULL`,
      )
      .all(client.id)
      .map((row) => {
        const id = Number(row['id']);
        const storagePath = row['storage_path'];
        const created = { id, createdAt: Number(row['created_at']) };
        return [
          String(row['client_ref']),
          {
            id,
            directory: jobDirectory(
              scheme,
              created,
              storagePath === null ? null : String(storagePath),
            ),
          },
        ] as const;
      }),
  );

  // A client with no `remove` does not reclaim finished jobs — see the method's
  // comment in clients/types.ts. Skipping the whole loop rather than each call
  // keeps `result.removed` honest: nothing was attempted, so nothing is counted.
  const remove = client.remove?.bind(client);
  if (remove !== undefined) {
    for (const entry of snapshot.history) {
      // Ours, and finished with. A stranger's job in a shared category is never
      // touched, and a failure is left where it is — deleting it would destroy
      // the evidence for why it failed.
      const job = importedJobs.get(entry.ref);
      if (job === undefined) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- one call per finished job, and the list is short
        await remove(entry.ref, true);
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
            `nothing at its storage path carries the ${downloadLabel(scheme.token, job.id)} label`,
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
  }

  return result;
}
