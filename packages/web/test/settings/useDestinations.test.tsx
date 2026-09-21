import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribe, subscribeInserts } from '../../src/store/notify.ts';
import { useDestinations, type DestinationsSource } from '../../src/settings/useDestinations.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave this file's harness mounted
 * and still subscribed through `notify.ts`'s module-level registry -- and
 * this hook subscribes once per listed row as well as once to the table.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/**
 * One `upsert` carrying the projected `plugin_destination` shape --
 * `PluginDestinationSyncRead`, which is the whole row (`sync/tables.ts`).
 * An `upsert` rather than a `create`, for `Feeds.test.tsx`'s `feedOp`
 * reason: the live tail only ever emits `upsert`.
 */
function destinationOp({
  id,
  pluginId,
  root = '/media',
  shape = '{title}.{ext}',
  unmatchedDir = '_unmatched',
  updatedAt = id,
}: {
  id: number;
  pluginId: string;
  root?: string;
  shape?: string;
  unmatchedDir?: string;
  updatedAt?: number;
}): SyncOp {
  return {
    op: 'upsert',
    table: 'plugin_destination',
    id,
    value: { id, pluginId, root, shape, unmatchedDir, createdAt: id, updatedAt },
  };
}

/** The three operations this hook needs, bound straight to a raw database -- no `Store`, no sync loop. */
function sourceFor(db: IDBDatabase): DestinationsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribe,
    subscribeInserts,
  };
}

function Rows({ source }: { source: DestinationsSource }): ReactElement {
  const destinations = useDestinations(source);
  if (destinations === undefined) return <p data-testid="loading">loading</p>;
  if (destinations.length === 0) return <p data-testid="none">none</p>;
  return (
    <ul>
      {destinations.map((destination) => (
        <li key={destination.id}>
          {`${destination.pluginId}|${destination.root}|${destination.shape}|${destination.unmatchedDir}`}
        </li>
      ))}
    </ul>
  );
}

/** `queryAllByRole`, not `getAllByRole`: an empty list renders no `listitem` at all, and `getAllByRole` throws on zero matches rather than answering `[]`. */
function rowsShown(): string[] {
  return screen.queryAllByRole('listitem').map((item) => item.textContent ?? '');
}

test('the destinations come from the replica', async () => {
  const db = await freshDb();
  await seed(db, [destinationOp({ id: 1, pluginId: 'tv', root: '/media/tv', shape: '{series}/{title}.{ext}' })]);

  render(<Rows source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(rowsShown(), ['tv|/media/tv|{series}/{title}.{ext}|_unmatched']);
  });
});

test('a replica holding no destination is an answer, not a first read still running', async () => {
  // `plugin_destination` is created empty by migration 20 and gains a row
  // only when one is saved, so "no destinations at all" is the ordinary
  // state of a fresh install and must not render as loading.
  const db = await freshDb();

  render(<Rows source={sourceFor(db)} />);

  await waitFor(() => {
    assert.ok(screen.getByTestId('none'), 'an empty table reads as empty');
  });
});

test('a destination saved after the first read arrives without a refetch', async () => {
  const db = await freshDb();
  render(<Rows source={sourceFor(db)} />);
  await waitFor(() => {
    assert.ok(screen.getByTestId('none'));
  });

  await seed(db, [destinationOp({ id: 1, pluginId: 'movie', root: '/media/films' })]);

  await waitFor(() => {
    assert.deepEqual(rowsShown(), ['movie|/media/films|{title}.{ext}|_unmatched']);
  });
});

test('a destination edited in place reaches the screen, which an insert subscription alone would miss', async () => {
  // This is the whole reason the hook watches each listed row as well as
  // the table. `PUT /api/destinations/:pluginId` upserts, so the ordinary
  // case is a *second* save over a row that already exists -- and
  // `store/apply.ts` counts that as `touched`, never `inserted`, so the
  // insert channel never wakes for it.
  const db = await freshDb();
  await seed(db, [destinationOp({ id: 1, pluginId: 'tv', root: '/media/tv' })]);
  render(<Rows source={sourceFor(db)} />);
  await waitFor(() => {
    assert.deepEqual(rowsShown(), ['tv|/media/tv|{title}.{ext}|_unmatched']);
  });

  await seed(db, [destinationOp({ id: 1, pluginId: 'tv', root: '/srv/tv', updatedAt: 9 })]);

  await waitFor(() => {
    assert.deepEqual(rowsShown(), ['tv|/srv/tv|{title}.{ext}|_unmatched']);
  });
});

test('destinations are listed by id, not in the order the updated-at index walked them', async () => {
  // `by_table_updated` is keyed on `updatedAt`, so saving one plugin's
  // destination would otherwise move its row past the others -- on a screen
  // whose whole job is to let an operator work down a list of plugins.
  const db = await freshDb();
  await seed(db, [
    destinationOp({ id: 1, pluginId: 'tv', root: '/media/tv', updatedAt: 50 }),
    destinationOp({ id: 2, pluginId: 'movie', root: '/media/films', updatedAt: 10 }),
  ]);

  render(<Rows source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(rowsShown().map((row) => row.split('|')[0]), ['tv', 'movie'],
      'id order, which is the order the rows were first saved in');
  });
});

test('a row missing a field this screen dereferences is declined, not rendered half-empty', async () => {
  // A replica persists across client builds and neither `SCHEMA_VERSION`
  // nor the generation token fires when a *wire shape* changes, so this is
  // a check rather than a cast (`store/gather.ts`'s own account).
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'plugin_destination', id: 1, value: { id: 1, pluginId: 'tv', root: '/media/tv' } },
    destinationOp({ id: 2, pluginId: 'movie', root: '/media/films' }),
  ]);

  render(<Rows source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(rowsShown(), ['movie|/media/films|{title}.{ext}|_unmatched']);
  });
});

test('the hook never reaches the network: the list comes from the replica only', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => assert.fail('a list must come from the replica, never a refetch');
  try {
    const db = await freshDb();
    await seed(db, [destinationOp({ id: 1, pluginId: 'tv' })]);
    render(<Rows source={sourceFor(db)} />);
    await waitFor(() => {
      assert.equal(rowsShown().length, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a store-closed rejection during refresh is caught, not left as an unhandled rejection', async () => {
  // This screen can still be mounted and subscribed when the store it reads
  // from stops -- a sign-out, a 401 -- the same `InvalidStateError` every
  // other hook in this package guards.
  const db = await freshDb();
  await seed(db, [destinationOp({ id: 1, pluginId: 'tv' })]);
  const source: DestinationsSource = {
    listByTable: () => Promise.reject(Object.assign(new Error('closed'), { name: 'InvalidStateError' })),
    subscribe,
    subscribeInserts,
  };

  render(<Rows source={source} />);

  await waitFor(() => {
    assert.ok(screen.getByTestId('loading'), 'the read never resolved, and nothing threw out of the effect');
  });
});
