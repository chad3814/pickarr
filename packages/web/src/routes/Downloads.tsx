import { useCallback, useEffect, useState } from 'react';
import { api, type DownloadView, type UntrackedEntry } from '../api/client.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { matchesTerm } from '../api/search.ts';
import { DownloadRow } from '../components/DownloadRow.tsx';
import { SearchBox } from '../components/SearchBox.tsx';

const POLL_MS = 3000;

/**
 * Page one landing on top of whatever the reader has already scrolled to.
 *
 * Two jobs, and the second is the one that matters: rows the poll has *not*
 * seen are left exactly where they are. Appending page one instead would grow
 * the list by thirty rows four times a minute, and replacing the list with it
 * would throw away every page past the first — the failure `usePagedList`'s
 * doc comment forbids, which shipped once already on Browse.
 *
 * New rows go in front rather than at the back because the list is
 * `created_at DESC` and page one is the newest rows: a download picked while
 * the tab was open belongs above everything, not below the page the reader
 * scrolled to.
 */
function mergeNewestPage(previous: DownloadView[], page: DownloadView[]): DownloadView[] {
  const fresh = new Map(page.map((download) => [download.id, download]));
  const known = new Set(previous.map((download) => download.id));
  return [
    ...page.filter((download) => !known.has(download.id)),
    ...previous.map((download) => fresh.get(download.id) ?? download),
  ];
}

/**
 * Polls while mounted. Deliberately not SSE: a useEffect beats a subscription
 * protocol, a reconnect story, and a broadcast bus for one screen.
 *
 * The poll covers page one only, which is the trade issue #31 makes: a status
 * change on a row the reader has scrolled *past* is no longer picked up by it.
 * The list is `created_at DESC`, so everything in flight is at the top and a
 * row leaves page one only once thirty newer downloads exist; the one
 * older-row transition a reader triggers themselves is a retry, and that is
 * patched from the retry's own response rather than waited for.
 */
export function Downloads() {
  const [untracked, setUntracked] = useState<UntrackedEntry[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Never rebuilt: nothing this screen holds changes which rows the server
  // should answer with, so the list is never started over. That is why the
  // search term below does not go into these dependencies — see the filter's
  // own comment.
  const fetchPage = useCallback(async (cursor: string | null) => {
    const page = await api.downloads(cursor);
    // Carried on every page rather than fetched separately: the server sends
    // the client's live queue whole with each one, because there is no cheaper
    // moment to send it and no second route that would answer it.
    setUntracked(page.untracked);
    return { items: page.tracked, nextCursor: page.nextCursor };
  }, []);

  const { items, setItems, loading, done, loadMore, sentinelRef } = usePagedList(
    fetchPage,
    setError,
  );

  // No immediate call here, unlike the poll this replaced: `usePagedList` loads
  // page one on mount, and firing again from this effect would mean two
  // requests for the same page every time the screen opens.
  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const page = await api.downloads(null);
        if (cancelled) return;
        setUntracked(page.untracked);
        setItems((previous) => mergeNewestPage(previous, page.tracked));
        setError(null);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [setItems]);

  /**
   * A rejection here used to go nowhere: the call site is `void retry(id)`, so
   * a refused retry (409 on a row that is no longer `failed`, a 404, a dropped
   * connection) left the button looking like it had done nothing at all.
   *
   * A retry that is *accepted* and then fails again on the next reconcile tick
   * still looks like nothing happened — the row returns to `failed` inside one
   * poll interval. That is the retry working and the underlying fault
   * repeating, and the row's error message is where it says so.
   *
   * Patched from the response, not by refetching. The refetch this replaces
   * was a whole unpaginated `/api/downloads`; page one is what that would be
   * now, and a retried row deep in the list is exactly the row page one no
   * longer holds — so the refetch would have stopped answering the question it
   * was there to answer. The response already carries the updated row, so this
   * is also one request fewer.
   */
  async function retry(downloadId: number): Promise<void> {
    try {
      const updated = await api.retry(downloadId);
      setItems((previous) =>
        previous.map((download) => (download.id === updated.id ? updated : download)),
      );
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  /**
   * The rows the box leaves on screen, both halves of the list.
   *
   * Still filtered here rather than by asking the server, and that is now a
   * narrower claim than it used to be. `/api/downloads` is paginated, so the
   * term reaches the pages that have been loaded rather than every row the
   * table holds — it reaches the rest as they load, since an empty filtered
   * list leaves the sentinel in view and the next page is asked for. Moving
   * the term into `?q=` is the remaining half of issue #31 and is deliberately
   * left out of the change that paginated this route, because it alters what
   * the box means as well as where it runs: `fetchPage` would be rebuilt per
   * keystroke and the list started over from page one each time, which is how
   * Browse behaves and is a different screen's worth of behaviour to judge.
   *
   * Derived on each render, from the term and the latest rows together, rather
   * than stored: the poll patches rows while the reader is still reading, and a
   * filtered copy in state would either need re-deriving inside `poll` and
   * `retry` both, or would go stale at whichever one forgot. It is also what
   * makes a row that *arrives* under a term get filtered by it.
   *
   * A download matches on its title, and an untracked entry on its name —
   * nothing else. Both are the row's own headline text and the only part of it a
   * reader would think to type; matching `status` as well would mean the term
   * "failed" quietly behaves like a state filter, which is a different feature
   * with a different control.
   */
  const tracked = items.filter((download) => matchesTerm(search, download.title));
  const visibleUntracked = untracked.filter((entry) => matchesTerm(search, entry.name));

  return (
    <section>
      <h1>Downloads</h1>
      <SearchBox label="Search downloads" value={search} onChange={setSearch} />
      {error !== null && <p className="error">{error}</p>}

      <ul className="downloads">
        {tracked.map((download) => (
          <DownloadRow key={download.id} download={download} onRetry={(id) => void retry(id)} />
        ))}
      </ul>

      {/*
        The pager sits with the list it pages, above the untracked section
        rather than at the foot of the screen: "Load more" here means more
        tracked downloads, and the entries below it are the client's whole live
        queue with no more to ask for.
      */}
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

      {/*
        The heading goes with the rows it labels. It is the whole of what says
        these downloads are not Pickarr's, so leaving it standing over an empty
        list once a term has excluded every one of them would read as Pickarr
        having lost track of something.
      */}
      {visibleUntracked.length > 0 && (
        <>
          <h2>Not managed by Pickarr</h2>
          <ul className="downloads untracked">
            {visibleUntracked.map((entry) => (
              <li key={entry.ref} className="download-row untracked">
                <span className="download-title">{entry.name}</span>
                <span className="download-status">{entry.state}</span>
                {entry.percentage !== null && <span>{entry.percentage}%</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
