import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyMovie, checkMovie } from './apply.ts';
import { MOVIE_MIGRATIONS } from './migrations.ts';
import { MOVIE_SYNCED } from './sync.ts';
import { MOVIE_TOKENS } from './tokens.ts';

/** Also the required prefix for every table this plugin declares. */
export const MOVIE_PLUGIN_ID = 'movie';

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
export { MOVIE_TOKENS } from './tokens.ts';
