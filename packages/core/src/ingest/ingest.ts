import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import type { FeedConfig } from '../config/schema.ts';
import type { FeedEntry } from '../feeds/parse-rss.ts';
import { insertFeedItem, setParseError } from '../db/feed-items.ts';
import { commitRelease, validateParsed, type PreparedRelease } from './commit.ts';

/**
 * How many individual parse failures one `ingestEntries` call will report by
 * title before it starts only counting them. A feed that suddenly fails to
 * parse everything — a redesign of its title format, say — must not write
 * thousands of log lines in one tick; `parseFailuresSuppressed` on the
 * result says how many were left out so the cap itself is visible.
 */
export const MAX_REPORTED_PARSE_FAILURES = 50;

export interface ParseFailure {
  title: string;
  reason: string;
}

export interface IngestResult {
  seen: number;
  inserted: number;
  parseErrors: number;
  groupsCreated: number;
  releasesAdded: number;
  upgradesFlagged: number;
  /**
   * The raw title and reason for up to `MAX_REPORTED_PARSE_FAILURES` of this
   * tick's parse failures — the actionable half of `parseErrors`, which is
   * only ever a count. `ingestEntries` has no logger of its own; the
   * scheduler logs these, one per line, which is what makes a name the
   * parser cannot handle visible instead of merely counted.
   */
  parseFailures: ParseFailure[];
  /** How many parse failures beyond the cap were left out of `parseFailures`. */
  parseFailuresSuppressed: number;
}

/**
 * Runs the whole plugin interaction — `parse`, the consumption of what it
 * returned, and `score` — under a guard, so that no way a plugin can be wrong
 * reaches the database or the transaction below.
 *
 * The narrower version of this wrapped `parse` alone, which made the spec's
 * promise ("a thrown exception is caught and recorded as a `parse_error`")
 * true for exactly one of the several ways a plugin can be wrong. The rest —
 * a throwing or non-finite `score`, a `display` the compiler swore was
 * well-formed — escaped the per-entry try only to hit the ROLLBACK, which
 * discards the poison item's own `feed_items` row, so the next tick re-serves
 * it, re-throws on it, and never reaches a single entry behind it. One
 * malformed item silently blinded the whole feed, permanently. `validateParsed`
 * carries its own try/catch for exactly that reason, so the guard here covers
 * only `parse` and `refusalReason` and the coverage is still total.
 *
 * Genuine database failures are deliberately *not* caught — those are not the
 * plugin's fault and should still abort the batch loudly.
 */
function prepareSafely(
  plugin: MediaTypePlugin,
  title: string,
): { prepared: PreparedRelease } | { error: string } {
  let parsed: ParsedRelease | null;
  try {
    parsed = plugin.parse(title);
    if (parsed === null) {
      // The plugin's own account of why, when it keeps one. Without this the
      // log reports a count where it could report a worklist.
      return { error: plugin.refusalReason?.() ?? 'unrecognized' };
    }
  } catch (error) {
    return { error: `plugin threw: ${(error as Error).message}` };
  }

  return validateParsed(plugin, parsed);
}

/**
 * Ingests feed entries under the two rules from the spec.
 *
 * Ledger: a feed item is processed only if its INSERT actually inserted, so a
 * feed re-serving its whole history is a no-op.
 *
 * Bump: within ingest, list_rank_at moves in exactly one situation — a release
 * arriving that beats both the picked release and any already-flagged upgrade on
 * a group the user has picked. Everything else here leaves list position alone.
 * (One write outside ingest also moves it: `failDownload`, so a group whose
 * download just failed surfaces on Picks.)
 */
export function ingestEntries(
  db: DatabaseSync,
  plugin: MediaTypePlugin,
  feed: FeedConfig,
  entries: FeedEntry[],
  now: number,
): IngestResult {
  const result: IngestResult = {
    seen: entries.length,
    inserted: 0,
    parseErrors: 0,
    groupsCreated: 0,
    releasesAdded: 0,
    upgradesFlagged: 0,
    parseFailures: [],
    parseFailuresSuppressed: 0,
  };

  for (const entry of entries) {
    db.exec('BEGIN');
    try {
      const feedItemId = insertFeedItem(db, {
        feedId: feed.id,
        guid: entry.guid,
        rawTitle: entry.title,
        link: entry.link,
        publishedAt: entry.publishedAt,
        firstSeenAt: now,
      });

      if (feedItemId === null) {
        db.exec('COMMIT');
        continue;
      }
      result.inserted += 1;

      const outcome = prepareSafely(plugin, entry.title);
      if ('error' in outcome) {
        setParseError(db, feedItemId, outcome.error);
        result.parseErrors += 1;
        if (result.parseFailures.length < MAX_REPORTED_PARSE_FAILURES) {
          result.parseFailures.push({ title: entry.title, reason: outcome.error });
        } else {
          result.parseFailuresSuppressed += 1;
        }
        db.exec('COMMIT');
        continue;
      }

      const committed = commitRelease(db, outcome.prepared, plugin, feedItemId, now);
      if (committed.groupCreated) result.groupsCreated += 1;
      result.releasesAdded += 1;
      if (committed.upgradeFlagged) result.upgradesFlagged += 1;

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return result;
}
