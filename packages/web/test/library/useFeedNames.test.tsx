import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribeTable } from '../../src/store/notify.ts';
import { useFeedNames, type FeedNamesSource } from '../../src/library/useFeedNames.ts';

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

/** One `upsert` `SyncOp` for `rss_feed`, matching `settings/useFeeds.test.tsx`'s own `feedOp`. */
function feedOp({ id, name, url = 'https://tracker.example/rss' }: { id: number; name: string; url?: string }): SyncOp {
  return {
    op: 'upsert',
    table: 'rss_feed',
    id,
    value: {
      id,
      pluginId: 'tv',
      name,
      downloadType: 'torrent',
      pollIntervalS: 300,
      downloadClientId: null,
      createdAt: id,
      updatedAt: id,
      url,
    },
  };
}

/** The two operations `useFeedNames` needs, bound straight to a raw database -- no `Store`, no sync loop. */
function sourceFor(db: IDBDatabase): FeedNamesSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribeTable,
  };
}

/** Every entry, sorted and stringified so a single query can read the whole map as one string. */
function textOf(names: ReadonlyMap<number, string>): string {
  return JSON.stringify([...names.entries()].toSorted((a, b) => a[0] - b[0]));
}

function Harness({ source }: { source: FeedNamesSource }): ReactElement {
  const names = useFeedNames(source);
  return <p data-testid="result">{textOf(names)}</p>;
}

/**
 * Renders `String(names.get(id))` rather than the whole map, so a test can
 * tell `undefined` (`'undefined'`) apart from an empty string (`''`) --
 * the distinction "an id no feed claims is simply absent" is about.
 */
function Lookup({ source, id }: { source: FeedNamesSource; id: number }): ReactElement {
  const names = useFeedNames(source);
  return <p data-testid="result">{String(names.get(id))}</p>;
}

function resultText(): string {
  return screen.getByTestId('result').textContent ?? '';
}

test('a feed id resolves to its name', async () => {
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);

  render(<Harness source={sourceFor(db)} />);

  await waitFor(() => {
    assert.equal(resultText(), textOf(new Map([[1, 'Movies HD']])));
  });
  db.close();
});

test('an id no feed claims is simply absent, not an empty string', async () => {
  // The card renders no trailing label at all for an unknown feed, which
  // is a different thing from a feed named ''. `Map.get` answering
  // `undefined` is what `CardHeading`'s optional `trailing` consumes.
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);

  render(<Lookup source={sourceFor(db)} id={2} />);

  await waitFor(() => {
    assert.equal(resultText(), 'undefined', 'an id no feed claims answers undefined, not the empty string');
  });
  db.close();
});

test('a feed renamed after the first read is re-read', async () => {
  // `subscribeTable`, not `subscribeInserts`: a rename is an update, and
  // an inserts-only subscription sleeps through it. This is the same gap
  // that left a deleted feed on the settings screen until a reload.
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  render(<Harness source={sourceFor(db)} />);
  await waitFor(() => {
    assert.equal(resultText(), textOf(new Map([[1, 'Movies HD']])));
  });

  await seed(db, [feedOp({ id: 1, name: 'Movies UHD' })]);

  await waitFor(() => {
    assert.equal(resultText(), textOf(new Map([[1, 'Movies UHD']])), 'the rename woke the reader, not just the next reload');
  });
  db.close();
});

test('reading feed names never calls fetch', async () => {
  // Global Constraint: lists come from the replica only. Asserted as a
  // call count, which a catch absorbing a stray fetch cannot fool.
  const db = await freshDb();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  try {
    render(<Harness source={sourceFor(db)} />);
    await waitFor(() => {
      assert.equal(resultText(), '[]');
    });
    assert.equal(fetchCalls, 0, 'useFeedNames never called fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
  db.close();
});
