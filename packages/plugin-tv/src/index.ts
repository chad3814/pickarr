import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyTv, checkTv, dropTvRows } from './apply.ts';
import { expectsTv } from './expects.ts';
import { TV_MIGRATIONS } from './migrations.ts';
import { TV_SYNCED } from './sync.ts';
import { TV_TOKENS } from './tokens.ts';

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
    dropRows: dropTvRows,
    apply: applyTv,
    synced: TV_SYNCED,
    tokens: TV_TOKENS,
    expects: expectsTv,
  }, deps);
}

export { applyTv, checkTv, dropTvRows } from './apply.ts';
export { expectsTv } from './expects.ts';
export { TV_MIGRATIONS } from './migrations.ts';
export { TV_SYNCED } from './sync.ts';
export { TV_TOKENS } from './tokens.ts';
