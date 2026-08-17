/**
 * A controllable stand-in for `IntersectionObserver`, so a test can say "the end
 * of the list came into view" without a layout engine.
 *
 * `happy-dom` does supply an `IntersectionObserver` class, which is why the
 * production code does not crash under test — but it never invokes the callback,
 * because there is no layout for it to measure. Left alone it is
 * indistinguishable from an observer watching an element that never scrolls into
 * view, so every infinite-scroll test would pass by loading nothing.
 *
 * The held boolean matters as much as the notification. A real observer reports
 * *changes*, so an element still on screen after a page was appended produces no
 * second callback — the very case that stalls infinite scroll on a tall viewport.
 * `usePagedList` keeps loading while the sentinel is intersecting rather than only
 * on the edge it crossed, and only a stub that remembers whether it is currently
 * in view can exercise that.
 */
export interface Intersection {
  /** Scroll the sentinel into view and leave it there. */
  enter(): void;
  /** Scroll it back out, so nothing further is auto-loaded. */
  exit(): void;
  /** How many elements are being watched right now — 0 once disconnected. */
  watching(): number;
  /**
   * How many times a sentinel has been handed to `observe`, counting re-arms.
   *
   * `usePagedList` re-arms after every page rather than caching whether the end
   * is on screen, because a cached answer goes stale between the observation and
   * React's next commit. There is no layout here to make that staleness visible,
   * so this counter is how a unit test can see the asking happen at all.
   */
  observations(): number;
  restore(): void;
}

interface Watcher {
  callback: IntersectionObserverCallback;
  observer: IntersectionObserver;
  targets: Set<Element>;
  live: boolean;
}

/**
 * The hook reads `isIntersecting` and nothing else, so the geometry a real entry
 * also carries is left off rather than invented. The cast is the same
 * narrow-stub-for-a-DOM-type move the `globalThis.fetch` stubs in these tests
 * make, and it stays confined to this file.
 */
function entryFor(target: Element, isIntersecting: boolean): IntersectionObserverEntry {
  return { target, isIntersecting } as unknown as IntersectionObserverEntry;
}

export function stubIntersectionObserver(): Intersection {
  const original = globalThis.IntersectionObserver;
  const watchers: Watcher[] = [];
  let observations = 0;
  let inView = false;

  class Stub implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string;
    // Part of the interface as the DOM lib declares it, and unread by anything
    // here; the hook sets `rootMargin` only.
    readonly scrollMargin: string = '';
    readonly thresholds: readonly number[] = [0];
    readonly #watcher: Watcher;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.rootMargin = options?.rootMargin ?? '';
      this.#watcher = { callback, observer: this, targets: new Set(), live: true };
      watchers.push(this.#watcher);
    }

    observe(target: Element): void {
      this.#watcher.targets.add(target);
      observations += 1;
      // A real observer reports an element's initial state as soon as it is
      // observed, without waiting for a scroll. Mirroring that is what lets a
      // list whose first page does not fill the screen keep filling itself.
      if (inView) notify(this.#watcher);
    }

    unobserve(target: Element): void {
      this.#watcher.targets.delete(target);
    }

    disconnect(): void {
      this.#watcher.targets.clear();
      this.#watcher.live = false;
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  function notify(watcher: Watcher): void {
    if (!watcher.live || watcher.targets.size === 0) return;
    const entries = [...watcher.targets].map((target) => entryFor(target, inView));
    // The observer a real callback receives is the one that fired, not a fresh
    // instance — handing over a new `Stub` here would register a junk watcher on
    // every single notification.
    watcher.callback(entries, watcher.observer);
  }

  globalThis.IntersectionObserver = Stub;

  return {
    enter(): void {
      inView = true;
      notifyAll();
    },
    exit(): void {
      inView = false;
      notifyAll();
    },
    watching(): number {
      return watchers.reduce((total, watcher) => total + watcher.targets.size, 0);
    },
    observations(): number {
      return observations;
    },
    restore(): void {
      globalThis.IntersectionObserver = original;
    },
  };

  // Iterating `watchers` directly is safe: nothing removes entries, and
  // `disconnect` flips a flag rather than splicing, so the array cannot change
  // length while a pass is in progress.
  function notifyAll(): void {
    for (const watcher of watchers) notify(watcher);
  }
}
