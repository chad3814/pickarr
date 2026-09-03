import type { DatabaseSync } from 'node:sqlite';
import type { NotifyOutcome } from '../host.ts';
import { parseRss } from './parse-rss.ts';

/** What one call to `pollFeed` did. */
export interface PollResult {
  /** Rows this poll created. Already handed to `notifyNewRssItems`. */
  inserted: readonly number[];
  /** Entries the feed still lists that we already had. */
  skipped: number;
}

/** The columns a poll needs from `rss_feed`, narrowed once per call rather than re-read per entry. */
interface FeedRow {
  url: string;
  downloadType: string;
}

function feedRow(raw: DatabaseSync, feedId: number): FeedRow {
  const row = raw.prepare('SELECT url, download_type FROM rss_feed WHERE id = ?').get(feedId);
  if (!row) {
    throw new Error(`rss feed id ${feedId} not found`);
  }
  return {
    url: String((row as { url: unknown }).url),
    downloadType: String((row as { download_type: unknown }).download_type),
  };
}

/**
 * Reads one feed, inserts what it has not seen before, and notifies only
 * those new rows -- never the ones it already held.
 *
 * `fetchText` rather than `HostFetch`: the contract exposes `json` and
 * `bytes`, and a feed is XML, so this depends on the narrower shape it
 * actually needs instead of pulling in a whole `HostFetch` for one call it
 * would never use. The concrete function a caller wires up here still runs
 * through `createHostFetch`'s own per-hostname queue (see `queue.ts`'s
 * `text` method) -- a feed's host is paced exactly like a plugin's `json`
 * or `bytes` call to that same host, not exempted from the budget Task 2
 * built just because this caller cannot use `HostFetch` itself.
 *
 * `notify` rather than `Host.notifyNewRssItems` bound in: the same function
 * shape, so a test can stub it directly without building a whole `Host`.
 */
export function createFeedReader(deps: {
  raw: DatabaseSync;
  fetchText: (url: string) => Promise<string>;
  notify: (ids: readonly number[]) => Promise<NotifyOutcome>;
  now: () => number;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}): { pollFeed(feedId: number): Promise<PollResult> } {
  // One prepared statement, reused across every entry of every poll: `feed_id`
  // is a bind parameter, not baked into the SQL, so this is not tied to a
  // single feed. `ON CONFLICT ... DO NOTHING RETURNING id` is what makes the
  // insert loop below correct rather than merely convenient -- probed
  // directly against `node:sqlite` (see the task report) to confirm a
  // conflicting insert resolves `.get()` to `undefined` rather than a row or
  // a throw, and a successful one resolves to the new row.
  const insert = deps.raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, guid, download_type, resolution, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT (feed_id, guid) DO NOTHING
    RETURNING id
  `);

  return {
    async pollFeed(feedId) {
      const feed = feedRow(deps.raw, feedId);
      const xml = await deps.fetchText(feed.url);
      const entries = parseRss(xml);
      const at = deps.now();

      // Ids this call created, taken from what `RETURNING` handed back --
      // never re-derived by re-selecting the feed's rows afterward. Re-
      // selecting would not distinguish a row this poll just inserted from
      // one an earlier poll already owned, which is the whole defect this
      // module exists to avoid: notifying on rows nobody just created.
      // `node:sqlite` is synchronous, so this loop has no `await` in it.
      const inserted: number[] = [];
      let skipped = 0;
      for (const entry of entries) {
        const row = insert.get(feedId, entry.filename, entry.link, entry.guid, feed.downloadType, at, at);
        if (row === undefined) {
          skipped += 1;
          continue;
        }
        inserted.push(Number((row as { id: unknown }).id));
      }

      // Always called, even with an empty list: a quiet feed still reports
      // "nothing new" rather than skipping the call, so a caller watching
      // `notify` can tell "polled, found nothing" from "never polled".
      const outcome = await deps.notify(inserted);

      // Both halves of `NotifyOutcome` are read, neither behind the other:
      // a feed naming an unregistered plugin and a plugin that threw are
      // unrelated failures, and dropping either would silently lose it by a
      // different route than the one `NotifyOutcome` was introduced to close.
      if (outcome.unowned.length > 0) {
        deps.log('feed items have no registered plugin', { feedId, ids: outcome.unowned });
      }
      for (const failure of outcome.failures) {
        deps.log('plugin failed on new items', { feedId, pluginId: failure.pluginId, error: String(failure.error) });
      }

      return { inserted, skipped };
    },
  };
}
