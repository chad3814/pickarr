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
      -- title is replaced outright, and it is the only one of the three that
      -- can be: MediaParent.title is non-nullable in the document, so there
      -- is no null for a later answer to overwrite a good value with.
      title          = excluded.title,
      -- COALESCE for the two nullable columns, not a replacement. A series
      -- learned as an episode's parent offers no overview at all, and
      -- MediaParent.releaseDate is nullable too -- so an episode whose season
      -- pack already taught us the series' first air date would erase it, and
      -- the next episode would erase it again.
      first_air_date = COALESCE(excluded.first_air_date, tv_series.first_air_date),
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
 * Whether television can represent this answer at all: the engine's
 * pre-flight, run at the top of the resolved branch and before a single
 * shared row exists.
 *
 * Both refusals below were once made inside `applyTv` alone, which the engine
 * calls *after* it has created the `media_item`, claimed the provider
 * reference on it and relinked the rss item to it. A throw there stranded all
 * three: a media item holding a claim nothing would ever drop, an rss item
 * pointing at it, and a resolution left `pending` forever while the job
 * dead-lettered. Refused here instead, an answer this plugin cannot write
 * costs nothing at all.
 *
 * Cheap enough to belong this early because it reads `media.kind` and
 * `media.parents` and nothing else -- no database, no service, so it has no
 * failure of its own to contribute.
 */
export function checkTv(media: Media): void {
  if (media.kind !== 'episode' && media.kind !== 'season' && media.kind !== 'series') {
    throw new Error(`plugin-tv: a tv lookup answered with kind ${media.kind}`);
  }
  // `tv_release.series_id` is `NOT NULL` and every one of the three shapes
  // names a series -- as itself, for a full-series pack, or through
  // `parents`. An answer that does neither is not something this schema can
  // record, and inventing a placeholder series would put a row in the library
  // that names nothing.
  if (media.kind !== 'series' && parentOfKind(media, 'series') === null) {
    throw new Error(`plugin-tv: ${media.kind} ${media.providerRef} names no series`);
  }
}

/**
 * The three shapes a television feed delivers, and what each one records.
 *
 * Both of `checkTv`'s refusals are repeated below. Kept rather than deleted
 * for two reasons: the kind guard is what narrows `media.kind` to the three
 * values `tv_release.kind` may hold and the branches below read, so the
 * compiler needs it here whatever the engine already asked; and `apply` is
 * exported on its own and driven directly by this package's tests, so a
 * caller that never ran the pre-flight still cannot write a row for an answer
 * that is not television. The pre-flight is where the refusal *matters* --
 * it is the one that happens before the shared rows exist -- and this is the
 * one that cannot be removed.
 */
export async function applyTv(args: ApplyArgs): Promise<void> {
  const { media, mediaItemId, raw, now } = args;

  if (media.kind !== 'episode' && media.kind !== 'season' && media.kind !== 'series') {
    throw new Error(`plugin-tv: a tv lookup answered with kind ${media.kind}`);
  }

  // The series is the answer itself for a full-series pack, and a parent
  // otherwise. See `checkTv` for why a missing one is refused rather than
  // defaulted.
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
