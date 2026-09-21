/**
 * What a film library path may name, and how each name resolves (design
 * spec §3).
 *
 * `collection` is this plugin's own, from `movie_detail`. `year` is offered
 * beside `releaseDate` because the convention every film library already
 * uses is `Title (2024)`, and deriving a year from a date string is not
 * something a shape can express. The rest are resolved by functions shared
 * with every plugin.
 *
 * **There is no `season` and no `episode`.** A film shape naming either is
 * refused `unknown-token` by `PUT /api/destinations/:pluginId`, while the
 * identical `{season}` in a television shape saves -- which is the point of
 * each plugin declaring its own list rather than the host holding one
 * union. Under `PluginTokens` it is also the point of the list being a map:
 * adding `season` here would mean writing a function that resolves a season
 * for a film, which is a thing nobody can write by accident.
 */
import type { PluginTokens, TokenResolver } from '@pickarr/contract';
import {
  mediaItemText,
  resolveExtension,
  resolveFilename,
  resolveReleaseDate,
  resolveResolution,
  resolveTitle,
  resolveYear,
} from '@pickarr/openmetadata';

/**
 * The collection this film belongs to, or `null` -- most films belong to
 * none, which is design spec §8.8's own worked example of a token that
 * resolves to nothing and must leave no empty segment behind.
 */
const resolveCollection: TokenResolver = async (file, ctx) => mediaItemText(
  ctx,
  file,
  'SELECT collection_name FROM movie_detail WHERE media_item_id = ?',
);

export const MOVIE_TOKENS: PluginTokens = {
  title: resolveTitle,
  year: resolveYear,
  releaseDate: resolveReleaseDate,
  collection: resolveCollection,
  resolution: resolveResolution,
  filename: resolveFilename,
  ext: resolveExtension,
};
