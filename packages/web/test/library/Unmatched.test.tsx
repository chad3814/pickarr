import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { RssItemSyncRead } from '@pickarr/contract';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribe, subscribeInserts } from '../../src/store/notify.ts';
import { Unmatched, type UnmatchedSource } from '../../src/library/Unmatched.tsx';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that threw before its own call would leave a component mounted, still
 * subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch, the way `applyBatch`'s own tests do -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/**
 * One `rss_item` `upsert` op, with everything but `id`, `filename`,
 * `mediaItemId` and `updatedAt` defaulted.
 *
 * **`upsert`, not `create`.** `sync/tail.ts`'s `tailSince` -- the loop a
 * running client actually receives live updates through -- never emits
 * `create` at all; only its backwards backfill walk does, for a row a
 * client may not hold yet. Building this with `create` would make a second
 * call for the same `id` a complete no-op (`store/apply.ts`: "`create` is a
 * no-op over a row already held"), silently refusing to apply the very
 * update the second test below drives.
 */
function rssOp({
  id,
  filename,
  mediaItemId,
  updatedAt,
}: {
  id: number;
  filename: string;
  mediaItemId: number | null;
  updatedAt: number;
}): SyncOp {
  const value: RssItemSyncRead = {
    id,
    feedId: 1,
    filename,
    createdAt: updatedAt,
    updatedAt,
    downloadType: 'torrent',
    mediaItemId,
    rankingScore: null,
    resolution: '1080p',
    resolutionDetail: null,
    deliveredAt: null,
  };
  return { op: 'upsert', table: 'rss_item', id, value };
}

/** The three reads/subscriptions `Unmatched` needs, bound straight to a raw database -- no `Store`, no sync loop, nothing this suite would have to stop afterwards. */
function sourceFor(db: IDBDatabase): UnmatchedSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribeInserts,
    subscribe,
  };
}

/**
 * Every rendered release's filename, in the order the screen shows them.
 * `queryAllByRole`, not `getAllByRole`: the latter throws when nothing
 * matches, which is exactly the state the "drops off" test asserts on.
 */
function filenamesShown(): string[] {
  return screen.queryAllByRole('listitem').map((item) => item.textContent ?? '');
}

test('lists releases whose mediaItemId is null, newest first', async () => {
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'older.mkv', mediaItemId: null, updatedAt: 10 }),
    rssOp({ id: 2, filename: 'matched.mkv', mediaItemId: 99, updatedAt: 20 }),
    rssOp({ id: 3, filename: 'newer.mkv', mediaItemId: null, updatedAt: 30 }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['newer.mkv', 'older.mkv'], 'matched.mkv is not here');
  });
});

test('a release that has since been matched drops off the list', async () => {
  const db = await freshDb();
  await seed(db, [rssOp({ id: 1, filename: 'pending.mkv', mediaItemId: null, updatedAt: 10 })]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['pending.mkv']);
  });

  // A lookup finished: the same row arrives again with a mediaItemId, as a
  // single in-place `upsert` -- exactly what `sync/tail.ts`'s `tailSince`
  // actually sends for a live match, and exactly the shape `subscribeInserts`
  // alone cannot see (`Unmatched.tsx`'s own docblock). This is provable now
  // that `Unmatched` also subscribes per-row through `source.subscribe`:
  // `store/notify.ts`'s `touched` channel fires on *any* change to a row it
  // already holds, `upsert` included, which is what wakes this screen to
  // re-read and drop the now-matched release.
  await seed(db, [rssOp({ id: 1, filename: 'pending.mkv', mediaItemId: 99, updatedAt: 20 })]);

  await waitFor(() => {
    assert.equal(filenamesShown().length, 0, 'a matched release leaves this screen');
  });
});

test('an empty list says nothing is unmatched, rather than rendering blank', async () => {
  const db = await freshDb();

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.ok(screen.getByText(/everything has been matched/i));
  });
});

test('a fresh unmatched release appears without a reload', async () => {
  const db = await freshDb();

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.ok(screen.getByText(/everything has been matched/i));
  });

  await seed(db, [rssOp({ id: 1, filename: 'arrived.mkv', mediaItemId: null, updatedAt: 10 })]);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['arrived.mkv'], 'subscribeInserts woke the screen and it re-read the table');
  });
});

test('no fetch is issued while listing', async () => {
  // Lists come from the replica only (Global Constraint). Assert on a call
  // count rather than on what rendered: a screen that quietly fetched and
  // got nothing back looks identical to one that correctly read an empty
  // replica.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('no fetch may be issued while listing');
  };
  try {
    const db = await freshDb();
    await seed(db, [rssOp({ id: 1, filename: 'local.mkv', mediaItemId: null, updatedAt: 10 })]);

    render(<Unmatched source={sourceFor(db)} />);

    await waitFor(() => {
      assert.deepEqual(filenamesShown(), ['local.mkv']);
    });
    assert.equal(calls, 0, 'the replica answered without the network');
  } finally {
    globalThis.fetch = original;
  }
});
