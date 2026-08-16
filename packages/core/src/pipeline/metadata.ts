import type { DatabaseSync } from 'node:sqlite';
import type {
  DisplayFields,
  MediaTypePlugin,
  MetadataCandidate,
  MetadataQuery,
  MetadataVerdict,
} from '@pickarr/plugin-api';
import { RateLimited, type SceneLookupClient } from '../clients/theporndb.ts';
import { cacheImage, performerArtworkKey, type ArtworkDeps } from '../media/artwork.ts';
import { getGroup } from '../db/groups.ts';
import {
  deferMetadata,
  dueMetadataQueue,
  getGroupMetadata,
  recordMetadataAnswer,
  setPosterPath,
  type MetadataQueueRow,
} from '../db/metadata.ts';
import { performersForGroups, performersNeedingArtwork, setPerformerArtwork } from '../db/performers.ts';
import { rememberSiteId, siteIdForName } from '../db/sites.ts';
import { backoffFor } from './backoff.ts';
import { enqueuePerformerSearch } from './performers.ts';

/**
 * How many failed attempts a row may accumulate before the worker gives up
 * on it and answers `state = 'none'` instead of deferring forever.
 *
 * Backoff ramps to its six-hour cap in nine attempts (1, 2, 4, ... 256
 * minutes), so every attempt past that costs a full six hours. Fifty spans
 * roughly ten days past the ramp — long enough that a genuine multi-day
 * provider outage still recovers once it clears, short enough that a row
 * poisoned by a deterministic fault (a corrupt `display`, a plugin bug that
 * throws on every call) eventually stops consuming a `perTick` slot four
 * times a day forever.
 */
export const MAX_METADATA_ATTEMPTS = 50;

export interface MetadataPassDeps {
  db: DatabaseSync;
  client: SceneLookupClient | undefined;
  /**
   * Resolves the plugin a group's `plugin` column names. `null` for a plugin
   * that is no longer configured — which is a normal outcome, not a bug: a
   * plugin can be removed from config after groups it created already exist.
   */
  pluginFor(pluginId: string): MediaTypePlugin | null;
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
 * `group_metadata.source` for a row answered without ever asking a provider
 * — no plugin, no hooks, a query the plugin declined to build, an empty
 * query list, or a row the worker gave up retrying. Deliberately not
 * `'none'`: that string already means something in this table (`state =
 * 'none'`), and `source = 'none', state = 'none'` would read as a tautology
 * rather than telling anyone anything. `'unasked'` shares a column with
 * `metadata_candidates.source` and `discovered_sites.source`, both of which
 * only ever hold a provider's name today — it has to mean the same thing
 * there too, not just here: no provider was ever consulted for this answer.
 */
const UNASKED_SOURCE = 'unasked';

/**
 * Answers a row the worker can never look up — no plugin, no hooks, an
 * unbuildable or empty query, or one that has exhausted its retries — as
 * `state = 'none'`. Leaving such a row queued would mean it is retried, and
 * fails to be answered, on every single pass forever.
 *
 * Exported so the HTTP layer can settle the same question the same way: a
 * request to look up a group this worker could never answer must not leave a
 * row in `metadata_queue` for the worker to discard on its next pass.
 */
export function answerUnaskable(db: DatabaseSync, groupId: number, now: number): void {
  recordMetadataAnswer(db, { groupId, source: UNASKED_SOURCE, confirmed: null, nearMisses: [], now });
}

/** Whether `runMetadataPass` could ever answer this group, short of asking a provider. */
export type MetadataAnswerability = 'askable' | 'unaskable';

/**
 * Whether a group is worth a `metadata_queue` row at all.
 *
 * Mirrors the early exits `lookUpOne` takes *before* it ever calls
 * `client.searchScenes`: no plugin, a plugin missing either metadata hook, a
 * query the plugin declines to build (`null`), or a query with nothing to
 * search for. Every one of those is answered `'none'` by `lookUpOne` itself
 * without spending a request — so a caller that queued the same group would
 * only be handing the worker a row it can only immediately discard.
 *
 * A plugin that *throws* building the query is deliberately treated as
 * `'askable'`, not `'unaskable'`: that is the transient-or-deterministic-fault
 * case `deferOrGiveUp` already handles by retrying (and eventually giving up
 * after `MAX_METADATA_ATTEMPTS`), and a row worth retrying is a row worth
 * queueing.
 */
export function metadataAnswerability(
  plugin: MediaTypePlugin | null,
  group: { identityKey: string; display: string },
): MetadataAnswerability {
  if (plugin === null || plugin.metadataQuery === undefined || plugin.confirmMetadata === undefined) {
    return 'unaskable';
  }
  const built = safeMetadataQuery(plugin, group);
  if ('error' in built) return 'askable';
  if (built.query === null || built.query.queries.length === 0) return 'unaskable';
  return 'askable';
}

/**
 * Runs `plugin.metadataQuery`/`plugin.confirmMetadata` under a guard, the way
 * `ingest.ts`'s `prepareSafely` guards `parse`. Both are third-party code
 * reached from a queue row that persists across passes, so a throw here must
 * become a deferral — the retry that follows costs one row's backoff, while
 * treating it as an answer would discard information (a bug or a transient
 * issue in the plugin) permanently, and letting it propagate would abort
 * every row still waiting behind this one. A deterministic throw (a plugin
 * bug, or `display` that can never parse) does not loop forever either:
 * `deferOrGiveUp` below still counts these deferrals toward the attempts
 * ceiling.
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
 * What happened to one queued row. `cooldownUntil` is independent of `kind`:
 * a row can be given up on *and* still be the one that just proved the
 * service is rate limited, in which case the pass must still stop, even
 * though this particular row will not be retried again.
 */
interface RowOutcome {
  kind: 'confirmed' | 'none' | 'deferred';
  cooldownUntil: number | null;
}

/**
 * Defers a row, unless it has now failed `MAX_METADATA_ATTEMPTS` times, in
 * which case it is answered `'none'` instead so it stops costing a `perTick`
 * slot on every pass forever. Either way this is a fresh statement — not
 * nested inside whatever transaction the caller may just have watched fail
 * — so it commits even when the failure that led here rolled its own
 * transaction back.
 */
function deferOrGiveUp(
  deps: MetadataPassDeps,
  row: MetadataQueueRow,
  now: number,
  message: string,
  nextAt: number,
  cooldownUntil: number | null = null,
): RowOutcome {
  const attemptsAfter = row.attempts + 1;
  if (attemptsAfter >= MAX_METADATA_ATTEMPTS) {
    deps.log(
      `metadata pass: group ${row.groupId} given up after ${attemptsAfter} attempts: ${message}`,
    );
    answerUnaskable(deps.db, row.groupId, now);
    return { kind: 'none', cooldownUntil };
  }
  deps.log(`metadata pass: group ${row.groupId} deferred (attempt ${attemptsAfter}): ${message}`);
  deferMetadata(deps.db, row.groupId, message, nextAt);
  return { kind: 'deferred', cooldownUntil };
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

  for (const row of due) {
    result.looked += 1;

    let outcome: RowOutcome;
    try {
      // eslint-disable-next-line no-await-in-loop -- rows are answered one at a time, deliberately sequential
      outcome = await lookUpOne(deps, row, now);
    } catch (error) {
      // A database failure while answering or deferring this one row — a
      // constraint the row's own data trips, a full disk — must not take
      // the rest of the queue down with it, and must not leave the row
      // permanently first in line: `dueMetadataQueue` orders by
      // (requested_at, group_id), so a row whose attempts/next_at never
      // moved would abort every pass on the same row forever, and nothing
      // behind it would ever be looked at. `deferOrGiveUp` bumps them here,
      // outside whatever transaction just failed and rolled itself back.
      const message = (error as Error).message;
      outcome = deferOrGiveUp(deps, row, now, `unexpected failure: ${message}`, now + backoffFor(row.attempts));
    }

    // One call site, gated on having settled. `deferred` has not settled: the
    // row will be asked again, and a group whose scene lookup is still in
    // flight has not yet failed to produce a cast. A single site rather than
    // one per settle path for the reason `deriveUpgradeReleaseId` exists — an
    // invariant re-derived by whichever caller remembers is one that holds on
    // some paths. This is the only place *this pass* settles a row, so every
    // settle path within it inherits the enqueue. It is not the only place in
    // the codebase a row settles: `http/server.ts`'s `answerUnaskable` call
    // also settles a row (as `state = 'none'`) without enqueueing, and that
    // asymmetry is currently unresolved rather than deliberate.
    if (outcome.kind !== 'deferred') {
      enqueuePerformerSearch({ db: deps.db, pluginFor: deps.pluginFor, log: deps.log }, row.groupId, now);
    }

    if (outcome.kind === 'confirmed') result.confirmed += 1;
    else if (outcome.kind === 'none') result.none += 1;
    else result.deferred += 1;

    if (outcome.cooldownUntil !== null) {
      result.cooldownUntil = outcome.cooldownUntil;
      // A 429 means the whole pass is rate limited, not just this row.
      // Rows not yet reached keep their existing next_at and are picked up
      // normally once the cooldown passes; asking each of them anyway would
      // spend one request per row rediscovering a limit already known.
      break;
    }
  }

  deps.log(
    `metadata pass: ${result.confirmed} confirmed, ${result.none} none, ${result.deferred} deferred` +
      (result.cooldownUntil === null
        ? ''
        : `, cooldown until ${new Date(result.cooldownUntil).toISOString()}`),
  );

  return result;
}

/**
 * Wraps `runMetadataPass` with the cooldown a 429 sets, held here across
 * calls rather than discarded the instant one pass returns it — which is
 * what main.ts did before this existed: `MetadataPassResult.cooldownUntil`
 * was computed and then thrown away, so only the one row that hit the 429
 * was deferred. Every other due row kept its `next_at`, and the very next
 * tick spent another request rediscovering the same rate limit, forever.
 *
 * A tick inside the cooldown makes **no** provider request at all — it never
 * calls `runMetadataPass`, so `dueMetadataQueue` is never even read — and
 * logs that fact once per cooldown, not once per tick: a multi-hour cooldown
 * at a five-second `intervalSeconds` would otherwise write thousands of
 * identical lines.
 *
 * This is main.ts's closure, factored out so it can be driven directly by a
 * test rather than only indirectly through the whole scheduler.
 */
export function createMetadataRunner(deps: MetadataPassDeps): () => Promise<void> {
  let cooldownUntil = 0;
  let loggedSkip = false;
  return async () => {
    const now = deps.now();
    if (now < cooldownUntil) {
      if (!loggedSkip) {
        deps.log(
          `metadata pass: skipped, cooling down until ${new Date(cooldownUntil).toISOString()}`,
        );
        loggedSkip = true;
      }
      return;
    }
    loggedSkip = false;
    const result = await runMetadataPass(deps);
    // `?? 0` clears a cooldown that has already lapsed as readily as it holds
    // one that has not: a pass with nothing to report (`cooldownUntil: null`)
    // must not leave a stale cooldown from an earlier call still standing.
    cooldownUntil = result.cooldownUntil ?? 0;
  };
}

async function lookUpOne(deps: MetadataPassDeps, row: MetadataQueueRow, now: number): Promise<RowOutcome> {
  const group = getGroup(deps.db, row.groupId);
  // A missing group cannot happen through the foreign key `metadata_queue`
  // holds on `media_groups`, but a group whose plugin has since been removed
  // from config can — `pluginFor` answers null for that, same as a missing
  // group would if it somehow existed.
  const plugin = group === null ? null : deps.pluginFor(group.plugin);
  if (group === null || plugin === null) {
    answerUnaskable(deps.db, row.groupId, now);
    return { kind: 'none', cooldownUntil: null };
  }

  if (plugin.metadataQuery === undefined || plugin.confirmMetadata === undefined) {
    answerUnaskable(deps.db, row.groupId, now);
    return { kind: 'none', cooldownUntil: null };
  }

  const built = safeMetadataQuery(plugin, group);
  if ('error' in built) {
    return deferOrGiveUp(deps, row, now, built.error, now + backoffFor(row.attempts));
  }
  if (built.query === null) {
    answerUnaskable(deps.db, row.groupId, now);
    return { kind: 'none', cooldownUntil: null };
  }
  const query = built.query;

  if (query.queries.length === 0) {
    // No search string to try is the same as no query at all: answer it and
    // move on, rather than asking a bare `q=` that matches everything.
    answerUnaskable(deps.db, row.groupId, now);
    return { kind: 'none', cooldownUntil: null };
  }

  if (deps.client === undefined) {
    // Configured with no client is the same "nothing was learned" case a
    // network failure is: the row must be retried, not answered.
    return deferOrGiveUp(
      deps,
      row,
      now,
      'no metadata client configured',
      now + backoffFor(row.attempts),
    );
  }
  const client = deps.client;

  const siteId = query.siteName === undefined ? null : siteIdForName(deps.db, query.siteName);

  // Only the first query is ever tried, even though `MetadataQuery.queries`
  // is documented as a list to try in order until one confirms — the same
  // contract `siteCandidates`' `queries` uses. The scenes plugin returns
  // exactly one query today, so this is latent rather than broken, but it is
  // not yet honoured: a future plugin returning several must not assume the
  // rest are ever consulted. Trying them in sequence would multiply API
  // calls per group, which this worker deliberately does not do.
  const candidateQuery = query.queries[0]!;

  let candidates: readonly MetadataCandidate[];
  try {
    candidates = await client.searchScenes(candidateQuery, siteId);
  } catch (error) {
    if (error instanceof RateLimited) {
      // Read the clock again rather than reusing the pass's `now`: this
      // request may have taken a while, and a cooldown computed from a
      // stale timestamp would expire earlier than the provider intended.
      const cooldownUntil = deps.now() + error.retryAfterMs;
      return deferOrGiveUp(deps, row, now, error.message, cooldownUntil, cooldownUntil);
    }
    return deferOrGiveUp(deps, row, now, (error as Error).message, now + backoffFor(row.attempts));
  }

  const confirmation = safeConfirmMetadata(plugin, candidates, query);
  if ('error' in confirmation) {
    return deferOrGiveUp(deps, row, now, confirmation.error, now + backoffFor(row.attempts));
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
  // written, and `cacheImage` never throws, so nothing here can undo it.
  //
  // Skipped when a path is already stored, which is the same rule
  // `performersNeedingArtwork` applies to avatars twenty lines below, for the
  // same reason and now stated once for both. Without it, migration 7's
  // backfill spends one full image download per confirmed group in the
  // library to overwrite a byte-identical file: `cacheImage` keys the poster
  // on the group id alone, so a refetch of the same scene writes the same
  // bytes to the same name.
  //
  // The cost of the rule is that a poster the provider *moved* is not
  // re-fetched — the stored path still names the old file, which is stale
  // decoration rather than a wrong answer. Telling the two apart would mean
  // reading the previous `poster_url` before the upsert overwrites it, and
  // the same argument then applies to `face_url` and `image_url`; it is worth
  // doing for all three or none, and this branch is not the place to widen
  // it. The row's `poster_url` is kept current either way, so a future pass
  // has what it needs.
  const cachedPoster = getGroupMetadata(deps.db, row.groupId)?.posterPath ?? null;
  if (confirmed !== null && confirmed.posterUrl !== null && cachedPoster === null) {
    const posterPath = await cacheImage(deps.artwork, String(row.groupId), confirmed.posterUrl);
    if (posterPath !== null) setPosterPath(deps.db, row.groupId, posterPath);
  }

  // Performer artwork, on the same terms as the poster above: the answer is
  // already written, `cacheImage` never throws, and a missing avatar is not a
  // missing scene.
  //
  // `performersNeedingArtwork` and the per-kind check below guard different
  // things. The query's WHERE is an OR across the two url/path pairs, so it
  // skips only a performer who needs neither image — the common case, once
  // most of the table is already cached — sparing that performer the loop
  // below entirely. It still returns a performer who needs just one of the
  // two, because the OR is satisfied by either half. The per-kind `path !==
  // null` check is what stops that performer's *other*, already-cached half
  // from being fetched again: one url succeeding while the other 404s or
  // times out is an ordinary partial failure, not a hypothetical, and this
  // is the only thing standing between it and a repeat fetch every time a
  // later group names the same performer.
  const performerIds = (performersForGroups(deps.db, [row.groupId]).get(row.groupId) ?? [])
    .map((performer) => performer.id);
  for (const performer of performersNeedingArtwork(deps.db, performerIds)) {
    for (const kind of ['face', 'image'] as const) {
      const url = kind === 'face' ? performer.faceUrl : performer.imageUrl;
      const path = kind === 'face' ? performer.facePath : performer.imagePath;
      if (url === null || path !== null) continue;
      // Sequential on purpose: these are remote fetches against one provider,
      // and the pass already walks groups one at a time rather than opening
      // the throttle this file's cooldown logic exists to respect.
      // eslint-disable-next-line no-await-in-loop -- one provider, one group at a time; not batched on purpose
      const stored = await cacheImage(deps.artwork, performerArtworkKey(performer.id, kind), url);
      if (stored !== null) setPerformerArtwork(deps.db, performer.id, kind, stored);
    }
  }

  return { kind: confirmed === null ? 'none' : 'confirmed', cooldownUntil: null };
}
