import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { openConfig } from '../../src/config/instance.ts';

const withPath = async (body: (path: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-config-'));
  try { await body(join(dir, 'pickarr.config.json')); } finally { await rm(dir, { recursive: true, force: true }); }
};

const portSchema = z.object({ port: z.number().int().default(7676) }).prefault({});

test('an absent section gets the schema defaults', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    assert.deepEqual(config.register('server', portSchema).current, { port: 7676 });
  });
});

test('a present section is parsed', async () => {
  await withPath(async (path) => {
    await writeFile(path, JSON.stringify({ server: { port: 9000 } }));
    const config = await openConfig({ path });
    assert.deepEqual(config.register('server', portSchema).current, { port: 9000 });
  });
});

test('a present but invalid section throws from register, naming the namespace', async () => {
  await withPath(async (path) => {
    await writeFile(path, JSON.stringify({ server: { port: 'not a number' } }));
    const config = await openConfig({ path });
    assert.throws(() => config.register('server', portSchema), /server/);
  });
});

test('a schema that does not accept undefined throws for an absent section', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    // Deliberate: design spec 2.6c. A namespace that wants to be optional
    // must carry its own defaults; this is the constraint, not a bug.
    assert.throws(() => config.register('server', z.object({ port: z.number() })), /server/);
  });
});

test('update writes the new value and moves current', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    const handle = config.register('server', portSchema);
    await handle.update({ port: 9001 });
    assert.deepEqual(handle.current, { port: 9001 });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).server, { port: 9001 });
  });
});

test('update leaves an unknown namespace byte-identical', async () => {
  await withPath(async (path) => {
    await writeFile(path, JSON.stringify({ plugin_scenes: { nested: { deep: [1, 2, 3] } } }, null, 2));
    const config = await openConfig({ path });
    await config.register('server', portSchema).update({ port: 9001 });
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(after.plugin_scenes, { nested: { deep: [1, 2, 3] } }, 'an unknown namespace must survive');
    assert.deepEqual(after.server, { port: 9001 });
  });
});

test('two concurrent updates on different namespaces both survive', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    const server = config.register('server', portSchema);
    const secrets = config.register('secrets', z.object({ baseDir: z.string().default('/run/secrets') }).prefault({}));
    await Promise.all([server.update({ port: 9002 }), secrets.update({ baseDir: '/tmp/s' })]);
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(after.server, { port: 9002 }, 'the server update must not be lost');
    assert.deepEqual(after.secrets, { baseDir: '/tmp/s' }, 'the secrets update must not be lost');
  });
});

test('an update refuses rather than overwriting a file that became unparseable', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    const handle = config.register('server', portSchema);
    await writeFile(path, '{ broken');
    await assert.rejects(() => handle.update({ port: 9003 }), /is not valid json/);
    assert.equal(await readFile(path, 'utf8'), '{ broken', 'the hand-edit must survive');
  });
});

test('a namespace registered twice throws', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    config.register('server', portSchema);
    assert.throws(() => config.register('server', portSchema), /already registered/);
  });
});

test('a failed update does not wedge later writes', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    const handle = config.register('server', portSchema);
    await writeFile(path, '{ broken');
    await assert.rejects(() => handle.update({ port: 9003 }), /is not valid json/);
    await writeFile(path, '{}');
    await handle.update({ port: 9004 });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).server, { port: 9004 });
  });
});
