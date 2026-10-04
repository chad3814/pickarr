/**
 * Reconciles what a download client says it holds against what this
 * database believes, **client first**: every entry in the snapshot is
 * looked up against the rows this client owns, never the other way around.
 *
 * That ordering is not a style preference -- it is the fix for 1.x's
 * 2026-08-15 incident. 1.x iterated its *rows* and asked, for each active
 * one, whether the client still had it. A row it had already marked
 * `failed` fell out of that active set, so once a row was wrong, nothing
 * ever asked the client about it again -- even though SABnzbd was still
 * holding the finished job the whole time. The wrong verdict was
 * permanent, because the machine that could have corrected it had stopped
 * looking.
 *
 * Iterating the snapshot's entries instead means every job the client is
 * willing to talk about gets reconciled against whatever this database
 * currently believes, **including `failed`, and including a row that does
 * not exist at all**. A wrong verdict is then recoverable on the very next
 * poll, rather than terminal.
 *
 * This module runs a ref-recovery pass (below), then the queue walk and the
 * history walk of the full reconcile pass, then an absence sweep, given a
 * snapshot already fetched. Delivering a `completed` row to its plugin is
 * not here and not in this function: `deliver.ts`'s `deliverCompleted` does
 * it, and `reconcile-job.ts`'s handler calls it after `walkSnapshot`
 * returns. Nothing in this module awaits anything, which is the practical
 * reason the two are separate -- delivery calls a plugin and a filesystem,
 * and this walk is a run of synchronous sqlite writes.
 */
import type { DatabaseSync } from 'node:sqlite';
import { redactText } from './redact.ts';
import {
  DOWNLOAD_STATUSES, UNCONFIRMED_AFTER_MS, advanceStatus, failRow, failUnconfirmed, heldRefs, rowByRef,
  rowsForClientByStatus, setAbsent, setProgress, setRef, setStoragePath,
} from './rows.ts';
import type { DownloadRow, DownloadStatus } from './rows.ts';
import type { ClientHistoryEntry, ClientQueueEntry, ClientSnapshot } from './snapshot.ts';

/**
 * What one `walkSnapshot` pass did: only the counters the walk and the
 * absence sweep in this module produce. `delivered`, `reclaimed`,
 * `unowned`, `reclaimFailures` and `undeliverable` belong to `deliver.ts`'s
 * `DeliverResult` -- a separate function, a separate pass, a separate
 * result -- and never join this type. `reconcile-job.ts`'s
 * `logTickSummary` is what puts the two side by side on one line, which is
 * the only place a tick is described as a whole.
 */
export interface ReconcileResult {
  advanced: number;
  completed: number;
  failed: number;
  untracked: number;
  recovered: number;
  absent: number;
  /**
   * Candidate refs recovery declined because a row on this client already
   * holds them -- see `refCandidates`. Reported rather than only logged for
   * the same reason `DeliverResult.reclaimFailures` is: a client whose every
   * candidate is already claimed looks identical to a client with nothing to
   * recover if all you have is `recovered: 0`.
   */
  refsAlreadyHeld: number;
  /**
   * Rows whose recovery write itself threw. The row keeps its null ref and
   * the next tick tries again; every other row's recovery in the same pass
   * still happened. See `recoverRefs`.
   */
  recoverFailures: number;
  /**
   * Entries this client holds that are filed under some other category and
   * that no row of ours claims -- somebody else's downloads, in short.
   *
   * A download client is not Pickarr's alone, and qBittorrent's
   * `/torrents/info` is fetched unfiltered (`qbittorrent.ts`'s `snapshot`),
   * so every torrent its operator ever added arrives in this walk. Each one
   * used to be counted `untracked` and logged by name, which on a real
   * install meant 200+ lines a minute about downloads Pickarr was never
   * asked to manage -- and, worse, made `untracked` mean "things in this
   * client" rather than "things in our category we cannot explain".
   *
   * Counted rather than dropped silently: `logTickSummary` prints every
   * non-zero counter, so one number per tick still says "this client holds
   * things that are not ours" -- which is the whole of what those lines
   * were worth.
   */
  foreign: number;
  /**
   * `submitting` rows failed because the client never confirmed them within
   * `UNCONFIRMED_AFTER_MS` of being written (#95). Set only by the settle
   * step `walkSnapshot` runs last, and only when the snapshot is both
   * successful and complete -- never on an unreachable client, which has no
   * list to say whether a row ever arrived at all, and never on a partial
   * one, which cannot show a row never arrived either.
   */
  unconfirmed: number;
}

/**
 * `category` names the entries in `snapshot.queue`/`snapshot.history` that
 * belong to this client, for the ref-recovery pass below: a candidate must
 * match both this and the submitting row's `rss_item.filename` before it can
 * stand in for a ref this database never recorded.
 */
export interface ReconcileDeps {
  raw: DatabaseSync;
  clientId: number;
  category: string | null;
  snapshot: ClientSnapshot;
  now: number;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * The default `last_error` for a failed torrent. qBittorrent's
 * `/torrents/info` has no failure-message field at all -- see
 * `qbittorrent.ts`'s `historyFrom` -- so `failMessage` is always `null` for
 * that client, and this default is the *only* thing a failed torrent will
 * ever carry into `last_error`. It names the client and says plainly that
 * no reason was given, rather than "unknown", which tells an operator
 * nothing about where to look.
 */
function defaultFailMessage(clientId: number): string {
  return `download client ${clientId} reported a failure with no reason given`;
}

/** Every status `advanceStatus` may move a `completed` history entry's row from. */
const ADVANCES_TO_COMPLETED: ReadonlySet<DownloadRow['status']> =
  new Set(['submitting', 'submitted', 'downloading', 'failed']);

/**
 * Whether this row already records exactly the failure the client is
 * reporting now -- same status, same reason.
 *
 * The `failed` arm's counterpart to `ADVANCES_TO_COMPLETED`, and the reason
 * the two arms of `walkHistoryEntry` now read alike. The `completed` arm has
 * always asked "is this row somewhere an advance to `completed` is a real
 * transition from?" and skipped the write when it was not. The `failed` arm
 * asked nothing: a failed history entry issued one `UPDATE` per tick against
 * a row it had already failed, forever, at every `RECONCILE_INTERVAL_S`
 * (10s) per client. That cost three things. `updated_at` was rewritten on every tick, so the column
 * stopped answering "when did this row last change" for exactly the rows an
 * operator is most likely to be looking at. `result.failed` reported a fresh
 * failure every tick, so the count meant "failed rows the client still
 * mentions" rather than "rows this tick failed" -- and with the summary line
 * now logging it, that would have been a line printed forever about nothing
 * happening. And the asymmetry itself was undocumented, which is what makes
 * a reader assume it was reasoned about.
 *
 * **Not terminality.** A row already `failed` whose job the client later
 * reports `completed` still advances -- `ADVANCES_TO_COMPLETED` includes
 * `'failed'` deliberately, and that a wrong verdict stays recoverable is
 * this module's whole headline property (see the module doc's account of
 * 1.x's 2026-08-15 incident). This guard is narrower than that: it declines
 * to rewrite a verdict with the one it already holds. A `failed` entry whose
 * *reason* has changed is a new fact and is written, so a client that
 * refines its own message still reaches `last_error`.
 */
function alreadyFailedForThisReason(row: DownloadRow, message: string): boolean {
  return row.status === 'failed' && row.lastError === message;
}

/**
 * Whether an entry no row of ours claims belongs to somebody else.
 *
 * Deliberately consulted **only** when `rowByRef` found nothing. Filtering
 * the snapshot up front by category is the obvious fix and is wrong: an
 * operator who drags a torrent into another category in qBittorrent would
 * strand its row at `submitted` for ever while the client finished the
 * download. A row we already own is ours whatever category it sits in; it
 * is only the *unclaimed* entries that category can speak for.
 *
 * Both sides are already normalised -- `deps.category` through
 * `reconcile-job.ts`'s `normalizeClientCategory`, and each entry's through
 * its adapter -- so `''` and `'None'` have both become `null` by here and
 * a client configured with no category matches entries filed under none.
 *
 * This says nothing about adoption: `recoverRefs` already requires
 * `entry.category === deps.category`, so an entry this refuses could never
 * have been adopted anyway.
 */
function isSomeoneElses(deps: ReconcileDeps, entryCategory: string | null): boolean {
  return entryCategory !== deps.category;
}

/**
 * Handles one queue entry: an advance to `downloading` from `submitted` or
 * `submitting`, then a progress observation applied regardless -- unless the
 * row is `delivered`, which every arm of this walk leaves untouched because
 * it is already past this machine.
 */
function walkQueueEntry(
  deps: ReconcileDeps,
  result: ReconcileResult,
  entry: ClientQueueEntry,
): void {
  const row = rowByRef(deps.raw, deps.clientId, entry.ref);
  if (row === undefined) {
    if (isSomeoneElses(deps, entry.category)) {
      result.foreign += 1;
      return;
    }
    result.untracked += 1;
    deps.log('client queue entry has no matching download row', { clientId: deps.clientId, ref: entry.ref });
    return;
  }
  if (row.status === 'delivered') return;

  if (row.status === 'submitted' || row.status === 'submitting') {
    if (advanceStatus(deps.raw, row, row.status, 'downloading', deps.now)) {
      result.advanced += 1;
    }
  }
  setProgress(deps.raw, row, entry.percentage, deps.now);
}

/**
 * Handles one history entry. `completed` stores the client's path (when it
 * reported one) and advances the row to `completed` from any non-terminal
 * state **and from `failed`** -- the one arm that reaches a row 1.x's
 * row-first ordering could never have asked about again. `failed` fails the
 * row with the client's message, redacted, or a stated default when the
 * client gave none -- unless the row already carries that same failure, in
 * which case there is nothing to record and it is left alone
 * (`alreadyFailedForThisReason`). `in-progress` is a transient post-processing state, not
 * a verdict either way, so it does nothing at all: 1.x once read every such
 * status as terminal and failed an ordinary multi-part download while
 * SABnzbd was still unpacking it.
 */
function walkHistoryEntry(
  deps: ReconcileDeps,
  result: ReconcileResult,
  entry: ClientHistoryEntry,
): void {
  const row = rowByRef(deps.raw, deps.clientId, entry.ref);
  if (row === undefined) {
    if (isSomeoneElses(deps, entry.category)) {
      result.foreign += 1;
      return;
    }
    result.untracked += 1;
    deps.log('client history entry has no matching download row', { clientId: deps.clientId, ref: entry.ref });
    return;
  }
  if (row.status === 'delivered') return;

  switch (entry.outcome) {
    case 'completed': {
      if (entry.storagePath !== null) {
        setStoragePath(deps.raw, row, entry.storagePath, deps.now);
      }
      if (ADVANCES_TO_COMPLETED.has(row.status)) {
        if (advanceStatus(deps.raw, row, row.status, 'completed', deps.now)) {
          result.completed += 1;
        }
      }
      return;
    }
    case 'failed': {
      const message = redactText(entry.failMessage ?? defaultFailMessage(deps.clientId));
      // Guarded the same way the `completed` arm above is -- see
      // `alreadyFailedForThisReason` for what the unguarded version cost and
      // why this is not the same thing as making `failed` terminal.
      if (alreadyFailedForThisReason(row, message)) return;
      if (failRow(deps.raw, row, message, deps.now)) {
        result.failed += 1;
      }
      return;
    }
    case 'in-progress':
      return;
  }
}

/**
 * The `rss_item.filename` a `submitting` row with no ref was submitted
 * under -- selecting only `filename`, never a column off `download_client`,
 * and never anything this module does not compare against a candidate's
 * `name`. Since migration 14 `download_client` holds no credential at all,
 * only the `secret` names `readClientConfig` resolves, and this module
 * selects neither.
 */
function filenameForItem(raw: DatabaseSync, rssItemId: number): string {
  const row = raw.prepare('SELECT filename FROM rss_item WHERE id = ?').get(rssItemId);
  if (!row) {
    throw new Error(`rss_item ${rssItemId} not found`);
  }
  return String((row as { filename: unknown }).filename);
}

/**
 * Every ref in `deps.snapshot` -- queue and history alike -- whose category
 * matches this client's and whose name matches `filename`, minus every ref
 * `held` says a row on this client already has. Both collections are
 * searched because a job can already be finished (in history) by the time
 * its ref is recovered.
 *
 * The `held` exclusion is not an optimisation. A `(category, name)` match
 * says nothing about who owns the job: a row already `downloading` under
 * `nzo-1` and a second `submitting` row for the same `rss_item.filename`
 * produce exactly one candidate each, and attaching `nzo-1` to the second
 * row is a `client_ref` unique-index violation -- a throw that escapes
 * `walkSnapshot` and abandons the rest of the tick, five ticks running,
 * until the dispatcher dead-letters the job and the client has no reconcile
 * at all. `recoverRefs`'s claim pass makes recovery a bijection *among
 * candidates*; this makes it a bijection against the rows that are not
 * candidates too, which is the other half of the same property.
 *
 * `alreadyHeld` is returned rather than silently dropped so the caller can
 * count it: a row whose only candidate belongs to someone else is left
 * `submitting` with a null ref forever, and "recovered nothing" is not a
 * useful description of that.
 */
function refCandidates(
  deps: ReconcileDeps,
  filename: string,
  held: ReadonlySet<string>,
): { refs: string[]; alreadyHeld: number } {
  const queueRefs = deps.snapshot.queue
    .filter((entry) => entry.category === deps.category && entry.name === filename)
    .map((entry) => entry.ref);
  const historyRefs = deps.snapshot.history
    .filter((entry) => entry.category === deps.category && entry.name === filename)
    .map((entry) => entry.ref);
  const matches = [...queueRefs, ...historyRefs];
  const refs = matches.filter((ref) => !held.has(ref));
  return { refs, alreadyHeld: matches.length - refs.length };
}

/**
 * The only status a null `client_ref` can be recovered for: a row still
 * `submitting` has an unresolved add or a submission whose response was
 * lost. Narrowed in SQL rather than after the read, so the query is served
 * by `..._status` and costs one row per unconfirmed submission instead of
 * one per download this client has ever had. See
 * `rows.ts`'s `rowsForClientByStatus` for the measurement.
 */
const RECOVERABLE_STATUSES: readonly DownloadStatus[] = ['submitting'];

/**
 * Recovers the `client_ref` 1.x used to restore with its per-installation
 * label marker -- dropped deliberately from 2.0 (see the module doc's linked
 * spec) -- with the replacement slice C's own §10 named: category and name.
 *
 * Never resubmits. A `submitting` row with no ref either has an unresolved
 * `.torrent` add or a submission whose response was lost; either way,
 * re-sending it risks a second copy running untracked forever, so this only
 * ever attaches a ref an already-fetched snapshot can prove is the same job.
 *
 * Runs only when `deps.snapshot.complete`: a missing candidate in an
 * incomplete snapshot would be indistinguishable from one on a page that
 * never loaded, so "exactly one match" can never be established against a
 * partial picture -- the same reasoning `ClientSnapshot.complete`'s doc
 * comment states for absence. Since #107 an adapter may stop paging early
 * and still answer `complete`, so this pass depends on `reconcile-job.ts`
 * setting `SnapshotAsk.everything` whenever a candidate row exists: a
 * `submitting` row with no ref is in `SWEPT_STATUSES`, which is exactly the
 * set the ask is built from, and a null ref there is what sets the flag.
 *
 * Two or more candidates recover nothing and are only logged: an ambiguous
 * match resolved arbitrarily could attach the wrong job's ref to this row,
 * which is worse than leaving it for a human to look at.
 *
 * Ambiguity runs three ways, so this resolves in three steps.
 *
 * 1. **A candidate a non-candidate row already holds is not a candidate at
 *    all.** `refCandidates` excludes every ref `heldRefs` reports, because a
 *    `(category, name)` match says nothing about ownership: a row already
 *    `downloading` under one ref and a `submitting` row for the same
 *    `rss_item.filename` each see that one job. See `refCandidates`.
 * 2. **"Exactly one candidate for this row" is not enough on its own.** Two
 *    rows whose `rss_item.filename` is the same -- the same `rss_item`
 *    requested twice, the same release picked twice, or two feeds carrying it
 *    -- each see the same single client job, and each would claim it.
 *    Attaching one job to two rows is wrong on its face. So a ref claimed by
 *    more than one row is dropped and logged, the same way a row with more
 *    than one candidate is, and the count is taken before anything is written
 *    so the decision does not depend on which row happened to be read first.
 * 3. **The write itself is caught per row.** Steps 1 and 2 close both routes
 *    this codebase knows about into `client_ref`'s partial unique index, and
 *    a violation there does not fail quietly: it throws
 *    SQLITE_CONSTRAINT_UNIQUE out of `setRef`, and that throw would escape
 *    `walkSnapshot` and abandon the rest of the tick -- the queue walk, the
 *    history walk, everything after. Five consecutive ticks of that
 *    dead-letters the reconcile job and the client stops being reconciled at
 *    all until a restart. Whatever route a future change opens, it must cost
 *    that row's recovery and nothing else's, which is the same reasoning
 *    `deliver.ts`'s `deliverOne` and `reclaimRows` already apply to a plugin
 *    and to a client that throw.
 */
function recoverRefs(deps: ReconcileDeps, result: ReconcileResult): void {
  if (!deps.snapshot.complete) return;

  const candidateRows = rowsForClientByStatus(deps.raw, deps.clientId, RECOVERABLE_STATUSES)
    .filter((row) => row.clientRef === null);
  // Nothing to recover means nothing to look up: the held-ref read is
  // skipped entirely rather than run for every tick of a client with no
  // unconfirmed submissions, which is almost every tick.
  if (candidateRows.length === 0) return;

  const held = heldRefs(deps.raw, deps.clientId);

  // First pass: which row wants which ref, for the rows whose match is
  // unambiguous from their own side.
  const claims: Array<{ row: DownloadRow; ref: string }> = [];
  for (const row of candidateRows) {
    const filename = filenameForItem(deps.raw, row.rssItemId);
    const { refs, alreadyHeld } = refCandidates(deps, filename, held);

    if (alreadyHeld > 0) {
      result.refsAlreadyHeld += alreadyHeld;
      deps.log('ref recovery candidate is already held by another download', {
        rowId: row.id, candidates: alreadyHeld, name: filename,
      });
    }

    if (refs.length > 1) {
      deps.log('ambiguous ref recovery candidates', {
        rowId: row.id, candidates: refs.length, name: filename,
      });
      continue;
    }

    const [only] = refs;
    if (only === undefined) continue;
    claims.push({ row, ref: only });
  }

  // Second pass: drop any ref two rows both claim. Counted before anything
  // is written, so the decision does not depend on which row happened to be
  // read first.
  const claimCounts = new Map<string, number>();
  for (const claim of claims) {
    claimCounts.set(claim.ref, (claimCounts.get(claim.ref) ?? 0) + 1);
  }

  for (const claim of claims) {
    const claimants = claimCounts.get(claim.ref) ?? 0;
    if (claimants > 1) {
      deps.log('ref claimed by more than one download', {
        rowId: claim.row.id, ref: claim.ref, claimants,
      });
      continue;
    }
    // Caught per row -- see step 3 of this function's doc comment. Only the
    // reason is logged, never the row or the snapshot entry.
    try {
      if (setRef(deps.raw, claim.row, claim.ref, deps.now)) {
        result.recovered += 1;
      }
    } catch (error) {
      result.recoverFailures += 1;
      deps.log('ref recovery write failed, leaving the download unconfirmed for the next tick', {
        rowId: claim.row.id,
        reason: error instanceof Error ? redactText(error.message) : String(error),
      });
    }
  }
}

/**
 * The two statuses the absence sweep skips. Terminal *for the sweep's
 * purposes* only -- an absence observation about either says nothing anyone
 * acts on, so stamping one would cost a write and buy no decision.
 *
 * Neither is where a row's life ends, and `failed` emphatically is not:
 * `ADVANCES_TO_COMPLETED` includes it on purpose, so a row this database
 * failed is advanced the moment the client reports the job completed. That
 * a wrong verdict stays recoverable is this module's headline property (see
 * the module doc's account of 1.x's 2026-08-15 incident), and this set does
 * not weaken it -- a `failed` row is reached through the snapshot's own
 * entries, which is precisely the path that does not depend on any sweep.
 */
const TERMINAL_STATUSES: ReadonlySet<DownloadRow['status']> = new Set(['delivered', 'failed']);

/**
 * The statuses the sweep below actually reads, for the query that narrows
 * it. Derived from `DOWNLOAD_STATUSES` and `TERMINAL_STATUSES` rather than
 * written out, so the two can never disagree: a seventh status added to
 * `rows.ts` is swept unless it is also named terminal, which is the safe
 * direction -- the alternative silently stops sweeping it.
 */
export const SWEPT_STATUSES: readonly DownloadStatus[] =
  DOWNLOAD_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status));

/**
 * Every ref `snapshot` accounts for, queue and history alike -- the set a
 * row's own `client_ref` is checked against to decide whether the client
 * still claims to hold it. Built from both collections because a job can
 * move from queue to history between one poll and the next; either one
 * mentioning a ref is enough to call a row holding it accounted for.
 */
function accountedForRefs(snapshot: ClientSnapshot): Set<string> {
  const refs = new Set<string>();
  for (const entry of snapshot.queue) refs.add(entry.ref);
  for (const entry of snapshot.history) refs.add(entry.ref);
  return refs;
}

/**
 * Records, for every non-terminal row this client owns, whether the
 * client's own account still includes it -- **never** what that means.
 *
 * Absence is an observation, never a verdict. 1.x arrived at that the hard
 * way: it once wrote a `disappeared-from-client` failure the moment a row
 * dropped out of a snapshot, and then had to build a whole recovery path
 * (`RECOVERABLE_FAILURE` in `packages/core/src/pipeline/reconcile.ts`) for
 * the rows its own verdict had stranded -- that module's comment now reads
 * "absence is an observation now, never a verdict". Starting from the
 * observation instead costs one nullable column, `absent_since`, and this
 * function never fails a row for holding one: it only stamps a row the
 * first time it is missed and clears the stamp the moment the row is seen
 * again, so a later slice can decide with a history rather than a single
 * reading.
 *
 * Runs only when `snapshot.complete`, for the same reason `recoverRefs`
 * does and `ClientSnapshot.complete`'s own doc comment states: a row
 * missing from a partial picture is indistinguishable from one on a page
 * that failed to load, so nothing here may read that absence as
 * meaningful. An incomplete snapshot neither stamps nor clears anything,
 * and `result.absent` stays zero. The rows swept here are the rows whose
 * refs `reconcile-job.ts` put in the `SnapshotAsk` -- the same
 * `SWEPT_STATUSES` query -- so an adapter that stopped paging early (#107)
 * stopped only after seeing every ref this pass could call absent.
 *
 * A row already stamped keeps its original stamp: the stamp records when
 * the row was *first* missed, and overwriting it on a later tick would
 * erase the only thing that makes a duration computable later. A row the
 * snapshot does account for has its stamp cleared, if it had one.
 *
 * `result.absent` counts every eligible row that ends this pass stamped,
 * not only the ones newly stamped by it, so it answers "how much does this
 * client not have" rather than "how much changed this tick".
 *
 * Rows are re-read from the database rather than reused from an earlier
 * pass, so a row the walk above just advanced -- to `downloading`, to
 * `completed`, to `failed` -- is swept against the status it holds *now*,
 * not the one it held when this tick started.
 */
function sweepAbsent(deps: ReconcileDeps, result: ReconcileResult): void {
  if (!deps.snapshot.complete) return;

  const refs = accountedForRefs(deps.snapshot);

  for (const row of rowsForClientByStatus(deps.raw, deps.clientId, SWEPT_STATUSES)) {
    // Restated after the query, not instead of it: the SQL is what makes the
    // read proportional to live rows, and this is the same "state both"
    // discipline `deliver.ts`'s own filter comment describes -- a future
    // change to either list is caught here rather than silently sweeping a
    // terminal row.
    if (TERMINAL_STATUSES.has(row.status)) continue;
    if (row.clientRef === null) continue;

    if (refs.has(row.clientRef)) {
      if (row.absentSince !== null) {
        setAbsent(deps.raw, row, null, deps.now);
      }
      continue;
    }

    if (row.absentSince === null) {
      setAbsent(deps.raw, row, deps.now, deps.now);
    }
    result.absent += 1;
  }
}

/**
 * Walks `deps.snapshot`'s queue and history, entry by entry, and advances
 * every row it can identify against what the client just reported. See the
 * module doc for why this iterates the snapshot rather than the database's
 * own rows.
 *
 * Ref recovery runs first, so a row it recovers a ref for is picked up by
 * this same walk on this same tick, rather than waiting a poll longer. The
 * absence sweep runs last, after every write the walk itself makes, so it
 * sees each row's final status for this tick rather than the one it read
 * it at. The unconfirmed-settle step runs last of all, after the sweep, so
 * a row recovery or the walk could still identify this tick is never failed
 * out from under it (#95) -- and, like the sweep immediately above it, only
 * when the snapshot is complete, since a partial list cannot show a row
 * never arrived.
 */
export function walkSnapshot(deps: ReconcileDeps): ReconcileResult {
  const result: ReconcileResult = {
    advanced: 0, completed: 0, failed: 0, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0, foreign: 0, unconfirmed: 0,
  };

  recoverRefs(deps, result);

  for (const entry of deps.snapshot.queue) {
    walkQueueEntry(deps, result, entry);
  }
  for (const entry of deps.snapshot.history) {
    walkHistoryEntry(deps, result, entry);
  }

  sweepAbsent(deps, result);

  // Last, after recovery has attached every ref the client's own list can
  // supply and the walk has advanced every row it can identify. A row still
  // `submitting` this long after its pick was never going to be confirmed,
  // and until it is settled migration 18's unique index refuses a re-pick
  // (#95).
  //
  // Guarded on `deps.snapshot.complete`, the same reason `recoverRefs` and
  // `sweepAbsent` both guard on it: a partial list cannot show a row never
  // arrived. qBittorrent and SABnzbd can both resolve a snapshot with
  // `complete: false` without throwing -- a failed page, an unparseable
  // total, hitting the page cap, a response body that is not an array --
  // and `runTick` treats that as a reachable client, reaching this function
  // regardless. Failing an old `submitting` row off a page the client
  // simply did not return this tick would free its unique-index slot for a
  // duplicate re-pick while the original download is still running.
  if (deps.snapshot.complete) {
    result.unconfirmed = failUnconfirmed(deps.raw, deps.clientId, deps.now - UNCONFIRMED_AFTER_MS, deps.now);
  }

  return result;
}
