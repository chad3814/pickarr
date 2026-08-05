import type { MediaTypePlugin, PluginFactory } from '@pickarr/plugin-api';
import { parseSceneRelease } from './parse.ts';
import { scoreScene } from './score.ts';
import { planSceneImport } from './plan-import.ts';

const createScenesPlugin: PluginFactory = (): MediaTypePlugin => ({
  id: 'scenes',
  displayName: 'Adult Scenes',
  parse: parseSceneRelease,
  score: scoreScene,
  planImport: planSceneImport,
});

export default createScenesPlugin;
export { parseSceneRelease, scoreScene, planSceneImport };
