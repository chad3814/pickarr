import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyMovie, checkMovie } from './apply.ts';
import { MOVIE_MIGRATIONS } from './migrations.ts';
import { MOVIE_SYNCED } from './sync.ts';

/** Also the required prefix for every table this plugin declares. */
export const MOVIE_PLUGIN_ID = 'movie';

/**
 * What a film library path may name (design spec §3).
 *
 * `year` and `collection` are this plugin's own; `year` is offered beside
 * `releaseDate` because the convention every film library already uses is
 * `Title (2024)`, and deriving it from a date string in a shape is not
 * something a shape can express. `resolution`, `filename` and `ext` come
 * from `rss_item` and the source path, as they do for every plugin.
 *
 * There is no `season` and no `episode`. A film shape naming either is
 * refused `unknown-token` by `PUT /api/destinations/:pluginId`, while the
 * identical `{season}` in a television shape saves -- which is the point of
 * each plugin declaring its own list rather than the host holding one
 * union. `host/test/media/destinations.test.ts` drives exactly that pair,
 * because a test using only a nonsense token like `{seasn}` cannot tell a
 * per-plugin validator from a union one.
 */
export const MOVIE_TOKENS: readonly string[] = [
  'title', 'year', 'releaseDate', 'collection', 'resolution', 'filename', 'ext',
];

/**
 * The film plugin.
 *
 * `id` and `mediaType` are `movie`, singular, because that is the contract's
 * `MediaType`; `category` is `movies`, plural, because that is the wire
 * vocabulary. The two meet here and nowhere else.
 */
export function createMoviePlugin(deps: LookupPluginDeps): MediaPlugin {
  return createLookupPlugin({
    id: MOVIE_PLUGIN_ID,
    mediaType: 'movie',
    category: 'movies',
    migrations: MOVIE_MIGRATIONS,
    check: checkMovie,
    apply: applyMovie,
    synced: MOVIE_SYNCED,
    tokens: MOVIE_TOKENS,
  }, deps);
}

export { applyMovie, checkMovie } from './apply.ts';
export { MOVIE_MIGRATIONS } from './migrations.ts';
export { MOVIE_SYNCED } from './sync.ts';
