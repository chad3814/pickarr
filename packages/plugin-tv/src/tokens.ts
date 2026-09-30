/**
 * What a television library path may name, and how each name resolves
 * (design spec §3).
 *
 * `series`, `season` and `episode` are this plugin's own -- they come from
 * `tv_series`, `tv_season` and `tv_release`, which no other plugin has.
 * `title`, `releaseDate`, `resolution`, `filename` and `ext` are resolved by
 * functions shared with every plugin: the first two and the last two come
 * from `media_item` and the source path, and `resolution` from
 * `rss_item.video_resolution`, the lookup service's own parse (issue #98).
 *
 * **Every key is written out here**, shared resolvers included, rather than
 * spread in from a constant: `MediaPlugin.tokens` promises that one object
 * is the whole answer to "what may a television shape say", and a spread
 * would put part of the answer somewhere a reader has to go and find. The
 * *functions* are shared; the list is not.
 */
import type { DownloadedFile, TokenResolver, TokensFor, TvTokenName } from '@pickarr/contract';
import {
  episodeMarker,
  mediaItemInteger,
  mediaItemText,
  paddedNumber,
  resolveExtension,
  resolveFilename,
  resolveReleaseDate,
  resolveResolution,
  resolveTitle,
} from '@pickarr/openmetadata';

/**
 * The series title, through the release row rather than from `media_item`.
 *
 * `media_item.title` for an episode is the *episode's* title, which is what
 * `{title}` gives. `{series}` has to reach the `tv_series` row the release
 * points at, or every episode of a show would land in a directory named
 * after itself.
 */
const resolveSeries: TokenResolver = async (file, ctx) => mediaItemText(
  ctx,
  file,
  `SELECT s.title FROM tv_release r JOIN tv_series s ON s.id = r.series_id
    WHERE r.media_item_id = ?`,
);

/**
 * The `S..E..` marker in the last segment of `file.path`, or `null`.
 *
 * During an import the engine calls every resolver once per placed entry,
 * with `file.path` set to *that entry's* path rather than the download's --
 * so for a pack this is the one file being copied, and its marker is the
 * only place that file's own episode is written down. Both separators, as
 * `resolveFilename` splits, because the path is the host's.
 */
function markerOf(file: DownloadedFile): ReturnType<typeof episodeMarker> {
  const segments = file.path.split(/[/\\]/);
  return episodeMarker(segments[segments.length - 1] ?? '');
}

/**
 * The season number, zero-padded to two digits -- design spec §8.2, applied
 * here because this is the only place in the chain that knows the value is
 * a number. See `paddedNumber`.
 *
 * The database first: an episode's own season, or a season pack's. When it
 * has none -- a series pack, whose release has no season parent, or an
 * episode whose service gave none (`tv_release.season_id` and
 * `tv_season.season_number` are both nullable) -- the season comes from the
 * marker in the entry's filename (see `markerOf`), so each file of a series
 * pack lands in its own season. `null` when neither says, and
 * `resolveShape` drops the segment rather than writing a hole (§8.8).
 */
const resolveSeason: TokenResolver = async (file, ctx) => paddedNumber(mediaItemInteger(
  ctx,
  file,
  `SELECT n.season_number FROM tv_release r JOIN tv_season n ON n.id = r.season_id
    WHERE r.media_item_id = ?`,
) ?? markerOf(file)?.season ?? null);

/**
 * The episode number, padded the same way.
 *
 * The database first: an episode's own `episode_number`. A season or series
 * pack has none -- one media item stands for every file in it -- so the
 * episode comes from the marker in the entry's filename (see `markerOf`);
 * without that fallback every entry of a pack resolved to one destination,
 * the first was placed misnamed and the rest refused `destination-exists`.
 * A multi-episode file names its first episode, then `-E` and each further
 * one, so `S01E01E02.mkv` gives `01-E02` and the canonical
 * `S{season}E{episode}` shape reads `S01E01-E02`. `null` when neither says.
 */
const resolveEpisode: TokenResolver = async (file, ctx) => {
  const stored = mediaItemInteger(ctx, file, 'SELECT episode_number FROM tv_release WHERE media_item_id = ?');
  if (stored !== null) return paddedNumber(stored);
  const marker = markerOf(file);
  if (marker === null) return null;
  return marker.episodes.map((episode) => paddedNumber(episode)).join('-E');
};

export const TV_TOKENS: TokensFor<TvTokenName> = {
  series: resolveSeries,
  season: resolveSeason,
  episode: resolveEpisode,
  title: resolveTitle,
  releaseDate: resolveReleaseDate,
  resolution: resolveResolution,
  filename: resolveFilename,
  ext: resolveExtension,
};
