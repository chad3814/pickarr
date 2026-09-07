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
 * This module runs only step 1 (queue) and step 3 (history) of the full
 * reconcile pass, given a snapshot already fetched. Ref recovery (a
 * `submitting` row with no `client_ref` yet) is Task 8's job, the absence
 * sweep is Task 9's, and delivering a `completed` row to its plugin is
 * Task 10's -- each of those runs in the same function, around this walk,
 * once its task lands.
 */
import type { DatabaseSync } from 'node:sqlite';
import { redactUrl } from './redact.ts';
import { advanceStatus, failRow, rowByRef, setProgress, setStoragePath } from './rows.ts';
import type { DownloadRow } from './rows.ts';
import type { ClientHistoryEntry, ClientQueueEntry, ClientSnapshot } from './snapshot.ts';

/**
 * Only the fields this task actually produces. `recovered` (Task 8) and
 * `absent` (Task 9) join this type as their passes land in the same
 * function; a reviewer seeing a type that will grow again is expected here,
 * not a sign this was left unfinished. `delivered` and `reclaimed` belong to
 * Task 10's own `deliverCompleted`, a separate function with a separate
 * result -- they never join this type.
 */
export interface ReconcileResult {
  advanced: number;
  completed: number;
  failed: number;
  untracked: number;
}

/**
 * `category` is not read by this task. It exists here, rather than being
 * added when Task 8 needs it, because `ReconcileDeps` is one shape shared
 * by every pass `walkSnapshot` will eventually run, and Task 8's recovery
 * pass (matching a `submitting` row with no ref against an entry by
 * category and name) is the first consumer of it.
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
 * Walks `deps.snapshot`'s queue and history, entry by entry, and advances
 * every row it can identify against what the client just reported. See the
 * module doc for why this iterates the snapshot rather than the database's
 * own rows.
 */
export function walkSnapshot(deps: ReconcileDeps): ReconcileResult {
  const result: ReconcileResult = { advanced: 0, completed: 0, failed: 0, untracked: 0 };

  for (const entry of deps.snapshot.queue) {
    walkQueueEntry(deps, result, entry);
  }
  for (const entry of deps.snapshot.history) {
    walkHistoryEntry(deps, result, entry);
  }

  return result;
}
