import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { repoRoot, webDist } from './paths.ts';

const run = promisify(execFile);

/**
 * Builds every workspace once for the whole run.
 *
 * Once, not per test: the build is fast but not free, and per-test it would be
 * the dominant cost of every spec. The output is immutable for the duration of
 * a run, so every worker shares it.
 *
 * The whole build rather than just the SPA, because two different things need
 * building and only one of them is obvious. The browser needs `web`'s bundle.
 * But the harness imports `plugin-scenes/src/index.ts`, which reaches
 * `@pickarr/plugin-api` through a *package specifier* — and Playwright does not
 * run under the `development` export condition that points those at `src/*.ts`,
 * so they resolve to `dist/`. A machine that has never run `npm run build` then
 * fails with `Cannot find module …/plugin-api/dist/index.js`, which names a
 * path rather than the reason. That is exactly how this first met CI: green on
 * a developer's machine, where a build had happened for unrelated reasons, and
 * red on a clean checkout.
 *
 * It is the real `npm run build`, not a hand-rolled bundler invocation, so
 * nothing under test can drift from what ships.
 */
export default async function globalSetup(): Promise<void> {
  await run('npm', ['run', 'build'], { cwd: repoRoot });

  // A build that reports success but leaves no shell would surface later as a
  // browser 404 with no explanation, so fail here where the cause is obvious.
  await access(`${webDist}/index.html`);
}
