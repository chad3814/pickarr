/**
 * What a client receives for a television item, and what it does not.
 *
 * `details_json` is projected away everywhere below: it is the metadata
 * provider's answer verbatim, unbounded, and nothing in a view reads it
 * (design spec §3.9). Every field a read returns is named explicitly, so a
 * column added to any of these tables later reaches no client until someone
 * decides it should.
 *
 * `tv_release` is listed first, `tv_season` and `tv_series` after it -- the
 * order a plugin declares its tables in is the order the backfill writes
 * them for one group (`sync/backfill.ts`), and a release row names its
 * season and series, so the detail comes before the shared parents it
 * points at.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { SyncedTable, TvRead, TvSeasonRead, TvSeriesRead } from '@pickarr/contract';

function asText(value: SQLOutputValue | undefined): string {
  return String(value);
}

function asTextOrNull(value: SQLOutputValue | undefined): string | null {
  return value === null ? null : String(value);
}

function asNumber(value: SQLOutputValue | undefined): number {
  return Number(value);
}

function asNumberOrNull(value: SQLOutputValue | undefined): number | null {
  return value === null ? null : Number(value);
}

function tvKind(value: SQLOutputValue | undefined): TvRead['kind'] {
  const text = String(value);
  if (text !== 'series' && text !== 'season' && text !== 'episode') {
    throw new Error(`plugin-tv: tv_release.kind is ${JSON.stringify(text)}, not a recognised kind`);
  }
  return text;
}

/** `?, ?, ...`, one per id -- never the ids themselves, which stay bound parameters. */
function holes(ids: readonly number[]): string {
  return ids.map(() => '?').join(', ');
}

/**
 * A release's own kind and episode number, plus its series' title and
 * reference and its season's number -- flattened by a join, because
 * `TvRead` is what one release reads as, not what any one of the three
 * tables holds alone.
 *
 * `seriesTitle`/`seriesRef` come from a required join: `tv_release.series_id`
 * is `NOT NULL` (`migrations.ts`), so every release names a series. `season`
 * is a left join: a series pack and some episodes have no season at all
 * (`apply.ts`'s `checkTv`/`applyTv`), and `seasonNumber` reads `null` rather
 * than a season this release does not have.
 *
 * `mediaItemId` is `tv_release.media_item_id`, which the client groups by.
 * This row's own id is not here and must not be: the host puts it on the op
 * (`sync/tail.ts`'s `SyncOp`), so keying does not depend on each read shape
 * remembering a field.
 */
const release: SyncedTable<TvRead> = {
  table: 'tv_release',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, TvRead> {
    if (ids.length === 0) return {};
    const rows = raw.prepare(`
      SELECT r.id, r.media_item_id, r.kind, r.episode_number,
             s.title AS series_title, s.provider_ref AS series_ref, n.season_number
      FROM tv_release r
      JOIN tv_series s ON s.id = r.series_id
      LEFT JOIN tv_season n ON n.id = r.season_id
      WHERE r.id IN (${holes(ids)})
    `).all(...ids);
    const result: Record<number, TvRead> = {};
    for (const row of rows) {
      result[asNumber(row.id)] = {
        mediaItemId: asNumber(row.media_item_id),
        kind: tvKind(row.kind),
        seriesTitle: asText(row.series_title),
        seriesRef: asText(row.series_ref),
        seasonNumber: asNumberOrNull(row.season_number),
        episodeNumber: asNumberOrNull(row.episode_number),
      };
    }
    return result;
  },
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] {
    if (mediaItemIds.length === 0) return [];
    const rows = raw.prepare(
      `SELECT id FROM tv_release WHERE media_item_id IN (${holes(mediaItemIds)})`,
    ).all(...mediaItemIds);
    return rows.map((row) => asNumber(row.id));
  },
};

/**
 * A season's own row, reached only through the releases that point at it --
 * `tv_season` carries no `media_item_id` of its own, since many episodes
 * share one season.
 */
const season: SyncedTable<TvSeasonRead> = {
  table: 'tv_season',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, TvSeasonRead> {
    if (ids.length === 0) return {};
    const rows = raw.prepare(
      `SELECT id, series_id, season_number, title FROM tv_season WHERE id IN (${holes(ids)})`,
    ).all(...ids);
    const result: Record<number, TvSeasonRead> = {};
    for (const row of rows) {
      result[asNumber(row.id)] = {
        seriesId: asNumber(row.series_id),
        seasonNumber: asNumberOrNull(row.season_number),
        title: asTextOrNull(row.title),
      };
    }
    return result;
  },
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] {
    if (mediaItemIds.length === 0) return [];
    const rows = raw.prepare(`
      SELECT DISTINCT season_id AS id FROM tv_release
      WHERE media_item_id IN (${holes(mediaItemIds)}) AND season_id IS NOT NULL
    `).all(...mediaItemIds);
    return rows.map((row) => asNumber(row.id));
  },
};

/**
 * A series' own row, reached only through the releases that point at it --
 * every release names one, directly or through a season or episode parent
 * (`checkTv`).
 */
const series: SyncedTable<TvSeriesRead> = {
  table: 'tv_series',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, TvSeriesRead> {
    if (ids.length === 0) return {};
    const rows = raw.prepare(
      `SELECT id, title, provider_ref, first_air_date, overview FROM tv_series WHERE id IN (${holes(ids)})`,
    ).all(...ids);
    const result: Record<number, TvSeriesRead> = {};
    for (const row of rows) {
      result[asNumber(row.id)] = {
        title: asText(row.title),
        providerRef: asText(row.provider_ref),
        firstAirDate: asTextOrNull(row.first_air_date),
        overview: asTextOrNull(row.overview),
      };
    }
    return result;
  },
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] {
    if (mediaItemIds.length === 0) return [];
    const rows = raw.prepare(
      `SELECT DISTINCT series_id AS id FROM tv_release WHERE media_item_id IN (${holes(mediaItemIds)})`,
    ).all(...mediaItemIds);
    return rows.map((row) => asNumber(row.id));
  },
};

export const TV_SYNCED: readonly SyncedTable<unknown>[] = [release, season, series];
