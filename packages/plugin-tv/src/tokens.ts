/**
 * What a television library path may name, and how each name resolves
 * (design spec §3).
 *
 * `series`, `season` and `episode` are this plugin's own -- they come from
 * `tv_series`, `tv_season` and `tv_release`, which no other plugin has.
 * `title`, `releaseDate`, `filename` and `ext` are resolved by functions
 * shared with every plugin, because they come from `media_item` and the
 * source path rather than from any plugin's tables. There is no
 * `resolution`, which design spec §3 lists and issue #98 removes: the
 * column of that name is the lookup state, not a video resolution, and 2.0
 * records no video resolution anywhere.
 *
 * **Every key is written out here**, shared resolvers included, rather than
 * spread in from a constant: `MediaPlugin.tokens` promises that one object
 * is the whole answer to "what may a television shape say", and a spread
 * would put part of the answer somewhere a reader has to go and find. The
 * *functions* are shared; the list is not.
 */
import type { TokenResolver, TokensFor, TvTokenName } from '@pickarr/contract';
import {
  mediaItemInteger,
  mediaItemText,
  paddedNumber,
  resolveExtension,
  resolveFilename,
  resolveReleaseDate,
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
 * The season number, zero-padded to two digits -- design spec §8.2, applied
 * here because this is the only place in the chain that knows the value is
 * a number. See `paddedNumber`.
 *
 * `null` for a series pack, and for an episode whose service gave no season
 * parent: `tv_release.season_id` is nullable and `tv_season.season_number`
 * is too, so both are real. `resolveShape` drops the segment rather than
 * writing a hole (§8.8).
 */
const resolveSeason: TokenResolver = async (file, ctx) => paddedNumber(mediaItemInteger(
  ctx,
  file,
  `SELECT n.season_number FROM tv_release r JOIN tv_season n ON n.id = r.season_id
    WHERE r.media_item_id = ?`,
));

/** The episode number, padded the same way. `null` for a season or series pack. */
const resolveEpisode: TokenResolver = async (file, ctx) => paddedNumber(mediaItemInteger(
  ctx,
  file,
  'SELECT episode_number FROM tv_release WHERE media_item_id = ?',
));

export const TV_TOKENS: TokensFor<TvTokenName> = {
  series: resolveSeries,
  season: resolveSeason,
  episode: resolveEpisode,
  title: resolveTitle,
  releaseDate: resolveReleaseDate,
  filename: resolveFilename,
  ext: resolveExtension,
};
