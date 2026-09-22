import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyXxx, checkXxx } from './apply.ts';
import { XXX_MIGRATIONS } from './migrations.ts';
import { XXX_SYNCED } from './sync.ts';
import { XXX_TOKENS } from './tokens.ts';

/** Also the required prefix for every table this plugin declares. */
export const XXX_PLUGIN_ID = 'xxx';

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
    // A scene is one file; spec 2026-09-22 §4.1.
    expects: async () => ({ kind: 'single' }),
  }, deps);
}

export { applyXxx, checkXxx } from './apply.ts';
export { XXX_MIGRATIONS } from './migrations.ts';
export { XXX_SYNCED } from './sync.ts';
export { XXX_TOKENS } from './tokens.ts';
