import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigDocument, writeConfigDocument } from '../../src/config/file.ts';

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-config-'));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('an absent file reads as an empty document', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readConfigDocument(join(dir, 'nope.json')), {});
  });
});

test('a document round-trips', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    await writeConfigDocument(path, { server: { port: 9000 } });
    assert.deepEqual(await readConfigDocument(path), { server: { port: 9000 } });
  });
});

test('unparseable json throws rather than reading as empty', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    await writeFile(path, '{ this is not json');
    await assert.rejects(() => readConfigDocument(path), /is not valid json/);
  });
});

test('a json value that is not an object throws', async () => {
  await withDir(async (dir) => {
    for (const contents of ['[]', '"a string"', '3', 'null']) {
      const path = join(dir, 'pickarr.config.json');
      // eslint-disable-next-line no-await-in-loop -- each iteration overwrites the same path, so the previous write's rejection must be observed before the next contents land
      await writeFile(path, contents);
      // eslint-disable-next-line no-await-in-loop -- see above
      await assert.rejects(() => readConfigDocument(path), /must be a json object/, `${contents} must be refused`);
    }
  });
});

test('the write is atomic: no temp file is left behind, and the file is never partially written', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    await writeConfigDocument(path, { server: { port: 9000 } });
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['pickarr.config.json'], 'only the target must remain');
    const text = await readFile(path, 'utf8');
    assert.equal(JSON.parse(text).server.port, 9000);
    assert.ok(text.endsWith('\n'), 'a config file a human edits ends with a newline');
  });
});

test('a rewrite replaces the whole document rather than merging', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    await writeConfigDocument(path, { server: { port: 9000 }, plugin: { a: 1 } });
    await writeConfigDocument(path, { server: { port: 9001 } });
    assert.deepEqual(await readConfigDocument(path), { server: { port: 9001 } });
  });
});

// chmod 000 does not deny root, so this can't provoke EACCES when running as
// root (e.g. some CI containers) -- skip rather than assert a false pass.
const canDenySelfAccess = process.getuid?.() !== 0;

test(
  'a read failure that is not ENOENT throws with no path in the message',
  { skip: !canDenySelfAccess },
  async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'pickarr.config.json');
      await writeFile(path, '{}');
      await chmod(path, 0o000);
      try {
        await assert.rejects(
          () => readConfigDocument(path),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes('/'), `message must carry no path: ${error.message}`);
            assert.match(error.message, /EACCES/, `errno code must be present: ${error.message}`);
            return true;
          },
        );
      } finally {
        await chmod(path, 0o644);
      }
    });
  },
);

test('two concurrent writes to the same path both settle, and the file ends up as exactly one of them', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    const [first, second] = await Promise.allSettled([
      writeConfigDocument(path, { server: { port: 9000 } }),
      writeConfigDocument(path, { server: { port: 9001 } }),
    ]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'fulfilled');

    const entries = await readdir(dir);
    assert.deepEqual(entries, ['pickarr.config.json'], 'no .config.tmp file must be left behind');

    const written = await readConfigDocument(path);
    const isFirst = JSON.stringify(written) === JSON.stringify({ server: { port: 9000 } });
    const isSecond = JSON.stringify(written) === JSON.stringify({ server: { port: 9001 } });
    assert.ok(isFirst || isSecond, `must be exactly one of the two documents, got ${JSON.stringify(written)}`);
  });
});
