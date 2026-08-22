import type { MediaTypePlugin, PluginConfig, PluginFactory } from '@pickarr/plugin-api';
import {
  buildRelease,
  lastRefusalReason,
  parseSceneRelease,
  sceneSiteCandidates,
  slug,
  type SceneParseOptions,
} from './parse.ts';
import {
  sceneFromManualValues,
  sceneManualFields,
  sceneSuggestManualValues,
  sceneToManualValues,
} from './manual.ts';
import { scoreScene } from './score.ts';
import { planSceneImport } from './plan-import.ts';
import { DEFAULT_PATH_TEMPLATE } from './path-template.ts';
import { confirmSceneMetadata, sceneMetadataQuery } from './metadata.ts';
import { scenePerformerQuery } from './performer-query.ts';

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
    metadataQuery: (group) => sceneMetadataQuery(group),
    performerQuery: (group) => scenePerformerQuery(group),
    confirmMetadata: (candidates, query) => confirmSceneMetadata(candidates, query),
    refusalReason: () => lastRefusalReason(),
    manualFields: () => sceneManualFields(),
    // `options` is reassigned by `learnSites`, so each hook reads it when it
    // runs rather than closing over the value it had at construction — a site
    // discovered since startup has to reach a hand-entered release too, or the
    // manual form keys it under a spelling the parser has stopped using.
    // `toManualValues` needs the list for the opposite reason: it checks the
    // site it is about to prefill against the key it came from, and that check
    // is only meaningful against the list as it stands at Edit time.
    fromManualValues: (values) => sceneFromManualValues(values, options),
    toManualValues: (media) => sceneToManualValues(media, options),
    suggestManualValues: (releaseName) => sceneSuggestManualValues(releaseName, options),
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
    // Reads `options` at call time for the same reason every hook above does:
    // `learnSites` reassigns it, and a list captured at construction would
    // report only what configuration supplied — which is precisely the half
    // of the answer that never changes.
    siteInputs: () => [...(options.sites ?? [])],
  };
};

export default createScenesPlugin;
export {
  buildRelease,
  lastRefusalReason,
  parseSceneRelease,
  sceneFromManualValues,
  sceneManualFields,
  sceneSiteCandidates,
  sceneSuggestManualValues,
  sceneToManualValues,
  scoreScene,
  planSceneImport,
  slug,
};
