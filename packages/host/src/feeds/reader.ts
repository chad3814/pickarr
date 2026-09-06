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

/**
 * How many previously-undelivered rows one poll re-offers alongside its
 * freshly-inserted ones. Every newly-inserted id is always included, in
 * full, however many there are -- this cap bounds only the catch-up on top
 * of that, so a feed that piled up a large backlog while unowned (no
 * registered plugin, or a plugin that kept rejecting) hands its owner a
 * bounded batch each cycle instead of every undelivered row it has ever
 * seen in one call. 500 is comfortably above a normal feed's per-poll new-
 * item count, so the ordinary path never notices it, while still retiring a
 * large backlog over a handful of poll cycles rather than never. Chosen
 * ids are the oldest undelivered ones first, so a backlog drains front-to-
 * back rather than starving its oldest rows indefinitely.
 */
export const MAX_CATCHUP_PER_POLL = 500;

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

  // Undelivered rows for one feed, oldest id first, over-fetched by however
  // many rows this same poll just inserted: a fresh insert also has a null
  // `delivered_at`, so it appears in this result set alongside true
  // backlog -- over-fetching by `inserted.length` and filtering those ids
  // back out below guarantees at least `MAX_CATCHUP_PER_POLL` genuinely
  // separate catch-up ids survive, rather than the cap being silently eaten
  // by the very rows `inserted` already covers.
  const undelivered = deps.raw.prepare(`
    SELECT id FROM rss_item WHERE feed_id = ? AND delivered_at IS NULL ORDER BY id ASC LIMIT ?
  `);

  // Marks one row delivered. A loop over single-row updates, not one
  // dynamic `IN (...)` statement: the ids marked in one call are already
  // bounded by `inserted.length + MAX_CATCHUP_PER_POLL`, so there is no
  // batch here large enough for that to matter.
  const markDelivered = deps.raw.prepare('UPDATE rss_item SET delivered_at = ? WHERE id = ?');

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

      // Every newly-inserted id is offered in full, always; catch-up on top
      // of that is capped. See `MAX_CATCHUP_PER_POLL`'s own doc for why a
      // cap that let a backlog crowd out new items would be its own bug.
      const insertedSet = new Set(inserted);
      const catchup = undelivered.all(feedId, MAX_CATCHUP_PER_POLL + inserted.length)
        .map((row) => Number((row as { id: unknown }).id))
        .filter((id) => !insertedSet.has(id))
        .slice(0, MAX_CATCHUP_PER_POLL);
      const offered = [...inserted, ...catchup];

      // Always called, even with an empty list: a quiet feed still reports
      // "nothing new" rather than skipping the call, so a caller watching
      // `notify` can tell "polled, found nothing" from "never polled".
      const outcome = await deps.notify(offered);

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

      // A feed names exactly one plugin, so `failures` here is all-or-
      // nothing for this whole batch: a non-empty `failures` means that one
      // plugin threw on it, and marking anything delivered would lose the
      // rows it never actually finished handling -- they are re-offered
      // next poll instead. Otherwise every offered id is delivered except
      // the ones reported `unowned`, which stay undelivered so they are
      // re-offered the moment a plugin exists to receive them.
      if (outcome.failures.length === 0) {
        const unownedSet = new Set(outcome.unowned);
        for (const id of offered) {
          if (unownedSet.has(id)) continue;
          markDelivered.run(at, id);
        }
      }

      return { inserted, skipped };
    },
  };
}
