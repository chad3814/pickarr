/**
 * `Host.retryLookup`: asking for a release to be identified again.
 *
 * **The engine already expected this to exist.** `openmetadata`'s
 * `applyEnvelope` marks a name it did not recognise `unresolved` and
 * enqueues nothing, and says why in its own comment: "the state a human
 * might fix. Nothing is enqueued -- a retry happens on request." This is
 * that request, and until now there was no way to make it.
 *
 * **It needs no new plugin contract, because `onNewRssItems` already means
 * "identify these".** Re-notifying a release the host has seen before is
 * safe by construction rather than by luck: the lookup table's insert is
 * `onConflictDoNothing`, so an existing row keeps its history, and the job
 * that follows sends a **fresh** batch request keyed on the filename. It
 * does not re-poll the dead lookup -- `lookupId` is read only by the poll
 * handler, which is enqueued separately. So a retry really is a new
 * question to the service, not a second look at the old answer.
 *
 * **Two refusals are checked here and one is not.** Whether the release
 * exists, and whether it is still unmatched, are conditions this module
 * reads directly: both are one column of one row, and answering them
 * before dispatching is what keeps a retry from quietly re-identifying
 * something that already has a media item. Whether any plugin owns the
 * release is *not* checked here -- `notifyNewRssItems` already decides it,
 * reports it as `unowned`, and would have to be asked twice otherwise.
 * That is `clients/pick.ts`'s rule applied here: a condition belongs to
 * whichever code already discovers it.
 *
 * **A plugin that throws is not a refusal.** `notifyNewRssItems` collects
 * a rejecting plugin into `failures` rather than throwing, but for a
 * single-release retry there is nothing partial to report: the work did
 * not happen, and the cause is a fault in the plugin rather than something
 * the operator got wrong. It is rethrown so it reaches the API's outermost
 * handler as a 500, on the same reasoning `clients/pick.ts` gives for
 * rethrowing an error it does not recognise -- answering 4xx would tell an
 * operator their request was refused when nothing had been decided.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RetryLookupRefusalCode } from '@pickarr/contract';
import type { NotifyOutcome } from '../host.ts';

/**
 * Why a retry could not be dispatched.
 *
 * The three codes come from `@pickarr/contract`'s
 * `RETRY_LOOKUP_REFUSALS` rather than being spelled again here -- that
 * list's own doc says what each means and why two of them share a
 * spelling with a pick's. A second spelling drifts silently, because
 * renaming one half reddens only that half's tests.
 */
export interface RetryLookupRefusal {
  readonly refusal: RetryLookupRefusalCode;
}

export type RetryLookupOutcome = { readonly accepted: true } | RetryLookupRefusal;

export interface RetryLookupDeps {
  readonly raw: DatabaseSync;
  /** `Host.notifyNewRssItems`, which owns the grouping and the dispatch. */
  readonly notify: (ids: readonly number[]) => Promise<NotifyOutcome>;
}

/**
 * The release's `media_item_id`, or `undefined` when no such row exists.
 *
 * Two questions from one read, because they are two answers to the same
 * `SELECT` and splitting them would mean two round trips and a window
 * between them.
 */
function linkOf(raw: DatabaseSync, rssItemId: number): { linked: boolean } | undefined {
  const row = raw.prepare('SELECT media_item_id FROM rss_item WHERE id = ?').get(rssItemId);
  if (row === undefined) return undefined;
  // `'media_item_id' in row`, not a cast: `node:sqlite` types a row as
  // `Record<string, SQLOutputValue>` and the no-cast rule applies here as
  // everywhere.
  const linked = 'media_item_id' in row && row.media_item_id !== null;
  return { linked };
}

export async function retryLookup(deps: RetryLookupDeps, rssItemId: number): Promise<RetryLookupOutcome> {
  const existing = linkOf(deps.raw, rssItemId);
  if (existing === undefined) return { refusal: 'unknown-release' };
  if (existing.linked) return { refusal: 'already-matched' };

  const outcome = await deps.notify([rssItemId]);
  if (outcome.unowned.includes(rssItemId)) return { refusal: 'plugin-not-registered' };

  // One id in, so at most one failure out, and it is this release's.
  const failure = outcome.failures[0];
  if (failure !== undefined) throw failure.error;

  return { accepted: true };
}
