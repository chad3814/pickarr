/**
 * Tells a plugin its file landed, and only then lets the download client
 * forget it.
 *
 * `onDownloadedFile` is a required `MediaPlugin` entry point (see
 * `packages/contract/src/plugin.ts`) that nothing in 2.0 has called until
 * now: it is the host's half of "the host notifies, the plugin imports" --
 * this codebase's replacement for 1.x's `pipeline/import.ts`, which pulled a
 * finished file into place itself. Here the host does none of that; it maps
 * the client's own path, measures the file, and hands both to the plugin
 * that owns it. What the plugin does with them is the plugin's business.
 *
 * **Ordering, and why each step is where it is.** For every `completed` row
 * with a `storage_path` and no `delivered_at`:
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
 * no "forget this job but keep seeding" call to make instead. Making
 * `remove` optional -- rather than a boolean flag some config could set
 * wrong -- is what makes calling it for a client that cannot safely support
 * it impossible to write, not merely discouraged.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile } from '@pickarr/contract';
import { ownerPluginId, PluginNotRegisteredError } from '../host.ts';
import { mapClientPath } from './paths.ts';
import { redactUrl } from './redact.ts';
import { markDelivered, markReclaimed, rowsForClient } from './rows.ts';
import type { DownloadRow } from './rows.ts';

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
  // Unreachable given `deliverCompleted`'s own filter below, but the type
  // is `string | null` regardless of what a caller has already checked, and
  // a row with nothing to map or stat has nothing this function can do.
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

    const file: DownloadedFile = { path: mappedPath, sizeBytes, downloadClientId: row.downloadClientId };
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
    deps.log('failed to deliver a completed download, leaving it completed for the next tick', {
      rowId: row.id,
      error: error instanceof Error ? error.message : String(error),
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
        reason: error instanceof Error ? redactUrl(error.message) : String(error),
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
  const result: DeliverResult = { delivered: 0, reclaimed: 0, unowned: 0, reclaimFailures: 0 };

  // Both `status === 'completed'` and `deliveredAt === null` are checked,
  // even though `markDelivered` never sets one without the other -- stating
  // both is what the module doc's own wording promises, and a future writer
  // of `delivered_at` that broke that pairing would be caught here rather
  // than silently redelivering, or silently skipping, a row.
  const completedRows = rowsForClient(deps.raw, deps.clientId)
    .filter((row) => row.status === 'completed' && row.storagePath !== null && row.deliveredAt === null);
  await deliverRows(deps, result, completedRows);

  const remove = deps.remove;
  if (remove !== undefined) {
    // Re-read rather than reuse `completedRows`: a row this same pass just
    // delivered is now `delivered` and eligible for reclaim in the same
    // tick, not one tick later. `reclaimedAt === null` is what keeps this a
    // once-per-download reclaim rather than a once-per-tick one -- see the
    // module doc and `db/migrate.ts`'s migration 8 comment.
    const deliveredRows = rowsForClient(deps.raw, deps.clientId)
      .filter((row) => row.status === 'delivered' && row.reclaimedAt === null);
    await reclaimRows(deps, remove, result, deliveredRows);
  }

  return result;
}
