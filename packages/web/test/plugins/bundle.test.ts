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
 * **Skips rather than fails when there is no current bundle to read.**
 * `npm run check` does not build -- `test:server`'s glob covers every
 * package's `test` directory, this file included, and runs before `npm run
 * build` ever does -- so on a clean tree with no prior `npm run build -w
 * @pickarr/web`, asserting `scripts.length > 0` would fail every future
 * task's `npm run check`. `t.skip(...)` reports the skip in the test
 * output rather than silently answering "pass" the way an early `return`
 * would.
 *
 * **`.github/workflows/ci.yml`'s `check` job builds before it checks, which
 * is what makes this assertion exist in CI at all.** Until that step was
 * added the job was `npm ci` then `npm run check`, neither of which builds,
 * so this test skipped in every CI run ever recorded and the design spec's
 * acceptance 5 was asserted nowhere automated. The hazard was still caught
 * there, but only incidentally, by the `e2e` job's own build. If that step
 * is ever removed, this file goes back to reporting a skip and nothing else
 * in `npm run check` looks at a bundle.
 *
 * **A bundle older than the sources it claims to cover is also "no current
 * bundle", and skips for the same reason.** Measured: with
 * `import '@pickarr/plugin-tv';` added to `src/plugins/registry.ts`,
 * `npm run build -w @pickarr/web` fails with `"DatabaseSync" is not
 * exported by "__vite-browser-external"` and leaves the previous good
 * `dist` in place -- against which the assertions below passed, reporting
 * on a tree that no longer existed. `playwright.config.ts` carries the same
 * lesson from the other side ("the suite serves whatever stale bundle
 * happens to be sitting on disk ... a CSS mutation looked like it had been
 * caught, when the browser had never actually loaded it").
 *
 * Skip rather than fail, deliberately, and for the same reason the absent
 * case skips: a developer who edits a source and runs `npm run check`
 * without rebuilding would otherwise get a red that is about their build
 * order and not about their change. In CI the case cannot arise -- a failed
 * `npm run build` stops the job before `npm run check` runs at all -- so
 * failing here would buy nothing CI needs and cost every local run in the
 * wrong order. What it does buy is that a stale bundle never again reports
 * a pass.
 */
test('the web bundle imports nothing from node', async (t) => {
  const dir = join(import.meta.dirname, '../../dist/assets');
  const exists = await stat(dir).then(() => true, () => false);
  if (!exists) {
    t.skip('no built bundle -- run `npm run build -w @pickarr/web` first');
    return;
  }

  const [built, newest] = await Promise.all([newestUnder(dir), newestSource()]);
  if (built !== undefined && newest !== undefined && built.mtimeMs < newest.mtimeMs) {
    t.skip(`the built bundle predates ${newest.file} -- run \`npm run build\` first`);
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

/** A file and when it was last written. */
interface Newest {
  readonly file: string;
  readonly mtimeMs: number;
}

/** The most recently written of the candidates, or `undefined` when none exists. */
function later(candidates: readonly (Newest | undefined)[]): Newest | undefined {
  return candidates.reduce<Newest | undefined>(
    (best, one) => (one === undefined || (best !== undefined && best.mtimeMs >= one.mtimeMs) ? best : one),
    undefined,
  );
}

/**
 * The most recently written file anywhere under `dir`, or `undefined` if
 * there is none -- including when `dir` itself does not exist, which is the
 * ordinary answer for a package that has no `src`.
 */
async function newestUnder(dir: string): Promise<Newest | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return later(
    await Promise.all(
      entries.map(async (entry): Promise<Newest | undefined> => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return newestUnder(path);
        const info = await stat(path);
        return { file: path, mtimeMs: info.mtimeMs };
      }),
    ),
  );
}

/**
 * The most recently written source file in the repository: the `src`
 * directory of every package, not only web's.
 *
 * **An over-approximation of the bundle's inputs, on purpose.** Web's
 * bundle is built from its own `src` plus the `dist/browser.js` of each
 * plugin package, which are in turn built from those packages' `src`; the
 * host's and the 1.x packages' sources reach it not at all. Enumerating the
 * real graph would mean a second copy of `packages/web/package.json`'s
 * dependency list here, drifting the moment a plugin is added -- which is
 * the defect this whole seam exists to retire. So the comparison is against
 * every package's `src`, derived by reading the directory.
 *
 * The asymmetry that makes that the right trade: over-approximating costs a
 * *skip* on a tree where an unrelated package was edited after the last
 * build, and `npm run build` before `npm run check` -- the order CI now
 * uses and every task gate has always used -- makes even that impossible.
 * Under-approximating costs a guard that reads a bundle predating the
 * import it is looking for and reports a pass.
 */
async function newestSource(): Promise<Newest | undefined> {
  const packages = join(import.meta.dirname, '../../..');
  const entries = await readdir(packages, { withFileTypes: true });
  return later(
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => newestUnder(join(packages, entry.name, 'src'))),
    ),
  );
}
