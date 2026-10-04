import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { freshDb } from '../store/harness.ts';
import { done } from '../../src/store/idb.ts';
import { getRows } from '../../src/store/rows.ts';
import { listCatalog, type CatalogQuery, type CatalogRecord } from '../../src/store/catalog.ts';
import { useCatalogItems, type CatalogItemsSource } from '../../src/library/useCatalogItems.ts';

afterEach(cleanup);

interface SeedItem {
  id: number;
  title: string;
  updatedAt: number;
  picked: 0 | 1;
  /** Seed the catalog record but not the `media_item` row. */
  rowMissing?: boolean;
}

/** Writes catalog records and `media_item` rows directly, in one transaction. */
async function seed(db: IDBDatabase, items: readonly SeedItem[]): Promise<void> {
  const tx = db.transaction(['catalog', 'rows'], 'readwrite');
  const catalog = tx.objectStore('catalog');
  const rows = tx.objectStore('rows');
  for (const item of items) {
    const record: CatalogRecord = {
      id: item.id,
      pluginId: 'tv',
      updatedAt: item.updatedAt,
      picked: item.picked,
      haystack: item.title.toLowerCase(),
      poster: null,
      background: null,
    };
    catalog.put(record);
    if (item.rowMissing === true) continue;
    rows.put({
      table: 'media_item',
      id: item.id,
      value: {
        id: item.id,
        pluginId: 'tv',
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
        provider: null,
        providerRef: null,
        title: item.title,
        releaseDate: null,
        description: null,
      },
    });
  }
  await done(tx);
}

interface Harnessed {
  source: CatalogItemsSource;
  /** Fires every subscribed callback, as a catalog wake would. */
  wake: () => void;
}

function sourceFor(
  db: IDBDatabase,
  list: CatalogItemsSource['listCatalog'] = (query, opts) => listCatalog(db, query, opts),
): Harnessed {
  const callbacks = new Set<(ids: readonly number[]) => void>();
  return {
    source: {
      listCatalog: list,
      getRows: (table, ids) => getRows(db, table, ids),
      subscribeCatalog: (cb) => {
        callbacks.add(cb);
        return () => {
          callbacks.delete(cb);
        };
      },
    },
    wake: () => {
      for (const cb of callbacks) cb([]);
    },
  };
}

function titlesShown(): string[] {
  return screen.getAllByRole('heading').map((heading) => heading.textContent ?? '');
}

async function settleRenders(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    // eslint-disable-next-line no-await-in-loop -- each tick has to land before the next is scheduled
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

function Listing({
  source,
  query,
  pageSize,
}: {
  source: CatalogItemsSource;
  query: CatalogQuery;
  pageSize?: number;
}): ReactElement | null {
  const { items, loadMore, done: allLoaded, empty } = useCatalogItems(source, query, pageSize);
  if (items.length === 0 && !empty) return null;
  if (empty) return <p>Nothing matches.</p>;
  return (
    <div>
      {items.map((item) => (
        <h2 key={item.id}>{item.title}</h2>
      ))}
      {!allLoaded && (
        <button type="button" onClick={loadMore}>
          Load more
        </button>
      )}
    </div>
  );
}

const PICKED: CatalogQuery = { pluginId: 'tv', filter: 'picked', term: '' };
const UNPICKED: CatalogQuery = { pluginId: 'tv', filter: 'unpicked', term: '' };

test('lists the catalog page newest first, resolving media items in catalog order, and loads more from the cursor', async () => {
  const db = await freshDb();
  await seed(db, [
    { id: 1, title: 'One', updatedAt: 10, picked: 1 },
    { id: 2, title: 'Two', updatedAt: 20, picked: 0 },
    { id: 3, title: 'Three', updatedAt: 30, picked: 1 },
    { id: 4, title: 'Four', updatedAt: 40, picked: 0 },
    { id: 5, title: 'Five', updatedAt: 50, picked: 1 },
  ]);
  const { source } = sourceFor(db);
  render(<Listing source={source} query={PICKED} pageSize={2} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Five', 'Three']);
  });
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Five', 'Three', 'One']);
  });
  assert.ok(screen.queryByRole('button', { name: /load more/i }) === null, 'the short page ends the list');

  db.close();
});

test('a query change resets the window', async () => {
  const db = await freshDb();
  await seed(db, [
    { id: 1, title: 'P1', updatedAt: 10, picked: 1 },
    { id: 2, title: 'P2', updatedAt: 20, picked: 1 },
    { id: 3, title: 'P3', updatedAt: 30, picked: 1 },
    { id: 4, title: 'U1', updatedAt: 15, picked: 0 },
    { id: 5, title: 'U2', updatedAt: 25, picked: 0 },
    { id: 6, title: 'U3', updatedAt: 35, picked: 0 },
  ]);
  const limits: number[] = [];
  const { source } = sourceFor(db, (query, opts) => {
    if (opts.from === undefined) limits.push(opts.limit);
    return listCatalog(db, query, opts);
  });
  const view = render(<Listing source={source} query={PICKED} pageSize={2} />);
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['P3', 'P2']);
  });
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['P3', 'P2', 'P1']);
  });

  limits.length = 0;
  view.rerender(<Listing source={source} query={UNPICKED} pageSize={2} />);
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['U3', 'U2']);
  });
  assert.deepEqual(limits, [2], 'the new query asks for one page, not the grown window');

  db.close();
});

test('a catalog wake re-reads from the top and a page appended from the stale cursor is dropped', async () => {
  const db = await freshDb();
  await seed(db, [
    { id: 1, title: 'Oldest', updatedAt: 10, picked: 1 },
    { id: 2, title: 'Middle', updatedAt: 20, picked: 1 },
    { id: 3, title: 'Newest', updatedAt: 30, picked: 1 },
  ]);
  let releasePage: (() => Promise<void>) | undefined;
  const { source, wake } = sourceFor(db, (query, opts) => {
    if (opts.from === undefined) return listCatalog(db, query, opts);
    return new Promise((resolve) => {
      releasePage = async () => {
        resolve(await listCatalog(db, query, opts));
      };
    });
  });
  render(<Listing source={source} query={PICKED} pageSize={2} />);
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newest', 'Middle']);
  });

  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.ok(releasePage !== undefined, 'the paging read is in flight and held');
  });

  await seed(db, [{ id: 4, title: 'Brand New', updatedAt: 40, picked: 1 }]);
  wake();
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Brand New', 'Newest', 'Middle', 'Oldest']);
  });

  await releasePage?.();
  await settleRenders();
  assert.deepEqual(titlesShown(), ['Brand New', 'Newest', 'Middle', 'Oldest'], 'the held page was dropped');
  assert.ok(screen.queryByRole('button', { name: /load more/i }) !== null, 'and did not strand the list');

  db.close();
});

test('wakes during an in-flight reload coalesce into exactly one further reload that shows the latest data', async () => {
  const db = await freshDb();
  await seed(db, [{ id: 1, title: 'Old', updatedAt: 10, picked: 1 }]);
  let reads = 0;
  let releaseFirst: (() => void) | undefined;
  const { source, wake } = sourceFor(db, async (query, opts) => {
    reads += 1;
    if (reads > 1) return listCatalog(db, query, opts);
    // The first read is answered from the data as it was now, and held.
    const stale = await listCatalog(db, query, opts);
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    return stale;
  });
  render(<Listing source={source} query={PICKED} pageSize={5} />);
  await waitFor(() => {
    assert.ok(releaseFirst !== undefined, 'the first reload is in flight and held');
  });

  await seed(db, [{ id: 2, title: 'Newer', updatedAt: 20, picked: 1 }]);
  wake();
  wake();
  wake();
  await settleRenders();
  assert.equal(reads, 1, 'wakes during a reload start no read of their own');

  releaseFirst?.();
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newer', 'Old']);
  });
  await settleRenders();
  assert.equal(reads, 2, 'three wakes cost exactly one further read');

  db.close();
});

test('empty is false until the first page resolves, then true for zero matches', async () => {
  const db = await freshDb();
  let release: ((records: readonly CatalogRecord[]) => void) | undefined;
  const { source } = sourceFor(db, () => new Promise((resolve) => { release = resolve; }));
  render(<Listing source={source} query={PICKED} pageSize={2} />);

  assert.ok(!screen.queryByText(/nothing matches/i), 'not yet knowable');
  assert.equal(screen.queryAllByRole('heading').length, 0);

  release?.([]);
  await waitFor(() => {
    assert.ok(screen.getByText(/nothing matches/i));
  });

  db.close();
});

test('a media item missing from rows is skipped, not rendered as a hole', async () => {
  const db = await freshDb();
  await seed(db, [
    { id: 1, title: 'One', updatedAt: 10, picked: 1 },
    { id: 2, title: 'Ghost', updatedAt: 20, picked: 1, rowMissing: true },
    { id: 3, title: 'Three', updatedAt: 30, picked: 1 },
  ]);
  const { source } = sourceFor(db);
  render(<Listing source={source} query={PICKED} pageSize={2} />);

  // The first page of two records is [Three, Ghost]; Ghost has no row and is skipped.
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Three']);
  });
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Three', 'One']);
  });

  db.close();
});

test('a page of records with no media_item rows is not empty, and paging continues from the last record', async () => {
  // Both records on the first page are ghosts. A cursor taken from the last
  // *item* would stay undefined, making loadMore a no-op and stranding 'One'.
  const db = await freshDb();
  await seed(db, [
    { id: 1, title: 'One', updatedAt: 10, picked: 1 },
    { id: 2, title: 'Ghost A', updatedAt: 20, picked: 1, rowMissing: true },
    { id: 3, title: 'Ghost B', updatedAt: 30, picked: 1, rowMissing: true },
  ]);
  let firstPageRead = false;
  const { source } = sourceFor(db, async (query, opts) => {
    const records = await listCatalog(db, query, opts);
    if (opts.from === undefined) firstPageRead = true;
    return records;
  });
  function Probe(): ReactElement {
    const { items, loadMore, done: allLoaded, empty } = useCatalogItems(source, PICKED, 2);
    return (
      <div>
        <p>{`items=${String(items.length)} done=${String(allLoaded)} empty=${String(empty)}`}</p>
        {items.map((item) => (
          <h2 key={item.id}>{item.title}</h2>
        ))}
        <button type="button" onClick={loadMore}>Load more</button>
      </div>
    );
  }
  render(<Probe />);

  // The initial render also reads items=0 done=false empty=false, so wait
  // for the first page to have been read and committed before asserting.
  await waitFor(() => {
    assert.ok(firstPageRead, 'the first page has been read');
  });
  await settleRenders();
  assert.ok(screen.getByText('items=0 done=false empty=false'), 'all-ghost first page: no items, more to page, not empty');
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['One']);
  });

  db.close();
});
