import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig, readConfigDocument, resolveSecrets } from '../../src/config/load.ts';
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

// V8's "Unexpected token" message echoes ~20 characters of source around the
// failure, and both config routes return this message verbatim to an
// unauthenticated LAN peer. An api key pasted without quotes, or left in
// front of a trailing comma, is an ordinary mistake — the message must not
// echo any fragment of it.
test('a JSON syntax error next to a literal key does not leak the key', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(path, '{"apiKey":SUPERSECRET1234567890,"trashDir":"/data/trash"}');

    await assert.rejects(readConfigDocument(path), (error: Error) => {
      assert.match(error.message, /not valid JSON/);
      assert.doesNotMatch(error.message, /SUPERSECRET1234567890/);
      assert.doesNotMatch(error.message, /SUPERSECRE/);
      // Not even the single quoted character V8 leads with — `Unexpected token
      // 'S'` is the secret's first byte.
      assert.doesNotMatch(error.message, /'S'/);
      // And the reader is told the detail was withheld rather than absent.
      assert.match(error.message, /withheld/);
      return true;
    });
  });
});

// The reduction is an allowlist: a shape V8 is known to build without quoting
// the document passes through whole, so an ordinary syntax error keeps its
// position and its explanation. Every one of these puts a key in the file too,
// so a shape wrongly admitted to the list would show up here as a leak rather
// than as a missing line number.
test('a syntax error that quotes no source keeps its position and explanation', async () => {
  const sourceFree: Record<string, string> = {
    'trailing comma': '{"apiKey":"SUPERSECRET1234567890",}',
    'missing colon': '{"apiKey" "SUPERSECRET1234567890"}',
    'unquoted property name': '{apiKey:"SUPERSECRET1234567890"}',
    'missing comma': '{"a":1 "apiKey":"SUPERSECRET1234567890"}',
    'unterminated string': '{"apiKey":"SUPERSECRET1234',
    'trailing junk': '{"a":1}SUPERSECRET1234567890',
  };

  for (const [name, contents] of Object.entries(sourceFree)) {
    await withTempDir(async (dir) => {
      const path = join(dir, 'config.json');
      await writeFile(path, contents);

      await assert.rejects(readConfigDocument(path), (error: Error) => {
        assert.match(error.message, /at position \d+ \(line \d+ column \d+\)/, name);
        assert.doesNotMatch(error.message, /withheld/, name);
        assert.doesNotMatch(error.message, /SUPERSECRE/, name);
        return true;
      });
    });
  }
});

// Nothing in the message may come from the file, so a document that is nothing
// but a secret must not put any of it on the wire. `readConfigDocument` is the
// one place this is enforced for both the boot log and the two config routes.
test('a file that is only a secret leaks none of it', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(path, 'SUPERSECRET1234567890');

    await assert.rejects(readConfigDocument(path), (error: Error) => {
      for (let length = 4; length <= 'SUPERSECRET1234567890'.length; length += 1) {
        assert.doesNotMatch(error.message, new RegExp('SUPERSECRET1234567890'.slice(0, length)));
      }
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
  assert.equal(config.metadata.perTick, 5);
});

// `parseConfig` does no I/O — that is `resolveSecrets`'s job — so a `file:`
// reference must come out exactly as it went in, not resolved and not
// rejected even if the path it names does not exist.
test('parseConfig leaves a file: reference unresolved', () => {
  const withSecret = structuredClone(VALID);
  withSecret.downloadClients[0]!.apiKey = 'file:/run/secrets/sabnzbd_api_key';
  const config = parseConfig(withSecret as unknown as JsonValue, 'test');
  assert.equal(config.downloadClients[0]?.apiKey, 'file:/run/secrets/sabnzbd_api_key');
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

test('a feed naming a download client that is not configured is refused by name', () => {
  const orphan = {
    ...structuredClone(VALID),
    feeds: [{ ...structuredClone(VALID.feeds[0]!), downloadClient: 'sab-elsewhere' }],
  };
  assert.throws(
    () => parseConfig(orphan as unknown as JsonValue, 'test'),
    (error: Error) => {
      assert.match(error.message, /feed1/);
      assert.match(error.message, /sab-elsewhere/);
      assert.match(error.message, /not configured/i);
      return true;
    },
  );
});

// The half that fails loudest before the field exists: `feedSchema` did not
// declare `downloadClient`, and zod strips what it does not declare, so a
// second client named on a feed was dropped between the file and the config
// without a word (#34).
test('a feed keeps the download client it names', () => {
  const base = structuredClone(VALID);
  const twoClients = {
    ...base,
    downloadClients: [...base.downloadClients, { ...base.downloadClients[0]!, id: 'sab-b', category: 'pickarr-b' }],
    feeds: [{ ...base.feeds[0]!, downloadClient: 'sab-b' }],
  };
  const config = parseConfig(twoClients as unknown as JsonValue, 'test');
  assert.equal(config.feeds[0]?.downloadClient, 'sab-b');
});

// The overwhelmingly common config, pinned so the routing change cannot start
// requiring an annotation that no existing file carries.
test('a feed naming no download client parses, leaving the field unset', () => {
  const config = parseConfig(structuredClone(VALID) as unknown as JsonValue, 'test');
  assert.equal(config.feeds[0]?.downloadClient, undefined);
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
