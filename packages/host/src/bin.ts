/**
 * The process entry point, and the only file in this package that does
 * anything on load.
 *
 * It exists so that `main.ts` does not. The build bundles each entry it is
 * given, so an entry-point check living in `main.ts` -- a module
 * `index.ts` re-exports -- ended up inside `dist/index.js` too, reading
 * *that* bundle's `import.meta.main`: running the library face of the
 * package migrated a database, installed signal handlers and started a
 * pump. Keeping the check in a file nothing imports is what makes
 * `import.meta.main` here mean what it says.
 *
 * The check is still worth making, rather than calling `main` unconditionally:
 * it is what lets this file be imported -- by a test, or by a future
 * supervisor -- without starting a host.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from './main.ts';

/**
 * Fallback for `import.meta.main` on a Node build where it is not yet a
 * boolean -- the same "is this the script Node was actually asked to run"
 * question, answered by comparing `argv[1]` against this module's own path
 * instead. Copied from `packages/core/src/main.ts`'s `entryFromArgv` rather
 * than imported: host production code must not depend on `@pickarr/core`.
 *
 * Both sides are realpathed before comparing, so running through a symlink
 * cannot make this compare a resolved path against an unresolved one and
 * wrongly answer "not the entry point".
 *
 * `realpathSync` is the sync form on purpose, and this is the branch's only
 * remaining one. What justifies it is not that it always runs -- on the
 * `node >= 24` this package declares, `import.meta.main` is a boolean and
 * this whole function is never called. It is that when it IS called, it is
 * called from the one place where blocking costs nothing: deciding, during
 * module evaluation of the process entry point, whether to start at all.
 * Nothing is on the loop yet and no pump has begun. The fallback stays
 * because the versions without `import.meta.main` are still ones this could
 * be run on; it is simply rare rather than routine.
 */
function entryFromArgv(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isEntryPoint =
  typeof import.meta.main === 'boolean' ? import.meta.main : entryFromArgv();

if (isEntryPoint) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(`[host] fatal: ${error.message}`);
    process.exit(1);
  });
}
