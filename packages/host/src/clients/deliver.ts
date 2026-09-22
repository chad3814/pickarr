/**
 * Tells a plugin its download landed, and only then lets the download
 * client forget it.
 *
 * `onDownloadedFile` is a required `MediaPlugin` entry point (see
 * `packages/contract/src/plugin.ts`) that nothing in 2.0 has called until
 * now: it is the host's half of "the host notifies, the plugin imports" --
 * this codebase's replacement for 1.x's `pipeline/import.ts`, which pulled a
 * finished file into place itself. Here the host does none of that; it maps
 * the client's own path, `stat`s it, and hands both to the plugin that owns
 * it -- `path` may be a file or a directory (`DownloadedFile`'s own doc
 * comment), and it is the plugin, through `LibraryImporter.list` and
 * `.place`, that looks inside it. What the plugin does with them is the
 * plugin's business.
 *
 * **Ordering, and why each step is where it is.** For every `completed` row
 * with a `storage_path` and no `delivered_at` (one without a path is
 * counted and logged instead -- see below):
 *
 * 1. `mapClientPath` the stored path -- the stored value is the *client's
 *    own* path, and the mapping is applied on demand, never stored, because
 *    a stored mapped path goes stale the moment a `filepath_mapping` row
 *    changes (see `paths.ts`'s own doc comment).
 * 2. `stat` it for `sizeBytes`, through `deps.stat` so no test here ever
 *    touches a real filesystem.
 * 3. find the owning plugin id, via `ownerPluginId` -- exported from
 *    `host.ts` and reused here rather than duplicated, per that function's
 *    own doc comment.
 * 4. `deliver(pluginId, file)`.
 * 5. only once that call returns, `markDelivered` -- which is the row's
 *    whole `completed` -> `delivered` transition; there is no separate
 *    "advance" call, because `rows.ts`'s `markDelivered` already performs it
 *    in the same guarded write.
 *
 * **A throw at any of 1-4 leaves the row `completed`, and logs.** The next
 * tick tries again -- forever, deliberately: a plugin that cannot accept a
 * file is a bug to fix, not a row to abandon, and nothing here dead-letters
 * a completed download the way a job's own retry budget eventually would.
 *
 * **A missing file is a delivery failure, not a completion failure, for the
 * same reason.** `stat` throwing does not call `failRow` -- imported by
 * `rows.ts`'s own callers elsewhere in this module family, but never by this
 * one -- because a `filepath_mapping` row corrected later takes effect on
 * the very next tick with nothing needing to be un-failed. Failing the row
 * here would trade a self-healing condition for a permanent one.
 *
 * **A `completed` row the client gave no path for counts `undeliverable`
 * and is retried.** `ClientHistoryEntry`'s own doc comment permits a
 * `completed` entry that omits `storagePath`, and both adapters emit `null`
 * for a field that is missing or empty, so this is a state the client
 * actually produces rather than a defensive branch. There is nothing to map
 * and nothing to `stat`, so nothing is delivered -- but the row is not
 * failed either, for the same reason a missing file is not: a path the
 * client reports on a later poll, or a corrected mapping, still works.
 * Counting and logging it is the whole of the fix. Before, the row was
 * filtered out of this pass silently: it sat `completed` with `delivered_at`
 * null across every tick, producing no counter and no log line, while §9 of
 * this slice's design names three "sits `completed` and is retried every
 * tick" cases and counts or logs every other one.
 *
 * **A row whose plugin is not registered counts `unowned` and is retried,**
 * the same shape `notifyNewRssItems` (`host.ts`) already reports for an rss
 * item whose feed names no registered plugin. `ownerPluginId` itself can
 * only say "no plugin id" when the referencing `rss_item`/`rss_feed` chain
 * is missing entirely, which the schema's foreign keys leave unreachable
 * for any row this function actually iterates -- so the case this module
 * (and `host.test.ts`'s own `notifyNewRssItems` tests) means by "not
 * registered" is a plugin id the feed genuinely names but this *host* has
 * never registered. `host.ts`'s `deliverToPlugin` is what tells the two
 * apart: it throws `PluginNotRegisteredError` for the latter, and
 * `deliverOne` below recognizes that specific type rather than treating
 * every rejection alike.
 *
 * **Reclaim runs second, and only for `delivered` rows `reclaimed_at` has
 * not already marked.** If `deps.remove` is present, it is called for each
 * such row, and only once `remove` returns does `markReclaimed` (`rows.ts`)
 * stamp it -- `remove` first, then the mark. A `remove` that throws leaves
 * the row unmarked, so the next tick retries it: the same at-least-once
 * shape `deliverOne`'s own steps 1-4 already have, and for the same reason
 * -- a client that could not confirm forgetting a job is a bug to keep
 * nudging, not a row to give up on. `reclaimed_at` is what turns "once per
 * pass" into "once per download": without the filter and the stamp, this
 * step would re-select every `delivered` row on every pass and call
 * `remove` for each all over again, forever -- see `db/migrate.ts`'s
 * migration 8 comment for the growth that produces. `remove` is *absent*
 * for qBittorrent: qBittorrent's `/torrents/delete` stops a torrent's seed
 * and abandons its ratio whether or not `deleteFiles` is set, and there is
 * no "forget this job but keep seeding" call to make instead.
 *
 * Optionality here is what makes *this* function's "if `deps.remove` is
 * present" the whole of the decision, rather than a flag some config could
 * set wrong. It is not, on its own, what makes reclaiming a torrent
 * impossible to write: an optional member is still a member, and the
 * composition that decides which client gets a `remove` lives one layer up.
 * `reconcile-job.ts`'s `ReconcileAdapter` is where that is enforced -- a
 * union discriminated on the client's transport, whose torrent arm has no
 * `remove` field for anyone to fill in. See its own doc comment.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile } from '@pickarr/contract';
import { mediaItemIdForRssItem, ownerPluginId } from '../db/owner.ts';
import { PluginNotRegisteredError } from '../errors.ts';
import { mapClientPath } from './paths.ts';
import { redactText } from './redact.ts';
import {
  markDelivered, markReclaimed, rowsForClientByStatus, unreclaimedRowsForClient,
} from './rows.ts';
import type { DownloadRow, DownloadStatus } from './rows.ts';

/** The one status a row must hold to be delivered, for the query that narrows the read. */
const DELIVERABLE_STATUSES: readonly DownloadStatus[] = ['completed'];

export interface DeliverDeps {
  raw: DatabaseSync;
  clientId: number;
  now: number;
  /** Measures a mapped path's size. Never a real filesystem call in a test -- always this seam. */
  stat: (path: string) => Promise<{ sizeBytes: number }>;
  /** Hands a delivered file to the plugin owning it. `host.ts`'s `deliverToPlugin` is the real implementation. */
  deliver: (pluginId: string, file: DownloadedFile) => Promise<void>;
  /**
   * Removes a job from the client's own queue/history, by `client_ref`.
   * Absent for a client -- qBittorrent -- that has no way to do this
   * without also stopping the seed; see the module doc.
   */
  remove?: (ref: string) => Promise<void>;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/** What one `deliverCompleted` pass did. */
export interface DeliverResult {
  /** Rows newly advanced `completed` -> `delivered` this pass. */
  delivered: number;
  /**
   * Delivered rows newly marked reclaimed this pass -- `deps.remove`
   * succeeded for the row *and* `markReclaimed`'s guard applied. A row
   * `remove` was called for but that a concurrent write already marked
   * reclaimed does not count here: that is not this pass's reclaim.
   */
  reclaimed: number;
  /** Completed rows whose plugin is not registered, retried next pass rather than counted as a generic failure. */
  unowned: number;
  /**
   * Delivered rows whose `remove` threw this pass. They stay unmarked, so a
   * later tick retries them -- but the number is reported rather than only
   * logged, because a client refusing every delete looks identical to a
   * client with nothing left to reclaim if all you have is `reclaimed: 0`.
   */
  reclaimFailures: number;
  /**
   * Completed rows the client reported no `storage_path` for, so there was
   * nothing to map, stat or hand to a plugin. They stay `completed` and are
   * offered again next pass; the number exists because the alternative was
   * silence -- see the module doc's own paragraph on this. Counted every
   * pass, not once: this answers "how many completed downloads can this
   * client not tell me where to find", which is a standing condition rather
   * than an event.
   */
  undeliverable: number;
}

/**
 * Counts and logs every row in `rows` the client gave no `storage_path`
 * for. At module scope, closing over nothing from the pass that calls it.
 *
 * Only the row id is logged, never the row: a `DownloadRow` carries a
 * client-supplied path and a client ref, and this package's rule is that a
 * message names the discriminant and nothing else.
 */
function reportUndeliverable(deps: DeliverDeps, result: DeliverResult, rows: readonly DownloadRow[]): void {
  for (const row of rows) {
    if (row.storagePath !== null) continue;
    result.undeliverable += 1;
    deps.log('download client reported this download completed with no storage path, nothing to deliver', {
      rowId: row.id,
    });
  }
}

/**
 * Delivers `rows` one at a time -- a row's `stat`, owner lookup, plugin call
 * and `markDelivered` all settle before the next row starts.
 *
 * Recursive rather than a `for` loop with an `await` in its body, the same
 * shape `sabnzbd.ts`'s `fetchHistoryPages` uses: nothing in `MediaPlugin`'s
 * contract promises `onDownloadedFile` tolerates concurrent calls for the
 * same plugin, so this keeps one in flight at a time rather than asking a
 * lint rule to reconsider a loop that was never a candidate for
 * parallelising in the first place.
 */
async function deliverRows(deps: DeliverDeps, result: DeliverResult, rows: readonly DownloadRow[]): Promise<void> {
  const [row, ...rest] = rows;
  if (row === undefined) return;
  await deliverOne(deps, result, row);
  await deliverRows(deps, result, rest);
}

/** Delivers one `completed` row, per the module doc's numbered steps. */
async function deliverOne(deps: DeliverDeps, result: DeliverResult, row: DownloadRow): Promise<void> {
  const storagePath = row.storagePath;
  // `deliverCompleted` counts and logs a null-path row through
  // `reportUndeliverable` and never passes it here, so nothing reaches this
  // in practice -- but "in practice" is a claim about a caller, and the type
  // is `string | null` whatever that caller has already checked. This
  // comment used to call the branch unreachable *given the filter*, which
  // was true only because the filter discarded those rows in silence: that
  // silence was the defect, not the reason this branch was safe.
  if (storagePath === null) return;

  try {
    const mappedPath = mapClientPath(deps.raw, deps.clientId, storagePath);
    const { sizeBytes } = await deps.stat(mappedPath);

    const pluginId = ownerPluginId(deps.raw, row.rssItemId);
    if (pluginId === undefined) {
      // See the module doc: unreachable while the schema's foreign keys
      // hold, but `ownerPluginId`'s return type still requires handling
      // it, and the right classification if it ever happened is the same
      // one `PluginNotRegisteredError` gets below -- nobody to deliver to.
      result.unowned += 1;
      deps.log('completed row names no owning feed, leaving it for the next tick', { rowId: row.id });
      return;
    }

    // `row.rssItemId`, never `row.id`. Both are integers off the same row,
    // so the wrong one compiles and names a real rss item belonging to some
    // other download -- which is why `deliver.test.ts` seeds the two with
    // different values rather than letting both sequences start at 1.
    //
    // `mediaItemIdForRssItem` is a second read of `rss_item`, on the row
    // `ownerPluginId` has just joined from. Not folded into that query: its
    // other two callers want the owner and not the media item, and a
    // delivery pass runs once per completed download rather than per row of
    // history.
    const file: DownloadedFile = {
      path: mappedPath,
      sizeBytes,
      downloadClientId: row.downloadClientId,
      rssItemId: row.rssItemId,
      mediaItemId: mediaItemIdForRssItem(deps.raw, row.rssItemId),
    };
    await deps.deliver(pluginId, file);

    if (markDelivered(deps.raw, row, deps.now)) {
      result.delivered += 1;
    }
  } catch (error) {
    if (error instanceof PluginNotRegisteredError) {
      result.unowned += 1;
      deps.log('completed row belongs to a plugin that is not registered, leaving it for the next tick', { rowId: row.id });
      return;
    }
    // Every other throw from steps 1-4, including `stat` finding nothing
    // there: logged, and the row stays `completed` for the next tick. See
    // the module doc for why this never calls `failRow`.
    //
    // `redactText`, matching `reclaimRows` below. Defence in depth rather
    // than a live leak: nothing that reaches this catch holds a credential
    // today -- steps 1-4 are two sqlite reads, `deps.stat`, and the
    // plugin's own `onDownloadedFile` -- so there is no url with an api key
    // in it for a message here to carry. The point is that the two catches
    // in one file no longer differ in a way a reader has to check, and a
    // later step that does build a url (a plugin handed the client's base
    // url, say) cannot leak through the one that was left raw.
    deps.log('failed to deliver a completed download, leaving it completed for the next tick', {
      rowId: row.id,
      error: error instanceof Error ? redactText(error.message) : String(error),
    });
  }
}

/**
 * Reclaims `rows` one at a time -- the same recursive shape as
 * `deliverRows`, for the same reason: a `for` loop awaiting `remove` in its
 * body is not a candidate for parallelising either.
 *
 * `remove` runs first, and `markReclaimed` only once it returns: see the
 * module doc's "Reclaim runs second" section for why that order, and not
 * the reverse, is what keeps a throwing `remove` retried next tick instead
 * of silently forgotten.
 */
async function reclaimRows(
  deps: DeliverDeps,
  remove: (ref: string) => Promise<void>,
  result: DeliverResult,
  rows: readonly DownloadRow[],
): Promise<void> {
  const [row, ...rest] = rows;
  if (row === undefined) return;
  if (row.clientRef !== null) {
    // Caught per row, not per pass. One ref the client will not delete --
    // already gone, or malformed, or a permission the client lost -- would
    // otherwise reject this whole pass and starve every row behind it in the
    // list, forever: the next tick reads the same rows in the same order and
    // stops at the same one. A poison row must cost its own reclaim and
    // nothing else's, which is the same reasoning `deliverOne` already
    // applies to a plugin that throws.
    try {
      await remove(row.clientRef);
      if (markReclaimed(deps.raw, row, deps.now)) {
        result.reclaimed += 1;
      }
    } catch (error) {
      result.reclaimFailures += 1;
      deps.log('reclaim failed, leaving the download for the next tick', {
        rowId: row.id,
        reason: error instanceof Error ? redactText(error.message) : String(error),
      });
    }
  }
  await reclaimRows(deps, remove, result, rest);
}

/**
 * Delivers every eligible `completed` row on `deps.clientId` to the plugin
 * that owns it, then reclaims every `delivered` row if `deps.remove` can.
 * See the module doc for the full ordering and its reasoning.
 */
export async function deliverCompleted(deps: DeliverDeps): Promise<DeliverResult> {
  const result: DeliverResult = {
    delivered: 0, reclaimed: 0, unowned: 0, reclaimFailures: 0, undeliverable: 0,
  };

  // `status` is narrowed in SQL -- see `rows.ts`'s `rowsForClientByStatus`
  // for why reading every row this client ever had, then filtering, cost
  // 153 ms of blocked event loop per tick at 20,000 finished rows. Both
  // `status === 'completed'` and `deliveredAt === null` are then checked
  // here, even though `markDelivered` never sets one without the other --
  // stating both is what the module doc's own wording promises, and a future
  // writer of `delivered_at` that broke that pairing would be caught here
  // rather than silently redelivering, or silently skipping, a row.
  const completedRows = rowsForClientByStatus(deps.raw, deps.clientId, DELIVERABLE_STATUSES)
    .filter((row) => row.status === 'completed' && row.deliveredAt === null);
  // `storagePath === null` is reported before anything is delivered, rather
  // than dropped by the filter above: a completed row the client cannot
  // place is a standing condition someone has to be able to see. See the
  // module doc.
  reportUndeliverable(deps, result, completedRows);
  await deliverRows(deps, result, completedRows.filter((row) => row.storagePath !== null));

  const remove = deps.remove;
  if (remove !== undefined) {
    // Re-read rather than reuse `completedRows`: a row this same pass just
    // delivered is now `delivered` and eligible for reclaim in the same
    // tick, not one tick later. `reclaimedAt === null` is what keeps this a
    // once-per-download reclaim rather than a once-per-tick one -- see the
    // module doc and `db/migrate.ts`'s migration 8 comment.
    // `reclaimed_at IS NULL` is in the SQL as well as restated here, unlike
    // the `completed` read above: `delivered` is where a row stops moving, so
    // every download this client has ever finished stays in that status
    // forever with `reclaimed_at` set. Narrowing on status alone would leave
    // this read growing with lifetime history, which is the whole thing the
    // narrowing was for -- see `rows.ts`'s `unreclaimedRowsForClient` for the
    // measurement.
    const deliveredRows = unreclaimedRowsForClient(deps.raw, deps.clientId)
      .filter((row) => row.status === 'delivered' && row.reclaimedAt === null);
    await reclaimRows(deps, remove, result, deliveredRows);
  }

  return result;
}
