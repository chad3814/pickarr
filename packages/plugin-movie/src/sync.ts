/**
 * What a client receives for a film, and what it does not.
 *
 * `details_json` is projected away: it is the metadata provider's answer
 * verbatim, unbounded, and nothing in a view reads it (design spec §3.9).
 * `movie_detail` is the film plugin's only table, so this is its whole
 * replica.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { MovieRead, SyncedTable } from '@pickarr/contract';

function asTextOrNull(value: SQLOutputValue | undefined): string | null {
  return value === null ? null : String(value);
}

function asNumber(value: SQLOutputValue | undefined): number {
  return Number(value);
}

function asNumberOrNull(value: SQLOutputValue | undefined): number | null {
  return value === null ? null : Number(value);
}

/** `?, ?, ...`, one per id -- never the ids themselves, which stay bound parameters. */
function holes(ids: readonly number[]): string {
  return ids.map(() => '?').join(', ');
}

const detail: SyncedTable<MovieRead> = {
  table: 'movie_detail',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, MovieRead> {
    if (ids.length === 0) return {};
    const rows = raw.prepare(
      `SELECT id, runtime_minutes, tagline FROM movie_detail WHERE id IN (${holes(ids)})`,
    ).all(...ids);
    const result: Record<number, MovieRead> = {};
    for (const row of rows) {
      result[asNumber(row.id)] = {
        runtimeMinutes: asNumberOrNull(row.runtime_minutes),
        tagline: asTextOrNull(row.tagline),
      };
    }
    return result;
  },
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] {
    if (mediaItemIds.length === 0) return [];
    const rows = raw.prepare(
      `SELECT id FROM movie_detail WHERE media_item_id IN (${holes(mediaItemIds)})`,
    ).all(...mediaItemIds);
    return rows.map((row) => asNumber(row.id));
  },
};

export const MOVIE_SYNCED: readonly SyncedTable<unknown>[] = [detail];
