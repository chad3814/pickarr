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
import { useFeeds, type FeedsSource } from '../../src/settings/useFeeds.ts';

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

/** One `upsert` `SyncOp` for `rss_feed` -- the live tail never emits `create` (see `Feeds.test.tsx`'s own `feedOp` doc). */
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

/** The two operations `useFeeds` needs, bound straight to a raw database -- no `Store`, no sync loop. */
function sourceFor(db: IDBDatabase): FeedsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribeInserts,
  };
}

function FeedNames({ source }: { source: FeedsSource }): ReactElement {
  const feeds = useFeeds(source);
  if (feeds === undefined) return <p data-testid="loading">loading</p>;
  return (
    <ul>
      {feeds.map((feed) => (
        <li key={feed.id}>{feed.name}</li>
      ))}
    </ul>
  );
}

/** `queryAllByRole`, not `getAllByRole`: an empty list renders no `listitem` at all, and `getAllByRole` throws on zero matches rather than answering `[]`. */
function namesShown(): string[] {
  return screen.queryAllByRole('listitem').map((item) => item.textContent ?? '');
}

test('feeds come from the replica', async () => {
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);

  render(<FeedNames source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(namesShown(), ['Movies HD']);
  });
});

test('a feed added later appears without a refetch', async () => {
  const db = await freshDb();
  render(<FeedNames source={sourceFor(db)} />);

  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);

  await waitFor(() => {
    assert.deepEqual(namesShown(), ['Movies HD']);
  });
});

test('a tombstoned feed is not listed', async () => {
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  await seed(db, [{ op: 'delete', table: 'rss_feed', id: 1 }]);

  render(<FeedNames source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(namesShown(), [], 'a tombstoned feed is excluded, same as any other synced table');
  });
});

test('an empty replica reads as zero feeds, not as a fetch fallback', async () => {
  // Global Constraint: lists come from the replica only. Asserted as a call
  // count on `fetch`, not on the rendered output -- `useCounts.test.tsx`'s
  // own doc on why a call count cannot be fooled by a catch absorbing a
  // stray fetch.
  const db = await freshDb();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  try {
    render(<FeedNames source={sourceFor(db)} />);
    await waitFor(() => {
      assert.deepEqual(namesShown(), []);
    });
    assert.equal(fetchCalls, 0, 'useFeeds never called fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
