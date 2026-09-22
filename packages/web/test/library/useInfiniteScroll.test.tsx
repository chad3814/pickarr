/**
 * The sentinel that loads the next page when it scrolls into view.
 *
 * **The environment's `IntersectionObserver` exists and never fires.**
 * Measured before this hook was written: happy-dom defines the constructor,
 * `observe()` accepts an element, and the callback is never called -- there
 * is no layout and nothing to intersect with. So a test that rendered the
 * real hook and scrolled would pass while proving nothing, which is this
 * repo's whole `CLAUDE.md` hazard genre.
 *
 * Every test here therefore replaces the global with one it can drive. That
 * is the same move `packages/core/test/abort-timeout.ts` made for
 * `AbortSignal.timeout`, and for the same reason: the real thing cannot be
 * made to do the interesting thing on demand.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, act } from '@testing-library/react';
import { useInfiniteScroll } from '../../src/library/useInfiniteScroll.ts';

/** One constructed observer, with the handle a test needs to drive it. */
interface FakeObserver {
  readonly observed: Element[];
  disconnected: boolean;
  /** Fires the callback as the browser would when the sentinel enters the viewport. */
  enter: () => void;
  /** Fires it as the browser would when the sentinel is present but off screen. */
  leave: () => void;
}

const constructed: FakeObserver[] = [];
const realObserver = globalThis.IntersectionObserver;

function installFakeObserver(): void {
  constructed.length = 0;
  class Fake {
    private readonly self: FakeObserver;
    constructor(callback: IntersectionObserverCallback) {
      const fire = (isIntersecting: boolean) => {
        const entries = this.self.observed.map((target) => ({ target, isIntersecting } as IntersectionObserverEntry));
        callback(entries, this as unknown as IntersectionObserver);
      };
      this.self = {
        observed: [],
        disconnected: false,
        enter: () => { fire(true); },
        leave: () => { fire(false); },
      };
      constructed.push(this.self);
    }
    observe(element: Element): void { this.self.observed.push(element); }
    unobserve(element: Element): void {
      const at = this.self.observed.indexOf(element);
      if (at !== -1) this.self.observed.splice(at, 1);
    }
    disconnect(): void { this.self.disconnected = true; this.self.observed.length = 0; }
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  globalThis.IntersectionObserver = Fake as unknown as typeof IntersectionObserver;
}

afterEach(() => {
  cleanup();
  globalThis.IntersectionObserver = realObserver;
});

/** A list whose sentinel is rendered only while there is more to load, as the real one is. */
function Harness({ onReach, enabled }: { onReach: () => void; enabled: boolean }) {
  const sentinel = useInfiniteScroll(onReach, enabled);
  return <div>{enabled && <div data-testid="sentinel" ref={sentinel} />}</div>;
}

test('reaching the sentinel loads the next page', () => {
  installFakeObserver();
  let reached = 0;
  render(<Harness onReach={() => { reached += 1; }} enabled />);

  assert.equal(constructed.length, 1, 'one observer for the one sentinel');
  assert.equal(reached, 0, 'nothing is loaded before the sentinel is seen');

  act(() => { constructed[0]?.enter(); });
  assert.equal(reached, 1);
});

test('a sentinel that is present but off screen loads nothing', () => {
  // The other side. Without it, a hook that called `onReach` on every
  // callback regardless of `isIntersecting` would pass the test above --
  // and would load every page at once the moment the list rendered.
  installFakeObserver();
  let reached = 0;
  render(<Harness onReach={() => { reached += 1; }} enabled />);

  act(() => { constructed[0]?.leave(); });
  assert.equal(reached, 0);
});

test('nothing is observed once there is nothing left to load', () => {
  // `enabled` is the list's `!done`. The real sentinel is unmounted then, so
  // this asserts the hook copes with the element going away rather than
  // holding a detached node forever.
  installFakeObserver();
  const { rerender } = render(<Harness onReach={() => {}} enabled />);
  assert.equal(constructed[0]?.observed.length, 1);

  rerender(<Harness onReach={() => {}} enabled={false} />);
  assert.equal(constructed[0]?.disconnected, true, 'the observer is disconnected, not left attached');
});

test('unmounting disconnects the observer', () => {
  // A list that scrolls away should not leave an observer holding its
  // sentinel. The browse screen mounts one of these per category route.
  installFakeObserver();
  const { unmount } = render(<Harness onReach={() => {}} enabled />);
  unmount();
  assert.equal(constructed[0]?.disconnected, true);
});

test('a re-render with a new callback reaches the new one, without rebuilding the observer', () => {
  // `loadMore`'s identity changes when `useMediaItems` re-renders, and
  // rebuilding the observer on every render would disconnect and re-observe
  // the sentinel constantly -- which in a real browser re-fires the callback
  // for an element already on screen, loading pages nobody scrolled to.
  installFakeObserver();
  let first = 0;
  let second = 0;
  const { rerender } = render(<Harness onReach={() => { first += 1; }} enabled />);
  rerender(<Harness onReach={() => { second += 1; }} enabled />);

  assert.equal(constructed.length, 1, 'still the one observer');
  act(() => { constructed[0]?.enter(); });
  assert.equal(first, 0, 'the stale callback is not the one called');
  assert.equal(second, 1);
});
