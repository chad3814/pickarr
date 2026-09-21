import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyTv, checkTv } from './apply.ts';
import { TV_MIGRATIONS } from './migrations.ts';
import { TV_SYNCED } from './sync.ts';

/** Also the required prefix for every table this plugin declares. */
export const TV_PLUGIN_ID = 'tv';

/**
 * What a television library path may name (design spec §3).
 *
 * `series`, `season` and `episode` are this plugin's own -- they come from
 * `tv_series`, `tv_season` and `tv_release`, which no other plugin has.
 * `resolution`, `filename` and `ext` are shared with every plugin because
 * they come from `rss_item` and the source path; they are repeated in each
 * plugin's list rather than concatenated from a shared constant, so this one
 * array is the whole answer to "what may a television shape say".
 */
export const TV_TOKENS: readonly string[] = [
  'series', 'season', 'episode', 'title', 'releaseDate', 'resolution', 'filename', 'ext',
];

/**
 * The television plugin: the shared lookup flow, plus what a resolved answer
 * means for television.
 *
 * `category` is `tv`, which happens to equal the id here -- it does not for
 * the film plugin, whose wire category is `movies`.
 */
export function createTvPlugin(deps: LookupPluginDeps): MediaPlugin {
  return createLookupPlugin({
    id: TV_PLUGIN_ID,
    mediaType: 'tv',
    category: 'tv',
    migrations: TV_MIGRATIONS,
    check: checkTv,
    apply: applyTv,
    synced: TV_SYNCED,
    tokens: TV_TOKENS,
  }, deps);
}

export { applyTv, checkTv } from './apply.ts';
export { TV_MIGRATIONS } from './migrations.ts';
export { TV_SYNCED } from './sync.ts';
