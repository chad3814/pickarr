import { useCallback, useEffect, useState } from 'react';
import { api, type ManualFieldsResponse } from '../api/client.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { FailedCard } from '../components/FailedCard.tsx';

/**
 * The names the parser refused that a person waved off. The open half of the
 * same failures shows up as cards in Browse's own list; this tab is only the
 * ones someone chose to set aside — reusing `FailedCard`, whose `Dismissed`
 * badge (in place of a Dismiss button) exists for exactly this list.
 */
export function Dismissed() {
  const [fields, setFields] = useState<ManualFieldsResponse>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (cursor: string | null) => {
    const page = await api.dismissed(cursor);
    return { items: page.items, nextCursor: page.nextCursor };
  }, []);

  const { items, setItems, loading, done, loadMore, sentinelRef } = usePagedList(
    fetchPage,
    setError,
  );

  // The schemas are configuration, one map for every card on every page, so
  // they are fetched once for the screen rather than per item.
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const next = await api.manualFields();
        if (!cancelled) setFields(next);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Drop the one card that was resolved. Refetching the first page instead
   * would discard every page loaded past it — see `usePagedList`'s own doc
   * comment.
   */
  async function fix(itemId: number, values: Record<string, string>): Promise<void> {
    try {
      const { group, joinedExisting } = await api.resolveFeedItem(itemId, values);
      setItems((previous) => previous.filter((existing) => existing.id !== itemId));
      setNotice(
        `${group.display.title} ${joinedExisting ? 'joined an existing group' : 'became a new group'}`,
      );
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Dismissed</h1>
      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && <p className="error">{error}</p>}

      {items.map((item) => (
        <FailedCard
          key={item.id}
          item={item}
          // A plugin with no manual hooks is *missing* from this map, and an
          // item whose feed has left configuration reports no plugin at all;
          // either way the card finds no schema and offers no editing.
          fields={fields[item.plugin]}
          onFix={(values) => void fix(item.id, values)}
          // Every item this tab lists already carries a `dismissedAt`, so
          // `FailedCard` never renders the Dismiss button that would call
          // this — dismissing only happens from Browse's own open cards.
          onDismiss={() => {}}
        />
      ))}

      {done && items.length === 0 && <p>Nothing dismissed.</p>}

      {!done && (
        <>
          {/* Coming into view is what asks for the next page. */}
          <div ref={sentinelRef} aria-hidden="true" />
          {loading && <p className="loading">Loading…</p>}
          {/*
            Kept, rather than replaced by the scrolling. An observer that never
            fires — a viewport too short to scroll, an odd zoom, a browser that
            reports nothing — would otherwise strand the reader with no way to
            ask for the rest, and it is the retry after a page that failed.
          */}
          <button type="button" onClick={loadMore} disabled={loading}>
            Load more
          </button>
        </>
      )}
    </section>
  );
}
