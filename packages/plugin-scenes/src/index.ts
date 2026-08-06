import type { MediaTypePlugin, PluginConfig, PluginFactory } from '@pickarr/plugin-api';
import { parseSceneRelease, type SceneParseOptions } from './parse.ts';
import { scoreScene } from './score.ts';
import { planSceneImport } from './plan-import.ts';

/**
 * Reads the optional `sites` list out of plugin config.
 *
 * A misconfigured value is rejected loudly rather than ignored: silently
 * dropping the list would file every date-at-end scene under a truncated site
 * name, which is a wrong library path that nothing surfaces as an error.
 */
function readSites(config: PluginConfig): readonly string[] {
  const sites = config['sites'];
  if (sites === undefined) return [];
  if (!Array.isArray(sites) || sites.some((site) => typeof site !== 'string')) {
    throw new Error('The scenes plugin\'s "sites" config must be a list of strings');
  }
  return sites;
}

const createScenesPlugin: PluginFactory = (config: PluginConfig): MediaTypePlugin => {
  const options: SceneParseOptions = { sites: readSites(config) };

  return {
    id: 'scenes',
    displayName: 'Adult Scenes',
    parse: (releaseName: string) => parseSceneRelease(releaseName, options),
    score: scoreScene,
    planImport: planSceneImport,
  };
};

export default createScenesPlugin;
export { parseSceneRelease, scoreScene, planSceneImport };
