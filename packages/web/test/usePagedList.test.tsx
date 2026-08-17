import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useCallback, useState } from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { usePagedList, type PagedFetch } from '../src/api/usePagedList.ts';
import { stubIntersectionObserver } from './intersection.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of it.
afterEach(cleanup);

/**
 * Three pages of one row each, keyed by the cursor that asks for them, plus a
 * record of every cursor the hook actually asked for — which is what the
 * one-request-per-cursor and stop-at-the-end tests assert on.
 */
function pages(): { fetchPage: (cursor: string | null) => Promise<PagedFetch<string>>; asked: string[] } {
  const asked: string[] = [];
  const byCursor = new Map<string, PagedFetch<string>>([
    ['', { items: ['one'], nextCursor: 'c1' }],
    ['c1', { items: ['two'], nextCursor: 'c2' }],
    ['c2', { items: ['three'], nextCursor: null }],
  ]);

  return {
    asked,
    fetchPage: async (cursor) => {
      asked.push(cursor ?? '');
      const page = byCursor.get(cursor ?? '');
      assert.ok(page !== undefined, `no page for cursor ${String(cursor)}`);
      return page;
    },
  };
}

/** Renders the list, its state, and the sentinel the hook wants observed. */
function Consumer({ fetchPage }: { fetchPage: (cursor: string | null) => Promise<PagedFetch<string>> }) {
  const [error, setError] = useState<string | null>(null);
  const list = usePagedList(fetchPage, setError);

  return (
    <section>
      <ul>
        {list.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {error !== null && <p>{`error: ${error}`}</p>}
      {list.loading && <p>loading</p>}
      {list.done && <p>done</p>}
      {!list.done && (
        <>
          <div ref={list.sentinelRef} />
          <button type="button" onClick={list.loadMore}>
            Load more
          </button>
        </>
      )}
    </section>
  );
}

/**
 * The same, for a list with a filter — the shape Browse's search box and
 * Failed's "Show dismissed" both take. Changing the filter changes `fetchPage`'s
 * identity, which is the hook's signal to start over from the first page.
 */
function Filtered({
  fetchFor,
}: {
  fetchFor: (filter: string, cursor: string | null) => Promise<PagedFetch<string>>;
}) {
  const [filter, setFilter] = useState('a');
  const [error, setError] = useState<string | null>(null);
  const fetchPage = useCallback(
    (cursor: string | null) => fetchFor(filter, cursor),
    [fetchFor, filter],
  );
  const list = usePagedList(fetchPage, setError);

  return (
    <section>
      <button type="button" onClick={() => setFilter('b')}>
        filter b
      </button>
      <ul>
        {list.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {error !== null && <p>{`error: ${error}`}</p>}
      {!list.done && <div ref={list.sentinelRef} />}
    </section>
  );
}

/**
 * Absence, as a boolean — the same helper `Browse.test.tsx` carries, for the
 * same reason. `assert.equal(screen.queryByText(x), null)` is the obvious
 * spelling and it makes a *failing* run pathological: node:assert deep-inspects
 * the live DOM element to build the message, which took 40+ seconds here before
 * the run was killed with nothing naming the test.
 */
function gone(text: string): boolean {
  return screen.queryByText(text) === null;
}

/** A promise plus the handle that settles it, so a test can hold a page open. */
function gate(): { held: Promise<void>; release: () => void } {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { held, release };
}

test('the next page arrives when the end of the list comes into view, with no click', async () => {
  const view = stubIntersectionObserver();
  try {
    const { fetchPage } = pages();
    render(<Consumer fetchPage={fetchPage} />);
    await waitFor(() => assert.ok(screen.getByText('one')));

    view.enter();

    await waitFor(() => assert.ok(screen.getByText('two')));
  } finally {
    view.restore();
  }
});

test('the list keeps filling while the end of it stays in view', async () => {
  // A real observer reports *changes*, so a page that is still not tall enough
  // to push the sentinel off screen produces no second callback: the list
  // stalls one page in and the reader has to nudge the scrollbar to get the
  // rest. Loading while the sentinel is intersecting, rather than only on the
  // edge it crossed, is what fills a tall viewport.
  const view = stubIntersectionObserver();
  try {
    const { fetchPage, asked } = pages();
    render(<Consumer fetchPage={fetchPage} />);
    await waitFor(() => assert.ok(screen.getByText('one')));

    view.enter();

    await waitFor(() => assert.ok(screen.getByText('three')));
    assert.ok(screen.getByText('done'));
    assert.deepEqual(asked, ['', 'c1', 'c2']);
  } finally {
    view.restore();
  }
});

test('a page that failed is not asked for again while the end stays in view', async () => {
  // The other half of filling-while-in-view. A rejected page changes nothing
  // about the sentinel, so an implementation that retries on every tick asks for
  // the same cursor forever — a hot loop against a server already refusing.
  // #33's malformed cursor is one way in; an offline tab or a 500 is another.
  //
  // It holds because the chain's effect depends only on things a page that
  // *arrived* can change, which is subtle enough to be worth pinning: widening
  // that dependency list to include `loading` puts the loop straight back.
  const view = stubIntersectionObserver();
  try {
    const asked: string[] = [];
    const fetchPage = async (cursor: string | null): Promise<PagedFetch<string>> => {
      asked.push(cursor ?? '');
      if (cursor === null) return { items: ['one'], nextCursor: 'c1' };
      throw new Error('Invalid cursor');
    };

    render(<Consumer fetchPage={fetchPage} />);
    await waitFor(() => assert.ok(screen.getByText('one')));

    view.enter();
    await waitFor(() => assert.ok(screen.getByText('error: Invalid cursor')));

    // Comfortably longer than a retry loop would take to make its next attempt.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(asked, ['', 'c1']);
  } finally {
    view.restore();
  }
});

test('a burst of intersections while a page is in flight asks for that cursor once', async () => {
  // A fast scroll fires the observer several times before the first response
  // lands. Keyed on the `loading` *state*, every one of those fires reads the
  // value from the render that has not happened yet and starts its own request
  // for the same cursor — so the page is appended as many times as the observer
  // fired. The guard has to be a ref, read at the moment of the fire.
  const view = stubIntersectionObserver();
  try {
    const { fetchPage, asked } = pages();
    const secondPage = gate();
    const held = async (cursor: string | null): Promise<PagedFetch<string>> => {
      if (cursor === 'c1') await secondPage.held;
      return fetchPage(cursor);
    };

    render(<Consumer fetchPage={held} />);
    await waitFor(() => assert.ok(screen.getByText('one')));

    view.enter();
    view.enter();
    view.enter();
    secondPage.release();

    await waitFor(() => assert.ok(screen.getByText('two')));
    assert.deepEqual(
      asked.filter((cursor) => cursor === 'c1'),
      ['c1'],
    );
  } finally {
    view.restore();
  }
});

test('a page still in flight when the filter changes never lands in the new list', async () => {
  // Browse's search box is not debounced, so a keystroke can arrive while a
  // scroll-triggered append is still out. Whichever response is slower wins the
  // append, and the slow one here belongs to a term the reader has already left
  // — its rows would be interleaved into results that do not match what the box
  // says. Under the old button this took a deliberate click mid-flight; auto
  // loading makes it ordinary.
  const view = stubIntersectionObserver();
  try {
    const stale = gate();
    const fetchFor = async (filter: string, cursor: string | null): Promise<PagedFetch<string>> => {
      if (filter !== 'a') return { items: ['b1'], nextCursor: null };
      if (cursor === null) return { items: ['a1'], nextCursor: 'c1' };
      await stale.held;
      return { items: ['a2'], nextCursor: null };
    };

    render(<Filtered fetchFor={fetchFor} />);
    await waitFor(() => assert.ok(screen.getByText('a1')));

    view.enter();
    fireEvent.click(screen.getByRole('button', { name: 'filter b' }));
    await waitFor(() => assert.ok(screen.getByText('b1')));

    stale.release();
    // Long enough that a response which was going to be appended would have
    // been by now.
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(gone('a2'), 'the superseded page must not be appended');
    assert.deepEqual(
      screen.getAllByRole('listitem').map((item) => item.textContent),
      ['b1'],
    );
  } finally {
    view.restore();
  }
});

test('nothing is asked for once the last page has arrived', async () => {
  const view = stubIntersectionObserver();
  try {
    const { fetchPage, asked } = pages();
    render(<Consumer fetchPage={fetchPage} />);
    await waitFor(() => assert.ok(screen.getByText('one')));

    view.enter();
    await waitFor(() => assert.ok(screen.getByText('done')));

    // The sentinel is gone with the button, so there is nothing left to watch —
    // a tab parked at the bottom of a finished list costs no requests at all.
    assert.equal(view.watching(), 0);
    view.enter();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(asked, ['', 'c1', 'c2']);
  } finally {
    view.restore();
  }
});

test('the button still loads the next page when the observer never fires', async () => {
  // The fallback the whole feature needs: a short viewport, an odd zoom level or
  // a browser that reports nothing leaves the observer silent, and without a
  // control the reader has no way to ask for the rest.
  const view = stubIntersectionObserver();
  try {
    const { fetchPage } = pages();
    render(<Consumer fetchPage={fetchPage} />);
    await waitFor(() => assert.ok(screen.getByText('one')));

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => assert.ok(screen.getByText('two')));
  } finally {
    view.restore();
  }
});

test('the button retries a page that failed', async () => {
  const view = stubIntersectionObserver();
  try {
    let attempts = 0;
    const fetchPage = async (cursor: string | null): Promise<PagedFetch<string>> => {
      if (cursor === null) return { items: ['one'], nextCursor: 'c1' };
      attempts += 1;
      if (attempts === 1) throw new Error('Invalid cursor');
      return { items: ['two'], nextCursor: null };
    };

    render(<Consumer fetchPage={fetchPage} />);
    await waitFor(() => assert.ok(screen.getByText('one')));

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => assert.ok(screen.getByText('error: Invalid cursor')));

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => assert.ok(screen.getByText('two')));
    // A page that lands clears the banner the failed attempt left.
    assert.ok(gone('error: Invalid cursor'));
  } finally {
    view.restore();
  }
});

test('a double-click on the button asks for that cursor once', async () => {
  // Impatience is ordinary, and the page must not be appended twice for it. This
  // passes on the `loading` state too — React flushes the first click's state
  // before dispatching the second — so it is not pinning the ref specifically;
  // what it pins is that one gesture costs one page however the button is
  // rendered, including if the `disabled` attribute is ever dropped.
  const view = stubIntersectionObserver();
  try {
    const { fetchPage, asked } = pages();
    const secondPage = gate();
    const held = async (cursor: string | null): Promise<PagedFetch<string>> => {
      if (cursor === 'c1') await secondPage.held;
      return fetchPage(cursor);
    };

    render(<Consumer fetchPage={held} />);
    await waitFor(() => assert.ok(screen.getByText('one')));

    const button = screen.getByRole('button', { name: 'Load more' });
    fireEvent.click(button);
    fireEvent.click(button);
    secondPage.release();

    await waitFor(() => assert.ok(screen.getByText('two')));
    assert.deepEqual(
      asked.filter((cursor) => cursor === 'c1'),
      ['c1'],
    );
  } finally {
    view.restore();
  }
});

test('the sentinel is re-observed once a page has arrived, rather than its position remembered', async () => {
  // The bug this pins, which `pagination.spec.ts` caught and no stub can
  // reproduce on its own: an empty list puts the sentinel in the viewport, so the
  // first observation says intersecting. Cache that in a ref and the answer is
  // already stale by the time page one has pushed the sentinel below the fold —
  // observations arrive in a later task than React's commit — so the chain effect
  // reads `true` and fetches page two unprompted. It did exactly that, giving a
  // 34-row list where 30 were seeded.
  //
  // There is no layout here, so the staleness itself is invisible; what is
  // checkable is that the hook asks the browser again after the page instead of
  // trusting what it was told before it. Re-observing is what asking means, since
  // observing an element always delivers a fresh observation for it.
  const view = stubIntersectionObserver();
  try {
    const { fetchPage } = pages();
    render(<Consumer fetchPage={fetchPage} />);
    const beforePage = view.observations();

    await waitFor(() => assert.ok(screen.getByText('one')));

    assert.ok(
      view.observations() > beforePage,
      `the page that arrived must re-arm the observer; observations stayed at ${String(beforePage)}`,
    );
  } finally {
    view.restore();
  }
});
