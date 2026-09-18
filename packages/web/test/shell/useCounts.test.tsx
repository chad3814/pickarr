import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { countByPlugin } from '../../src/store/rows.ts';
import { subscribeInserts } from '../../src/store/notify.ts';
import { useCounts, CATEGORIES, type CountsSource } from '../../src/shell/useCounts.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would skip it and leave this file's
 * component mounted, still subscribed through `notify.ts`'s module-level
 * registry.
 */
afterEach(cleanup);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A real timer, not fake ones -- fake timers hang this suite (`CLAUDE.md`). */
function settle(): Promise<void> {
  return delay(15);
}

/** Seeds `ops` into `db` in one batch, the way `applyBatch`'s own tests do -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/** The two operations `useCounts` needs, bound straight to a raw database -- no `Store`, no sync loop, nothing this suite would have to stop afterwards. */
function sourceFor(db: IDBDatabase): CountsSource {
  return {
    countByPlugin: (table, pluginId) => countByPlugin(db, table, pluginId),
    subscribeInserts,
  };
}

/** Renders every count as text a query can find by its category. */
function Counts({ store }: { store: CountsSource }): ReactElement {
  const counts = useCounts(store);
  return (
    <dl>
      {CATEGORIES.map((category) => (
        <dd key={category} data-testid={category}>
          {counts[category]}
        </dd>
      ))}
    </dl>
  );
}

function textOf(category: string): string {
  return screen.getByTestId(category).textContent ?? '';
}

test('a count comes from the replica and climbs when rows arrive', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 1 } }]);

  render(<Counts store={sourceFor(db)} />);

  await waitFor(() => {
    assert.equal(textOf('tv'), '1', 'the initial read counted the one seeded row');
  });

  await seed(db, [{ op: 'upsert', table: 'media_item', id: 2, value: { pluginId: 'tv', updatedAt: 2 } }]);

  await waitFor(() => {
    assert.equal(textOf('tv'), '2', 'subscribeInserts woke the hook and it re-read the table');
  });

  db.close();
});

test('a tombstoned row is not counted', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 1 } }]);
  await seed(db, [{ op: 'delete', table: 'media_item', id: 1 }]);

  render(<Counts store={sourceFor(db)} />);

  await waitFor(() => {
    assert.equal(textOf('tv'), '0', 'a tombstoned media item is excluded, same as listByTable itself excludes it');
  });

  db.close();
});

test('the count does not fall back to the network when the replica is empty', async () => {
  // Spec §6, Global Constraint. Zero is an answer. A count that quietly
  // fetched would make the one screen proving offline capability the screen
  // hiding its absence.
  //
  // Asserted as a call count on `fetch`, independent of what `counts`
  // renders -- not by making the stub throw and trusting the throw to
  // surface. A fix-round review mutated `refresh()` to add an unconditional
  // `await fetch(...)` and this test still passed under the throwing form:
  // `safeRefresh`'s catch (added for a different, legitimate reason -- see
  // `useCounts.ts`'s own doc) absorbed the stub's throw and left `counts` at
  // the same `ZERO_COUNTS` an honestly empty replica produces, so the
  // assertion below could not tell "read zero rows" from "crashed before
  // reading at all". A call count cannot be fooled the same way: it does not
  // matter whether a stray `fetch()` throws, resolves, or is itself caught --
  // if it happened at all, this fails.
  const db = await freshDb();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  try {
    render(<Counts store={sourceFor(db)} />);

    await waitFor(() => {
      assert.equal(textOf('tv'), '0', 'an empty replica reads as zero, not as still-loading');
    });
    assert.equal(textOf('movie'), '0');
    assert.equal(textOf('xxx'), '0');
    assert.equal(fetchCalls, 0, 'useCounts never called fetch: counts come from the replica only');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('each category is counted separately', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 1, value: { pluginId: 'tv', updatedAt: 1 } },
    { op: 'upsert', table: 'media_item', id: 2, value: { pluginId: 'tv', updatedAt: 2 } },
    { op: 'upsert', table: 'media_item', id: 3, value: { pluginId: 'movie', updatedAt: 3 } },
    { op: 'upsert', table: 'media_item', id: 4, value: { pluginId: 'xxx', updatedAt: 4 } },
  ]);

  render(<Counts store={sourceFor(db)} />);

  await waitFor(() => {
    assert.equal(textOf('tv'), '2', 'two tv media items');
  });
  assert.equal(textOf('movie'), '1', 'one movie media item, not conflated with tv');
  assert.equal(textOf('xxx'), '1', 'one xxx media item, not conflated with the other two');

  db.close();
});

test('counting asks the index once per category and reads no rows', async () => {
  // Pins the shape of `refresh` itself, not just its output: three calls to
  // `countByPlugin`, one per category, and nothing else -- `listByTable`
  // (or any row read) is not part of this source at all, so a regression
  // back to reading rows would fail this test by having no such method to
  // call, not merely by producing a wrong number.
  const calls: string[] = [];
  const source: CountsSource = {
    countByPlugin: async (table, pluginId) => {
      calls.push(`${table}:${pluginId}`);
      return pluginId === 'tv' ? 2 : 0;
    },
    subscribeInserts: () => () => {},
  };

  render(<Counts store={source} />);

  await waitFor(() => {
    assert.equal(textOf('tv'), '2', 'the tv count settled from the stub');
  });
  assert.equal(textOf('movie'), '0');
  assert.equal(textOf('xxx'), '0');
  assert.deepEqual(calls, ['media_item:tv', 'media_item:movie', 'media_item:xxx']);
});

test('a store-closed rejection during refresh is caught, not left as an unhandled rejection', async () => {
  // `useCounts.ts`'s own `safeRefresh` catch, proved directly rather than
  // asserted by doc comment: a fix-round review found the original (broad)
  // version of this catch had zero test coverage -- removing it produced no
  // failures anywhere in this file. This constructs the exact race `Shell`
  // can cause (its store closing while a read is still in flight) without
  // needing `Shell` at all: `countByPlugin` is held open on a promise this
  // test controls, and rejected with the same `InvalidStateError` shape
  // IndexedDB actually produces when the connection underneath it is gone
  // (measured directly against `Shell.test.tsx`'s own race, task 6's report).
  let rejectRead: ((err: unknown) => void) | undefined;
  const source: CountsSource = {
    countByPlugin: () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
    subscribeInserts,
  };

  const escaped: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    render(<Counts store={source} />);

    await waitFor(() => {
      assert.ok(rejectRead !== undefined, 'the first read is in flight');
    });

    const storeClosed = Object.assign(new Error('connection is closing or closed'), { name: 'InvalidStateError' });
    rejectRead?.(storeClosed);
    await settle();

    assert.deepEqual(escaped, [], 'the rejection was caught, not left to escape as an unhandled rejection');
    assert.equal(textOf('tv'), '0', 'the failed read left the count at its initial value, and the component is still alive');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});
