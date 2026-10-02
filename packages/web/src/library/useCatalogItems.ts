/**
 * One category's media items, newest first, filtered and searched through the
 * derived `catalog` store (design spec 2026-10-02 §3) -- the read behind the
 * Library page whenever a picked filter or a search term is set.
 *
 * **Why this hook exists beside `useMediaItems` rather than replacing it.**
 * The default view (`all`, no term) never pays a catalog read: it pages the
 * `rows` store directly through `useMediaItems` (design spec §3.3). This hook
 * is the other path, and returns the same {@link MediaItemsResult} so a page
 * can swap one for the other.
 *
 * **A catalog wake re-reads the whole window, not a page.** A record changing
 * can leave the filter (or the term's match) from anywhere in the window it
 * had occupied, and a record entering can land anywhere in it too, so a
 * cursor resume cannot reconcile either. `windowSizeRef` tracks how many
 * records the window has asked for in total, and a `subscribeCatalog` wake
 * re-issues that request from the top. Only `loadMore` resumes from a cursor,
 * and `windowGenerationRef` drops a page that resolves after a reload has
 * replaced the window it was appended to (`useMediaItems.ts` explains the
 * duplicate that otherwise appears).
 *
 * **The cursor is the last *record*, not the last item.** A record whose
 * `media_item` row is absent yields no item; resuming from the last item
 * would re-read that record forever.
 *
 * Reads come from the replica only: this hook never calls `fetch`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { Store } from '../store/index.ts';
import type { CatalogQuery, CatalogRecord, ListCatalogOptions } from '../store/catalog.ts';
import { isMediaItem, PAGE_SIZE, type MediaItemsResult } from './useMediaItems.ts';

export interface CatalogItemsSource {
  listCatalog: (query: CatalogQuery, opts: ListCatalogOptions) => Promise<readonly CatalogRecord[]>;
  getRows: Store['getRows'];
  subscribeCatalog: (cb: (ids: readonly number[]) => void) => () => void;
}

/** IndexedDB's complaint that the connection is already closed -- see `useMediaItems.ts`'s `isStoreClosed`. */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

interface Cursor {
  updatedAt: number;
  id: number;
}

function cursorFor(record: CatalogRecord | undefined): Cursor | undefined {
  return record === undefined ? undefined : { updatedAt: record.updatedAt, id: record.id };
}

/** `records`' media items in catalog order; a record with no usable `media_item` row is skipped. */
async function resolveItems(
  source: CatalogItemsSource,
  records: readonly CatalogRecord[],
): Promise<readonly MediaItemSyncRead[]> {
  const rows = await source.getRows('media_item', records.map((record) => record.id));
  return records.flatMap((record) => {
    const value = rows.get(record.id);
    return isMediaItem(value) ? [value] : [];
  });
}

export function useCatalogItems(
  source: CatalogItemsSource,
  query: CatalogQuery,
  pageSize: number = PAGE_SIZE,
): MediaItemsResult {
  const [items, setItems] = useState<readonly MediaItemSyncRead[]>([]);
  const [done, setDone] = useState(false);
  const [resolved, setResolved] = useState(false);

  const windowSizeRef = useRef(pageSize);
  const cursorRef = useRef<Cursor | undefined>(undefined);
  const loadingMoreRef = useRef(false);
  const windowGenerationRef = useRef(0);
  // The query the current effect run reads for; `loadMore` pages the same one.
  const queryRef = useRef(query);

  useEffect(() => {
    let cancelled = false;
    const effectQuery: CatalogQuery = { pluginId: query.pluginId, filter: query.filter, term: query.term };
    queryRef.current = effectQuery;
    windowSizeRef.current = pageSize;
    cursorRef.current = undefined;
    loadingMoreRef.current = false;
    windowGenerationRef.current += 1;
    setItems([]);
    setDone(false);
    setResolved(false);

    async function reloadWindow(): Promise<void> {
      const requested = windowSizeRef.current;
      const records = await source.listCatalog(effectQuery, { limit: requested });
      const resolvedItems = await resolveItems(source, records);
      if (cancelled) return;
      // Before the state writes, so a `loadMore` queued behind this one sees the new generation.
      windowGenerationRef.current += 1;
      setItems(resolvedItems);
      setDone(records.length < requested);
      cursorRef.current = cursorFor(records.at(-1));
      setResolved(true);
    }

    function safeReload(): void {
      reloadWindow().catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    }

    safeReload();
    const unsubscribe = source.subscribeCatalog(safeReload);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source, query.pluginId, query.filter, query.term, pageSize]);

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return;
    const cursor = cursorRef.current;
    if (cursor === undefined) return;
    loadingMoreRef.current = true;
    windowSizeRef.current += pageSize;
    const generation = windowGenerationRef.current;

    source
      .listCatalog(queryRef.current, { from: cursor, limit: pageSize })
      .then(async (records) => {
        const more = await resolveItems(source, records);
        // The window was replaced while this page was in flight and the
        // replacement already covers it; skip all three writes together.
        if (generation !== windowGenerationRef.current) return;
        setItems((current) => [...current, ...more]);
        setDone(records.length < pageSize);
        cursorRef.current = cursorFor(records.at(-1)) ?? cursor;
      })
      .catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      })
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [source, pageSize]);

  // `empty` means "no items and nothing more to page", not "the first page
  // had no items": a page of records whose `media_item` rows are absent
  // yields no items while `done` is still false and later pages may hold some.
  return { items, loadMore, done, empty: resolved && done && items.length === 0 };
}
