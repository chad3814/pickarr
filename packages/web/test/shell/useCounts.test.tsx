import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribeInserts } from '../../src/store/notify.ts';
import { useCounts, CATEGORIES, type CountsSource } from '../../src/shell/useCounts.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would skip it and leave this file's
 * component mounted, still subscribed through `notify.ts`'s module-level
 * registry.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch, the way `applyBatch`'s own tests do -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/** The two reads `useCounts` needs, bound straight to a raw database -- no `Store`, no sync loop, nothing this suite would have to stop afterwards. */
function sourceFor(db: IDBDatabase): CountsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
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
  // Spec §6. Zero is an answer. A count that quietly fetched would make the
  // one screen proving offline capability the screen hiding its absence.
  const db = await freshDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    throw new Error('useCounts must never call fetch: counts come from the replica only');
  };

  try {
    render(<Counts store={sourceFor(db)} />);

    await waitFor(() => {
      assert.equal(textOf('tv'), '0', 'an empty replica reads as zero, not as still-loading');
    });
    assert.equal(textOf('movie'), '0');
    assert.equal(textOf('xxx'), '0');
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
