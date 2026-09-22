/**
 * Removing a feed, and putting one back.
 *
 * **Delete when it produced nothing, disable when it did.** `PRAGMA
 * foreign_keys` is ON and `rss_item.feed_id` is
 * `NOT NULL REFERENCES rss_feed (id)`, so a feed that has ever polled
 * cannot be deleted without deleting its items -- and each of those items
 * can own a `torrent_download` or `nzb_download` row, which is the record
 * of a file that may be on disk right now. Cascading through all of that to
 * honour the word "delete" would discard the only thing that says where a
 * library file came from.
 *
 * A feed that produced nothing has none of that behind it. It is also the
 * case worth removing cleanly -- a mistyped url, a tracker that answered
 * nothing -- so it is deleted outright rather than left in the list forever
 * wearing a disabled badge.
 *
 * **Disabling is reversible** ({@link enableFeed}). A one-way disable would
 * be a delete wearing a kinder word, and would leave an operator with a
 * list that only ever grows.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Why a removal or an enable could not be carried out. */
export interface FeedRefusal {
  readonly refusal: 'unknown-feed';
}

export type RemoveFeedOutcome =
  /** The feed produced no releases and its row is gone. */
  | { readonly outcome: 'deleted' }
  /**
   * The feed produced releases, so it stopped polling and kept them.
   * `items` is how many held it back -- an operator who asked to remove
   * something and got "disabled" instead is owed the reason.
   */
  | { readonly outcome: 'disabled'; readonly items: number }
  | FeedRefusal;

export type EnableFeedOutcome = { readonly outcome: 'enabled' } | FeedRefusal;

/** Whether the feed exists at all, asked before anything is written. */
function feedExists(raw: DatabaseSync, id: number): boolean {
  return raw.prepare('SELECT 1 FROM rss_feed WHERE id = ?').get(id) !== undefined;
}

/**
 * Deletes feed `id` if it has no releases, disables it if it has.
 *
 * Disabling is idempotent and does **not** move `disabled_at`: the
 * `WHERE disabled_at IS NULL` below is what makes a second call, or a
 * retried request, leave the record saying when polling actually stopped
 * rather than when someone last clicked.
 */
export function removeFeed(
  deps: { raw: DatabaseSync; now: () => number },
  id: number,
): RemoveFeedOutcome {
  if (!feedExists(deps.raw, id)) return { refusal: 'unknown-feed' };

  const row = deps.raw.prepare('SELECT count(*) AS n FROM rss_item WHERE feed_id = ?').get(id);
  // `'n' in row`, not a cast: `node:sqlite` types a row as
  // `Record<string, SQLOutputValue>` and the no-cast rule applies here as
  // everywhere. An aggregate always answers a row, so the absent case is
  // this module being wrong about its own SQL.
  const items = row !== undefined && 'n' in row && typeof row.n === 'number' ? row.n : 0;

  if (items === 0) {
    deps.raw.prepare('DELETE FROM rss_feed WHERE id = ?').run(id);
    return { outcome: 'deleted' };
  }

  deps.raw
    .prepare('UPDATE rss_feed SET disabled_at = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL')
    .run(deps.now(), deps.now(), id);
  return { outcome: 'disabled', items };
}

/**
 * Clears `disabled_at`, so the feed polls again from the next schedule.
 *
 * `updated_at` moves whether or not the row was disabled, because a client
 * learns about this row through the sync log and the log is driven by the
 * update trigger -- a no-op `UPDATE` that changed nothing would leave a
 * replica showing a feed as disabled after it had been enabled.
 */
export function enableFeed(deps: { raw: DatabaseSync; now: () => number }, id: number): EnableFeedOutcome {
  if (!feedExists(deps.raw, id)) return { refusal: 'unknown-feed' };
  deps.raw.prepare('UPDATE rss_feed SET disabled_at = NULL, updated_at = ? WHERE id = ?').run(deps.now(), id);
  return { outcome: 'enabled' };
}

/**
 * Stops a feed polling without removing anything, whatever it has produced.
 *
 * **Not the same as {@link removeFeed}, and both exist on purpose.**
 * `removeFeed` answers "get rid of this", and deletes when it safely can.
 * This answers "pause this", which is a different intention and is the only
 * way to quiet a feed that *could* have been deleted -- a brand new one
 * that has not polled yet.
 *
 * Idempotent in the same way, and for the same reason: `disabled_at IS
 * NULL` keeps a second call from moving the record of when polling stopped.
 */
export function disableFeed(
  deps: { raw: DatabaseSync; now: () => number },
  id: number,
): { readonly outcome: 'disabled' } | FeedRefusal {
  if (!feedExists(deps.raw, id)) return { refusal: 'unknown-feed' };
  deps.raw
    .prepare('UPDATE rss_feed SET disabled_at = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL')
    .run(deps.now(), deps.now(), id);
  return { outcome: 'disabled' };
}
