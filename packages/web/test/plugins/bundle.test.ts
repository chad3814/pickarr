import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The production bundle carries no node import.
 *
 * **Asserted over the built artifact, not over the import graph**, because
 * the failure this catches is a build-time resolution that no unit test
 * sees: web's `src/` importing a plugin package's *root* entry instead of
 * its `/browser` subpath reaches `node:sqlite` through
 * `@pickarr/openmetadata` -> `drizzle-orm`. Measured before this seam
 * existed: that import fails `npm run build` outright.
 *
 * `node:l` appears in the baseline bundle as an incidental substring and is
 * not an import, so the assertion is on the import forms, not on the two
 * characters.
 *
 * **Skips rather than fails when there is no built bundle to read.**
 * `npm run check` does not build -- `test:server`'s glob covers every
 * package's `test` directory, this file included, and runs before `npm run
 * build` ever does -- so on a clean tree with no prior `npm run build -w
 * @pickarr/web`, asserting `scripts.length > 0` would fail every future
 * task's `npm run check`. `t.skip(...)` reports the skip in the test
 * output rather than silently answering "pass" the way an early `return`
 * would.
 */
test('the web bundle imports nothing from node', async (t) => {
  const dir = join(import.meta.dirname, '../../dist/assets');
  const exists = await stat(dir).then(() => true, () => false);
  if (!exists) {
    t.skip('no built bundle -- run `npm run build -w @pickarr/web` first');
    return;
  }

  const names = await readdir(dir);
  const scripts = names.filter((name) => name.endsWith('.js'));
  assert.ok(scripts.length > 0, 'dist/assets exists but holds no built script');

  for (const name of scripts) {
    const source = await readFile(join(dir, name), 'utf8');
    for (const forbidden of ['from"node:', "from'node:", 'require("node:', 'drizzle', 'DatabaseSync']) {
      assert.ok(!source.includes(forbidden), `${name} contains ${forbidden}`);
    }
  }
});
