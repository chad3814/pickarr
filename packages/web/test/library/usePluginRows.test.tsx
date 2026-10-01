import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { PluginRows } from '@pickarr/plugin-ui';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { getRows, pluginRowsByMediaItems } from '../../src/store/rows.ts';
import { subscribeTouched, emit } from '../../src/store/notify.ts';
import { usePluginRows, emptyPluginRows, type PluginRowsSource } from '../../src/library/usePluginRows.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave this file's harness mounted.
 */
afterEach(cleanup);

/** A real timer, not fake ones -- fake timers hang this suite (`CLAUDE.md`). */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 15);
  });
}

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

function sourceFor(db: IDBDatabase): PluginRowsSource {
  return {
    pluginRowsByMediaItems: (mediaItemIds, tables) => pluginRowsByMediaItems(db, mediaItemIds, tables),
    // The module-level registry `applyBatch` itself emits into, so a second
    // `seed` below wakes this hook exactly as a second `/api/sync` batch
    // would.
    subscribeTouched,
    getRows: (table, ids) => getRows(db, table, ids),
  };
}

/**
 * A source whose fetch is `fetchRows` and whose other two members answer
 * nothing.
 *
 * For the tests that count fetches against no database at all. The no-op
 * `subscribeTouched` still returns an unsubscribe, so the hook's teardown
 * path runs; `getRows` is never reached, because nothing in those tests
 * applies a batch and so nothing can wake it.
 */
function countingSource(fetchRows: PluginRowsSource['pluginRowsByMediaItems']): PluginRowsSource {
  return {
    pluginRowsByMediaItems: fetchRows,
    subscribeTouched: () => () => {},
    getRows: async () => new Map(),
  };
}

/** Every id's `PluginRows`, sorted and stringified so a query can read it as one string. */
function textOf(rows: ReadonlyMap<number, PluginRows>): string {
  return JSON.stringify([...rows.entries()].toSorted((a, b) => a[0] - b[0]));
}

function Harness({
  source,
  mediaItemIds,
  tables,
}: {
  source: PluginRowsSource;
  mediaItemIds: readonly number[];
  tables: readonly string[];
}): ReactElement {
  const rows = usePluginRows(source, mediaItemIds, tables);
  return <div data-testid="result">{textOf(rows)}</div>;
}

function resultText(): string {
  return screen.getByTestId('result').textContent ?? '';
}

test('an empty mediaItemIds list fetches nothing and answers an empty map', async () => {
  let calls = 0;
  const source = countingSource(async () => {
    calls += 1;
    return { rows: new Map(), heldIds: new Map() };
  });
  render(<Harness source={source} mediaItemIds={[]} tables={['tv_release']} />);
  await settle();
  assert.equal(calls, 0, 'nothing to fetch for a page with no items');
  assert.equal(resultText(), '[]');
});

test("an empty tables list fetches nothing -- there is nothing a caller declared to partition", async () => {
  let calls = 0;
  const source = countingSource(async () => {
    calls += 1;
    return { rows: new Map(), heldIds: new Map() };
  });
  render(<Harness source={source} mediaItemIds={[1, 2]} tables={[]} />);
  await settle();
  assert.equal(calls, 0, 'a plugin with no declared tables costs nothing here either');
});

test('fetches once for the whole page, batched, and answers each id its own rows', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv' } },
    { op: 'upsert', table: 'tv_release', id: 10, value: { mediaItemId: 1, kind: 'episode' } },
    { op: 'upsert', table: 'media_item', id: 2, value: { pluginId: 'tv' } },
  ]);

  render(<Harness source={sourceFor(db)} mediaItemIds={[1, 2]} tables={['tv_release']} />);

  await waitFor(() => {
    assert.equal(resultText(), textOf(new Map([
      [1, { tv_release: [{ mediaItemId: 1, kind: 'episode' }] }],
      [2, { tv_release: [] }],
    ])));
  });
  db.close();
});

test('re-rendering with the same stable mediaItemIds and tables references does not refetch', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv' } }]);
  let calls = 0;
  const real = sourceFor(db);
  const source: PluginRowsSource = {
    ...real,
    pluginRowsByMediaItems: (mediaItemIds, tables) => {
      calls += 1;
      return real.pluginRowsByMediaItems(mediaItemIds, tables);
    },
  };
  const mediaItemIds = [1];
  const tables = ['tv_release'];

  const { rerender } = render(<Harness source={source} mediaItemIds={mediaItemIds} tables={tables} />);
  await waitFor(() => {
    assert.equal(calls, 1);
  });

  rerender(<Harness source={source} mediaItemIds={mediaItemIds} tables={tables} />);
  await settle();
  assert.equal(calls, 1, 'the same references changed nothing this effect depends on');
  db.close();
});

test('a new mediaItemIds reference -- a new page -- refetches', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv' } },
    { op: 'upsert', table: 'media_item', id: 2, value: { pluginId: 'tv' } },
  ]);
  let calls = 0;
  const real = sourceFor(db);
  const source: PluginRowsSource = {
    ...real,
    pluginRowsByMediaItems: (mediaItemIds, tables) => {
      calls += 1;
      return real.pluginRowsByMediaItems(mediaItemIds, tables);
    },
  };
  const tables = ['tv_release'];

  const { rerender } = render(<Harness source={source} mediaItemIds={[1]} tables={tables} />);
  await waitFor(() => {
    assert.equal(calls, 1);
  });

  rerender(<Harness source={source} mediaItemIds={[1, 2]} tables={tables} />);
  await waitFor(() => {
    assert.equal(calls, 2, 'a page with a different id list is a new fetch');
  });
  db.close();
});

test('a store-closed rejection is caught, not left as an unhandled rejection', async () => {
  // The same `InvalidStateError` shape `shell/useCounts.ts`'s own test
  // manufactures, and for the same reason: a list can still be mounted
  // when the store it reads from stops (sign-out, a 401).
  let rejectFetch: ((err: unknown) => void) | undefined;
  const source = countingSource(
    () =>
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      }),
  );

  const escaped: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    render(<Harness source={source} mediaItemIds={[1]} tables={['tv_release']} />);
    await waitFor(() => {
      assert.ok(rejectFetch !== undefined, 'the fetch is in flight');
    });

    const storeClosed = Object.assign(new Error('connection is closing or closed'), { name: 'InvalidStateError' });
    rejectFetch?.(storeClosed);
    await settle();

    assert.deepEqual(escaped, [], 'the rejection was caught, not left to escape as an unhandled rejection');
    assert.equal(resultText(), '[]', 'the failed fetch left the map at its initial, empty value');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

/**
 * One `create` `SyncOp` for `tv_release`, carrying only the field this hook's
 * own filter dereferences.
 *
 * `mediaItemId` and no more, deliberately: `usePluginRows` reads an inserted
 * row to answer one question -- does it belong to a media item on this page
 * -- and a fixture carrying the whole `TvRead` would not say which field
 * that question is asked of. `Category.test.tsx` drives the full read shape,
 * because that is where a card actually renders one.
 */
function tvReleaseFor(id: number, mediaItemId: number): SyncOp {
  return { op: 'create', table: 'tv_release', id, value: { mediaItemId } };
}

test('a plugin row inserted under an id on this page refetches; one under an id that is not, does not', async () => {
  // The staleness this subscription exists for, and its cost control, in one
  // test -- they are two halves of the same decision and a test of either
  // alone would let the other rot.
  //
  // `subscribeTouched` is **table-wide**: a wake carries ids and nothing
  // else, so without a filter one `tv_release` insert anywhere would refetch
  // the page for every mounted browse screen. Neither id has been held by a
  // previous fetch here, so both wakes fall to the filter -- a read of the
  // row -- and `getRows` is the batched member: one transaction per wake
  // however many ids the batch carried, which is exactly the trade
  // `useGatheredItem`'s own `regatherIfOurs` measured at 4 transactions
  // before and 1 after.
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv' } },
    { op: 'upsert', table: 'media_item', id: 2, value: { pluginId: 'tv' } },
  ]);
  let fetches = 0;
  let reads = 0;
  const real = sourceFor(db);
  const source: PluginRowsSource = {
    ...real,
    pluginRowsByMediaItems: (mediaItemIds, tables) => {
      fetches += 1;
      return real.pluginRowsByMediaItems(mediaItemIds, tables);
    },
    getRows: (table, ids) => {
      reads += 1;
      return real.getRows(table, ids);
    },
  };
  const mediaItemIds = [1];
  const tables = ['tv_release'];

  render(<Harness source={source} mediaItemIds={mediaItemIds} tables={tables} />);
  await waitFor(() => {
    assert.equal(fetches, 1, 'the first read, before any wake');
  });
  assert.equal(reads, 0, 'and no filter read yet: nothing has been inserted');

  // Item 2 is not on this page.
  await seed(db, [tvReleaseFor(20, 2)]);
  await waitFor(() => {
    assert.equal(reads, 1, 'the wake cost exactly one batched read');
  });
  await settle();
  assert.equal(fetches, 1, 'and no refetch: the inserted row belongs to a media item this page does not hold');

  // Item 1 is.
  await seed(db, [tvReleaseFor(10, 1)]);
  await waitFor(() => {
    assert.equal(fetches, 2, 'an insert under an id on this page does refetch');
  });
  assert.equal(reads, 2, 'one batched read per wake, whichever way the filter went');
  assert.equal(resultText(), textOf(new Map([[1, { tv_release: [{ mediaItemId: 1 }] }]])), 'and the refetch carried the new row');

  db.close();
});

test('unmounting drops every touched subscription, one per declared table', async () => {
  // Task 6's fix round spent a whole round removing a latch that leaked
  // three subscriptions per opened card. Closing a staleness by adding a
  // subscription is how that gets reintroduced, so the teardown is asserted
  // directly rather than inferred from a refetch that stopped happening --
  // a hook that kept its subscriptions but ignored their wakes would pass
  // the weaker version of this.
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv' } }]);
  let live = 0;
  const subscribedTo: string[] = [];
  const real = sourceFor(db);
  const source: PluginRowsSource = {
    ...real,
    subscribeTouched: (table, cb) => {
      live += 1;
      subscribedTo.push(table);
      const off = real.subscribeTouched(table, cb);
      return () => {
        live -= 1;
        off();
      };
    },
  };

  const { unmount } = render(
    <Harness source={source} mediaItemIds={[1]} tables={['tv_release', 'tv_season']} />,
  );
  await waitFor(() => {
    assert.equal(live, 2, 'one subscription per table the plugin declared, and no more');
  });
  assert.deepEqual(subscribedTo, ['tv_release', 'tv_season'], 'each declared table, in the order declared');

  unmount();
  assert.equal(live, 0, 'and none left behind');

  db.close();
});

test('an update to a plugin row the page holds refetches, and the new value is shown', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'tv_release', id: 50, value: { mediaItemId: 1, title: 'Old' } }]);
  render(<Harness source={sourceFor(db)} mediaItemIds={[1]} tables={['tv_release']} />);
  await waitFor(() => { assert.ok(resultText().includes('Old')); });
  await seed(db, [{ op: 'upsert', table: 'tv_release', id: 50, value: { mediaItemId: 1, title: 'New' } }]);
  await waitFor(() => { assert.ok(resultText().includes('New'), 'the corrected title arrived without a remount'); });
});

test('a plugin row the page holds that is re-pointed to another item disappears from the page', async () => {
  // Only the held id can wake this: the row's new value names an item this
  // page does not show, so the mediaItemOf fallback would say "not ours".
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'tv_release', id: 50, value: { mediaItemId: 1, title: 'Moved' } }]);
  render(<Harness source={sourceFor(db)} mediaItemIds={[1]} tables={['tv_release']} />);
  await waitFor(() => { assert.ok(resultText().includes('Moved')); });
  await seed(db, [{ op: 'upsert', table: 'tv_release', id: 50, value: { mediaItemId: 2, title: 'Moved' } }]);
  await waitFor(() => { assert.ok(!resultText().includes('Moved'), 'the row left this page'); });
});

test('a delete of a plugin row the page holds refetches, and the row is gone', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'tv_release', id: 50, value: { mediaItemId: 1, title: 'Gone soon' } }]);
  render(<Harness source={sourceFor(db)} mediaItemIds={[1]} tables={['tv_release']} />);
  await waitFor(() => { assert.ok(resultText().includes('Gone soon')); });
  await seed(db, [{ op: 'delete', table: 'tv_release', id: 50 }]);
  await waitFor(() => { assert.ok(!resultText().includes('Gone soon'), 'a tombstone carries no value, and the held id is enough'); });
});

test('a touched row for another item does not refetch', async () => {
  let fetches = 0;
  const source: PluginRowsSource = {
    ...sourceFor(await freshDb()),
    pluginRowsByMediaItems: async (ids, tables) => { fetches += 1; return { rows: new Map(), heldIds: new Map(tables.map((t) => [t, new Set<number>()])) }; },
  };
  render(<Harness source={source} mediaItemIds={[1]} tables={['tv_release']} />);
  await waitFor(() => { assert.equal(fetches, 1); });
  // A touched id the page does not hold, whose row (none in this db) names no item of ours.
  emit({ touched: new Map([['tv_release', [999]]]), inserted: new Map() });
  await settle();
  assert.equal(fetches, 1);
});

test('one wake with several matching ids refetches once', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'tv_release', id: 50, value: { mediaItemId: 1, title: 'A' } },
    { op: 'upsert', table: 'tv_release', id: 51, value: { mediaItemId: 1, title: 'B' } },
  ]);
  let fetches = 0;
  const real = sourceFor(db);
  const counting: PluginRowsSource = {
    ...real,
    pluginRowsByMediaItems: (ids, tables) => { fetches += 1; return real.pluginRowsByMediaItems(ids, tables); },
  };
  render(<Harness source={counting} mediaItemIds={[1]} tables={['tv_release']} />);
  await waitFor(() => { assert.equal(fetches, 1); });
  emit({ touched: new Map([['tv_release', [50, 51]]]), inserted: new Map() });
  await settle();
  assert.equal(fetches, 2, 'both ids are held; one refetch covers both');
});

test('emptyPluginRows seeds every named table to an empty array, and no others', () => {
  assert.deepEqual(emptyPluginRows(['tv_release', 'movie_detail']), { tv_release: [], movie_detail: [] });
  assert.deepEqual(emptyPluginRows([]), {});
});

test('a plugin that declared no tables gets one shared frozen value, not an object per call', () => {
  // Two of the three shipped plugins declare `tables: []`, so this is the
  // `rows` prop every card on two of the three browse screens receives on
  // every render. `{} !== {}`, so a fresh literal defeats any memoisation a
  // plugin's `Card` applied to `rows` -- `CardProps` is a public seam and
  // its `onExpandedChange` is memoised for exactly that reason (fix round
  // 1, review-found).
  //
  // An identity comparison, and safe to write as one: these are plain
  // objects, never DOM nodes, so `CLAUDE.md`'s live-element hazard does not
  // apply. Written as a boolean anyway, which is the house form.
  assert.ok(emptyPluginRows([]) === emptyPluginRows([]), 'the empty answer is one value, reused');
  assert.ok(Object.isFrozen(emptyPluginRows([])), 'and frozen, because every card shares it');

  // A non-empty `tables` cannot share, since the answer depends on the
  // argument -- so it is frozen rather than shared, and the caller holds it
  // stable instead (`library/Category.tsx` memoises on `tables`).
  const named = emptyPluginRows(['tv_release']);
  assert.ok(Object.isFrozen(named), 'a named-table answer is frozen too');
  assert.ok(named !== emptyPluginRows(['tv_release']), 'but not shared: it depends on its argument');
});
