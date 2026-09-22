import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { PluginRows } from '@pickarr/plugin-ui';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { pluginRowsByMediaItems } from '../../src/store/rows.ts';
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
  const source: PluginRowsSource = {
    pluginRowsByMediaItems: async () => {
      calls += 1;
      return new Map();
    },
  };
  render(<Harness source={source} mediaItemIds={[]} tables={['tv_release']} />);
  await settle();
  assert.equal(calls, 0, 'nothing to fetch for a page with no items');
  assert.equal(resultText(), '[]');
});

test("an empty tables list fetches nothing -- there is nothing a caller declared to partition", async () => {
  let calls = 0;
  const source: PluginRowsSource = {
    pluginRowsByMediaItems: async () => {
      calls += 1;
      return new Map();
    },
  };
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
  const source: PluginRowsSource = {
    pluginRowsByMediaItems: () =>
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      }),
  };

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
