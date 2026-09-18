/**
 * One rule, in three parts: **`npm run dev` must actually serve a working
 * host, and every way it can stop doing so silently is pinned here.**
 *
 * `dev` is two processes that have to agree about three numbers -- the port
 * the host listens on, the port Vite serves, and the origin Better Auth
 * trusts -- and they are written down in three different files. Nothing
 * fails loudly when they drift:
 *
 * - **Vite's proxy target vs the host's `DEFAULT_PORT`.** `vite.config.ts`
 *   names `8787` as a literal, because `packages/web` must not import from
 *   `packages/host` to learn it (web's only workspace dependency is
 *   `@pickarr/contract`, and it is a type-only one). So the literal and the
 *   constant are tied together *here* instead: this test is the seam. Move
 *   `DEFAULT_PORT` and every `/api` call in dev proxies to a closed port.
 * - **Vite's dev port vs `PICKARR_PUBLIC_URL`.** `dev:host` hardcodes the
 *   origin because Better Auth "refuses every state-changing request whose
 *   `Origin` is neither `baseURL` nor a trusted origin" (`main.ts`'s note on
 *   `authFor`, measured against better-auth 1.7.3) -- and Vite dev *is* a
 *   reverse proxy, so the host's own bound address is the wrong answer. If
 *   Vite serves any other port than the one that origin names, the app loads
 *   and browses fine and only *signing in* fails. That is why the config has
 *   to pin `server.port` explicitly rather than lean on Vite's default, and
 *   why `strictPort` has to be set: without it a busy 5173 sends Vite to 5174
 *   and the trusted origin is quietly wrong again.
 * - **`--conditions development`.** Without it every `@pickarr/*` import
 *   resolves through the `default` export condition to `dist/`, so the host
 *   runs whatever was last built and edits to `src/` do nothing at all. A
 *   stale `dist/` is the normal state of a worktree, so this does not present
 *   as an error -- it presents as a host that ignores you.
 *
 * **Asserted against the manifests, not by running anything.** What is wrong
 * in each case above is a string in a `package.json`, and booting two servers
 * to discover that is a test nobody waits for. The cost is that this pins the
 * *wiring* only: that `dev` names both halves and that the numbers agree. It
 * cannot tell you Vite still honours `server.port`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT } from '@pickarr/host';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The only field of a `package.json` this rule reads. */
interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

async function scriptsOf(...segments: readonly string[]): Promise<Readonly<Record<string, string>>> {
  const text = await readFile(join(REPO_ROOT, ...segments), 'utf8');
  return (JSON.parse(text) as Manifest).scripts ?? {};
}

/**
 * The `KEY=value` assignments a shell applies before the command in
 * `command`, which is where an npm script has to put a variable if it wants
 * one -- there is no other env seam in a manifest string.
 *
 * Stops at the first token that is not an assignment, so a `=` inside a later
 * argument (`--env-file-if-exists=.env.local` is one) is not read as a
 * variable being set.
 */
function leadingEnv(command: string): Readonly<Record<string, string>> {
  const assignments: Record<string, string> = {};
  for (const token of command.split(/\s+/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(token);
    if (match?.[1] === undefined) break;
    assignments[match[1]] = match[2] ?? '';
  }
  return assignments;
}

test('dev runs both halves and tears them down together', async () => {
  const root = await scriptsOf('package.json');
  const dev = root['dev'];

  assert.ok(dev !== undefined, 'the root manifest declares no `dev` script');
  assert.match(
    dev,
    /npm run dev -w @pickarr\/web/,
    'dev does not start the web dev server, so nothing serves the client',
  );
  assert.match(
    dev,
    /npm run dev:host/,
    'dev does not start the host, so every /api call proxies to a closed port',
  );
  assert.match(
    dev,
    /(^|\s)(-k|--kill-others)(\s|$)/,
    'dev does not pass concurrently -k, so killing one half orphans the other on its port',
  );
});

test('the web dev server runs vite', async () => {
  const web = await scriptsOf('packages', 'web', 'package.json');

  assert.equal(web['dev'], 'vite', 'the web manifest declares no `dev` script that runs vite');
});

test('vite proxies /api to the port the host actually listens on', async () => {
  const config = (await import('../packages/web/vite.config.ts')).default;
  const target = config.server?.proxy?.['/api'];

  assert.equal(
    typeof target,
    'string',
    'vite.config.ts no longer proxies /api to a plain URL, so this test cannot read its port',
  );
  assert.equal(
    target,
    `http://localhost:${String(DEFAULT_PORT)}`,
    `vite proxies /api somewhere other than the host's DEFAULT_PORT (${String(DEFAULT_PORT)}), so dev serves a client whose every request 502s`,
  );
});

test('vite pins its dev port, because dev:host hardcodes that origin', async () => {
  const config = (await import('../packages/web/vite.config.ts')).default;

  assert.equal(
    config.server?.port,
    5173,
    'vite.config.ts does not pin server.port, so the origin PICKARR_PUBLIC_URL names is whatever vite defaults to today',
  );
  assert.equal(
    config.server?.strictPort,
    true,
    'vite.config.ts does not set strictPort, so a busy port moves vite to the next one and PICKARR_PUBLIC_URL silently names the wrong origin',
  );
});

test('dev:host resolves workspace packages from source, watches, and boots', async () => {
  const root = await scriptsOf('package.json');
  const devHost = root['dev:host'];

  assert.ok(devHost !== undefined, 'the root manifest declares no `dev:host` script');

  const tokens = devHost.split(/\s+/);
  assert.ok(
    tokens.includes('--conditions') && tokens.includes('development'),
    'dev:host drops --conditions development, so the host runs a stale dist/ and ignores every edit to src/',
  );
  assert.ok(
    tokens.includes('--watch'),
    'dev:host drops --watch, so it is `npm start` and a source edit needs a manual restart',
  );

  const env = leadingEnv(devHost);
  assert.ok(
    env['PICKARR_DATABASE'] !== undefined,
    "dev:host sets no PICKARR_DATABASE, so the host opens its container default (/config/pickarr.db) and dies with 'unable to open database file'",
  );
});

test('dev:host trusts the origin vite dev actually serves', async () => {
  const root = await scriptsOf('package.json');
  const devHost = root['dev:host'];
  assert.ok(devHost !== undefined, 'the root manifest declares no `dev:host` script');

  const config = (await import('../packages/web/vite.config.ts')).default;
  const vitePort = config.server?.port;
  assert.equal(typeof vitePort, 'number', 'vite.config.ts does not pin a numeric server.port');

  assert.equal(
    leadingEnv(devHost)['PICKARR_PUBLIC_URL'],
    `http://localhost:${String(vitePort)}`,
    'dev:host trusts an origin that is not where vite dev serves, so the client loads but every sign-in is refused',
  );
});
