import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/** One page of a keyset-paginated list, as the hook needs to see it. */
export interface PagedFetch<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * How early the next page is asked for. Enough that the page is usually already
 * appended by the time the reader reaches where it goes, without being so eager
 * that a list nobody scrolls loads itself to the end.
 */
const ROOT_MARGIN = '200px';

export interface PagedList<T> {
  items: T[];
  /**
   * Exposed so that acting on a row patches the list in place. Refetching the
   * first page instead discards every page loaded past it — see the hook's own
   * doc comment.
   */
  setItems: Dispatch<SetStateAction<T[]>>;
  loading: boolean;
  done: boolean;
  loadMore: () => void;
  sentinelRef: (node: HTMLElement | null) => void;
}

/**
 * A keyset-paginated list that loads the next page as its end comes into view.
 *
 * The `"<sortKey>:<id>"` cursors are what make this safe to do unprompted: they
 * are stable while ingest is writing, so pages cannot shift under a reader the
 * way an offset would, and the same page is never served twice.
 *
 * **Acting on a row must patch the list through `setItems`, never refetch the
 * first page.** That bug shipped once already — picking a release refetched page
 * one and discarded every page loaded after it, so anything picked below the fold
 * snapped the list back to its original length. Loading pages by scrolling makes
 * that failure harder to see rather than rarer: with a button, a reader who lost
 * twenty pages noticed, and with scrolling the list silently shortens and they
 * scroll again. Callers get `setItems` precisely so they never need the refetch;
 * it is pinned by `picking after "load more" keeps the pages already loaded` and
 * its by-scrolling twin in `Browse.test.tsx`, and by that same file's fixing
 * and dismissing pairs for the failed half of the merge — the same rule
 * `Dismissed.tsx`'s own `fix` follows, for the tab that list's actions moved to.
 *
 * `fetchPage` is expected to be a `useCallback` over whatever the list is
 * filtered by; a change in its identity is the signal to start over from the
 * first page. `reportError` is handed the message rather than the hook owning an
 * error of its own, so a route keeps reporting page failures through the same
 * banner as the failures its own actions produce — and a page that lands clears
 * it, as it did before.
 */
export function usePagedList<T>(
  fetchPage: (cursor: string | null) => Promise<PagedFetch<T>>,
  reportError: (message: string | null) => void,
): PagedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  // The in-flight flag is a ref, not the `loading` state, because the observer
  // reads it at the moment it fires. A fast scroll fires several times before
  // React has re-rendered with `loading: true`, so every one of those fires
  // would see the stale `false` from the render it closed over and start its own
  // request for the same cursor — appending that page as many times as the
  // observer happened to fire. `loading` still exists, but for the spinner.
  const inFlight = useRef(false);

  // Which filter the responses currently landing belong to. Starting over bumps
  // it, so a page still out for the previous filter is dropped when it arrives
  // rather than appended: Browse's search box is not debounced, so a keystroke
  // routinely lands while a scroll-triggered append is still in flight, and
  // whichever response is slower would otherwise win. That put rows for a term
  // the reader had already left into results that no longer matched the box.
  const generation = useRef(0);

  const load = useCallback(
    async (from: string | null, replace: boolean): Promise<void> => {
      const mine = replace ? (generation.current += 1) : generation.current;
      inFlight.current = true;
      setLoading(true);
      try {
        const page = await fetchPage(from);
        if (mine !== generation.current) return;
        setItems((previous) => (replace ? page.items : [...previous, ...page.items]));
        setCursor(page.nextCursor);
        setDone(page.nextCursor === null);
        reportError(null);
      } catch (cause) {
        if (mine !== generation.current) return;
        reportError((cause as Error).message);
      } finally {
        // Only the newest load owns these: a superseded one finishing later must
        // not report the list as idle while its replacement is still out.
        if (mine === generation.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    },
    [fetchPage, reportError],
  );

  useEffect(() => {
    void load(null, true);
  }, [load]);

  const autoLoad = (): void => {
    if (inFlight.current || done || cursor === null) return;
    void load(cursor, false);
  };

  const autoLoadRef = useRef(autoLoad);
  useEffect(() => {
    autoLoadRef.current = autoLoad;
  });

  const observer = useRef<IntersectionObserver | null>(null);
  const sentinel = useRef<HTMLElement | null>(null);

  /**
   * Point a fresh observer at whatever sentinel is mounted, replacing any
   * previous one.
   *
   * Fresh, rather than one long-lived observer, because observing an element
   * always delivers an initial observation for it: re-arming is how the browser
   * is *asked* where the sentinel sits now. That is the whole mechanism behind
   * the re-arm effect below.
   */
  const watchSentinel = useCallback((): void => {
    observer.current?.disconnect();
    observer.current = null;
    const node = sentinel.current;
    if (node === null) return;

    const next = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) autoLoadRef.current();
      },
      { rootMargin: ROOT_MARGIN },
    );
    next.observe(node);
    observer.current = next;
  }, []);

  const sentinelRef = useCallback(
    (node: HTMLElement | null): void => {
      sentinel.current = node;
      watchSentinel();
    },
    [watchSentinel],
  );

  useEffect(() => () => observer.current?.disconnect(), []);

  /**
   * Ask again where the end of the list is, every time a page changed the layout.
   *
   * Two problems, one answer. An observer reports *crossings*, so a page too
   * short to push the sentinel out of view produces no second callback and the
   * list stalls one page in — worst on a tall window, where the first page may
   * not fill the screen at all. Re-arming produces the missing report.
   *
   * The other problem is why this does not just cache "is it on screen" in a ref
   * and consult that. An empty list puts the sentinel in the viewport, so the
   * first observation says intersecting; observations are delivered in a later
   * task than React's commit, so when page one lands this effect would read that
   * `true` — long stale, the sentinel having been pushed far below the fold by
   * thirty cards — and fetch page two unprompted. It did: `pagination.spec.ts`
   * caught a 34-row list where 30 were seeded, one full page nobody asked for.
   * A cached answer can be wrong; asking cannot be.
   *
   * Termination comes from the dependency list, and it is load-bearing: every
   * entry is something only a page that *arrived* can change. A page that failed
   * leaves items, cursor and done as they were, so nothing re-arms and the same
   * cursor is not asked for again — no hot loop against a server already
   * refusing. Adding `loading` here would reintroduce exactly that loop.
   *
   * `items` rather than a count, so a patch through `setItems` also re-arms:
   * dropping a picked row shortens the list, which can be what brings the end
   * into view.
   */
  useEffect(() => {
    watchSentinel();
  }, [items, done, cursor, watchSentinel]);

  /**
   * The fallback control, and the retry after a page that failed — which is why
   * nothing here consults whether the last attempt went wrong.
   *
   * Guarded on the ref rather than `loading` so that the caller is free to render
   * the button however it likes. Two clicks do in fact see a fresh `loading`
   * between them, since React flushes the first one's state before the second
   * event is dispatched, but that makes the state guard correct only by way of the
   * `disabled` attribute and React's scheduling — neither of which this hook
   * controls. The ref cannot go stale either way.
   */
  const loadMore = (): void => {
    if (inFlight.current) return;
    void load(cursor, false);
  };

  return { items, setItems, loading, done, loadMore, sentinelRef };
}
