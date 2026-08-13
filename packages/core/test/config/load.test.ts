import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig, resolveSecrets } from '../../src/config/load.ts';
import type { JsonValue } from '../../src/json.ts';

const VALID = {
  server: { port: 8080 },
  database: { path: '/config/pickarr.db' },
  trashDir: '/data/trash',
  plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes' } },
  downloadClients: [
    {
      id: 'sab',
      type: 'sabnzbd',
      url: 'http://sabnzbd:8080',
      apiKey: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
    },
  ],
  feeds: [
    {
      id: 'feed1',
      url: 'https://example.invalid/rss',
      plugin: '@pickarr/plugin-scenes',
      intervalSeconds: 900,
    },
  ],
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-config-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loads a valid config', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(VALID));
    const config = await loadConfig(path);
    assert.equal(config.server.port, 8080);
    assert.equal(config.downloadClients[0]?.apiKey, '0f1e2d3c4b5a69788796a5b4c3d2e1f0');
    assert.equal(config.feeds[0]?.intervalSeconds, 900);
  });
});

test('resolves a file: secret and trims its trailing newline', async () => {
  await withTempDir(async (dir) => {
    const secretPath = join(dir, 'sab_key');
    await writeFile(secretPath, 'super-secret-value\n');
    const path = join(dir, 'config.json');
    const withSecret = structuredClone(VALID);
    withSecret.downloadClients[0]!.apiKey = `file:${secretPath}`;
    await writeFile(path, JSON.stringify(withSecret));

    const config = await loadConfig(path);
    assert.equal(config.downloadClients[0]?.apiKey, 'super-secret-value');
  });
});

test('a missing secret file is fatal and names the path but not the contents', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    const withSecret = structuredClone(VALID);
    withSecret.downloadClients[0]!.apiKey = `file:${join(dir, 'absent')}`;
    await writeFile(path, JSON.stringify(withSecret));

    await assert.rejects(loadConfig(path), (error: Error) => {
      assert.match(error.message, /absent/);
      return true;
    });
  });
});

test('a literal api key below the minimum length is rejected', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    const broken = structuredClone(VALID);
    broken.downloadClients[0]!.apiKey = 'sh0rtky';
    await writeFile(path, JSON.stringify(broken));

    await assert.rejects(loadConfig(path), (error: Error) => {
      assert.match(error.message, /apiKey/);
      assert.match(error.message, /16/);
      return true;
    });
  });
});

// The schema sees `file:/path/to/secret`, not the secret, so the schema's
// length rule cannot bind the value the client will actually be handed. This
// pins the check that does.
test('a file: secret resolving to a short key is rejected without printing it', async () => {
  await withTempDir(async (dir) => {
    const secretPath = join(dir, 'sab_key');
    await writeFile(secretPath, 'tinykey\n');
    const path = join(dir, 'config.json');
    const withSecret = structuredClone(VALID);
    withSecret.downloadClients[0]!.apiKey = `file:${secretPath}`;
    await writeFile(path, JSON.stringify(withSecret));

    await assert.rejects(loadConfig(path), (error: Error) => {
      assert.match(error.message, /apiKey/);
      assert.doesNotMatch(error.message, /tinykey/);
      return true;
    });
  });
});

test('an invalid config names the offending field', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    const broken = structuredClone(VALID);
    broken.downloadClients[0]!.importMode = 'teleport';
    await writeFile(path, JSON.stringify(broken));

    await assert.rejects(loadConfig(path), (error: Error) => {
      assert.match(error.message, /importMode/);
      return true;
    });
  });
});

test('PICKARR_PORT overrides the configured port', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(VALID));
    process.env['PICKARR_PORT'] = '9999';
    try {
      const config = await loadConfig(path);
      assert.equal(config.server.port, 9999);
    } finally {
      delete process.env['PICKARR_PORT'];
    }
  });
});

test('two feeds sharing an id is rejected', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    const dupes = structuredClone(VALID);
    dupes.feeds.push({ ...dupes.feeds[0]! });
    await writeFile(path, JSON.stringify(dupes));
    await assert.rejects(loadConfig(path), /duplicate feed id/i);
  });
});

test('the metadata block defaults when absent', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(VALID));
    const config = await loadConfig(path);
    assert.equal(config.metadata.enabled, true);
    assert.equal(config.metadata.intervalSeconds, 5);
    assert.equal(config.metadata.perTick, 5);
    assert.equal(config.metadata.artworkDir, undefined);
  });
});

test('a non-positive perTick is refused at startup', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    const broken = structuredClone(VALID) as Record<string, unknown>;
    broken['metadata'] = { perTick: 0 };
    await writeFile(path, JSON.stringify(broken));
    await assert.rejects(loadConfig(path), /perTick/);
  });
});

test('parseConfig accepts a valid document without touching the filesystem', () => {
  const config = parseConfig(structuredClone(VALID) as unknown as JsonValue, 'test');
  assert.equal(config.server.port, 8080);
  // Unresolved: parseConfig does no I/O, so a `file:` reference is still a reference.
  assert.equal(config.metadata.perTick, 5);
});

test('parseConfig names its source and the offending field', () => {
  const broken = structuredClone(VALID);
  broken.downloadClients[0]!.importMode = 'teleport';
  assert.throws(
    () => parseConfig(broken as unknown as JsonValue, '/some/where.json'),
    (error: Error) => {
      assert.match(error.message, /\/some\/where\.json/);
      assert.match(error.message, /importMode/);
      return true;
    },
  );
});

test('parseConfig applies the cross-field checks', () => {
  const dupes = structuredClone(VALID);
  dupes.feeds.push({ ...dupes.feeds[0]! });
  assert.throws(() => parseConfig(dupes as unknown as JsonValue, 'test'), /duplicate feed id/i);

  const orphan = structuredClone(VALID);
  orphan.feeds[0]!.plugin = '@pickarr/plugin-absent';
  assert.throws(() => parseConfig(orphan as unknown as JsonValue, 'test'), /not configured/i);
});

test('resolveSecrets replaces a file: reference in place', async () => {
  await withTempDir(async (dir) => {
    const secretPath = join(dir, 'sab_key');
    await writeFile(secretPath, 'resolved-secret-value\n');
    const document = structuredClone(VALID);
    document.downloadClients[0]!.apiKey = `file:${secretPath}`;
    const config = parseConfig(document as unknown as JsonValue, 'test');

    await resolveSecrets(config);
    assert.equal(config.downloadClients[0]?.apiKey, 'resolved-secret-value');
  });
});

test('resolveSecrets rejects a short resolved key without printing it', async () => {
  await withTempDir(async (dir) => {
    const secretPath = join(dir, 'sab_key');
    await writeFile(secretPath, 'tinykey\n');
    const document = structuredClone(VALID);
    document.downloadClients[0]!.apiKey = `file:${secretPath}`;
    const config = parseConfig(document as unknown as JsonValue, 'test');

    await assert.rejects(resolveSecrets(config), (error: Error) => {
      assert.match(error.message, /apiKey/);
      assert.doesNotMatch(error.message, /tinykey/);
      return true;
    });
  });
});
