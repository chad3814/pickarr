import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import type { FeedConfig } from '../config/schema.ts';
import type { FeedEntry } from '../feeds/parse-rss.ts';
import { insertFeedItem, setParseError } from '../db/feed-items.ts';
import { findGroup, flagUpgrade, insertGroup } from '../db/groups.ts';
import { insertRelease, releaseScore } from '../db/releases.ts';

export interface IngestResult {
  seen: number;
  inserted: number;
  parseErrors: number;
  groupsCreated: number;
  releasesAdded: number;
  upgradesFlagged: number;
}

function searchTextFor(display: DisplayFields): string {
  const parts = [display.title, display.subtitle ?? '', display.date ?? ''];
  for (const field of display.fields) parts.push(field.value);
  return parts.join(' ').toLowerCase();
}

function parseSafely(
  plugin: MediaTypePlugin,
  title: string,
): { parsed: ParsedRelease } | { error: string } {
  try {
    const parsed = plugin.parse(title);
    return parsed === null ? { error: 'unrecognized' } : { parsed };
  } catch (error) {
    return { error: `parse threw: ${(error as Error).message}` };
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

      const outcome = parseSafely(plugin, entry.title);
      if ('error' in outcome) {
        setParseError(db, feedItemId, outcome.error);
        result.parseErrors += 1;
        db.exec('COMMIT');
        continue;
      }

      const { parsed } = outcome;
      const existing = findGroup(db, plugin.id, parsed.identityKey);
      const groupId =
        existing?.id ??
        insertGroup(db, {
          plugin: plugin.id,
          identityKey: parsed.identityKey,
          display: JSON.stringify(parsed.display),
          searchText: searchTextFor(parsed.display),
          createdAt: now,
        });
      if (existing === null) result.groupsCreated += 1;

      const score = plugin.score(parsed.quality);
      const releaseId = insertRelease(db, {
        groupId,
        feedItemId,
        quality: JSON.stringify(parsed.quality),
        score,
        createdAt: now,
      });
      result.releasesAdded += 1;

      if (existing !== null && existing.state === 'picked') {
        const pickedScore = releaseScore(db, existing.pickedReleaseId) ?? Number.NEGATIVE_INFINITY;
        const flaggedScore =
          releaseScore(db, existing.upgradeReleaseId) ?? Number.NEGATIVE_INFINITY;

        if (score > pickedScore && score > flaggedScore) {
          flagUpgrade(db, groupId, releaseId, now);
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
