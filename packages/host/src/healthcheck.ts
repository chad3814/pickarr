/**
 * The container's healthcheck, run by `HEALTHCHECK` in the Dockerfile as its
 * own process rather than as a `node -e` one-liner.
 *
 * 1.x's healthcheck (`packages/core/src/healthcheck.ts`) exists for exactly
 * one reason: a `node -e` one-liner cannot `import` anything, so it could not
 * read `resolveServerPort` or the config schema either -- it fell back to a
 * hardcoded 8080 and reported every install unhealthy the moment an operator
 * configured any other port. `HEALTHCHECK` still runs a fixed command with no
 * shell to parse the run's own environment for it, so 2.0 has the identical
 * constraint. The fix is the same one 1.x used: a real module, so the probe
 * can import boot's own port resolution instead of guessing at it.
 *
 * **The port rules are not reimplemented here.** `resolveReadPort` and
 * `configuredEnvValue` are `main.ts`'s, imported rather than copied --
 * `resolveHealthPort` below only decides *which of the two sources* to ask,
 * in the same order `resolveSettings` already does. Two resolvers that agree
 * today and drift tomorrow would be worse than one, because nothing would
 * prove they had diverged until an operator's working config port started
 * failing its healthcheck.
 */
import type { ConfigDocument } from './config/file.ts';
import { readConfigDocument } from './config/file.ts';
import { serverConfigSchema } from './config/schemas.ts';
import { configuredEnvValue, resolveConfigPath, resolveReadPort } from './main.ts';

/**
 * The port boot would resolve to: `PICKARR_READ_API_PORT`, else
 * `configDoc`'s `server.port`, else the schema's default (7676) --
 * `resolveSettings`'s own order for this one field, restated here because
 * the healthcheck process never builds a full `HostSettings`.
 *
 * Synchronous and given the already-read document rather than a path, so a
 * test can supply either without a filesystem; `main` below is what reads
 * the real file for the shipped process. `configDoc['server']` is validated
 * through `serverConfigSchema` itself -- the same schema `resolveSettings`
 * registers -- rather than read as a bare property, so an absent `server`
 * section or an absent `port` within it still produces the documented
 * default instead of `undefined`.
 */
export function resolveHealthPort(env: NodeJS.ProcessEnv, configDoc: ConfigDocument): number {
  const portRaw = configuredEnvValue(env['PICKARR_READ_API_PORT']);
  if (portRaw !== undefined) return resolveReadPort(portRaw);
  return serverConfigSchema.parse(configDoc['server']).port;
}

/** Only the part of `fetch` a probe uses, so a test can supply one without a real socket. */
type FetchLike = (url: string) => Promise<Response>;

/**
 * True when the read API answers `/api/health` with a 2xx. `/api/health` is
 * one of the two open routes precisely so this needs no credential
 * (`api/server.ts`'s `ROUTES`).
 *
 * `127.0.0.1` rather than `localhost`: the server binds `0.0.0.0` by default,
 * and resolving `localhost` to `::1` first on a dual-stack image would report
 * a healthy server as down.
 *
 * A rejected fetch -- connection refused, the ordinary shape during the
 * container's start period -- is `false`, not a throw: that is the condition
 * this whole file exists to report, not a failure to ask the question.
 */
async function probeHealth(port: number, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The process entry point Docker's `HEALTHCHECK` runs: resolve the port,
 * probe it, and set the exit code `docker inspect` reads -- 0 healthy,
 * nonzero not.
 *
 * `deps` exists for the reason `main.ts`'s own `main` takes one: a test
 * supplies `env` and `fetchImpl` rather than mutating the process's real
 * `process.env` or reaching the network, and the shipped entry point below
 * supplies neither, so it reads `process.env` and probes with the real
 * `fetch`. Reading the config file is this function's job rather than
 * `resolveHealthPort`'s, on the same split `resolveConfigPath` already draws
 * in `main.ts`: which file to open is one decision, what is inside it is
 * another.
 *
 * A config file that cannot be read or parsed rejects, rather than being
 * swallowed into a quiet "unhealthy": that is not the read API being down,
 * it is this probe being unable to ask, and the two deserve different
 * messages in `docker inspect` -- the entry point below is what turns this
 * rejection into a message on stderr and a nonzero exit rather than losing
 * it.
 */
export async function main(
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const configDoc = await readConfigDocument(resolveConfigPath(env));
  const port = resolveHealthPort(env, configDoc);
  process.exitCode = (await probeHealth(port, fetchImpl)) ? 0 : 1;
}

// Runs only when this file is the process Node was actually asked to run,
// not when a test -- or a future supervisor -- imports it instead. `bin.ts`
// needs a *separate* file for this same check because `index.ts` re-exports
// `main.ts`'s `main`, so a check inside `main.ts` would also run inside
// `dist/index.js`. `index.ts` names nothing from this file, so nothing
// re-exports `healthcheck.ts`, and the check can live here the way 1.x's
// single-file `healthcheck.ts` did -- this file needs no `bin.ts` of its own.
//
// `import.meta.main` is used directly, with no `argv`-comparison fallback:
// unlike `bin.ts`, which is the one place that check is worth keeping for a
// pre-24 Node, this package declares `engines.node >= 24` at the workspace
// root (`package.json`), where `import.meta.main` is always a boolean.
if (import.meta.main) {
  main().catch((error: unknown) => {
    // `docker inspect` keeps a healthcheck's output, and a bare nonzero exit
    // here would be indistinguishable from the read API actually being down.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`healthcheck: ${message}\n`);
    process.exitCode = 1;
  });
}
