import type { MediaTypePlugin, PluginConfig, PluginFactory } from '@pickarr/plugin-api';
import type { PickarrConfig } from '../config/schema.ts';

export interface PluginModule {
  default?: PluginFactory;
}

export type PluginImporter = (packageName: string) => Promise<PluginModule>;

export interface PluginRegistry {
  byPackage(packageName: string): MediaTypePlugin;
  byId(id: string): MediaTypePlugin | undefined;
  libraryRoot(packageName: string): string;
  all(): MediaTypePlugin[];
}

const defaultImporter: PluginImporter = (packageName) =>
  import(packageName) as Promise<PluginModule>;

/**
 * Two identifiers are in play. Config keys and feeds[].plugin use the *package
 * name*, because that is what import() needs. Stored rows use the plugin's
 * *id*, because that survives a package rename and identity must not break if
 * a package is republished under a different name.
 */
export async function loadPlugins(
  config: PickarrConfig,
  importer: PluginImporter = defaultImporter,
): Promise<PluginRegistry> {
  const byPackage = new Map<string, MediaTypePlugin>();
  const byId = new Map<string, MediaTypePlugin>();
  const roots = new Map<string, string>();
  const idToPackage = new Map<string, string>();

  for (const [packageName, pluginConfig] of Object.entries(config.plugins)) {
    const libraryRoot = pluginConfig['libraryRoot'];
    if (typeof libraryRoot !== 'string' || libraryRoot.length === 0) {
      throw new Error(`Plugin ${packageName} is missing a libraryRoot in its config`);
    }

    let module: PluginModule;
    try {
      module = await importer(packageName);
    } catch (error) {
      throw new Error(`Could not import plugin ${packageName}: ${(error as Error).message}`);
    }

    const factory = module.default;
    if (typeof factory !== 'function') {
      throw new Error(`Plugin ${packageName} does not default-export a factory function`);
    }

    const plugin = factory(pluginConfig as PluginConfig);

    const existingPackage = idToPackage.get(plugin.id);
    if (existingPackage !== undefined) {
      throw new Error(
        `Plugins ${existingPackage} and ${packageName} both claim the id "${plugin.id}"; ids must be unique across packages`,
      );
    }

    byPackage.set(packageName, plugin);
    byId.set(plugin.id, plugin);
    roots.set(packageName, libraryRoot);
    idToPackage.set(plugin.id, packageName);
  }

  return {
    byPackage(packageName) {
      const plugin = byPackage.get(packageName);
      if (plugin === undefined) throw new Error(`No plugin registered for package ${packageName}`);
      return plugin;
    },
    byId: (id) => byId.get(id),
    libraryRoot(packageName) {
      const root = roots.get(packageName);
      if (root === undefined) throw new Error(`No library root for package ${packageName}`);
      return root;
    },
    all: () => [...byPackage.values()],
  };
}
