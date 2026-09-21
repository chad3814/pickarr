import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyXxx, checkXxx } from './apply.ts';
import { XXX_MIGRATIONS } from './migrations.ts';
import { XXX_SYNCED } from './sync.ts';

/** Also the required prefix for every table this plugin declares. */
export const XXX_PLUGIN_ID = 'xxx';

/**
 * What an xxx library path may name (design spec §3).
 *
 * `site` is this plugin's own, from `xxx_site`. There is no `year`: a scene
 * is dated to the day and `releaseDate` carries that, where a film's library
 * convention wants the year alone. `resolution`, `filename` and `ext` come
 * from `rss_item` and the source path, as they do for every plugin.
 */
export const XXX_TOKENS: readonly string[] = [
  'site', 'title', 'releaseDate', 'resolution', 'filename', 'ext',
];

export function createXxxPlugin(deps: LookupPluginDeps): MediaPlugin {
  return createLookupPlugin({
    id: XXX_PLUGIN_ID,
    mediaType: 'xxx',
    category: 'xxx',
    migrations: XXX_MIGRATIONS,
    check: checkXxx,
    apply: applyXxx,
    synced: XXX_SYNCED,
    tokens: XXX_TOKENS,
  }, deps);
}

export { applyXxx, checkXxx } from './apply.ts';
export { XXX_MIGRATIONS } from './migrations.ts';
export { XXX_SYNCED } from './sync.ts';
