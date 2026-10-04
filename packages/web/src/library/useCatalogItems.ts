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
 * re-issues that request from the top. Wakes coalesce like `Unmatched`'s
 * refresh: one reload at a time, and any number of wakes during it cost one
 * further reload when it settles. Only `loadMore` resumes from a cursor,
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
import { isMediaItem, isStoreClosed, PAGE_SIZE, type MediaItemsResult } from './useMediaItems.ts';

export interface CatalogItemsSource {
  listCatalog: (query: CatalogQuery, opts: ListCatalogOptions) => Promise<readonly CatalogRecord[]>;
  getRows: Store['getRows'];
  subscribeCatalog: (cb: (ids: readonly number[]) => void) => () => void;
}

interface Cursor {
  updatedAt: number;
  id: number;
}

function cursorFor(record: CatalogRecord | undefined): Cursor | undefined {
  return record === undefined ? undefined : { updatedAt: record.updatedAt, id: record.id };
}

/** `MediaItemsResult` plus the catalog records behind the items, keyed by item id -- the grid reads its image ids from these. */
export interface CatalogItemsResult extends MediaItemsResult {
  records: ReadonlyMap<number, CatalogRecord>;
}

/** `records`' media items in catalog order, and the records themselves by id; a record with no usable `media_item` row contributes to neither. */
async function resolveItems(
  source: CatalogItemsSource,
  records: readonly CatalogRecord[],
): Promise<{ items: readonly MediaItemSyncRead[]; records: ReadonlyMap<number, CatalogRecord> }> {
  const rows = await source.getRows('media_item', records.map((record) => record.id));
  const items: MediaItemSyncRead[] = [];
  const byId = new Map<number, CatalogRecord>();
  for (const record of records) {
    const value = rows.get(record.id);
    if (!isMediaItem(value)) continue;
    items.push(value);
    byId.set(record.id, record);
  }
  return { items, records: byId };
}

export function useCatalogItems(
  source: CatalogItemsSource,
  query: CatalogQuery,
  pageSize: number = PAGE_SIZE,
): CatalogItemsResult {
  const [items, setItems] = useState<readonly MediaItemSyncRead[]>([]);
  const [records, setRecords] = useState<ReadonlyMap<number, CatalogRecord>>(new Map());
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
    setRecords(new Map());
    setDone(false);
    setResolved(false);

    async function reloadWindow(): Promise<void> {
      const requested = windowSizeRef.current;
      const page = await source.listCatalog(effectQuery, { limit: requested });
      const resolvedPage = await resolveItems(source, page);
      if (cancelled) return;
      // Before the state writes, so a `loadMore` queued behind this one sees the new generation.
      windowGenerationRef.current += 1;
      setItems(resolvedPage.items);
      setRecords(resolvedPage.records);
      setDone(page.length < requested);
      cursorRef.current = cursorFor(page.at(-1));
      setResolved(true);
    }

    // Wakes coalesce; they do not queue (`Unmatched.tsx`'s `makeRefresh`
    // explains the same shape). A wake during an in-flight reload sets
    // `dirty` instead of starting a second read, and one more reload runs
    // when the first settles: the one in flight may have started before the
    // change committed, so it cannot be trusted to have seen it. That is also
    // what keeps two reloads from resolving out of order and leaving the
    // older answer on screen.
    let reloading = false;
    let dirty = false;
    function safeReload(): void {
      if (reloading) {
        dirty = true;
        return;
      }
      reloading = true;
      reloadWindow()
        .catch((err: unknown) => {
          if (isStoreClosed(err)) return;
          throw err;
        })
        .finally(() => {
          reloading = false;
          if (!dirty) return;
          dirty = false;
          if (!cancelled) safeReload();
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
      .then(async (page) => {
        const more = await resolveItems(source, page);
        // The window was replaced while this page was in flight and the
        // replacement already covers it; skip all four writes together.
        if (generation !== windowGenerationRef.current) return;
        setItems((current) => [...current, ...more.items]);
        setRecords((current) => new Map([...current, ...more.records]));
        setDone(page.length < pageSize);
        cursorRef.current = cursorFor(page.at(-1)) ?? cursor;
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
  return { items, records, loadMore, done, empty: resolved && done && items.length === 0 };
}
