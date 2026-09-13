import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyTv, checkTv } from './apply.ts';
import { TV_MIGRATIONS } from './migrations.ts';

/** Also the required prefix for every table this plugin declares. */
export const TV_PLUGIN_ID = 'tv';

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
  }, deps);
}

export { applyTv, checkTv } from './apply.ts';
export { TV_MIGRATIONS } from './migrations.ts';
