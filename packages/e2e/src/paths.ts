import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The monorepo root — `packages/e2e/src` is three levels down from it. */
export const repoRoot = resolve(here, '..', '..', '..');

/**
 * Where `vite build` puts the SPA. The same directory `main.ts` hands
 * `buildServer` as `webRoot` in production, so the harness serves exactly the
 * bundle that ships rather than a dev-server rendering of it.
 */
export const webDist = join(repoRoot, 'packages', 'web', 'dist');
