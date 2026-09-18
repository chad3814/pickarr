import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTablePlugin } from '../../src/store/rows.ts';
import type { StoredRow } from '../../src/store/db.ts';
import { subscribeInserts } from '../../src/store/notify.ts';
import { useMediaItems, type MediaItemsSource } from '../../src/library/useMediaItems.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave this file's `Listing` still
 * mounted and still subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/** One `create` `SyncOp` for the `media_item` table, with everything but the four fields this suite varies defaulted. */
function mediaItem({
  id,
  pluginId,
  title,
  updatedAt,
}: {
  id: number;
  pluginId: string;
  title: string;
  updatedAt: number;
}): SyncOp {
  return {
    op: 'create',
    table: 'media_item',
    id,
    value: {
      id,
      pluginId,
      createdAt: updatedAt,
      updatedAt,
      provider: null,
      providerRef: null,
      title,
      releaseDate: null,
      description: null,
    },
  };
}

/** The two reads `useMediaItems` needs, bound straight to a raw database -- no `Store`, no sync loop, nothing this suite has to stop afterwards. */
function sourceFor(db: IDBDatabase): MediaItemsSource {
  return {
    listByTablePlugin: (table, pluginId, opts) => listByTablePlugin(db, table, pluginId, opts),
    subscribeInserts,
  };
}

/** The rendered headings' text, in the order they appear. */
function titlesShown(): string[] {
  return screen.getAllByRole('heading').map((heading) => heading.textContent ?? '');
}

/** Exercises `useMediaItems` directly, the way `useCounts.test.tsx`'s `Counts` exercises `useCounts`. */
function Listing({
  source,
  pluginId,
  pageSize,
}: {
  source: MediaItemsSource;
  pluginId: string;
  pageSize?: number;
}): ReactElement | null {
  const { items, loadMore, done, empty } = useMediaItems(source, pluginId, pageSize);

  if (items.length === 0 && !empty) return null;
  if (empty) return <p>Nothing here yet.</p>;

  return (
    <div>
      {items.map((item) => (
        <h2 key={item.id}>{item.title}</h2>
      ))}
      {!done && (
        <button type="button" onClick={loadMore}>
          Load more
        </button>
      )}
    </div>
  );
}

test('a category lists its items newest first, and loads more on demand', async () => {
  const db = await freshDb();
  await seed(db, [
    mediaItem({ id: 1, pluginId: 'tv', title: 'Oldest', updatedAt: 10 }),
    mediaItem({ id: 2, pluginId: 'tv', title: 'Middle', updatedAt: 20 }),
    mediaItem({ id: 3, pluginId: 'tv', title: 'Newest', updatedAt: 30 }),
  ]);
  render(<Listing source={sourceFor(db)} pluginId="tv" pageSize={2} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newest', 'Middle'], 'newest first, one page');
  });
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newest', 'Middle', 'Oldest'], 'the next page appends');
  });

  db.close();
});

test('an empty category says so rather than rendering nothing', async () => {
  // Zero is an answer (spec §1), and "empty" must not look like "still
  // loading" -- a blank region is how an offline-capable screen hides that
  // it has nothing.
  const db = await freshDb();
  render(<Listing source={sourceFor(db)} pluginId="tv" pageSize={2} />);
  await waitFor(() => {
    assert.ok(screen.getByText(/nothing here yet/i), 'an empty category says so in words');
  });
  assert.ok(screen.queryByRole('button', { name: /load more/i }) === null, 'and offers no more to load');

  db.close();
});

test('a row arriving for this category appears without a reload', async () => {
  const db = await freshDb();
  render(<Listing source={sourceFor(db)} pluginId="tv" pageSize={24} />);
  await waitFor(() => {
    assert.ok(screen.getByText(/nothing here yet/i));
  });
  await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: 'Arrived', updatedAt: 10 })]);
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Arrived'], 'subscribeInserts refreshed the list');
  });

  db.close();
});

test('no fetch is issued while listing', async () => {
  // Lists come from the replica only (Global Constraint). Assert on a call
  // count rather than on what rendered: a list that quietly fetched and got
  // nothing back looks identical to one that correctly read an empty replica.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('no fetch may be issued while listing');
  };
  try {
    const db = await freshDb();
    await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: 'Local', updatedAt: 10 })]);
    render(<Listing source={sourceFor(db)} pluginId="tv" pageSize={24} />);
    await waitFor(() => {
      assert.deepEqual(titlesShown(), ['Local']);
    });
    assert.equal(calls, 0, 'the replica answered without the network');
    db.close();
  } finally {
    globalThis.fetch = original;
  }
});

test('a category is scoped to its own pluginId, not another category\'s', async () => {
  const db = await freshDb();
  await seed(db, [
    mediaItem({ id: 1, pluginId: 'tv', title: 'A TV Show', updatedAt: 10 }),
    mediaItem({ id: 2, pluginId: 'movie', title: 'A Movie', updatedAt: 20 }),
  ]);
  render(<Listing source={sourceFor(db)} pluginId="tv" pageSize={24} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['A TV Show'], 'only the tv item is shown');
  });

  db.close();
});

test('clicking load more twice before the first page resolves issues only one request', async () => {
  // Review-found: the cursor recovers from a double-click (both requests
  // answer the same page and advance it identically), but `items` does
  // not -- nothing removes the row a second, redundant `.then` already
  // appended. Asserted here as a call count on the *paging* read, not on
  // what eventually renders: a duplicate request that happens to answer
  // with the same rows would still duplicate `items`, and a call count
  // catches that even if a later render coincidentally looked right.
  const db = await freshDb();
  await seed(db, [
    mediaItem({ id: 1, pluginId: 'tv', title: 'Oldest', updatedAt: 10 }),
    mediaItem({ id: 2, pluginId: 'tv', title: 'Middle', updatedAt: 20 }),
    mediaItem({ id: 3, pluginId: 'tv', title: 'Newest', updatedAt: 30 }),
  ]);
  const real = sourceFor(db);
  let pagingCalls = 0;
  let releasePage: (() => void) | undefined;
  const source: MediaItemsSource = {
    subscribeInserts: real.subscribeInserts,
    listByTablePlugin: (table, pluginId, opts) => {
      if (opts.from === undefined) return real.listByTablePlugin(table, pluginId, opts);
      pagingCalls += 1;
      return new Promise((resolve) => {
        releasePage = () => {
          resolve(real.listByTablePlugin(table, pluginId, opts));
        };
      });
    },
  };

  render(<Listing source={source} pluginId="tv" pageSize={2} />);
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newest', 'Middle']);
  });

  const button = screen.getByRole('button', { name: /load more/i });
  fireEvent.click(button);
  fireEvent.click(button);
  assert.equal(pagingCalls, 1, 'a second click while the first page request is still in flight is a no-op');

  releasePage?.();
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newest', 'Middle', 'Oldest'], 'the one request that was issued still completes the page');
  });

  db.close();
});

test('before the first page resolves, neither the empty message nor a list appears', async () => {
  // `empty` (`useMediaItems.ts`'s own doc) is `resolved && items.length ===
  // 0` -- distinct from "still loading", which also has `items.length ===
  // 0`. Review-found: dropping the `resolved` guard passed every other test
  // in this file, because none of them observed the state *before* the
  // first read settles. This one holds the read open and asserts
  // synchronously, before releasing it.
  let releaseFirstLoad: ((rows: readonly StoredRow[]) => void) | undefined;
  const source: MediaItemsSource = {
    listByTablePlugin: () =>
      new Promise((resolve) => {
        releaseFirstLoad = resolve;
      }),
    subscribeInserts: () => () => {},
  };

  render(<Listing source={source} pluginId="tv" pageSize={2} />);

  assert.ok(!screen.queryByText(/nothing here yet/i), 'not yet knowable whether the category is empty');
  assert.equal(screen.queryAllByRole('heading').length, 0, 'and no items are shown either');

  releaseFirstLoad?.([]);
  await waitFor(() => {
    assert.ok(screen.getByText(/nothing here yet/i), 'once the read actually resolves empty, it is reported');
  });
});

test('no fetch is issued when loading more', async () => {
  // The no-fetch tests above cover the initial load and the insert-driven
  // reload; review-found that neither exercises `loadMore` itself, which is
  // a separate call to `listByTablePlugin` with its own call site a stray
  // `fetch` could hide behind.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('no fetch may be issued while loading more');
  };
  try {
    const db = await freshDb();
    await seed(db, [
      mediaItem({ id: 1, pluginId: 'tv', title: 'Oldest', updatedAt: 10 }),
      mediaItem({ id: 2, pluginId: 'tv', title: 'Middle', updatedAt: 20 }),
      mediaItem({ id: 3, pluginId: 'tv', title: 'Newest', updatedAt: 30 }),
    ]);
    render(<Listing source={sourceFor(db)} pluginId="tv" pageSize={2} />);
    await waitFor(() => {
      assert.deepEqual(titlesShown(), ['Newest', 'Middle']);
    });

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => {
      assert.deepEqual(titlesShown(), ['Newest', 'Middle', 'Oldest']);
    });

    assert.equal(calls, 0, 'loadMore answered from the replica without the network');
    db.close();
  } finally {
    globalThis.fetch = original;
  }
});
