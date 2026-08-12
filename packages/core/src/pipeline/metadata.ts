import type { DatabaseSync } from 'node:sqlite';
import type {
  DisplayFields,
  MediaTypePlugin,
  MetadataCandidate,
  MetadataQuery,
  MetadataVerdict,
} from '@pickarr/plugin-api';
import { RateLimited, type SceneLookupClient } from '../clients/theporndb.ts';
import { cachePoster, type ArtworkDeps } from '../media/artwork.ts';
import { getGroup } from '../db/groups.ts';
import {
  deferMetadata,
  dueMetadataQueue,
  recordMetadataAnswer,
  setPosterPath,
  type MetadataQueueRow,
} from '../db/metadata.ts';
import { rememberSiteId, siteIdForName } from '../db/sites.ts';

/** Doubling backoff from one minute, capped so a long outage never stops retrying. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

function backoffFor(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, MAX_BACKOFF_MS);
}

export interface MetadataPassDeps {
  db: DatabaseSync;
  client: SceneLookupClient | undefined;
  /**
   * Resolves the plugin a group's `plugin` column names. `null` for a plugin
   * that is no longer configured — which is a normal outcome, not a bug: a
   * plugin can be removed from config after groups it created already exist.
   */
  pluginFor(pluginPackage: string): MediaTypePlugin | null;
  artwork: ArtworkDeps;
  perTick: number;
  now: () => number;
  log(message: string): void;
}

export interface MetadataPassResult {
  /** Queue rows this pass looked at, whether they ended up confirmed, none, or deferred. */
  looked: number;
  confirmed: number;
  none: number;
  deferred: number;
  /** Set when a 429 stopped the pass early; the moment lookups may resume. */
  cooldownUntil: number | null;
}

// Never actually returned: `safeConfirmMetadata` is only called once `lookUpOne`
// has confirmed `confirmMetadata` is defined. It exists to satisfy the optional
// hook's type without an unsafe non-null assertion.
const EMPTY_VERDICT: MetadataVerdict = { confirmed: null, nearMisses: [] };

/**
 * Answers a row the worker can never look up — no plugin, no hooks, or a
 * query the plugin declined to build — as `state = 'none'`. Leaving such a
 * row queued would mean it is retried, and fails to be answered, on every
 * single pass forever.
 */
function answerUnaskable(db: DatabaseSync, groupId: number, source: string, now: number): void {
  recordMetadataAnswer(db, { groupId, source, confirmed: null, nearMisses: [], now });
}

/**
 * Runs `plugin.metadataQuery`/`plugin.confirmMetadata` under a guard, the way
 * `ingest.ts`'s `prepareSafely` guards `parse`. Both are third-party code
 * reached from a queue row that persists across passes, so a throw here must
 * become a deferral — the retry that follows costs one row's backoff, while
 * treating it as an answer would discard information (a bug or a transient
 * issue in the plugin) permanently, and letting it propagate would abort
 * every row still waiting behind this one.
 */
function safeMetadataQuery(
  plugin: MediaTypePlugin,
  group: { identityKey: string; display: string },
): { query: MetadataQuery | null } | { error: string } {
  try {
    const display = JSON.parse(group.display) as DisplayFields;
    return { query: plugin.metadataQuery?.({ identityKey: group.identityKey, display }) ?? null };
  } catch (error) {
    return { error: `plugin threw building metadata query: ${(error as Error).message}` };
  }
}

function safeConfirmMetadata(
  plugin: MediaTypePlugin,
  candidates: readonly MetadataCandidate[],
  query: MetadataQuery,
): { verdict: MetadataVerdict } | { error: string } {
  try {
    return { verdict: plugin.confirmMetadata?.(candidates, query) ?? EMPTY_VERDICT };
  } catch (error) {
    return { error: `plugin threw confirming metadata: ${(error as Error).message}` };
  }
}

/**
 * Drains up to `perTick` due rows from the metadata queue: builds each
 * group's query, searches, confirms, writes the answer, and caches the
 * poster on a confirmation.
 *
 * Sequential, not concurrent, mirroring `resolveSitesForBatch` and
 * `searchSites`'s own paging: this is simpler, self-rate-limiting, and a
 * pass this small has nothing to gain from concurrency.
 *
 * The rule throughout is the one `resolveSitesForBatch` documents: a search
 * that ran and matched nothing is an answer, but a search that could not be
 * made learned nothing and must not be cached as one.
 */
export async function runMetadataPass(deps: MetadataPassDeps): Promise<MetadataPassResult> {
  const result: MetadataPassResult = {
    looked: 0,
    confirmed: 0,
    none: 0,
    deferred: 0,
    cooldownUntil: null,
  };

  const now = deps.now();
  const due = dueMetadataQueue(deps.db, now, deps.perTick);
  if (due.length === 0) return result;

  // Attached to every answer this pass writes, including the "never asked"
  // ones (no plugin, no hooks, no query) — `group_metadata.source` is
  // NOT NULL, and there is no other candidate value once a client exists.
  const source = deps.client?.source ?? 'none';

  for (const row of due) {
    result.looked += 1;
    // eslint-disable-next-line no-await-in-loop -- rows are answered one at a time, deliberately sequential
    const outcome = await lookUpOne(deps, row, source, now);

    if (outcome === 'confirmed') result.confirmed += 1;
    else if (outcome === 'none') result.none += 1;
    else if (outcome.kind === 'deferred') {
      result.deferred += 1;
      if (outcome.cooldownUntil !== null) {
        result.cooldownUntil = outcome.cooldownUntil;
        // A 429 means the whole pass is rate limited, not just this row.
        // Rows not yet reached keep their existing next_at and are picked up
        // normally once the cooldown passes; asking each of them anyway would
        // spend one request per row rediscovering a limit already known.
        break;
      }
    }
  }

  deps.log(
    `metadata pass: ${result.confirmed} confirmed, ${result.none} none, ${result.deferred} deferred` +
      (result.cooldownUntil === null ? '' : `, cooldown until ${result.cooldownUntil}`),
  );

  return result;
}

type RowOutcome = 'confirmed' | 'none' | { kind: 'deferred'; cooldownUntil: number | null };

async function lookUpOne(
  deps: MetadataPassDeps,
  row: MetadataQueueRow,
  source: string,
  now: number,
): Promise<RowOutcome> {
  const group = getGroup(deps.db, row.groupId);
  // A missing group cannot happen through the foreign key `metadata_queue`
  // holds on `media_groups`, but a group whose plugin has since been removed
  // from config can — `pluginFor` answers null for that, same as a missing
  // group would if it somehow existed.
  const plugin = group === null ? null : deps.pluginFor(group.plugin);
  if (group === null || plugin === null) {
    answerUnaskable(deps.db, row.groupId, source, now);
    return 'none';
  }

  if (plugin.metadataQuery === undefined || plugin.confirmMetadata === undefined) {
    answerUnaskable(deps.db, row.groupId, source, now);
    return 'none';
  }

  const built = safeMetadataQuery(plugin, group);
  if ('error' in built) {
    deps.log(`metadata query for group ${row.groupId} failed: ${built.error}`);
    deferMetadata(deps.db, row.groupId, built.error, now + backoffFor(row.attempts));
    return { kind: 'deferred', cooldownUntil: null };
  }
  if (built.query === null) {
    answerUnaskable(deps.db, row.groupId, source, now);
    return 'none';
  }
  const query = built.query;

  if (deps.client === undefined) {
    // Configured with no client is the same "nothing was learned" case a
    // network failure is: the row must be retried, not answered.
    const message = 'no metadata client configured';
    deps.log(`metadata lookup for group ${row.groupId} failed: ${message}`);
    deferMetadata(deps.db, row.groupId, message, now + backoffFor(row.attempts));
    return { kind: 'deferred', cooldownUntil: null };
  }
  const client = deps.client;

  const siteId = query.siteName === undefined ? null : siteIdForName(deps.db, query.siteName);

  let candidates: readonly MetadataCandidate[];
  try {
    candidates = await client.searchScenes(query.queries[0] ?? '', siteId);
  } catch (error) {
    if (error instanceof RateLimited) {
      const cooldownUntil = now + error.retryAfterMs;
      deps.log(`metadata lookup rate limited; cooldown until ${cooldownUntil}`);
      deferMetadata(deps.db, row.groupId, error.message, cooldownUntil);
      return { kind: 'deferred', cooldownUntil };
    }
    const message = (error as Error).message;
    deps.log(`metadata lookup for group ${row.groupId} failed: ${message}`);
    deferMetadata(deps.db, row.groupId, message, now + backoffFor(row.attempts));
    return { kind: 'deferred', cooldownUntil: null };
  }

  const confirmation = safeConfirmMetadata(plugin, candidates, query);
  if ('error' in confirmation) {
    deps.log(`metadata confirmation for group ${row.groupId} failed: ${confirmation.error}`);
    deferMetadata(deps.db, row.groupId, confirmation.error, now + backoffFor(row.attempts));
    return { kind: 'deferred', cooldownUntil: null };
  }
  const { confirmed, nearMisses } = confirmation.verdict;

  // Backfills `discovered_sites.source_id` from the scene response, so a
  // later lookup can filter by the provider's integer id instead of an
  // unfiltered `q=` search. Only when the confirmed scene's own site is the
  // one the query asked about — a near-miss on a different site says nothing
  // about the id of the site actually being resolved.
  if (
    confirmed !== null &&
    confirmed.siteId !== null &&
    query.siteName !== undefined &&
    confirmed.siteName === query.siteName
  ) {
    rememberSiteId(deps.db, query.siteName, confirmed.siteId);
  }

  recordMetadataAnswer(deps.db, { groupId: row.groupId, source: client.source, confirmed, nearMisses, now });

  // A poster failure is not a metadata failure: the answer above is already
  // written, and `cachePoster` never throws, so nothing here can undo it.
  if (confirmed !== null && confirmed.posterUrl !== null) {
    const posterPath = await cachePoster(deps.artwork, row.groupId, confirmed.posterUrl);
    if (posterPath !== null) setPosterPath(deps.db, row.groupId, posterPath);
  }

  return confirmed === null ? 'none' : 'confirmed';
}
