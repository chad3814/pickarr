import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { repoRoot, webDist } from './paths.ts';

const run = promisify(execFile);

/**
 * Builds every workspace once for the whole run.
 *
 * The 1.x E2E suite this ran for was deleted in task 3, and for a while
 * afterward this function had nothing to build for -- but that is no longer
 * true: `packages/e2e/tests/shell.spec.ts` is the live 2.0 suite, and every
 * spec in it needs the real built SPA, since
 * `../src/harness-2.ts`'s `harness` fixture serves `webDist` (below) as the
 * host's `webRoot`. Building once here, rather than per test, is what the
 * root `playwright.config.ts`'s own refusal-to-run-from-root guarantees a
 * bare `npx playwright test` cannot skip.
 */
export default async function globalSetup(): Promise<void> {
  await run('npm', ['run', 'build'], { cwd: repoRoot });

  // A build that reports success but leaves no shell would surface later as a
  // browser 404 with no explanation, so fail here where the cause is obvious.
  await access(`${webDist}/index.html`);
}
