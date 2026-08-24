import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename as realRename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../src/db/open.ts';
import type { PluginRegistry } from '../src/plugins/registry.ts';
import type { RekeyDeps } from '../src/pipeline/rekey.ts';
import type { PickarrConfig } from '../src/config/schema.ts';
import {
  buildDownloadClients,
  composeMetadataTick,
  entryFromArgv,
  pluginById,
  resolveArtworkDir,
  runRekeyAtBoot,
} from '../src/main.ts';

const MAIN_TS_PATH = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/**
 * Swaps `process.argv[1]` for the duration of `fn`, restoring the real argv
 * afterwards regardless of outcome — `entryFromArgv` reads it directly
 * (that's the whole point: it is `main.ts`'s view of what Node was actually
 * asked to run), so there is no way to exercise it without touching the
 * real global.
 */
async function withArgv1<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const original = process.argv;
  process.argv = value === undefined ? [original[0] ?? 'node'] : [original[0] ?? 'node', value];
  try {
    return await fn();
  } finally {
    process.argv = original;
  }
}

const PLUGIN_ID = 'scenes-v1';
const PACKAGE_NAME = '@pickarr/plugin-scenes';

const fakePlugin: MediaTypePlugin = {
  id: PLUGIN_ID,
  displayName: 'Scenes',
  parse: () => null,
  score: () => 0,
  planImport: () => null,
};

/**
 * Mirrors the real registry from plugins/registry.ts exactly: `byId` looks up
 * by the plugin's own id, `byPackage` looks up by config package name and
 * throws on anything else — the same "unknown key throws" shape that would
 * make a `byPackage`-wired `pluginFor` fail loudly on every group whose
 * `media_groups.plugin` column holds an id rather than a package name.
 */
function fakeRegistry(): PluginRegistry {
  return {
    byPackage(packageName) {
      if (packageName === PACKAGE_NAME) return fakePlugin;
      throw new Error(`No plugin registered for package ${packageName}`);
    },
    byId: (id) => (id === PLUGIN_ID ? fakePlugin : undefined),
    libraryRoot: () => '/media',
    libraryRootById: () => '/media',
    all: () => [fakePlugin],
  };
}

// `media_groups.plugin` holds `plugin.id` (commit.ts writes `plugin: plugin.id`),
// never the package name — so a group whose row holds a real plugin id must
// reach its plugin through `pluginById`. This is the one test that would have
// caught task 10's documented defect (wiring `pluginFor` to `byPackage`
// instead): see the "break on purpose" note in the task report.
test('pluginById resolves a group by plugin id, not by package name', () => {
  const resolve = pluginById(fakeRegistry());
  assert.equal(resolve(PLUGIN_ID), fakePlugin);
});

test('pluginById returns null for an id no longer configured', () => {
  const resolve = pluginById(fakeRegistry());
  assert.equal(resolve('some-removed-plugin'), null);
});

test('resolveArtworkDir defaults to an artwork/ directory beside the database', () => {
  assert.equal(resolveArtworkDir('/config/pickarr.db', undefined), '/config/artwork');
});

test('resolveArtworkDir keeps an explicitly configured directory', () => {
  assert.equal(resolveArtworkDir('/config/pickarr.db', '/mnt/posters'), '/mnt/posters');
});

// `import.meta.url` is already realpathed by the ESM loader; `argv[1]` is
// not. A naive string comparison of the two would say "not the entry point"
// for `node /some/link/main.js` where the link points at this file — the
// worst failure mode here, since the process still boots and exits cleanly
// having started nothing. This is the case that actually matters.
test('entryFromArgv is true when argv[1] reaches this module through a symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-entrypoint-'));
  try {
    const link = join(dir, 'main.ts');
    await symlink(MAIN_TS_PATH, link);
    await withArgv1(link, () => {
      assert.equal(entryFromArgv(), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('entryFromArgv is true when argv[1] is this module directly', async () => {
  await withArgv1(MAIN_TS_PATH, () => {
    assert.equal(entryFromArgv(), true);
  });
});

test('entryFromArgv is false for a real file that is not this module', async () => {
  await withArgv1(fileURLToPath(import.meta.url), () => {
    assert.equal(entryFromArgv(), false);
  });
});

test('entryFromArgv is false, not throwing, when argv[1] does not exist', async () => {
  await withArgv1('/no/such/path/main.js', () => {
    assert.equal(entryFromArgv(), false);
  });
});

test('entryFromArgv is false when argv[1] is absent', async () => {
  await withArgv1(undefined, () => {
    assert.equal(entryFromArgv(), false);
  });
});

// A performer search is the fallback for a scene lookup that settled without
// a cast, so the pass that produces those rows has to run before the pass
// that drains them. Asserting the *sequence* — not just that both ran — is
// what pins that, without needing `main()`'s config/db/fetch/scheduler
// machinery: `composeMetadataTick` is a pure function of its two arguments.
test('composeMetadataTick runs the scene pass and then the performer pass, in order', async () => {
  const calls: string[] = [];
  const runScenes = async (): Promise<void> => {
    calls.push('scenes');
  };
  const runPerformers = async (): Promise<void> => {
    calls.push('performers');
  };

  const tick = composeMetadataTick(runScenes, runPerformers);
  await tick();

  assert.deepEqual(calls, ['scenes', 'performers']);
});

test('composeMetadataTick awaits the scene pass before starting the performer pass', async () => {
  const calls: string[] = [];
  const runScenes = async (): Promise<void> => {
    // A microtask delay: if the composed tick did not await this before
    // calling `runPerformers`, `performers` would be recorded first.
    await Promise.resolve();
    calls.push('scenes');
  };
  const runPerformers = async (): Promise<void> => {
    calls.push('performers');
  };

  const tick = composeMetadataTick(runScenes, runPerformers);
  await tick();

  assert.deepEqual(calls, ['scenes', 'performers']);
});

// ---------------------------------------------------------------------------
// Task 6: runRekeyAtBoot — the startup wiring around runRekeyOnBoot. This is
// the "startup test" the task report's Step 5 break-on-purpose refers to:
// remove the try/catch inside runRekeyAtBoot and the second test below is
// the one that fails, because nothing left upstream would catch the throw
// this fake registry produces.
// ---------------------------------------------------------------------------

const REAL_DEPS: RekeyDeps = {
  now: () => Date.now(),
  rename: realRename,
  commit: (handle) => handle.exec('COMMIT'),
};

test('runRekeyAtBoot: an empty database logs a report line and resolves without throwing', async () => {
  const db = openTestDatabase();
  const messages: string[] = [];
  await runRekeyAtBoot(db, fakeRegistry(), REAL_DEPS, (message) => messages.push(message));
  assert.equal(messages.length, 1);
  assert.ok(messages[0]?.includes('rekey:'));
});

test('runRekeyAtBoot: a pass that throws outright is logged and does not stop startup', async () => {
  const db = openTestDatabase();
  // `planRekey` calls `registry.all()` before anything else, outside any
  // try/catch of its own — the cleanest way to force a genuine, uncaught
  // throw out of the whole `runRekeyOnBoot` call, standing in for whatever a
  // real parser regression could do that `applyRekey`'s own per-group
  // try/catch does not already convert into a counted `failed`.
  const explodingRegistry: PluginRegistry = {
    byPackage: () => {
      throw new Error('unused in this test');
    },
    byId: () => undefined,
    libraryRoot: () => '/media',
    libraryRootById: () => '/media',
    all: () => {
      throw new Error('registry exploded');
    },
  };

  const messages: string[] = [];
  // If runRekeyAtBoot's try/catch is removed, this `await` rejects and the
  // test fails — which is exactly the break-on-purpose evidence Step 5 asks
  // for. With the try/catch in place, it resolves, and the thrown message is
  // what ends up logged instead of taking the process down.
  await runRekeyAtBoot(db, explodingRegistry, REAL_DEPS, (message) => messages.push(message));

  assert.equal(messages.length, 1);
  assert.ok(messages[0]?.includes('registry exploded'), 'the caught error must be visible in the boot log');
});

// ---------------------------------------------------------------------------
// Task 9: buildDownloadClients — the switch that turns each downloadClients
// entry into a real client. Neither test below could have existed before
// this task's extraction: the loop previously ran inline inside `main()`,
// with no exported seam onto the clients it built, so there was nothing here
// to call. This is not a case of a test discriminating a pre-existing bug
// from a fix; it is new coverage for code that was already correct once
// Task 6 wired in `createQbittorrentClient` for real.
// ---------------------------------------------------------------------------

function fixtureConfig(): PickarrConfig {
  return {
    server: { port: 8080 },
    database: { path: '/tmp/pickarr-test.db' },
    trashDir: '/tmp/pickarr-test-trash',
    plugins: {},
    downloadClients: [
      {
        id: 'sab-1',
        type: 'sabnzbd',
        url: 'http://localhost:8090',
        apiKey: 'a'.repeat(32),
        category: 'pickarr',
        importMode: 'move',
        pathMappings: [],
      },
      {
        id: 'qbit-1',
        type: 'qbittorrent',
        url: 'http://localhost:8091',
        apiKey: `qbt_${'A'.repeat(28)}`,
        category: 'pickarr',
        importMode: 'move',
        pathMappings: [],
      },
    ],
    feeds: [
      { id: 'feed-1', url: 'http://example.com/feed', plugin: 'scenes-v1', intervalSeconds: 900 },
    ],
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5 },
  };
}

test('buildDownloadClients builds one client per configured entry, keyed by id', () => {
  const clients = buildDownloadClients(fixtureConfig());

  assert.equal(clients.size, 2);
  assert.ok(clients.has('sab-1'));
  assert.ok(clients.has('qbit-1'));
});

// The one assertion that actually proves the switch dispatched on
// `clientConfig.type` rather than defaulting every entry to SABnzbd:
// `DownloadClient.remove` is optional, sabnzbd.ts implements it and
// qbittorrent.ts deliberately does not (see `DownloadClient.remove`'s own
// doc comment for why). A constructor-identity check would pass even if
// both branches called `createSabnzbdClient`; this would not.
test('buildDownloadClients: the qBittorrent client has no remove, the SABnzbd one does', () => {
  const clients = buildDownloadClients(fixtureConfig());

  const sabnzbdClient = clients.get('sab-1');
  const qbittorrentClient = clients.get('qbit-1');

  assert.notEqual(sabnzbdClient?.remove, undefined);
  assert.equal(qbittorrentClient?.remove, undefined);
});
