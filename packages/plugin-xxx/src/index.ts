import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyXxx } from './apply.ts';
import { XXX_MIGRATIONS } from './migrations.ts';

/** Also the required prefix for every table this plugin declares. */
export const XXX_PLUGIN_ID = 'xxx';

export function createXxxPlugin(deps: LookupPluginDeps): MediaPlugin {
  return createLookupPlugin({
    id: XXX_PLUGIN_ID,
    mediaType: 'xxx',
    category: 'xxx',
    migrations: XXX_MIGRATIONS,
    apply: applyXxx,
  }, deps);
}

export { applyXxx } from './apply.ts';
export { XXX_MIGRATIONS } from './migrations.ts';
