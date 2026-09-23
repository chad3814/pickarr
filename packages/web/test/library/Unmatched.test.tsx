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
    lookupJson: null,
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

/** The filename the cost test below gives release `id`. */
function costFixtureFilename(id: number): string {
  return `release-${String(id)}.mkv`;
}

/**
 * Polls until `read()` has stopped changing across `stable` consecutive
 * macrotasks, or `limit` of them have passed, and answers its final value. A
 * screen whose every wake starts another walk has no quiet point to
 * `waitFor`, so the number the test below asserts on is only knowable once
 * the screen has actually stopped reading.
 */
async function quiesce(read: () => number, stable = 60, limit = 4000): Promise<number> {
  let last = read();
  let unchanged = 0;
  for (let tick = 0; tick < limit && unchanged < stable; tick += 1) {
    // eslint-disable-next-line no-await-in-loop -- each tick has to land before the next is scheduled; that is the whole of what "has stopped" means here
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    const now = read();
    unchanged = now === last ? unchanged + 1 : 0;
    last = now;
  }
  return last;
}

test('a batch that matches every listed release costs one re-read, not one per listed row', async () => {
  // Cost, asserted directly. Every other test in this file checks what
  // finally rendered, and a screen that re-read the whole table once per
  // listed row renders exactly what one that re-read it once renders --
  // which is why the fan-out survived a fix round aimed at this very screen
  // (whole-branch review §1: 400 rows with 24 listed cost 408 full-table
  // page reads for a single batch, because `store/notify.ts`'s `emit` fires
  // `fireRow` once per touched row and each fire started its own walk).
  //
  // A walk is counted by its first read, the one carrying no `from`: every
  // walk starts with exactly one of those and resumes with a `from`
  // thereafter, so counting them needs nothing of `readUnmatched`'s
  // internals.
  const db = await freshDb();
  const total = 400;
  const listed = 24;
  const seedOps: SyncOp[] = [];
  for (let id = 1; id <= total; id += 1) {
    // The newest `listed` rows are the unmatched ones: the short tail this
    // screen exists to show, and exactly one screenful of it.
    seedOps.push(rssOp({
      id,
      filename: costFixtureFilename(id),
      mediaItemId: id > total - listed ? null : 7,
      updatedAt: id,
    }));
  }
  await seed(db, seedOps);

  const real = sourceFor(db);
  let walks = 0;
  let pageReads = 0;
  const source: UnmatchedSource = {
    ...real,
    listByTable: (table, opts) => {
      pageReads += 1;
      if (opts.from === undefined) walks += 1;
      return real.listByTable(table, opts);
    },
  };

  render(<Unmatched source={source} />);
  await waitFor(() => {
    assert.equal(filenamesShown().length, listed, 'one screenful of unmatched releases');
  });
  const walksAfterFirstRender = walks;

  // A lookup batch matches every listed release at once -- the exact
  // transition this screen exists to show. `emit` runs all `listed` row
  // subscriptions synchronously before `applyBatch` resolves, so the
  // fan-out is already fully visible the moment this `await` returns.
  const matched: SyncOp[] = [];
  for (let id = total - listed + 1; id <= total; id += 1) {
    matched.push(rssOp({ id, filename: costFixtureFilename(id), mediaItemId: 7, updatedAt: id + total }));
  }
  await seed(db, matched);

  assert.equal(walks - walksAfterFirstRender, 1, 'the batch started one walk, not one per listed row');

  await waitFor(() => {
    assert.equal(filenamesShown().length, 0, 'every listed release left the screen');
  });
  const settled = await quiesce(() => walks) - walksAfterFirstRender;
  assert.ok(settled <= 2, `one batch settles in at most two walks, not ${String(settled)}`);
  assert.ok(pageReads > 0, 'and the screen really did read the replica');
});
