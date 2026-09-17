import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The monorepo root — `packages/e2e/src` is three levels down from it. */
export const repoRoot = resolve(here, '..', '..', '..');

/**
 * Where `vite build` puts the SPA -- not the same directory `server.webRoot`
 * names in production, but the same bytes. `main.ts`'s `defaultWebRoot`
 * resolves to `packages/host/dist/web` (its own doc explains why), and the
 * image's runtime stage `COPY`s `packages/web/dist` -- this directory --
 * into it; there is no `buildServer` function that does the copying, and
 * nothing in `main.ts` reads from `packages/web/dist` directly. This harness
 * serves `webDist` itself as `webRoot` (`harness-2.ts`'s `boot`), which is
 * exactly the bundle that ships, one `COPY` earlier than production sees it,
 * rather than a dev-server rendering of it.
 */
export const webDist = join(repoRoot, 'packages', 'web', 'dist');
