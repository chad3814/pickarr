import type { MediaTypePlugin, PluginConfig, PluginFactory } from '@pickarr/plugin-api';
import {
  lastRefusalReason,
  parseSceneRelease,
  sceneSiteCandidates,
  type SceneParseOptions,
} from './parse.ts';
import { scoreScene } from './score.ts';
import { planSceneImport } from './plan-import.ts';
import { DEFAULT_PATH_TEMPLATE } from './path-template.ts';

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
  // Reassigned rather than mutated so that the options object handed to
  // `parse` is never aliased by a caller that could change it underneath us.
  let options: SceneParseOptions = { sites: readSites(config) };

  const configured = config['pathTemplate'];
  if (configured !== undefined && typeof configured !== 'string') {
    throw new Error('The scenes plugin\'s "pathTemplate" config must be a string');
  }
  const pathTemplate = configured ?? DEFAULT_PATH_TEMPLATE;

  return {
    id: 'scenes',
    displayName: 'Adult Scenes',
    parse: (releaseName: string) => parseSceneRelease(releaseName, options),
    score: scoreScene,
    planImport: (media, files) => planSceneImport(media, files, { pathTemplate }),
    siteCandidates: (releaseName: string) => sceneSiteCandidates(releaseName, options),
    refusalReason: () => lastRefusalReason(),
    learnSites(sites: readonly string[]) {
      const known = new Set(options.sites ?? []);
      const merged = [...(options.sites ?? [])];
      for (const site of sites) {
        if (site.length > 0 && !known.has(site)) {
          known.add(site);
          merged.push(site);
        }
      }
      options = { sites: merged };
    },
  };
};

export default createScenesPlugin;
export { lastRefusalReason, parseSceneRelease, sceneSiteCandidates, scoreScene, planSceneImport };
