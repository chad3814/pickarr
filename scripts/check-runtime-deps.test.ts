/**
 * One rule: **nothing the root manifest declares as a `devDependency` may
 * survive into the production install**, which is the install the runtime
 * stage of the `Dockerfile` builds with `npm ci --omit=dev`.
 *
 * Issue #82. `drizzle-kit` was a root `devDependency` and shipped in the
 * runtime image anyway, because npm's per-node flags come from the *union of
 * the edges that reach a node*, not from where the package was declared.
 * `better-auth` is a production dependency of `@pickarr/host` and declares an
 * **optional peer** on `drizzle-kit`, so a non-dev edge reached it and npm
 * recorded it as `devOptional` -- "wanted by a dev edge or an optional edge."
 * `--omit=dev` removes only what is flagged `dev`, so it kept the node. The
 * manifest said dev and the lockfile disagreed, which is exactly the trap:
 * reading `package.json` tells you nothing about what the image installs.
 *
 * It cost eight packages rather than one, because a stowaway brings its own
 * tree: `drizzle-kit` pulled `@drizzle-team/brocli`, `@js-temporal/polyfill`
 * (and its `jsbi`), `get-tsconfig` (and its `resolve-pkg-maps`), `jiti`, and
 * `esbuild` -- a bundler, in an image whose whole job is to run output that
 * was already built.
 *
 * **Asserted against `package-lock.json`, not against a built image.** The
 * lockfile is where npm writes the decision down, so whether the image is
 * clean follows from whether the lockfile is; and a test that shells out to
 * `docker build` is a test nobody waits for.
 *
 * **Nothing breaks when this regresses**, which is the reason it is a test at
 * all. A migration CLI idling in the runtime image is image size and attack
 * surface, never a failure, so no other check would ever report it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The only fields of a `package-lock.json` node this rule reads. */
interface LockNode {
  readonly dev?: boolean;
  readonly devOptional?: boolean;
}

interface Lockfile {
  readonly packages: Readonly<Record<string, LockNode>>;
}

interface RootManifest {
  readonly devDependencies: Readonly<Record<string, string>>;
}

/**
 * `dev: true` is the only flag `--omit=dev` prunes on. Everything else -- no
 * flag at all, or `devOptional` -- npm installs, so for this rule they are the
 * same answer, and `devOptional` is the one that actually bit us.
 */
function survivesOmitDev(node: LockNode): boolean {
  return node.dev !== true;
}

test('no root devDependency survives into the production install', async () => {
  const [lockText, manifestText] = await Promise.all([
    readFile(join(REPO_ROOT, 'package-lock.json'), 'utf8'),
    readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
  ]);
  const lock = JSON.parse(lockText) as Lockfile;
  const manifest = JSON.parse(manifestText) as RootManifest;

  const stowaways = Object.keys(manifest.devDependencies).filter((name) => {
    const node = lock.packages[`node_modules/${name}`];
    return node !== undefined && survivesOmitDev(node);
  });

  assert.deepEqual(
    stowaways,
    [],
    `these root devDependencies are in the production closure, so the runtime image ships them (and their dependencies): ${stowaways.join(', ')}`,
  );
});
