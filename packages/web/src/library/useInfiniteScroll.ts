/**
 * Loads the next page when a sentinel element scrolls into view.
 *
 * **It does not replace the button, and that is deliberate.** `Category`
 * still renders `Load more` below the sentinel, and it still works. Removing
 * it would take away the only keyboard-reachable way to get more items and
 * leave a screen-reader user with no control to activate and no announcement
 * that anything arrived -- the gap between "the query passes" and "a person
 * can use it" that `CLAUDE.md`'s longest hazard is about. It is also the
 * fallback wherever `IntersectionObserver` is missing or never fires, which
 * is not hypothetical: the test environment is exactly that.
 *
 * **Why a ref callback rather than `useRef` + `useEffect`.** The sentinel is
 * rendered only while there is more to load, so the element appears and
 * disappears during the list's life. A ref callback is told about both; an
 * effect keyed on a ref's `.current` is not, because mutating a ref does not
 * re-render and the effect would never re-run.
 */
import { useCallback, useEffect, useRef } from 'react';

/**
 * Attaches to the sentinel. Call `onReach` when it becomes visible, while
 * `enabled`.
 *
 * `onReach` may be called repeatedly -- a browser fires on every crossing,
 * and a slow page can be reached again before the first load lands.
 * `useMediaItems`' `loadMore` already refuses a re-entrant call while a
 * request is in flight and once the cursor is exhausted, so this hook does
 * no throttling of its own rather than keeping a second, differently-wrong
 * copy of that rule.
 */
export function useInfiniteScroll(
  onReach: () => void,
  enabled: boolean,
): (element: HTMLElement | null) => void {
  // The latest callback, read at fire time. Without this the observer would
  // have to be rebuilt whenever `onReach`'s identity changed -- and
  // rebuilding re-observes, which fires immediately for an element already
  // on screen and loads pages nobody scrolled to.
  const onReachRef = useRef(onReach);
  useEffect(() => {
    onReachRef.current = onReach;
  }, [onReach]);

  const observerRef = useRef<IntersectionObserver | undefined>(undefined);

  // Disconnect on unmount. The ref callback handles the element going away
  // during the list's life; this handles the list itself going away, which
  // the callback is never told about.
  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = undefined;
  }, []);

  return useCallback((element: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = undefined;
    if (element === null || !enabled) return;
    // `IntersectionObserver` is absent in some environments. The button
    // below the sentinel is what keeps the list usable there, so this
    // declines rather than throwing.
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      // `.some`, not `entries[0]`: a browser may deliver several entries in
      // one callback, and only one of them needs to be on screen.
      if (entries.some((entry) => entry.isIntersecting)) onReachRef.current();
    });
    observer.observe(element);
    observerRef.current = observer;
  }, [enabled]);
}
