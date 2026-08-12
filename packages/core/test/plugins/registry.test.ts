import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaTypePlugin, PluginFactory } from '@pickarr/plugin-api';
import { loadPlugins, type PluginModule } from '../../src/plugins/registry.ts';
import type { PickarrConfig } from '../../src/config/schema.ts';

function fakePlugin(id: string): MediaTypePlugin {
  return {
    id,
    displayName: id,
    parse: () => null,
    score: () => 0,
    planImport: () => null,
  };
}

function fakeModule(id: string): PluginModule {
  const factory: PluginFactory = () => fakePlugin(id);
  return { default: factory };
}

function configWith(plugins: Record<string, Record<string, string>>): PickarrConfig {
  return {
    server: { port: 8080 },
    database: { path: ':memory:' },
    trashDir: '/trash',
    plugins,
    downloadClients: [],
    feeds: [],
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5 },
  } as PickarrConfig;
}

test('loads a plugin and indexes it by package name and id', async () => {
  const config = configWith({ 'pkg-a': { libraryRoot: '/media/a' } });
  const registry = await loadPlugins(config, async () => fakeModule('alpha'));

  assert.equal(registry.byPackage('pkg-a').id, 'alpha');
  assert.equal(registry.byId('alpha')?.id, 'alpha');
  assert.equal(registry.libraryRoot('pkg-a'), '/media/a');
  assert.equal(registry.all().length, 1);
});

test('two packages claiming the same id is fatal', async () => {
  const config = configWith({
    'pkg-a': { libraryRoot: '/media/a' },
    'pkg-b': { libraryRoot: '/media/b' },
  });
  await assert.rejects(
    loadPlugins(config, async () => fakeModule('same')),
    /pkg-a.*pkg-b|pkg-b.*pkg-a/,
  );
});

test('a plugin config without a libraryRoot is fatal', async () => {
  const config = configWith({ 'pkg-a': {} });
  await assert.rejects(loadPlugins(config, async () => fakeModule('alpha')), /libraryRoot/);
});

test('a module without a default export is fatal and names the package', async () => {
  const config = configWith({ 'pkg-a': { libraryRoot: '/media/a' } });
  await assert.rejects(
    loadPlugins(config, async () => ({}) as PluginModule),
    /pkg-a/,
  );
});

test('an import failure is fatal and names the package', async () => {
  const config = configWith({ 'pkg-missing': { libraryRoot: '/media/a' } });
  await assert.rejects(
    loadPlugins(config, async () => {
      throw new Error('not installed');
    }),
    /pkg-missing/,
  );
});

test('byPackage throws for an unregistered package', async () => {
  const config = configWith({ 'pkg-a': { libraryRoot: '/media/a' } });
  const registry = await loadPlugins(config, async () => fakeModule('alpha'));
  assert.throws(() => registry.byPackage('pkg-nope'), /pkg-nope/);
});
