/**
 * The settings screen's whole relationship with the replica: every
 * configured feed, kept current by `subscribeInserts` -- the same shape
 * `shell/useCounts.ts` and `library/useMediaItems.ts` already use for their
 * own reads (design spec §4).
 *
 * **One page, not a paged window.** Unlike `useMediaItems` (media items
 * arrive from lookups, unbounded) this hook reads the whole `rss_feed`
 * table in a single `listByTable` call, bounded by {@link FEEDS_LIMIT}. A
 * feed is something a person configures by hand, not something a plugin
 * produces in bulk, so a page far larger than any operator plausibly
 * reaches is a reasonable place to stop rather than a paging concern this
 * screen needs to solve today. If that assumption stops holding, this is
 * the one place to grow -- `library/Unmatched.tsx`'s own multi-page walk is
 * the pattern to follow.
 *
 * **Lists come from the replica only. There is no remote fallback**
 * (Global Constraint). This hook never calls `fetch`; `listByTable` and
 * `subscribeInserts` are the whole of what it is built on.
 */
import { useEffect, useState } from 'react';
import type { RssFeedSyncRead } from '@pickarr/contract';
import type { Store } from '../store/index.ts';
import type { StoredRow } from '../store/db.ts';

const TABLE = 'rss_feed';

/**
 * A single-page limit far larger than any host plausibly configures -- see
 * this file's docblock on why one page is enough for now.
 */
const FEEDS_LIMIT = 500;

/**
 * The two `Store` members this hook needs, and nothing else -- narrower
 * than `Store` itself so a test can hand it a bare database's `listByTable`
 * and `subscribeInserts` directly, the way `useCounts.test.tsx`'s
 * `sourceFor` does. A real `Store` satisfies this by structural assignment.
 */
export interface FeedsSource {
  listByTable: Store['listByTable'];
  subscribeInserts: Store['subscribeInserts'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The two fields this hook dereferences -- `name` for the heading and `url`
 * (already redacted by the host; see `RssFeedSyncRead`'s own doc) alongside
 * it -- and no more, matching `store/gather.ts`'s own predicates' rule of
 * checking exactly what a module reads off a row.
 */
function isRssFeed(value: unknown): value is RssFeedSyncRead {
  return isRecord(value) && typeof value.name === 'string' && typeof value.url === 'string';
}

function toFeeds(rows: readonly StoredRow[]): readonly RssFeedSyncRead[] {
  const result: RssFeedSyncRead[] = [];
  for (const row of rows) {
    if (isRssFeed(row.value)) result.push(row.value);
  }
  return result;
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed -- the same `InvalidStateError` shape
 * `shell/useCounts.ts`'s and `library/useMediaItems.ts`'s own
 * `isStoreClosed` guard, and for the same reason: this screen can still be
 * mounted and subscribed when the store it reads from stops (sign-out, a
 * 401). Anything else is rethrown.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * Every configured feed, newest first, re-read whenever one is added or
 * revived. `undefined` until the first read resolves -- distinct from an
 * empty array, which means "loaded, and there are none" (Global Constraint:
 * zero is an answer, and the two must not render the same way), matching
 * `library/Unmatched.tsx`'s own `rows` state.
 */
export function useFeeds(source: FeedsSource): readonly RssFeedSyncRead[] | undefined {
  const [feeds, setFeeds] = useState<readonly RssFeedSyncRead[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      const rows = await source.listByTable(TABLE, { direction: 'prev', limit: FEEDS_LIMIT });
      if (cancelled) return;
      setFeeds(toFeeds(rows));
    }

    function safeRefresh(): void {
      refresh().catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    }

    safeRefresh();
    const unsubscribe = source.subscribeInserts(TABLE, safeRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  return feeds;
}
