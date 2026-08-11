import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { repoRoot, webDist } from './paths.ts';

const run = promisify(execFile);

/**
 * Builds the SPA once for the whole run.
 *
 * Once, not per test: `vite build` is fast but not free, and a per-test build
 * would be the dominant cost of every spec in the suite. The bundle is
 * immutable for the duration of a run, so every worker can serve the same one.
 *
 * The build is the real `npm run build -w @pickarr/web`, not a hand-rolled
 * `vite` invocation, so the artifact under test cannot drift from the artifact
 * that ships.
 */
export default async function globalSetup(): Promise<void> {
  await run('npm', ['run', 'build', '-w', '@pickarr/web'], { cwd: repoRoot });

  // A build that reports success but leaves no shell would surface later as a
  // browser 404 with no explanation, so fail here where the cause is obvious.
  await access(`${webDist}/index.html`);
}
