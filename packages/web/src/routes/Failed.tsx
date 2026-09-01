import { useCallback, useEffect, useState } from 'react';
import { api, type ManualFieldsResponse } from '../api/client.ts';
// `FixForm` lives in `FailedCard.tsx` now, not here: its doc comment there is
// about why one form instance must never be shared between items, and this
// route still renders its own rows rather than that card until the tab that
// replaces this screen (see the module doc below).
import { FixForm } from '../components/FailedCard.tsx';
import { usePagedList } from '../api/usePagedList.ts';

/**
 * The names the parser refused, each with the reason and a way to describe it
 * by hand or to say it is never wanted.
 */
export function Failed() {
  const [fields, setFields] = useState<ManualFieldsResponse>({});
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rebuilt whenever the toggle changes, which is `usePagedList`'s signal to
  // start the list over from the first page.
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const page = await api.failed(cursor, includeDismissed);
      return { items: page.items, nextCursor: page.nextCursor };
    },
    [includeDismissed],
  );

  const { items, setItems, loading, done, loadMore, sentinelRef } = usePagedList(
    fetchPage,
    setError,
  );

  // The schemas are configuration, one map for every row on every page, so they
  // are fetched once for the screen rather than per item.
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
   * Drop the one row that was resolved. Refetching the first page instead would
   * discard every page loaded past it — the bug Browse had, where acting on a row
   * further down the list snapped it back to its original length. Pages now
   * arrive by scrolling, which only hides that failure: a list that silently
   * shortens gets scrolled again rather than noticed.
   */
  async function fix(itemId: number, values: Record<string, string>): Promise<void> {
    try {
      const { group, joinedExisting } = await api.resolveFeedItem(itemId, values);
      setItems((previous) => previous.filter((existing) => existing.id !== itemId));
      setEditing(null);
      setNotice(
        `${group.display.title} ${joinedExisting ? 'joined an existing group' : 'became a new group'}`,
      );
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  /**
   * Drop the row, or flip it to its dismissed state when dismissed rows are
   * being shown.
   *
   * Which of the two is right is exactly the question "Show dismissed" answers:
   * with it off the row no longer belongs on the list, and with it on it does —
   * reloading the page would bring it straight back, so filtering it out here
   * makes the screen disagree with a refresh, and puts the row's own `Dismissed`
   * badge out of reach on the only path that can produce it. The stamp is taken
   * from the response rather than invented locally, so the row carries the time
   * the server recorded.
   */
  async function dismiss(itemId: number): Promise<void> {
    try {
      const { dismissedAt } = await api.dismissFeedItem(itemId);
      setItems((previous) =>
        includeDismissed
          ? previous.map((existing) =>
              existing.id === itemId ? { ...existing, dismissedAt } : existing,
            )
          : previous.filter((existing) => existing.id !== itemId),
      );
      setNotice(null);
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Failed</h1>
      <label>
        <input
          type="checkbox"
          checked={includeDismissed}
          onChange={(event) => setIncludeDismissed(event.target.checked)}
        />
        Show dismissed
      </label>
      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && <p className="error">{error}</p>}

      <ul className="failed">
        {items.map((item) => {
          // A plugin with no manual hooks is *absent* from the map, and an item
          // whose feed has left configuration reports no plugin at all. Either
          // way there is no form to offer — but dismissing is core's own
          // bookkeeping, so it stays available.
          const schema = fields[item.plugin];
          return (
            <li key={item.id} className="failed-row">
              <h2>{item.rawTitle}</h2>
              <p className="failed-reason">{item.parseError}</p>
              <p className="failed-feed">Feed: {item.feedId}</p>

              <div className="failed-actions">
                {schema !== undefined && editing !== item.id && (
                  <button type="button" onClick={() => setEditing(item.id)}>
                    Fix…
                  </button>
                )}
                {item.dismissedAt === null ? (
                  <button type="button" onClick={() => void dismiss(item.id)}>
                    Dismiss
                  </button>
                ) : (
                  // Dismissing it again is a 409; it is listed at all only
                  // because "show dismissed" is how it stays fixable.
                  <span className="badge">Dismissed</span>
                )}
              </div>

              {schema !== undefined && editing === item.id && (
                <FixForm
                  item={item}
                  fields={schema}
                  onSubmit={(values) => void fix(item.id, values)}
                  onCancel={() => setEditing(null)}
                />
              )}
            </li>
          );
        })}
      </ul>

      {done && items.length === 0 && <p>Nothing failed to parse.</p>}

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
