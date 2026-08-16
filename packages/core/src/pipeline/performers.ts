import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin, MetadataPerformer } from '@pickarr/plugin-api';
import { RateLimited, type PerformerLookupClient } from '../clients/theporndb.ts';
import { getGroup } from '../db/groups.ts';
import {
  deferPerformerSearch,
  duePerformerQueue,
  groupHasCast,
  insertPerformerSearch,
  removePerformerSearch,
  type PerformerQueueRow,
} from '../db/performer-queue.ts';
import { setGroupPerformers, upsertPerformers } from '../db/performers.ts';
import { backoffFor } from './metadata.ts';
import { pickPerformer } from './pick-performer.ts';

export interface PerformerEnqueueDeps {
  db: DatabaseSync;
  /**
   * Resolves the plugin a group's `plugin` column names. `null` for a plugin no
   * longer configured — a normal outcome, not a bug: a plugin can be removed
   * from config after groups it created already exist.
   */
  pluginFor(pluginId: string): MediaTypePlugin | null;
  log(message: string): void;
}

/**
 * What to search a performer directory for on behalf of one group, or `null`
 * when there is nothing worth asking.
 *
 * Exported because the pass needs the same answer the enqueue acted on, and a
 * pass re-deriving it from the plugin would be this rule spelled twice — the
 * duplication `deriveUpgradeReleaseId` exists in this codebase to prevent. Both
 * callers ask here.
 *
 * A plugin throwing is a log line and a `null`, never a throw of our own. The
 * caller is a loop over settled rows inside `runMetadataPass`, and a plugin bug
 * must cost one group its search rather than aborting a pass that has other rows
 * to answer — the same treatment `safeMetadataQuery` gives `metadataQuery`.
 */
export function performerQueryFor(deps: PerformerEnqueueDeps, groupId: number): string | null {
  const group = getGroup(deps.db, groupId);
  if (group === null) return null;

  const plugin = deps.pluginFor(group.plugin);
  if (plugin?.performerQuery === undefined) return null;

  try {
    const display = JSON.parse(group.display) as DisplayFields;
    const query = plugin.performerQuery({ identityKey: group.identityKey, display });
    return query === null || query.trim().length === 0 ? null : query.trim();
  } catch (error) {
    // `JSON.parse` and `plugin.performerQuery` share this one try/catch, so
    // this cannot say which of the two threw — a group with corrupt `display`
    // looks identical here to a genuine plugin bug. Naming both rather than
    // blaming the plugin is what keeps an operator from chasing innocent
    // plugin code when the real fault is a malformed stored row.
    deps.log(
      `performer enqueue: group ${groupId} skipped, building the query threw (plugin or malformed display): ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Queues one group, answering whether it queued.
 *
 * The two refusals the spec names are both here in effect, but only one is
 * enforced here: whether the plugin has anything to ask is this layer's question
 * because only this layer holds the registry, while "does the group already have
 * a cast" is pure SQL and stays inside `insertPerformerSearch`, where no future
 * caller can bypass it. `metadataAnswerability` sits on the same side of the
 * same line for the same reason.
 */
export function enqueuePerformerSearch(
  deps: PerformerEnqueueDeps,
  groupId: number,
  now: number,
): boolean {
  if (performerQueryFor(deps, groupId) === null) return false;
  return insertPerformerSearch(deps.db, groupId, now);
}

/**
 * How many failed attempts a queue row may accumulate before the pass gives up
 * on it and drops it rather than deferring it forever.
 *
 * Fifty, for the reason `MAX_METADATA_ATTEMPTS` documents: `backoffFor` — shared
 * with the metadata pass rather than copied — ramps to its six-hour cap in nine
 * attempts, so fifty spans roughly ten days past the ramp. Long enough that a
 * genuine multi-day provider outage still recovers once it clears, short enough
 * that a row poisoned by a deterministic fault stops consuming a `perTick` slot
 * four times a day forever.
 */
export const MAX_PERFORMER_ATTEMPTS = 50;

/**
 * Extends the enqueue deps rather than restating them: the pass calls
 * `performerQueryFor`, which needs exactly `db`, `pluginFor` and `log`.
 */
export interface PerformerPassDeps extends PerformerEnqueueDeps {
  client: PerformerLookupClient | undefined;
  perTick: number;
  now: () => number;
}

export interface PerformerPassResult {
  /** Queue rows this pass looked at, whether they ended up linked, unmatched or deferred. */
  looked: number;
  linked: number;
  unmatched: number;
  deferred: number;
  /** Set when a 429 stopped the pass early; the moment searches may resume. */
  cooldownUntil: number | null;
}

/**
 * Records the outcome of one search: links the performer if there is one, and
 * removes the queue row either way, in one transaction.
 *
 * **The castless check is re-done here, inside the transaction that writes.**
 * `insertPerformerSearch` already refused a group with a cast, but that was at
 * enqueue time and a metadata refetch can attach a real cast in the interval —
 * and `setGroupPerformers` deletes the group's rows before inserting, so a
 * one-name guess arriving late would *replace* a confirmed cast rather than lose
 * to it. Re-checking under the writing transaction is what makes that impossible
 * rather than merely unlikely.
 *
 * The row's removal is in the same transaction as the link for the same reason
 * `failDownload` transacts its two statements: nothing here awaits, so no reader
 * can observe the gap, but a process dying between them would leave a linked cast
 * still queued — and the next pass would spend a request re-linking it.
 *
 * The row goes whether or not anything was linked. A search that ran and matched
 * nothing **is** an answer, the rule `resolve-sites.ts` and `runMetadataPass`
 * both state; leaving it queued would spend one request per pass forever
 * rediscovering the same silence.
 */
function recordPerformerOutcome(
  deps: PerformerPassDeps,
  groupId: number,
  performer: MetadataPerformer | null,
  now: number,
): 'linked' | 'unmatched' {
  deps.db.exec('BEGIN');
  try {
    let linked = false;
    if (performer !== null && !groupHasCast(deps.db, groupId)) {
      const ids = upsertPerformers(deps.db, 'theporndb', [performer], now);
      setGroupPerformers(deps.db, groupId, ids);
      linked = true;
    }
    removePerformerSearch(deps.db, groupId);
    deps.db.exec('COMMIT');
    return linked ? 'linked' : 'unmatched';
  } catch (error) {
    deps.db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Defers a row, unless it has now failed `MAX_PERFORMER_ATTEMPTS` times, in
 * which case the row is removed so it stops costing a `perTick` slot forever.
 *
 * A fresh statement, not nested inside whatever transaction the caller may just
 * have watched fail — so it commits even when that transaction rolled itself
 * back. This is what stops a poison row (a constraint its own data trips, a full
 * disk) from being permanently first in line: `duePerformerQueue` orders by
 * `(requested_at, group_id)`, so a row whose attempts never moved would abort
 * every pass on the same row and nothing behind it would ever be looked at.
 * `runMetadataPass` documents having had exactly that defect.
 */
function deferOrGiveUp(
  deps: PerformerPassDeps,
  row: PerformerQueueRow,
  message: string,
  nextAt: number,
): void {
  const attemptsAfter = row.attempts + 1;
  if (attemptsAfter >= MAX_PERFORMER_ATTEMPTS) {
    deps.log(
      `performer pass: group ${row.groupId} given up after ${attemptsAfter} attempts: ${message}`,
    );
    removePerformerSearch(deps.db, row.groupId);
    return;
  }
  deps.log(`performer pass: group ${row.groupId} deferred (attempt ${attemptsAfter}): ${message}`);
  deferPerformerSearch(deps.db, row.groupId, message, nextAt);
}

/**
 * Drains up to `perTick` due rows: builds each group's query, searches, decides,
 * and links on an unambiguous match.
 *
 * Sequential, not concurrent, mirroring `runMetadataPass` and
 * `resolveSitesForBatch`: simpler, self-rate-limiting, and a pass this small has
 * nothing to gain from concurrency.
 *
 * The rule throughout is the one `resolveSitesForBatch` documents: a search that
 * ran and matched nothing is an answer, but a search that could not be *made*
 * learned nothing and must not be recorded as one.
 */
export async function runPerformerPass(deps: PerformerPassDeps): Promise<PerformerPassResult> {
  const result: PerformerPassResult = {
    looked: 0,
    linked: 0,
    unmatched: 0,
    deferred: 0,
    cooldownUntil: null,
  };

  const client = deps.client;
  if (client === undefined) return result;

  const now = deps.now();
  const due = duePerformerQueue(deps.db, now, deps.perTick);
  if (due.length === 0) return result;

  for (const row of due) {
    result.looked += 1;
    const query = performerQueryFor(deps, row.groupId);

    // The query is rebuilt each pass rather than stored, so it can have gone
    // away since the row was written — a title corrected by hand to one word.
    // That is not a failure to retry; there is nothing left to ask.
    if (query === null) {
      removePerformerSearch(deps.db, row.groupId);
      result.unmatched += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- rows are answered one at a time, deliberately sequential
      const page = await client.searchPerformers(query);
      if (page.truncated) {
        deps.log(
          `performer pass: group ${row.groupId} judged "${query}" on one page of ` +
            `${page.results.length}; the provider reported more`,
        );
      }
      const outcome = recordPerformerOutcome(
        deps, row.groupId, pickPerformer(query, page.results), now,
      );
      if (outcome === 'linked') result.linked += 1;
      else result.unmatched += 1;
    } catch (error) {
      if (error instanceof RateLimited) {
        // A rate limit is a fact about the service, not about this row: the row
        // keeps its next_at and is picked up normally once the cooldown clears.
        // Asking the rest anyway would spend one request per row rediscovering a
        // limit already known.
        result.cooldownUntil = now + error.retryAfterMs;
        break;
      }
      result.deferred += 1;
      // `now` and the backoff are both computed from the pass's captured clock
      // and passed in, matching `metadata.ts`'s own `deferOrGiveUp` signature.
      // Reading `deps.now()` again inside would stamp `next_at` from a later
      // instant than the row was judged at.
      deferOrGiveUp(deps, row, (error as Error).message, now + backoffFor(row.attempts));
    }
  }

  deps.log(
    `performer pass: ${result.linked} linked, ${result.unmatched} unmatched, ` +
      `${result.deferred} deferred` +
      (result.cooldownUntil === null
        ? ''
        : `, cooldown until ${new Date(result.cooldownUntil).toISOString()}`),
  );

  return result;
}

/**
 * Wraps `runPerformerPass` with the cooldown a 429 sets, held here across calls
 * rather than discarded the instant one pass returns it — the defect
 * `createMetadataRunner` documents main.ts having had, where only the one row
 * that hit the 429 was deferred and the very next tick spent another request
 * rediscovering the same rate limit, forever.
 *
 * A tick inside the cooldown makes **no** provider request at all — it never
 * calls `runPerformerPass`, so `duePerformerQueue` is never even read — and logs
 * that fact once per cooldown, not once per tick: a multi-hour cooldown at a
 * five-second `intervalSeconds` would otherwise write thousands of identical
 * lines.
 */
export function createPerformerRunner(deps: PerformerPassDeps): () => Promise<void> {
  let cooldownUntil = 0;
  let loggedSkip = false;
  return async () => {
    const now = deps.now();
    if (now < cooldownUntil) {
      if (!loggedSkip) {
        deps.log(
          `performer pass: skipped, cooling down until ${new Date(cooldownUntil).toISOString()}`,
        );
        loggedSkip = true;
      }
      return;
    }
    loggedSkip = false;
    const result = await runPerformerPass(deps);
    // `?? 0` clears a cooldown that has already lapsed as readily as it holds one
    // that has not: a pass with nothing to report (`cooldownUntil: null`) must
    // not leave a stale cooldown from an earlier call still standing.
    cooldownUntil = result.cooldownUntil ?? 0;
  };
}
