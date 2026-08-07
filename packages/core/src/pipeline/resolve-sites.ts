import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, SiteLookupCandidates } from '@pickarr/plugin-api';
import type { SiteLookupClient, SiteSearchResult } from '../clients/theporndb.ts';
import { getDiscoveredSite, recordDiscoveredSite, sitePrefixKey } from '../db/sites.ts';

/** Lowercase, alphanumerics only — see `SiteLookupCandidates`. */
function comparisonKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The shortest a confirmed site's own name may be.
 *
 * The service knows sites called `BIG`, `DP`, `Ex` and `Rk`. They are real, so
 * the lookup answers correctly — and the answer is still wrong, because a name
 * that short is indistinguishable from an ordinary first word.
 * `Big.Boobs.For.The.Win` resolved to the site `BIG` with the title `Boobs For
 * The Win`, and `DP.Addiction.Vol.1.Elegant.Angel` to the site `DP`.
 *
 * Measured across 6,884 corpus titles: rejecting these costs ten titles that
 * previously parsed, every one of them with a fabricated site and a truncated
 * title. The parse rate drops and the output improves, which is the second
 * time that pair has come up — rate is not the objective.
 *
 * This bounds the *answer*, not the query. A short query is still worth
 * sending, because it is how a longer site name gets found: `2 Chicks` finds
 * `2 Chicks Same Time`.
 */
const MIN_CONFIRMED_SITE_LENGTH = 4;

/** A confirmed site: the name to use, plus the service's identifier for it. */
export interface PickedSite {
  readonly name: string;
  readonly sourceUuid: string | null;
}

/**
 * Chooses which search result is the release's site, or `null` for none.
 *
 * A result is believed only when it *is* one of the release's own leading
 * runs. The query itself is not a candidate answer: searching `2 Chicks` is
 * how `2 Chicks Same Time` is found, and searching `Free Use` is how
 * `Freeuse Fantasy` is found, but nothing is named either query. Judging by
 * the query would reject both — and then the one-word retry would confirm the
 * real-but-wrong site `Free`, which exists.
 *
 * `prefixes` arrives longest first, so the first hit is the longest match and
 * a four-word site beats the two-word run inside it.
 */
export function pickSite(
  results: readonly SiteSearchResult[],
  prefixes: readonly string[],
): PickedSite | null {
  const byKey = new Map<string, PickedSite>();
  for (const site of results) {
    const display = site.name.length > 0 ? site.name : site.shortName;
    if (display.length === 0) continue;
    if (comparisonKey(display).length < MIN_CONFIRMED_SITE_LENGTH) continue;
    const picked: PickedSite = { name: display, sourceUuid: site.sourceUuid };
    for (const spelling of [site.name, site.shortName]) {
      const key = comparisonKey(spelling);
      if (key.length > 0 && !byKey.has(key)) byKey.set(key, picked);
    }
  }

  for (const prefix of prefixes) {
    const match = byKey.get(comparisonKey(prefix));
    if (match !== undefined) return match;
  }
  return null;
}

export interface ResolveSitesResult {
  /** Prefixes confirmed as sites during this pass, newly looked up or cached. */
  confirmed: string[];
  /** How many lookups were actually sent to the metadata service. */
  queried: number;
  /** How many answers came from the cache instead of the network. */
  cached: number;
  /**
   * Titles left without a confirmed site because a lookup could not be made.
   * These parse with the first word as their site, and that key is durable —
   * the caller logs them so an outage is visible rather than silently baked
   * into a group.
   */
  unresolved: string[];
}

export interface ResolveSitesDeps {
  db: DatabaseSync;
  plugin: MediaTypePlugin;
  client: SiteLookupClient | undefined;
  now: () => number;
  log: (message: string) => void;
}

/**
 * Confirms the sites a batch of release names needs, before any of them are
 * parsed.
 *
 * Ordering is the whole point. `parse` is synchronous and its output is an
 * identity key that outlives the tick, so a site learned *after* a name is
 * parsed cannot be applied to it without re-keying a group the user may
 * already have picked. Resolving first means a name is only ever parsed once,
 * with the best site information available at the time.
 *
 * Candidates are tried most specific first and the pass stops at the first
 * confirmation, so a two-word site is never reduced to its first word once it
 * has matched. A prefix already answered — positively or negatively — is not
 * asked about again.
 *
 * A lookup that *fails* (network, auth, rate limit) is deliberately not cached
 * as a negative: nothing was learned, and recording one would make an outage
 * permanent.
 */
export async function resolveSitesForBatch(
  deps: ResolveSitesDeps,
  titles: readonly string[],
): Promise<ResolveSitesResult> {
  const result: ResolveSitesResult = { confirmed: [], queried: 0, cached: 0, unresolved: [] };
  const { plugin } = deps;
  if (plugin.siteCandidates === undefined || plugin.learnSites === undefined) return result;

  // Answers found during this pass, so a batch of fifty scenes from one site
  // asks about it once rather than fifty times.
  const answered = new Map<string, string | null>();
  const confirmed = new Set<string>();

  for (const title of titles) {
    let candidates: SiteLookupCandidates | null;
    try {
      candidates = plugin.siteCandidates(title);
    } catch (error) {
      deps.log(`site candidates for ${title} failed: ${(error as Error).message}`);
      continue;
    }
    if (candidates === null || candidates.queries.length === 0) continue;

    let settled = false;
    let lookupFailed = false;

    for (const query of candidates.queries) {
      const key = sitePrefixKey(query);
      if (key.length === 0) continue;

      if (answered.has(key)) {
        const remembered = answered.get(key) ?? null;
        if (remembered !== null) {
          confirmed.add(remembered);
          settled = true;
          break;
        }
        continue;
      }

      const cachedRow = getDiscoveredSite(deps.db, key);
      if (cachedRow !== undefined) {
        result.cached += 1;
        answered.set(key, cachedRow.site);
        if (cachedRow.site !== null) {
          confirmed.add(cachedRow.site);
          settled = true;
          break;
        }
        continue;
      }

      if (deps.client === undefined) {
        lookupFailed = true;
        break;
      }

      let results: readonly SiteSearchResult[];
      try {
        results = await deps.client.searchSites(query);
      } catch (error) {
        // Not cached: nothing was learned, so the next tick must be free to
        // ask again rather than inheriting a negative that was really an
        // outage.
        deps.log(`site lookup failed for "${query}": ${(error as Error).message}`);
        lookupFailed = true;
        break;
      }

      result.queried += 1;
      const found = pickSite(results, candidates.prefixes);
      answered.set(key, found?.name ?? null);
      recordDiscoveredSite(
        deps.db,
        key,
        { site: found?.name ?? null, sourceUuid: found?.sourceUuid ?? null },
        deps.client.source,
        deps.now(),
      );
      if (found !== null) {
        confirmed.add(found.name);
        settled = true;
        break;
      }
    }

    if (!settled && lookupFailed) result.unresolved.push(title);
  }

  result.confirmed = [...confirmed];
  if (result.confirmed.length > 0) plugin.learnSites(result.confirmed);
  return result;
}
