import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import type { FeedConfig } from '../config/schema.ts';
import type { FeedEntry } from '../feeds/parse-rss.ts';
import { insertFeedItem, setParseError } from '../db/feed-items.ts';
import { findGroup, flagUpgrade, insertGroup } from '../db/groups.ts';
import { insertRelease, releaseScore } from '../db/releases.ts';

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

function isText(value: string | undefined): boolean {
  return typeof value === 'string';
}

function searchTextFor(display: DisplayFields): string {
  const parts = [display.title];
  if (isText(display.subtitle)) parts.push(display.subtitle ?? '');
  if (isText(display.date)) parts.push(display.date ?? '');
  for (const field of display.fields) {
    if (field !== null && typeof field === 'object' && isText(field.value)) parts.push(field.value);
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Everything a plugin contributes to one feed item, validated and reduced to
 * the exact values the writes below need.
 */
interface PreparedRelease {
  identityKey: string;
  displayJson: string;
  searchText: string;
  qualityJson: string;
  score: number;
}

/**
 * Runs the whole plugin interaction — `parse`, the consumption of what it
 * returned, and `score` — inside one guard, and shape-checks the result before
 * any of it reaches the database.
 *
 * The narrower version of this wrapped `parse` alone, which made the spec's
 * promise ("a thrown exception is caught and recorded as a `parse_error`")
 * true for exactly one of the several ways a plugin can be wrong. A plugin is
 * third-party code whose return value crosses a boundary nothing type-checks,
 * and each of the escapes below was reachable: a `score` that throws; a
 * `display` with no `fields`, which made `searchTextFor` throw on a value the
 * compiler swore was iterable; a `score` returning `NaN`, which bound as SQL
 * NULL and tripped `releases.score`'s NOT NULL constraint. Every one of them
 * escaped the per-entry try only to hit the ROLLBACK — which discards the
 * poison item's own `feed_items` row, so the next tick re-serves it, re-throws
 * on it, and never reaches a single entry behind it. One malformed item
 * silently blinded the whole feed, permanently.
 *
 * Returning an error string instead puts the failure exactly where the spec
 * says it belongs: on the feed item, as a `parse_error`, visible in the
 * worklist, with the rest of the batch unaffected. Genuine database failures
 * are deliberately *not* caught here — those are not the plugin's fault and
 * should still abort the batch loudly.
 */
function prepareSafely(
  plugin: MediaTypePlugin,
  title: string,
): { prepared: PreparedRelease } | { error: string } {
  try {
    const parsed: ParsedRelease | null = plugin.parse(title);
    if (parsed === null) {
      // The plugin's own account of why, when it keeps one. Without this the
      // log reports a count where it could report a worklist.
      return { error: plugin.refusalReason?.() ?? 'unrecognized' };
    }

    if (typeof parsed.identityKey !== 'string' || parsed.identityKey.length === 0) {
      return { error: 'invalid parse result: identityKey must be a non-empty string' };
    }

    const display = parsed.display;
    if (display === null || typeof display !== 'object') {
      return { error: 'invalid parse result: display must be an object' };
    }
    if (typeof display.title !== 'string') {
      return { error: 'invalid parse result: display.title must be a string' };
    }
    if (!Array.isArray(display.fields)) {
      return { error: 'invalid parse result: display.fields must be an array' };
    }
    for (const field of display.fields) {
      if (
        field === null ||
        typeof field !== 'object' ||
        typeof field.label !== 'string' ||
        typeof field.value !== 'string'
      ) {
        return {
          error: 'invalid parse result: display.fields elements must have string label and value',
        };
      }
    }

    const quality = parsed.quality;
    if (quality === null || typeof quality !== 'object' || Array.isArray(quality)) {
      return { error: 'invalid parse result: quality must be an object' };
    }

    const score = plugin.score(quality);
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return { error: `invalid score: ${String(score)} is not a finite number` };
    }

    return {
      prepared: {
        identityKey: parsed.identityKey,
        displayJson: JSON.stringify(display),
        searchText: searchTextFor(display),
        qualityJson: JSON.stringify(quality),
        score,
      },
    };
  } catch (error) {
    return { error: `plugin threw: ${(error as Error).message}` };
  }
}

/**
 * Ingests feed entries under the two rules from the spec.
 *
 * Ledger: a feed item is processed only if its INSERT actually inserted, so a
 * feed re-serving its whole history is a no-op.
 *
 * Bump: list_rank_at moves in exactly one situation — a release arriving that
 * beats both the picked release and any already-flagged upgrade on a group the
 * user has picked. Everything else leaves list position alone.
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

      const { prepared } = outcome;
      const existing = findGroup(db, plugin.id, prepared.identityKey);
      const groupId =
        existing?.id ??
        insertGroup(db, {
          plugin: plugin.id,
          identityKey: prepared.identityKey,
          display: prepared.displayJson,
          searchText: prepared.searchText,
          createdAt: now,
        });
      if (existing === null) result.groupsCreated += 1;

      const score = prepared.score;
      insertRelease(db, {
        groupId,
        feedItemId,
        quality: prepared.qualityJson,
        score,
        createdAt: now,
      });
      result.releasesAdded += 1;

      if (existing !== null && existing.state === 'picked') {
        const pickedScore = releaseScore(db, existing.pickedReleaseId) ?? Number.NEGATIVE_INFINITY;
        const flaggedScore =
          releaseScore(db, existing.upgradeReleaseId) ?? Number.NEGATIVE_INFINITY;

        // This comparison decides whether the *bump* is earned — whether a
        // newly arrived release is better than everything the group already
        // knows about. Which release ends up flagged is not decided here;
        // flagUpgrade re-derives that from the group's own releases, so the
        // flag cannot disagree with the table it summarizes.
        if (score > pickedScore && score > flaggedScore) {
          flagUpgrade(db, groupId, now);
          result.upgradesFlagged += 1;
        }
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return result;
}
