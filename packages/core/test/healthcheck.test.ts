import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeHealth, resolveHealthPort } from '../src/healthcheck.ts';

/**
 * A port that is deliberately not the schema default. The bug this file exists
 * for was a healthcheck that probed 8080 no matter what the config said, so a
 * test whose fixture uses 8080 would pass against the broken version.
 */
const CONFIGURED_PORT = 8888;

const VALID = {
  server: { port: CONFIGURED_PORT },
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

async function withConfig(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-healthcheck-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(VALID));
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the probed port is the one the config asks for, not the schema default', async () => {
  await withConfig(async (path) => {
    assert.equal(await resolveHealthPort(path), CONFIGURED_PORT);
  });
});

test('PICKARR_PORT overrides the configured port, as it does at boot', async () => {
  await withConfig(async (path) => {
    process.env['PICKARR_PORT'] = '9999';
    try {
      assert.equal(await resolveHealthPort(path), 9999);
    } finally {
      delete process.env['PICKARR_PORT'];
    }
  });
});

test('a healthy server is probed on the configured port and reports healthy', async () => {
  await withConfig(async (path) => {
    const asked: string[] = [];
    const healthy = await probeHealth(path, async (url) => {
      asked.push(String(url));
      return new Response('{}', { status: 200 });
    });

    assert.equal(healthy, true);
    assert.deepEqual(asked, [`http://127.0.0.1:${CONFIGURED_PORT}/api/health`]);
  });
});

test('a non-ok response reports unhealthy', async () => {
  await withConfig(async (path) => {
    const healthy = await probeHealth(path, async () => new Response('nope', { status: 503 }));
    assert.equal(healthy, false);
  });
});

test('a refused connection reports unhealthy rather than throwing', async () => {
  await withConfig(async (path) => {
    const healthy = await probeHealth(path, async () => {
      throw new Error('fetch failed');
    });
    assert.equal(healthy, false);
  });
});

test('an unreadable config is an error, not a quiet unhealthy', async () => {
  // Distinguishing the two matters to whoever reads `docker inspect`: a probe
  // that cannot even find the config is a deployment fault, and reporting it
  // as a plain unhealthy would hide that behind a symptom the operator would
  // otherwise go looking for in the app.
  await assert.rejects(probeHealth(join(tmpdir(), 'pickarr-absent-config.json'), async () =>
    new Response('{}', { status: 200 }),
  ));
});
