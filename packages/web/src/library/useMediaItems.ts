/**
 * One category's media items, newest first, paged on demand and kept
 * current as rows arrive -- the read this slice's whole per-category screen
 * is built on (design spec §6, §7).
 *
 * **Newest first is `direction: 'prev'`, not `'next'`.** `by_table_plugin_updated`
 * (`store/db.ts`) orders ascending by `[table, pluginId, updatedAt, id]`, so a
 * `'next'` cursor walk starts at the oldest row. `'prev'` starts at the high
 * end of the range and walks down -- newest first -- which is what
 * `listByTablePlugin`'s own `direction` parameter is for (`store/rows.ts`).
 *
 * **The window, not the cursor, is what a live insert re-reads.** This hook
 * tracks how many rows the current window has asked for in total
 * (`windowSizeRef`, starting at `pageSize` and growing by `pageSize` on every
 * `loadMore`), and a `subscribeTouched` wake (an insert, an update or a delete -- a
 * tombstone is reported under `touched` only, so a dropped item leaves the
 * list live) re-issues *that* request from
 * the top (`from` absent) rather than resuming from wherever the last page
 * left off. A cursor-based resume on a wake would need to reconcile a page
 * boundary against rows the insert may have shifted underneath it; asking
 * for the same total again does not, matching `useCounts.ts`'s own "re-read
 * the whole thing" answer to the identical question. `loadMore` is the one
 * path that *does* resume from a cursor -- it has no reason to redo work a
 * wake-triggered reload would otherwise repeat on every keystroke of typing
 * "load more, load more, load more".
 *
 * **Lists come from the replica only. There is no remote fallback**
 * (Global Constraint; storage design spec §9). This hook never calls
 * `fetch` -- `listByTablePlugin` and `subscribeTouched` are the whole of
 * what it is built on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { Store } from '../store/index.ts';
import type { StoredRow } from '../store/db.ts';

/**
 * A screenful, and nothing more. Task 7 uses the same constant, so it is
 * exported here rather than written twice.
 */
export const PAGE_SIZE = 24;

const TABLE = 'media_item';

/**
 * The two `Store` members this hook needs, and nothing else -- narrower than
 * `Store` itself so a test can bind it to a bare database directly, the way
 * `useCounts.test.tsx`'s `sourceFor` does. A real `Store` satisfies this by
 * structural assignment.
 */
export interface MediaItemsSource {
  listByTablePlugin: Store['listByTablePlugin'];
  subscribeTouched: Store['subscribeTouched'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The same shape `store/gather.ts`'s own `isMediaItem` checks -- the one
 * field this hook dereferences beyond the envelope (`pluginId`), and no
 * more. A row `by_table_plugin_updated` returns already carries a matching
 * `value.pluginId` (a tombstone has no `value` at all and is index-invisible
 * per that index's own doc), so this exists to decline a malformed row
 * rather than to filter by category a second time.
 */
export function isMediaItem(value: unknown): value is MediaItemSyncRead {
  return isRecord(value) && typeof value.pluginId === 'string';
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed -- the same `InvalidStateError` shape
 * `shell/useCounts.ts`'s `isStoreClosed` and `useGatheredItem.ts`'s own
 * check guard against, for the identical reason: a category screen can still
 * be mounted and subscribed when the store it reads from stops (sign-out, a
 * 401). Anything else is rethrown.
 */
export function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/** `row.value` if it matches {@link isMediaItem}, else `undefined` -- narrowed directly rather than cast, so a row a future wire-shape change no longer matches is declined instead of forwarded (`store/gather.ts`'s own reasoning for the same predicate shape). */
function asMediaItem(row: StoredRow): MediaItemSyncRead | undefined {
  return isMediaItem(row.value) ? row.value : undefined;
}

function toMediaItems(rows: readonly StoredRow[]): readonly MediaItemSyncRead[] {
  const result: MediaItemSyncRead[] = [];
  for (const row of rows) {
    const item = asMediaItem(row);
    if (item !== undefined) result.push(item);
  }
  return result;
}

/** The key {@link ListByTableOptions.from} names for `row`, or `undefined` when `row` is absent or does not match {@link isMediaItem} -- the boundary `loadMore` resumes from, and the same reason it can go missing as {@link asMediaItem}'s. */
function cursorFor(row: StoredRow | undefined): { updatedAt: number; id: number } | undefined {
  if (row === undefined) return undefined;
  const item = asMediaItem(row);
  return item === undefined ? undefined : { updatedAt: item.updatedAt, id: row.id };
}

export interface MediaItemsResult {
  items: readonly MediaItemSyncRead[];
  loadMore: () => void;
  done: boolean;
  /**
   * `false` until the first page has resolved, and distinct from
   * `items.length === 0` even after: a category that resolved with rows is
   * never `empty`, and a category that has not resolved yet is never
   * `empty` either, no matter how long that takes. "Nothing here yet" and
   * "still loading" would otherwise render as the same blank region.
   */
  empty: boolean;
}

/**
 * `pluginId`'s media items, newest first. `pageSize` defaults to
 * {@link PAGE_SIZE} and exists as a parameter so a test can page in twos
 * without seeding two dozen rows.
 */
export function useMediaItems(
  source: MediaItemsSource,
  pluginId: string,
  pageSize: number = PAGE_SIZE,
): MediaItemsResult {
  const [items, setItems] = useState<readonly MediaItemSyncRead[]>([]);
  const [done, setDone] = useState(false);
  const [resolved, setResolved] = useState(false);

  // How many rows the current window has asked for in total, and where the
  // next `loadMore` resumes from. Refs, not state: neither is itself
  // rendered, and both must be readable inside `loadMore` and inside the
  // `subscribeTouched` callback without either closing over a stale render.
  const windowSizeRef = useRef(pageSize);
  const cursorRef = useRef<{ updatedAt: number; id: number } | undefined>(undefined);

  /**
   * Whether a `loadMore` request is already in flight. A ref, not state,
   * for the same reason `cursorRef` is: `loadMore` itself must read and set
   * it without waiting on a render.
   *
   * **A real defect this guards, not a theoretical one (review-found).** A
   * second click before the first page resolves used to fire a second
   * request from the *same* cursor -- both requests answer the same page,
   * and both `.then` handlers append it, producing a duplicate row (and a
   * duplicate React key). The cursor itself recovers on the next click
   * (both handlers advance it to the same next boundary), but `items` does
   * not: nothing removes the row the second handler already appended.
   * Guarding the call itself, so the second click is a no-op, is what
   * keeps `items` from seeing that request at all.
   *
   * **This guards re-entrant calls and nothing else**, which is why
   * {@link windowGenerationRef} exists alongside it.
   */
  const loadingMoreRef = useRef(false);

  /**
   * Bumped every time the window is replaced from the top -- by `apply`
   * below, and by this effect re-running for a new `source`/`pluginId`.
   * `loadMore` captures it before issuing its request and discards the
   * answer if it has moved since.
   *
   * **A second real defect, and the one `loadingMoreRef` above cannot
   * reach (whole-branch review §2).** That ref stops a second *call*; it
   * says nothing about a page resolving into a list that was replaced
   * underneath it. A live `media_item` insert arriving while a page is in
   * flight wakes `reloadWindow`, which re-reads the *whole* window --
   * `windowSizeRef` was already grown by the `loadMore` that is still in
   * flight, so the reload's answer already contains that page. The held
   * `.then` then appended it a second time: measured as
   * ['Brand New','Newest','Middle','Oldest','Oldest'] with a React
   * duplicate-key warning, and `setDone` from the same held page removed
   * "Load more" at the same moment, leaving the duplicate and no way past
   * it. Not theoretical: this branch's own `SCHEMA_VERSION` bump forces
   * every client through a resync, which is a continuous stream of exactly
   * those inserts.
   *
   * Discarding is right rather than merely safe: the reload that bumped
   * this already asked for, and answered with, everything the held page
   * was going to add.
   */
  const windowGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    windowSizeRef.current = pageSize;
    cursorRef.current = undefined;
    loadingMoreRef.current = false;
    windowGenerationRef.current += 1;
    setItems([]);
    setDone(false);
    setResolved(false);

    function apply(rows: readonly StoredRow[], requested: number): void {
      if (cancelled) return;
      // Before the state writes, so a `loadMore` whose `.then` is already
      // queued behind this one still sees the new generation.
      windowGenerationRef.current += 1;
      setItems(toMediaItems(rows));
      setDone(rows.length < requested);
      cursorRef.current = cursorFor(rows.at(-1));
      setResolved(true);
    }

    /** Re-reads the whole current window from the top -- see this file's own doc on why a wake resumes from `from: undefined` rather than from `cursorRef`. */
    async function reloadWindow(): Promise<void> {
      const requested = windowSizeRef.current;
      const rows = await source.listByTablePlugin(TABLE, pluginId, { direction: 'prev', limit: requested });
      apply(rows, requested);
    }

    function safeReload(): void {
      reloadWindow().catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    }

    safeReload();
    const unsubscribe = source.subscribeTouched(TABLE, safeReload);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source, pluginId, pageSize]);

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return; // a request is already in flight; a second click is a no-op (see loadingMoreRef's own doc)
    const cursor = cursorRef.current;
    if (cursor === undefined) return; // already exhausted, or the first page has not resolved yet
    loadingMoreRef.current = true;
    windowSizeRef.current += pageSize;
    const generation = windowGenerationRef.current;

    source
      .listByTablePlugin(TABLE, pluginId, { direction: 'prev', from: cursor, limit: pageSize })
      .then((rows) => {
        // The window was replaced while this page was in flight, and the
        // replacement already covers it -- see `windowGenerationRef`. All
        // three writes are skipped together: appending would duplicate a
        // row, `setDone` would strand the list on a short held page, and
        // `cursorRef` would clobber the boundary the reload just set.
        if (generation !== windowGenerationRef.current) return;
        setItems((current) => [...current, ...toMediaItems(rows)]);
        setDone(rows.length < pageSize);
        cursorRef.current = cursorFor(rows.at(-1)) ?? cursor;
      })
      .catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      })
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [source, pluginId, pageSize]);

  return { items, loadMore, done, empty: resolved && items.length === 0 };
}
