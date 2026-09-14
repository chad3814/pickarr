import type { DatabaseSync } from 'node:sqlite';

/**
 * One `filepath_mapping` row, narrowed the way `config.ts`'s `readRow` and
 * `select.ts`'s `readFeedRow` narrow theirs: each field pulled through its
 * own `unknown`-typed accessor, never a wholesale cast. Only `from_path` and
 * `to_path` are selected, and this module never queries `download_client` at
 * all -- the same rule `rows.ts` and `select.ts` state. Since migration 14
 * that table holds `secret` *names* rather than credentials, which does not
 * relax it: a name is safe to log, but a module that selects one is a module
 * that could resolve it, and only `readClientConfig` may.
 */
interface MappingRow {
  fromPath: string;
  toPath: string;
}

function readMappings(raw: DatabaseSync, clientId: number): MappingRow[] {
  const rows = raw.prepare(
    'SELECT from_path, to_path FROM filepath_mapping WHERE download_client_id = ?',
  ).all(clientId);
  return rows.map((row) => ({
    fromPath: String((row as { from_path: unknown }).from_path),
    toPath: String((row as { to_path: unknown }).to_path),
  }));
}

/**
 * Whether `clientPath` falls under the prefix `fromPath`, at a path boundary
 * rather than merely as a string prefix. Plain `startsWith` would let
 * `/downloads-old` match a `/downloads` mapping, because the former starts
 * with the latter's characters even though it names a sibling directory, not
 * anything beneath it. Requiring the remainder to be empty or to begin with
 * `/` is what keeps a mapping from reaching into a directory it was never
 * meant to describe.
 */
function matchesBoundary(clientPath: string, fromPath: string): boolean {
  if (!clientPath.startsWith(fromPath)) return false;
  const remainder = clientPath.slice(fromPath.length);
  return remainder === '' || remainder.startsWith('/');
}

/**
 * Translates a path reported by download client `clientId` into one the
 * host can open, using that client's `filepath_mapping` rows.
 *
 * The **longest** matching `from_path` wins, not the first one found, so a
 * specific mapping (`/downloads/tv` -> `/media/tv`) beats a general one that
 * also matches (`/downloads` -> `/media`) regardless of which row was
 * inserted first -- row order is a storage detail, not a rule a caller
 * should have to depend on. Ties (two mappings of the same length, which
 * would require two identical `from_path` values for one client) resolve to
 * whichever `.reduce` visits first; nothing here relies on that.
 *
 * No match is not an error: the path is returned unchanged, which is the
 * correct behaviour for a host that shares a filesystem with its client --
 * the common single-machine setup, which needs no mappings at all and must
 * not be treated as a misconfiguration.
 *
 * `node:path` is deliberately unused. These are *foreign* paths -- possibly
 * Windows-shaped, always from a machine that is not this one -- and
 * `path.resolve`/`path.normalize` would rewrite them according to the
 * host's own platform rules, which do not apply to a string that never
 * touches this host's filesystem until after this function returns. String
 * prefix matching only.
 */
export function mapClientPath(raw: DatabaseSync, clientId: number, clientPath: string): string {
  const mappings = readMappings(raw, clientId);
  let best: MappingRow | null = null;
  for (const mapping of mappings) {
    if (!matchesBoundary(clientPath, mapping.fromPath)) continue;
    if (best === null || mapping.fromPath.length > best.fromPath.length) {
      best = mapping;
    }
  }
  if (best === null) return clientPath;
  return best.toPath + clientPath.slice(best.fromPath.length);
}
