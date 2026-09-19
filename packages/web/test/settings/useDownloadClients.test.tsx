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
import { useDownloadClients, type DownloadClientsSource } from '../../src/settings/useDownloadClients.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave this file's harness still
 * mounted, still subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/** One `upsert` carrying the projected `download_client` shape -- the live tail never emits `create` (see `Feeds.test.tsx`'s own `feedOp` doc). */
function clientOp({ id, name }: { id: number; name: string }): SyncOp {
  return {
    op: 'upsert',
    table: 'download_client',
    id,
    value: {
      id,
      name,
      type: 'torrent',
      implementation: 'qbittorrent',
      url: 'http://qbit.example:8080',
      username: null,
      category: '',
      createdAt: id,
      updatedAt: id,
    },
  };
}

/** The two operations `useDownloadClients` needs, bound straight to a raw database -- no `Store`, no sync loop. */
function sourceFor(db: IDBDatabase): DownloadClientsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribeInserts,
  };
}

function ClientNames({ source }: { source: DownloadClientsSource }): ReactElement {
  const clients = useDownloadClients(source);
  if (clients === undefined) return <p data-testid="loading">loading</p>;
  return (
    <ul>
      {clients.map((client) => (
        <li key={client.id}>{client.name}</li>
      ))}
    </ul>
  );
}

/** `queryAllByRole`, not `getAllByRole`: an empty list renders no `listitem` at all, and `getAllByRole` throws on zero matches rather than answering `[]`. */
function namesShown(): string[] {
  return screen.queryAllByRole('listitem').map((item) => item.textContent ?? '');
}

test('download clients come from the replica', async () => {
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Seedbox' })]);

  render(<ClientNames source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(namesShown(), ['Seedbox']);
  });
});

test('download clients are listed newest first', async () => {
  // `useFeeds`'s own equivalent exists because flipping `direction: 'prev'`
  // to `'next'` reversed that list and left all 100 web tests green: a
  // claim in a docblock with no test behind it.
  //
  // `clientOp` stamps `updatedAt: id`, and `by_table_updated` orders on
  // exactly that column, which is what makes the direction observable.
  // Seeded out of order so the expectation cannot be satisfied by insertion
  // order, and spelled out rather than derived from the seeded ops.
  const db = await freshDb();
  await seed(db, [
    clientOp({ id: 2, name: 'middle' }),
    clientOp({ id: 3, name: 'newest' }),
    clientOp({ id: 1, name: 'oldest' }),
  ]);

  render(<ClientNames source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(namesShown(), ['newest', 'middle', 'oldest']);
  });
});

test('a download client added later appears without a refetch', async () => {
  const db = await freshDb();
  render(<ClientNames source={sourceFor(db)} />);

  await seed(db, [clientOp({ id: 1, name: 'Seedbox' })]);

  await waitFor(() => {
    assert.deepEqual(namesShown(), ['Seedbox']);
  });
});

test('a tombstoned download client is not listed', async () => {
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Seedbox' })]);
  await seed(db, [{ op: 'delete', table: 'download_client', id: 1 }]);

  render(<ClientNames source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(namesShown(), [], 'a tombstoned client is excluded, same as any other synced table');
  });
});

test('a row missing a field the screen renders is declined rather than rendered blank', async () => {
  // A replica persists across client builds, so a row written by an older
  // host can be read by a newer page against a wire shape that has moved
  // (`store/gather.ts`'s own doc on why its predicates check rather than
  // cast). The second row here carries no `category`, which the list
  // renders; it drops out instead of putting an empty line on screen.
  const db = await freshDb();
  await seed(db, [
    clientOp({ id: 1, name: 'complete' }),
    {
      op: 'upsert',
      table: 'download_client',
      id: 2,
      value: {
        id: 2,
        name: 'missing a field',
        type: 'torrent',
        implementation: 'qbittorrent',
        url: 'http://qbit.example:8080',
        username: null,
        createdAt: 2,
        updatedAt: 2,
      },
    },
  ]);

  render(<ClientNames source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(namesShown(), ['complete'], 'the incomplete row is not listed at all');
  });
});

test('an empty replica reads as zero download clients, not as a fetch fallback', async () => {
  // Global Constraint: lists come from the replica only. Asserted as a call
  // count on `fetch` rather than on the rendered output, which a catch
  // absorbing a stray fetch would leave looking identical.
  const db = await freshDb();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  try {
    render(<ClientNames source={sourceFor(db)} />);
    await waitFor(() => {
      assert.deepEqual(namesShown(), []);
    });
    assert.equal(fetchCalls, 0, 'useDownloadClients never called fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
