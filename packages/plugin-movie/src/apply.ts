/**
 * One resolved answer, written as a film.
 *
 * The simplest of the three: a film has no parent this slice models, so
 * `media.parents` is expected to be empty and is ignored if it is not. One
 * upsert keyed on the media item, so a retried job re-writes rather than
 * duplicating.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DetailValue, Media } from '@pickarr/openmetadata';
import type { ApplyArgs } from '@pickarr/openmetadata';

/** A detail that should be a whole number, or null. A string of digits counts. */
function wholeNumber(details: Readonly<Record<string, DetailValue>>, key: string): number | null {
  const value = details[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** A detail that should be text, or null. A number is not a tagline. */
function text(details: Readonly<Record<string, DetailValue>>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Whether a film can represent this answer at all: the engine's pre-flight,
 * run at the top of the resolved branch and before a single shared row
 * exists.
 *
 * The guard was once made inside `applyMovie` alone, which the engine calls
 * *after* it has created the `media_item`, claimed the provider reference on
 * it and relinked the rss item to it -- so a mis-sent category stranded all
 * three with the resolution stuck `pending` and nothing on any path to undo
 * it. It reads `media.kind` and nothing else, which is what makes it cheap
 * enough to run this early.
 */
export function checkMovie(media: Media): void {
  if (media.kind !== 'movie') {
    throw new Error(`plugin-movie: a movies lookup answered with kind ${media.kind}`);
  }
}

/**
 * `checkMovie`'s guard is repeated below rather than removed: `applyMovie` is
 * exported on its own and driven directly by this package's tests, so a
 * caller that never ran the pre-flight still cannot write a `movie_detail`
 * row for something that is not a film. The pre-flight is the copy that
 * matters -- it is the one that runs before the shared rows exist.
 */
export async function applyMovie(args: ApplyArgs): Promise<void> {
  const { media, mediaItemId, raw, now } = args;
  if (media.kind !== 'movie') {
    throw new Error(`plugin-movie: a movies lookup answered with kind ${media.kind}`);
  }

  raw.prepare(`
    INSERT INTO movie_detail
      (media_item_id, runtime_minutes, imdb_id, tagline, collection_name, details_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (media_item_id) DO UPDATE SET
      runtime_minutes = excluded.runtime_minutes,
      imdb_id         = excluded.imdb_id,
      tagline         = excluded.tagline,
      collection_name = excluded.collection_name,
      details_json    = excluded.details_json,
      updated_at      = excluded.updated_at
  `).run(
    mediaItemId,
    wholeNumber(media.details, 'runtimeMinutes'),
    text(media.details, 'imdbId'),
    text(media.details, 'tagline'),
    text(media.details, 'collectionName'),
    JSON.stringify(media.details),
    now,
    now,
  );
}

/** Deletes the film row for a media item the host is dropping (`MediaPlugin.onMediaItemDropped`). */
export function dropMovieRows(mediaItemId: number, raw: DatabaseSync): void {
  raw.prepare('DELETE FROM movie_detail WHERE media_item_id = ?').run(mediaItemId);
}
