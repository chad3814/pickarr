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
import { useClientMappings, type ClientMappingsSource } from '../../src/settings/useClientMappings.ts';

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

/**
 * One `upsert` carrying the **projected** `filepath_mapping` shape --
 * `FilepathMappingSyncRead`, not the raw table row: no `import_mode`, which
 * belongs to the importer and is not replicated. An `upsert` rather than a
 * `create` for `Feeds.test.tsx`'s `feedOp` reason: the live tail only ever
 * emits `upsert`.
 */
function mappingOp({
  id,
  downloadClientId = 1,
  fromPath,
  toPath,
  updatedAt = id,
}: {
  id: number;
  downloadClientId?: number;
  fromPath: string;
  toPath: string;
  updatedAt?: number;
}): SyncOp {
  return {
    op: 'upsert',
    table: 'filepath_mapping',
    id,
    value: { id, downloadClientId, fromPath, toPath, createdAt: id, updatedAt },
  };
}

/** The three operations `useClientMappings` needs, bound straight to a raw database -- no `Store`, no sync loop. */
function sourceFor(db: IDBDatabase): ClientMappingsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribe,
    subscribeInserts,
  };
}

function MappingPaths({ source, clientId }: { source: ClientMappingsSource; clientId: number }): ReactElement {
  const mappings = useClientMappings(source, clientId);
  if (mappings === undefined) return <p data-testid="loading">loading</p>;
  return (
    <ul>
      {mappings.map((mapping) => (
        <li key={mapping.id}>{`${mapping.fromPath}|${mapping.toPath}`}</li>
      ))}
    </ul>
  );
}

/** `queryAllByRole`, not `getAllByRole`: an empty list renders no `listitem` at all, and `getAllByRole` throws on zero matches rather than answering `[]`. */
function pathsShown(): string[] {
  return screen.queryAllByRole('listitem').map((item) => item.textContent ?? '');
}

test('a client\'s mappings come from the replica', async () => {
  const db = await freshDb();
  await seed(db, [mappingOp({ id: 1, fromPath: '/downloads', toPath: '/media' })]);

  render(<MappingPaths source={sourceFor(db)} clientId={1} />);

  await waitFor(() => {
    assert.deepEqual(pathsShown(), ['/downloads|/media']);
  });
});

test('only this client\'s mappings are listed', async () => {
  // A mapping belongs to exactly one client by foreign key and is
  // meaningless away from it (design spec §8). The table is table-wide in
  // the replica, so the filter is this hook's job.
  const db = await freshDb();
  await seed(db, [
    mappingOp({ id: 1, downloadClientId: 1, fromPath: '/mine', toPath: '/media' }),
    mappingOp({ id: 2, downloadClientId: 2, fromPath: '/theirs', toPath: '/other' }),
  ]);

  render(<MappingPaths source={sourceFor(db)} clientId={1} />);

  await waitFor(() => {
    assert.deepEqual(pathsShown(), ['/mine|/media']);
  });
});

test('an added mapping arrives through the insert subscription, with no refetch asked for', async () => {
  const db = await freshDb();
  render(<MappingPaths source={sourceFor(db)} clientId={1} />);
  await waitFor(() => {
    assert.deepEqual(pathsShown(), []);
  });

  await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' })]);

  await waitFor(() => {
    assert.deepEqual(pathsShown(), ['/downloads|/media']);
  });
});

test('an edited mapping updates in place, which the insert channel alone cannot see', async () => {
  // `store/apply.ts` counts an upsert over a row that already carried a
  // value as `touched`, never `inserted` (`Changed`'s own doc), so
  // `subscribeInserts` does not fire for an edit. This hook watches each
  // listed row by key as well, which is the only channel an edit wakes.
  const db = await freshDb();
  await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' })]);
  render(<MappingPaths source={sourceFor(db)} clientId={1} />);
  await waitFor(() => {
    assert.deepEqual(pathsShown(), ['/downloads|/media']);
  });

  await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/tank/media', updatedAt: 9 })]);

  await waitFor(() => {
    assert.deepEqual(pathsShown(), ['/downloads|/tank/media']);
  });
});

test('a removed mapping leaves the list, through the delete tombstone', async () => {
  // `installSyncTriggers` emits `AFTER DELETE ... 'delete'`, so a removal
  // tombstones to the browser for free (design spec §5). A tombstone is
  // absent from `by_table_updated`, so the re-read simply does not find it.
  const db = await freshDb();
  await seed(db, [
    mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' }),
    mappingOp({ id: 8, fromPath: '/incomplete', toPath: '/staging' }),
  ]);
  render(<MappingPaths source={sourceFor(db)} clientId={1} />);
  await waitFor(() => {
    assert.equal(pathsShown().length, 2);
  });

  await seed(db, [{ op: 'delete', table: 'filepath_mapping', id: 7 }]);

  await waitFor(() => {
    assert.deepEqual(pathsShown(), ['/incomplete|/staging']);
  });
});

test('a mapping whose replicated row is missing a path is declined, not rendered as a blank line', async () => {
  // A replica outlives the build that reads it and neither `SCHEMA_VERSION`
  // nor the generation token fires when a wire shape changes
  // (`store/gather.ts`'s predicates' own reasoning). A check rather than a
  // cast, so an unreadable row is one this list declines.
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'filepath_mapping', id: 1, value: { id: 1, downloadClientId: 1, fromPath: '/ok', toPath: '/media', createdAt: 1, updatedAt: 1 } },
    { op: 'upsert', table: 'filepath_mapping', id: 2, value: { id: 2, downloadClientId: 1, fromPath: '/broken', createdAt: 2, updatedAt: 2 } },
  ]);

  render(<MappingPaths source={sourceFor(db)} clientId={1} />);

  await waitFor(() => {
    assert.deepEqual(pathsShown(), ['/ok|/media']);
  });
});

test('undefined until the first read resolves, which is not the same as none', async () => {
  const db = await freshDb();
  render(<MappingPaths source={sourceFor(db)} clientId={1} />);

  assert.ok(screen.getByTestId('loading'), 'the first render has no answer yet');

  await waitFor(() => {
    assert.ok(!screen.queryByTestId('loading'), 'and the empty answer is distinct from it');
  });
  assert.deepEqual(pathsShown(), []);
});

test('the hook never calls fetch: the list comes from the replica only', async () => {
  const db = await freshDb();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  try {
    await seed(db, [mappingOp({ id: 1, fromPath: '/downloads', toPath: '/media' })]);
    render(<MappingPaths source={sourceFor(db)} clientId={1} />);
    await waitFor(() => {
      assert.deepEqual(pathsShown(), ['/downloads|/media']);
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unmounting drops every subscription, the per-row ones included', async () => {
  // A hook that subscribes per listed row has as many teardowns to get
  // right as there are rows, and a leaked one keeps re-reading a database
  // whose component is gone. Counted through the source, which is the only
  // place both channels pass through.
  const db = await freshDb();
  await seed(db, [
    mappingOp({ id: 1, fromPath: '/downloads', toPath: '/media' }),
    mappingOp({ id: 2, fromPath: '/incomplete', toPath: '/staging' }),
  ]);
  let live = 0;
  const bare = sourceFor(db);
  const counted: ClientMappingsSource = {
    listByTable: bare.listByTable,
    subscribe: (table, id, cb) => {
      live += 1;
      const off = bare.subscribe(table, id, cb);
      return () => {
        live -= 1;
        off();
      };
    },
    subscribeInserts: (table, cb) => {
      live += 1;
      const off = bare.subscribeInserts(table, cb);
      return () => {
        live -= 1;
        off();
      };
    },
  };

  const { unmount } = render(<MappingPaths source={counted} clientId={1} />);
  await waitFor(() => {
    assert.equal(pathsShown().length, 2);
  });
  assert.ok(live >= 3, 'the insert channel and one subscription per listed row');

  unmount();
  assert.equal(live, 0, 'every subscription this hook opened is released on unmount');
});
