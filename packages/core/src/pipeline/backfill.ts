import type { DatabaseSync } from 'node:sqlite';
import type { FeedBackfillConfig, FeedConfig } from '../config/schema.ts';
import type { FeedEntry } from '../feeds/parse-rss.ts';
import type { IngestResult, IngestSource } from '../ingest/ingest.ts';
import {
  getBackfillPosition,
  saveBackfillPosition,
  type BackfillPosition,
} from '../db/feed-backfill.ts';

/**
 * The first page a walk asks for, and it is one rather than zero because page
 * zero is the page the live poll already requests every interval. Re-reading it
 * would spend a fetch on the freshest thing this install has, by construction.
 */
const FIRST_PAGE = 1;

export interface BackfillDeps {
  db: DatabaseSync;
  feeds: readonly FeedConfig[];
  fetchPage(feed: FeedConfig, page: number): Promise<FeedEntry[]>;
  /**
   * Files one page: whatever the live poll does before `ingestEntries` — site
   * resolution above all — and then the ingest itself. Async for that reason
   * rather than because ingest is; `ingestEntries` is synchronous.
   *
   * Backfilled titles must resolve their sites exactly as live ones do. Skipping
   * it to save provider calls would key an old group differently from a new one
   * and split a single scene across two groups, which is worse than being slow —
   * the reason `pagesPerPass` is the rate limit instead.
   *
   * Takes the source explicitly rather than defaulting it, so a pass that files
   * history through the live path is a type error here rather than a browse list
   * that silently reorders itself around scenes from 2019.
   */
  ingestPage(feed: FeedConfig, entries: FeedEntry[], source: IngestSource): Promise<IngestResult>;
  now: () => number;
  log(message: string): void;
}

/** Whether every guid on this page was on the page before it. */
function repeats(page: ReadonlySet<string>, previous: ReadonlySet<string>): boolean {
  for (const guid of page) {
    if (!previous.has(guid)) return false;
  }
  return true;
}

/**
 * Walks one feed's pagination as far as this pass is allowed to go.
 *
 * Stops for one of four reasons, and the position records which:
 *
 * - **`done`** — a page came back with no items. That is the only signal that
 *   honestly means "there is no more history". The issue proposed stopping when
 *   every item on a page was already known, and that rule cannot work: page one
 *   of a feed the poll has been reading is *entirely* known every time, so the
 *   walk would finish before it started. A page of known items is the expected
 *   case near the top and says nothing about what is below it.
 * - **`exhausted`** — `maxPages` reached. There is more; the cap stopped us.
 * - **`broken`** — consecutive pages carried the same items, so the indexer is
 *   ignoring the parameter. Checked *before* ingest, because after ingest it is
 *   indistinguishable from an ordinary page of already-known items — which is
 *   exactly how this failure stays silent without the check.
 * - the `pagesPerPass` allowance ran out, which is not a stop at all: the state
 *   stays `running` and the next pass picks up from the stored page.
 *
 * A throw from `fetchPage` or `ingestPage` propagates. The position for pages
 * already walked in this pass has been saved, and the page that failed has not,
 * so the next pass retries exactly it. That is the whole retry policy, and it is
 * enough for a walk with no deadline.
 */
async function walkOne(
  deps: BackfillDeps,
  feed: FeedConfig,
  config: FeedBackfillConfig,
): Promise<void> {
  const stored = getBackfillPosition(deps.db, feed.id);
  if (stored !== null && stored.state !== 'running') return;

  let position: BackfillPosition =
    stored ?? { feedId: feed.id, nextPage: FIRST_PAGE, pagesRead: 0, state: 'running', detail: null };

  const save = (next: BackfillPosition): void => {
    position = next;
    saveBackfillPosition(deps.db, next, deps.now());
  };

  // Only ever holds a page fetched during *this* pass, which is why
  // `pagesPerPass` has a floor of two: with one page per pass there would never
  // be a previous page to compare against and the guard would never run.
  let previous: ReadonlySet<string> | null = null;

  for (let walked = 0; walked < config.pagesPerPass; walked += 1) {
    if (position.pagesRead >= config.maxPages) {
      save({
        ...position,
        state: 'exhausted',
        detail: `stopped at the maxPages cap of ${String(config.maxPages)}`,
      });
      return;
    }

    const page = position.nextPage;
    const entries = await deps.fetchPage(feed, page);

    if (entries.length === 0) {
      save({
        ...position,
        state: 'done',
        detail: `page ${String(page)} came back with no items`,
      });
      return;
    }

    const guids = new Set(entries.map((item) => item.guid));
    if (previous !== null && repeats(guids, previous)) {
      const parameter = config.style === 'newznab' ? 'offset' : 'page';
      save({
        ...position,
        state: 'broken',
        detail: `page ${String(page)} repeated page ${String(page - 1)}; the indexer ignored ${parameter}`,
      });
      return;
    }
    previous = guids;

    await deps.ingestPage(feed, entries, 'backfill');
    save({ ...position, nextPage: page + 1, pagesRead: position.pagesRead + 1 });
  }
}

/**
 * The pass, shaped as a closure over its deps like `createMetadataRunner`, so a
 * test can drive it directly without a scheduler.
 *
 * One feed's failure does not end the pass for the others, matching
 * `ingestAllNow`'s per-feed `catch`: a single indexer being down is not a reason
 * to stop backfilling everything else.
 */
export function createBackfillRunner(deps: BackfillDeps): () => Promise<void> {
  return async () => {
    for (const feed of deps.feeds) {
      // A feed with no `backfill` block has not opted in, and this is the only
      // gate: the feature is inert on every existing install until somebody
      // writes that block by hand.
      if (feed.backfill === undefined) continue;
      try {
        await walkOne(deps, feed, feed.backfill);
      } catch (error) {
        deps.log(`backfill ${feed.id}: ${(error as Error).message}`);
      }
    }
  };
}
