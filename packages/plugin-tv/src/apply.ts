/**
 * One resolved answer, written as television.
 *
 * The shared `media_item` row is the engine's; these three tables are what
 * television has that a film does not -- a series, its seasons, and the
 * numbers that order an episode within them.
 *
 * Every write is an upsert keyed on the unique index behind it, because a job
 * the runner retries after a crash must re-write rather than duplicate a
 * series. `RETURNING id` on each upsert is what makes that possible in one
 * statement: a select-then-insert would race with a second episode of the same
 * season arriving in the next job.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ApplyArgs, DetailValue, Media, MediaParent } from '@pickarr/openmetadata';

/**
 * Which `details` key carries a season number, and which an episode number.
 *
 * Both are unverified guesses. The OpenAPI document specifies `details` keys
 * for `scene` and `movie` only -- nobody has yet seen what an episode's
 * `details` actually carries, because the probe that was meant to settle this
 * needs a credential that is not available yet. `details_json` on
 * `tv_release` holds the whole object regardless, so a key that turns out to
 * be named differently costs a read to correct, not a migration.
 */
const SEASON_NUMBER_KEY = 'seasonNumber';
const EPISODE_NUMBER_KEY = 'episodeNumber';

function readInteger(row: Record<string, SQLOutputValue> | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== 'number') {
    throw new TypeError(`plugin-tv: expected an integer ${column}, got ${String(value)}`);
  }
  return value;
}

/**
 * A detail that should be a whole number, or null.
 *
 * Null rather than a guess: an episode number this plugin invented would order
 * a library wrongly and never say where the number came from.
 */
function wholeNumber(details: Readonly<Record<string, DetailValue>>, key: string): number | null {
  const value = details[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  // The service sends some numbers as strings; a string of digits is still the
  // number it says it is, and anything else is not a number at all.
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function upsertSeries(
  raw: DatabaseSync,
  series: MediaParent,
  overview: string | null,
  now: number,
): number {
  const row = raw.prepare(`
    INSERT INTO tv_series (provider, provider_ref, title, first_air_date, overview, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      title          = excluded.title,
      first_air_date = excluded.first_air_date,
      -- COALESCE, not a replacement: a series learned as an episode's parent
      -- has no overview to offer, and overwriting one we already have with
      -- null would lose it on the next episode.
      overview       = COALESCE(excluded.overview, tv_series.overview),
      updated_at     = excluded.updated_at
    RETURNING id
  `).get(series.provider, series.providerRef, series.title, series.releaseDate, overview, now, now);
  return readInteger(row, 'id');
}

function upsertSeason(
  raw: DatabaseSync,
  seriesId: number,
  season: MediaParent,
  seasonNumber: number | null,
  now: number,
): number {
  const row = raw.prepare(`
    INSERT INTO tv_season (series_id, provider, provider_ref, season_number, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      series_id     = excluded.series_id,
      season_number = COALESCE(excluded.season_number, tv_season.season_number),
      title         = excluded.title,
      updated_at    = excluded.updated_at
    RETURNING id
  `).get(seriesId, season.provider, season.providerRef, seasonNumber, season.title, now, now);
  return readInteger(row, 'id');
}

function upsertRelease(
  raw: DatabaseSync,
  release: {
    mediaItemId: number;
    kind: string;
    seriesId: number;
    seasonId: number | null;
    episodeNumber: number | null;
    details: Readonly<Record<string, DetailValue>>;
    now: number;
  },
): void {
  raw.prepare(`
    INSERT INTO tv_release
      (media_item_id, kind, series_id, season_id, episode_number, details_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (media_item_id) DO UPDATE SET
      kind           = excluded.kind,
      series_id      = excluded.series_id,
      season_id      = excluded.season_id,
      episode_number = excluded.episode_number,
      details_json   = excluded.details_json,
      updated_at     = excluded.updated_at
  `).run(
    release.mediaItemId,
    release.kind,
    release.seriesId,
    release.seasonId,
    release.episodeNumber,
    JSON.stringify(release.details),
    release.now,
    release.now,
  );
}

function parentOfKind(media: Media, kind: 'series' | 'season'): MediaParent | null {
  return media.parents.find((candidate) => candidate.kind === kind) ?? null;
}

/**
 * The three shapes a television feed delivers, and what each one records.
 *
 * A kind that cannot be television throws rather than writing a row: that is
 * either a service bug or a category sent wrongly, and a row for it would bury
 * the evidence in the library.
 */
export async function applyTv(args: ApplyArgs): Promise<void> {
  const { media, mediaItemId, raw, now } = args;

  if (media.kind !== 'episode' && media.kind !== 'season' && media.kind !== 'series') {
    throw new Error(`plugin-tv: a tv lookup answered with kind ${media.kind}`);
  }

  // The series is the answer itself for a full-series pack, and a parent
  // otherwise. `NOT NULL` on `tv_release.series_id` is why this is refused
  // rather than defaulted: every one of the three shapes names a series, and
  // inventing a placeholder would put a row in the library naming nothing.
  const series = media.kind === 'series' ? media : parentOfKind(media, 'series');
  if (series === null) {
    throw new Error(`plugin-tv: ${media.kind} ${media.providerRef} names no series`);
  }
  const seriesOverview = media.kind === 'series' ? media.overview : null;
  const seriesId = upsertSeries(raw, series, seriesOverview, now);

  // The season is the answer itself for a season pack, a parent for an
  // episode, and absent for a series pack -- or for an episode the service
  // gave no season parent for, which is a shape the schema allows.
  const season = media.kind === 'season' ? media : parentOfKind(media, 'season');
  const seasonId = season === null
    ? null
    : upsertSeason(raw, seriesId, season, wholeNumber(media.details, SEASON_NUMBER_KEY), now);

  upsertRelease(raw, {
    mediaItemId,
    kind: media.kind,
    seriesId,
    seasonId,
    episodeNumber: media.kind === 'episode' ? wholeNumber(media.details, EPISODE_NUMBER_KEY) : null,
    details: media.details,
    now,
  });
}
