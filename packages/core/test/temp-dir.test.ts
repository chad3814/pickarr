import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.ts';

/**
 * Directories handed out by the tests below, so a later test can look for them
 * after the hook that removes them has run. Top-level tests in one file run in
 * declaration order, which is what makes "gone by the next test" observable at
 * all — a single test cannot watch its own `after` hook.
 */
const handedOut: string[] = [];

async function gone(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
}

test('the directory is real while the test is running', async (t) => {
  const dir = await tempDir(t, 'pickarr-temp-dir-test-');
  handedOut.push(dir);

  await writeFile(join(dir, 'file.txt'), 'contents');

  assert.equal((await stat(dir)).isDirectory(), true);
  assert.equal(await readFile(join(dir, 'file.txt'), 'utf8'), 'contents');
});

test('the previous test left nothing behind', async () => {
  assert.equal(handedOut.length, 1);
  assert.equal(await gone(handedOut[0]!), true);
});

test('two directories in one test are both registered', async (t) => {
  handedOut.push(await tempDir(t, 'pickarr-temp-dir-a-'));
  handedOut.push(await tempDir(t, 'pickarr-temp-dir-b-'));

  assert.notEqual(handedOut[1], handedOut[2]);
});

test('both of the previous test\'s directories are gone', async () => {
  assert.equal(await gone(handedOut[1]!), true);
  assert.equal(await gone(handedOut[2]!), true);
});

/**
 * The four files this helper was written for. A test that removed its own
 * directory at the end of its body only cleaned up on the happy path, and these
 * four never did even that — 33 directories per run between them. Naming the
 * files rather than scanning the whole suite is deliberate: nine other files
 * still call `mkdtemp` directly inside a `finally`, which is correct, and a
 * blanket ban would read as a rule this change did not make.
 */
const CONVERTED = [
  'manual/identity-plan.test.ts',
  'manual/operations.test.ts',
  'pipeline/upgrade.test.ts',
  'pipeline/import.test.ts',
];

test('the converted files create no temporary directory of their own', async () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const sources = await Promise.all(
    CONVERTED.map(async (file) => readFile(join(root, file), 'utf8')),
  );

  const offenders: string[] = [];
  for (const [index, file] of CONVERTED.entries()) {
    const source = sources[index]!;
    // `upgrade.test.ts` and `import.test.ts` keep a factory of their own for
    // the sites already wrapped in `try`/`finally`, and those spell it
    // `return mkdtemp(...)`. What the 33 leaking sites had in common is the
    // awaited form inside a test body, so that is what is banned — and it is
    // matched as a bare substring rather than as an assignment, because one of
    // them read `const trashDir = join(await mkdtemp(...), 'not-a-directory')`
    // and an assignment-shaped pattern let it through.
    if (source.includes('await mkdtemp(')) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
