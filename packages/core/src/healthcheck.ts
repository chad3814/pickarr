/**
 * The container's healthcheck, as a real entry point rather than a `node -e`
 * one-liner in the `HEALTHCHECK` line.
 *
 * It is a module here for the reason the one-liner failed: a probe has to agree
 * with boot about which port to talk to, and the only way to agree is to ask the
 * same code. The shell version could not `import`, so it guessed — see
 * `resolveServerPort` for what that cost. Being a module also makes the probe
 * testable, which a string inside a Dockerfile is not.
 */
import { parseConfig, readConfigDocument, resolveServerPort } from './config/load.ts';

/** Mirrors `main.ts`'s `CONFIG_PATH`; the Dockerfile sets `PICKARR_CONFIG`. */
const CONFIG_PATH = process.env['PICKARR_CONFIG'] ?? '/config/config.json';

/**
 * Only the part of `fetch` a probe uses, so a test can supply one without
 * standing up a server or reaching the network.
 */
type FetchLike = (url: string) => Promise<Response>;

/**
 * Which port to probe.
 *
 * `parseConfig` and not `loadConfig`: the port needs the document and the
 * override, and nothing else. `loadConfig` would additionally run
 * `resolveSecrets`, which reads api keys off disk — work a healthcheck has no
 * use for, and secrets it has no business holding, thirty seconds apart forever.
 */
export async function resolveHealthPort(configPath: string): Promise<number> {
  const document = await readConfigDocument(configPath);
  return resolveServerPort(parseConfig(document, configPath).server.port);
}

/**
 * Whether the server answers `/api/health` on the port it should be listening on.
 *
 * A rejected fetch is `false`, not a throw: a refused connection is exactly the
 * condition a healthcheck exists to report, and it is the normal answer during
 * the start period. A config that cannot be read or parsed *does* throw, because
 * that is not the app being unhealthy — it is the probe being unable to ask, and
 * the two deserve different messages in `docker inspect`.
 *
 * `127.0.0.1` rather than `localhost`: the server binds `0.0.0.0`, and resolving
 * `localhost` to `::1` first on a dual-stack image would report a healthy server
 * as down.
 */
export async function probeHealth(
  configPath: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const port = await resolveHealthPort(configPath);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

// Runs only when executed directly, so importing this from a test does not exit
// the test runner.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = (await probeHealth(CONFIG_PATH)) ? 0 : 1;
  } catch (error) {
    // The probe could not ask. Say why on stderr — `docker inspect` keeps the
    // healthcheck's output, and a bare exit code 1 here would be indistinguishable
    // from the app being down.
    process.stderr.write(`healthcheck: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
