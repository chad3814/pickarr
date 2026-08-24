import type { PathMapping } from '../config/schema.ts';

/**
 * Translates a client-reported path into one Pickarr can open.
 *
 * Shared by every client rather than copied per client, and that is worth a
 * sentence: this is the translation a recursive delete used to be aimed
 * through, which is why `DownloadClient.remove` argues for asking the client to
 * delete rather than doing it here. Two copies free to drift is not a risk
 * worth the eight lines it would save.
 *
 * The `/` in the prefix test is load-bearing: without it `/downloads2` matches
 * a mapping for `/downloads` and every path under a sibling directory is
 * rewritten into the wrong tree.
 *
 * Mappings are sorted longest-`from`-first on a copy before matching, so a
 * nested mapping (`/downloads/complete`) wins over its parent
 * (`/downloads`) regardless of the order the caller configured them in.
 * Sorting here rather than trusting the caller to pre-sort means there is
 * only one place this can be gotten wrong, not one per client. The sort is
 * on a copy — never the caller's array — because callers (config objects)
 * are shared and must not observe their own path mappings reordered out
 * from under them. `Array.prototype.sort` is stable, so mappings whose
 * `from` lengths tie keep the order they were configured in.
 */
export function applyPathMappings(
  mappings: readonly PathMapping[],
  clientPath: string,
): string {
  const sorted = mappings.toSorted((a, b) => b.from.length - a.from.length);
  for (const mapping of sorted) {
    if (clientPath === mapping.from || clientPath.startsWith(`${mapping.from}/`)) {
      return mapping.to + clientPath.slice(mapping.from.length);
    }
  }
  return clientPath;
}
