/**
 * Holding new arrivals until the operator is back at the top.
 *
 * A category list and the grid both read a live result: a sync wake
 * replaces the window, and an item that arrived since lands at the head.
 * Scrolled down, that pushes everything the operator is looking at by one
 * row, and in the grid it reflows every row below the insertion. So while
 * the page is scrolled, {@link useHeldItems} freezes the *order* of the ids
 * on screen and holds anything that would have to go above or between them;
 * the controls row shows `N new`, and reaching the top -- by scrolling, or
 * through the button, which scrolls -- releases the hold.
 *
 * **What still moves while held.** A shown item keeps updating in place: a
 * title change, a pick, a new tile image all flow through, because they
 * change what a row says and not where it is. An item that drops out of the
 * result -- tombstoned, or no longer matching the filter after a catalog
 * rewrite -- is removed. Pages the operator loads are appended at the tail,
 * which is below everything on screen, and once appended they join the
 * frozen order so a later arrival older than them is held rather than
 * slotted among them.
 *
 * **What counts as new.** Any item the result places ahead of, or between,
 * the shown ids. That includes an existing item an update bumped to the
 * head -- the list is newest first by `updatedAt`, so showing it there would
 * move everything below it exactly as a new item would.
 *
 * **Why `window.scrollY === 0` and not "near the top".** The category page
 * scrolls as the window (the nav and the controls are `position: sticky`
 * against it). Zero is the one position where inserting at the head moves
 * nothing the operator can see; a few pixels down and the first row is
 * already what they are reading.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaItemsResult } from './useMediaItems.ts';

/** Whether the window is scrolled to the very top, tracked through the `scroll` event. */
export function useScrolledToTop(): boolean {
  const [atTop, setAtTop] = useState(() => window.scrollY === 0);
  useEffect(() => {
    const onScroll = (): void => {
      setAtTop(window.scrollY === 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  return atTop;
}

export interface HeldItems<R extends MediaItemsResult> {
  /** `result` with its `items` replaced by what is shown: the frozen order, updated in place, plus loaded pages. */
  readonly shown: R;
  /** How many arrivals are being held above or between the shown items; 0 while live. */
  readonly held: number;
  /** Scrolls to the top; reaching it is what releases the hold. */
  readonly reveal: () => void;
}

/**
 * `result` as it should be rendered given whether the window is at the top.
 * Live at the top; frozen in order below it, per the module doc.
 */
export function useHeldItems<R extends MediaItemsResult>(result: R, atTop: boolean): HeldItems<R> {
  // `null` is live. Otherwise the ids on screen, in the order they are shown.
  const [frozen, setFrozen] = useState<readonly number[] | null>(null);
  const itemsRef = useRef(result.items);
  itemsRef.current = result.items;

  useEffect(() => {
    if (atTop) {
      setFrozen(null);
      return;
    }
    // Leaving the top: snapshot what is on screen right now.
    setFrozen((current) => current ?? itemsRef.current.map((item) => item.id));
  }, [atTop]);

  const partition = useMemo(() => {
    if (frozen === null) return { shown: result.items, appended: [] as number[], held: 0 };
    const frozenSet = new Set(frozen);
    const byId = new Map(result.items.map((item) => [item.id, item] as const));
    let lastFrozenIndex = -1;
    result.items.forEach((item, index) => {
      if (frozenSet.has(item.id)) lastFrozenIndex = index;
    });
    const held = result.items.slice(0, lastFrozenIndex + 1).filter((item) => !frozenSet.has(item.id)).length;
    const appendedItems = result.items.slice(lastFrozenIndex + 1);
    const shown = [
      ...frozen.flatMap((id) => {
        const item = byId.get(id);
        return item === undefined ? [] : [item];
      }),
      ...appendedItems,
    ];
    return { shown, appended: appendedItems.map((item) => item.id), held };
  }, [frozen, result.items]);

  // Loaded pages join the frozen order, so a later arrival older than them
  // is held rather than slotted among them (module doc).
  useEffect(() => {
    if (frozen === null || partition.appended.length === 0) return;
    setFrozen([...frozen, ...partition.appended]);
  }, [frozen, partition.appended]);

  const reveal = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const shown = useMemo(
    () => ({ ...result, items: partition.shown, empty: result.empty && partition.shown.length === 0 }),
    [result, partition.shown],
  );

  return { shown, held: partition.held, reveal };
}
