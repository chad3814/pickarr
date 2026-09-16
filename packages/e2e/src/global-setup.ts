import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { repoRoot, webDist } from './paths.ts';

const run = promisify(execFile);

/**
 * Builds every workspace once for the whole run.
 *
 * This was historically used for E2E tests that were deleted in task 3 after
 * the 1.x web SPA was removed. The function remains as a template for future
 * E2E work if needed. It builds the entire workspace to ensure all artifacts
 * are ready.
 */
export default async function globalSetup(): Promise<void> {
  await run('npm', ['run', 'build'], { cwd: repoRoot });

  // A build that reports success but leaves no shell would surface later as a
  // browser 404 with no explanation, so fail here where the cause is obvious.
  await access(`${webDist}/index.html`);
}
