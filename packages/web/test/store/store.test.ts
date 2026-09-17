import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createStore, type CreateStoreDeps, type Store } from '../../src/store/index.ts';
import { openStore } from '../../src/store/db.ts';
import { readCursors } from '../../src/store/meta.ts';
import { emitReset } from '../../src/store/notify.ts';
import type { Lease, Schedule, SyncFetch, SyncLoop, SyncResponse } from '../../src/store/sync.ts';

/**
 * The one test the whole slice has been building toward: everything wired
 * together, through `createStore` alone, with no module reached into
 * directly. Every task before this one tested its own module against a
 * hand-built store -- a database the *test* opened and seeded with
 * `applyBatch` calls it wrote itself -- so none of them could catch
 * `index.ts` wiring a read function, a subscription, or `stop()` to the
 * wrong (or no) database. This is the test that would.
 *
 * Everything started here is torn down in `afterEach`, not at the end of the
 * test body, because `afterEach` runs whether the test passed or threw and a
 * per-test call only runs on the happy path -- which is the path that did
 * not need it (`CLAUDE.md`). Left running, this suite's own scheduled tasks
 * and `BroadcastChannel` would hang the process with no failing test to
 * point at.
 */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A real timer, not fake ones -- fake timers hang this suite (`CLAUDE.md`). Nothing here waits on wall-clock duration; the scheduler is driven by hand. */
function settle(): Promise<void> {
  return delay(15);
}

interface ScheduledTask {
  loop: SyncLoop;
  run: () => void;
  ran: boolean;
  cancelled: boolean;
}

interface ManualScheduler {
  schedule: Schedule;
  drive(loop: SyncLoop): Promise<void>;
}

/** The scheduler seam `sync.ts` was built to take, driven by hand so the two loops can be stepped in the order this test chooses. */
function manualScheduler(): ManualScheduler {
  const tasks: ScheduledTask[] = [];
  const schedule: Schedule = (loop, _delayMs, run) => {
    const task: ScheduledTask = { loop, run, ran: false, cancelled: false };
    tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };
  return {
    schedule,
    async drive(loop: SyncLoop): Promise<void> {
      const task = tasks.find((t) => t.loop === loop && !t.ran && !t.cancelled);
      if (task === undefined) throw new Error(`no pending ${loop} task to drive`);
      task.ran = true;
      const returned: unknown = task.run();
      assert.equal(returned, undefined, 'the loop hands the scheduler a synchronous wrapper');
      await settle();
    },
  };
}

/** `[table, id]` pairs, sorted by id -- so an assertion does not depend on the order a query happened to answer rows in. */
function byId(rows: readonly { table: string; id: number }[]): (readonly [string, number])[] {
  return rows.map((row): readonly [string, number] => [row.table, row.id]).toSorted((a, b) => a[1] - b[1]);
}

function ok(body: unknown): SyncResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

interface StubFetch {
  fetch: SyncFetch;
  urls: string[];
}

/** Routes by exact url, and fails loudly on anything unrouted rather than answering a default that would hide a wrong request. */
function stubFetch(table: Readonly<Record<string, unknown>>): StubFetch {
  const urls: string[] = [];
  return {
    urls,
    fetch: (url: string): Promise<SyncResponse> => {
      urls.push(url);
      if (!Object.hasOwn(table, url)) throw new Error(`unrouted sync request: ${url}`);
      return Promise.resolve(ok(table[url]));
    },
  };
}

/**
 * Granted the moment it is asked for, and what makes this store "the leader"
 * that fetches. The release function `hold` now must return (`Lease`'s own
 * doc) is a no-op here: nothing in this file ever calls it, so the release
 * promise handed to `onGranted` behaves exactly as it always did for these
 * tests -- pending for as long as the test runs.
 */
function grantedLease(): Lease {
  return {
    hold(onGranted): () => void {
      onGranted(
        new Promise<void>(() => {
          // Never settles in this fixture: nothing here ever releases.
        }),
      );
      return () => {
        // Nothing to release: see this function's own doc.
      };
    },
  };
}

let dbCounter = 0;
/** A database name no other test in this process shares. */
function freshDbName(): string {
  dbCounter += 1;
  return `store-e2e-${String(dbCounter)}`;
}

test('createStore wires a replica end to end: bootstrap, a tail page, a retiring backfill, every read, the gatherer, a subscriber, and stop', async () => {
  const dbName = freshDbName();

  // The pivot: since = 10 (W - 1), before = 11 (W). Every table `listByTable`
  // can walk carries an `updatedAt`, so that read is exercised too, not just
  // the four that do not need one.
  const mediaItem = { pluginId: 'demo', title: 'A Show', updatedAt: 1000 };
  const rssItem = { mediaItemId: 7, feedId: 40, filename: 'release.mkv', updatedAt: 1001 };
  const person = { name: 'Cast Member', updatedAt: 999 };
  const role = { mediaItemId: 7, personId: 100, role: 'actor' };
  const torrent = { rssItemId: 1, downloadClientId: 5, status: 'downloading', updatedAt: 1002 };
  const nzb = { rssItemId: 1, downloadClientId: 6, status: 'queued', updatedAt: 1003 };

  const fetch = stubFetch({
    '/api/sync/bootstrap': { since: 10, before: 11, generation: 'gen-1' },
    '/api/sync?since=10': {
      ops: [
        { op: 'upsert', table: 'media_item', id: 7, value: mediaItem },
        { op: 'upsert', table: 'rss_item', id: 1, value: rssItem },
        { op: 'upsert', table: 'person', id: 100, value: person },
      ],
      cursor: 20,
      generation: 'gen-1',
    },
    '/api/sync/backfill?before=11': {
      ops: [
        { op: 'create', table: 'role', id: 2, value: role },
        { op: 'create', table: 'torrent_download', id: 10, value: torrent },
      ],
      cursor: 5,
      generation: 'gen-1',
    },
    '/api/sync/backfill?before=5': {
      ops: [{ op: 'create', table: 'nzb_download', id: 11, value: nzb }],
      cursor: null,
      generation: 'gen-1',
    },
  });

  const sched = manualScheduler();
  const deps: CreateStoreDeps = {
    dbName,
    fetch: fetch.fetch,
    schedule: sched.schedule,
    now: (): number => 1000,
    locks: grantedLease(),
  };
  const store: Store = await createStore(deps);
  cleanups.push(() => {
    store.stop();
  });
  await settle();

  assert.deepEqual(fetch.urls, ['/api/sync/bootstrap'], 'the only request before either loop has run');

  let rowWakes = 0;
  cleanups.push(
    store.subscribe('media_item', 7, () => {
      rowWakes += 1;
    }),
  );
  let insertedRoles: readonly number[] = [];
  cleanups.push(
    store.subscribeInserts('role', (ids) => {
      insertedRoles = ids;
    }),
  );

  await sched.drive('tail');
  assert.equal(rowWakes, 1, 'a subscriber on the row the tail just wrote fired');

  await sched.drive('backfill'); // page 1: role + torrent_download
  assert.deepEqual(insertedRoles, [2], 'subscribeInserts reported the role the backfill just created');

  await sched.drive('backfill'); // page 2: nzb_download, retires

  // Every row is queryable, through every one of the five reads.
  assert.deepEqual(await store.getRow('media_item', 7), mediaItem);
  assert.deepEqual(await store.getRows('person', [100]), new Map([[100, person]]));
  const owned = await store.byMediaItem(7);
  assert.deepEqual(byId(owned), [
    ['rss_item', 1],
    ['role', 2],
  ]);
  const downloads = await store.byRssItem(1);
  assert.deepEqual(byId(downloads), [
    ['torrent_download', 10],
    ['nzb_download', 11],
  ]);
  const listed = await store.listByTable('media_item', { direction: 'next', limit: 10 });
  assert.deepEqual(listed.map((row) => row.id), [7]);

  // gatherMediaItem assembles one media item from all of the above.
  const gathered = await store.gatherMediaItem(7);
  assert.ok(gathered !== undefined);
  assert.deepEqual(gathered.mediaItem, mediaItem);
  assert.equal(gathered.pluginId, 'demo');
  assert.equal(gathered.releases.length, 1);
  assert.equal(gathered.releases[0]?.id, 1);
  assert.deepEqual(byId(gathered.releases[0]?.downloads ?? []), [
    ['torrent_download', 10],
    ['nzb_download', 11],
  ]);
  assert.equal(gathered.roles.length, 1);
  assert.equal(gathered.roles[0]?.id, 2);
  assert.deepEqual(gathered.roles[0]?.person, person);
  assert.deepEqual(gathered.feedIds, [40]);

  // The cursors in `meta` match the last page each loop served: the tail's
  // last page carried cursor 20, and the backfill's last page carried a null
  // cursor -- read through a second connection, since `Store` exposes no
  // `db` of its own to read `meta` through.
  const inspect = await openStore(dbName);
  assert.deepEqual(await readCursors(inspect), { since: 20, before: null });
  inspect.close();

  // stop() has to actually stop things: closing the replica along with the
  // sync loops, not merely cancelling the scheduled tasks -- a store whose
  // `stop()` left the database connection open would still pass every
  // assertion above and still leave something behind. A read attempted after
  // stop() is refused because the connection underneath it is gone, which is
  // the outward sign that it really closed.
  store.stop();
  await assert.rejects(
    () => store.getRow('media_item', 7),
    'a read after stop() fails, because stop() closed this store\'s IndexedDB connection rather than only cancelling its sync loops',
  );
});

test('subscribeReset on the Store reaches the registry a reset announces to', async () => {
  // Task 8's review found this passthrough unexercised: rebinding it to a
  // no-op passed the whole suite. It is one line, and a one-line wire that
  // nothing tests is exactly the shape that survives a refactor broken.
  const fetch = stubFetch({ '/api/sync/bootstrap': { since: 0, before: null, generation: 'g' } });
  const sched = manualScheduler();
  const store: Store = await createStore({
    dbName: freshDbName(),
    fetch: fetch.fetch,
    schedule: sched.schedule,
    now: (): number => 1000,
    locks: grantedLease(),
  });
  cleanups.push(() => {
    store.stop();
  });
  await settle();

  let announced = 0;
  const off = store.subscribeReset(() => { announced += 1; });
  emitReset();
  off();
  emitReset();

  assert.equal(announced, 1, 'the Store subscription is wired to the registry, and unsubscribing works through it');
});
