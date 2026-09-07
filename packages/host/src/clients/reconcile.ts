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
 * This module runs a ref-recovery pass (below), then step 1 (queue) and
 * step 3 (history) of the full reconcile pass, given a snapshot already
 * fetched. The absence sweep is Task 9's, and delivering a `completed` row
 * to its plugin is Task 10's -- each of those runs in the same function,
 * around this walk, once its task lands.
 */
import type { DatabaseSync } from 'node:sqlite';
import { redactUrl } from './redact.ts';
import { advanceStatus, failRow, rowByRef, rowsForClient, setProgress, setRef, setStoragePath } from './rows.ts';
import type { DownloadRow } from './rows.ts';
import type { ClientHistoryEntry, ClientQueueEntry, ClientSnapshot } from './snapshot.ts';

/**
 * Only the fields this task actually produces. `absent` (Task 9) joins this
 * type as its pass lands in the same function; a reviewer seeing a type that
 * will grow again is expected here, not a sign this was left unfinished.
 * `delivered` and `reclaimed` belong to Task 10's own `deliverCompleted`, a
 * separate function with a separate result -- they never join this type.
 */
export interface ReconcileResult {
  advanced: number;
  completed: number;
  failed: number;
  untracked: number;
  recovered: number;
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
 * client gave none. `in-progress` is a transient post-processing state, not
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
      const message = redactUrl(entry.failMessage ?? defaultFailMessage(deps.clientId));
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
 * under -- selecting only `filename`, never the credential columns that
 * live on `download_client`, and never anything this module does not
 * compare against a candidate's `name`.
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
 * matches this client's and whose name matches `filename`. Both collections
 * are searched because a job can already be finished (in history) by the
 * time its ref is recovered.
 */
function refCandidates(deps: ReconcileDeps, filename: string): string[] {
  const queueRefs = deps.snapshot.queue
    .filter((entry) => entry.category === deps.category && entry.name === filename)
    .map((entry) => entry.ref);
  const historyRefs = deps.snapshot.history
    .filter((entry) => entry.category === deps.category && entry.name === filename)
    .map((entry) => entry.ref);
  return [...queueRefs, ...historyRefs];
}

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
 * comment states for absence.
 *
 * Two or more candidates recover nothing and are only logged: an ambiguous
 * match resolved arbitrarily could attach the wrong job's ref to this row,
 * which is worse than leaving it for a human to look at.
 */
function recoverRefs(deps: ReconcileDeps, result: ReconcileResult): void {
  if (!deps.snapshot.complete) return;

  const candidateRows = rowsForClient(deps.raw, deps.clientId)
    .filter((row) => row.status === 'submitting' && row.clientRef === null);

  for (const row of candidateRows) {
    const filename = filenameForItem(deps.raw, row.rssItemId);
    const matches = refCandidates(deps, filename);

    if (matches.length > 1) {
      deps.log('ambiguous ref recovery candidates', {
        rowId: row.id, candidates: matches.length, name: filename,
      });
      continue;
    }

    const [only] = matches;
    if (only === undefined) continue;

    if (setRef(deps.raw, row, only, deps.now)) {
      result.recovered += 1;
    }
  }
}

/**
 * Walks `deps.snapshot`'s queue and history, entry by entry, and advances
 * every row it can identify against what the client just reported. See the
 * module doc for why this iterates the snapshot rather than the database's
 * own rows.
 *
 * Ref recovery runs first, so a row it recovers a ref for is picked up by
 * this same walk on this same tick, rather than waiting a poll longer.
 */
export function walkSnapshot(deps: ReconcileDeps): ReconcileResult {
  const result: ReconcileResult = { advanced: 0, completed: 0, failed: 0, untracked: 0, recovered: 0 };

  recoverRefs(deps, result);

  for (const entry of deps.snapshot.queue) {
    walkQueueEntry(deps, result, entry);
  }
  for (const entry of deps.snapshot.history) {
    walkHistoryEntry(deps, result, entry);
  }

  return result;
}
