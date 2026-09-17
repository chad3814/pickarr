import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { eventually } from './syncTestKit.ts';
import {
  startSync,
  webLocksLease,
  type Lease,
  type Schedule,
  type SyncDeps,
  type SyncFetch,
  type SyncHandle,
  type SyncLoop,
  type SyncResponse,
} from '../../src/store/sync.ts';
import { readCursors, writeCursors, readGeneration, writeGeneration, type Cursors } from '../../src/store/meta.ts';
import { getRow } from '../../src/store/rows.ts';
import { request } from '../../src/store/idb.ts';
import { subscribe, subscribeReset } from '../../src/store/notify.ts';
import { CHANNEL_NAME, serializeChanged, type ChannelMessage } from '../../src/store/leader.ts';

/**
 * Everything a test starts is torn down here rather than at the end of the
 * test body, because `afterEach` runs whether the test passed or threw and a
 * per-test call only runs on the happy path -- which is the path that did not
 * need it (`CLAUDE.md`). An open `BroadcastChannel` keeps the process alive,
 * so a failing test that skipped `stop()` would hang the file with no test
 * name attached.
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

/**
 * Lets every promise chain a driven tick started -- a fetch, an IndexedDB
 * transaction, a `BroadcastChannel` delivery -- reach its end.
 *
 * A real timer rather than fake ones, which hang this suite (`CLAUDE.md`).
 * Nothing here waits on wall-clock *duration*: the scheduler is injected, so
 * the only thing this has to outlast is a handful of microtask and task
 * turns.
 */
function settle(): Promise<void> {
  return delay(15);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settleOuter: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settleOuter = resolve;
  });
  if (settleOuter === undefined) throw new Error('unreachable: a Promise executor runs synchronously');
  return { promise, resolve: settleOuter };
}

interface ScheduledTask {
  loop: SyncLoop;
  delayMs: number;
  run: () => void;
  ran: boolean;
  cancelled: boolean;
}

interface ManualScheduler {
  schedule: Schedule;
  /** The task a loop is waiting on, if any. `undefined` once a loop has retired or been cancelled. */
  pendingFor(loop: SyncLoop): ScheduledTask | undefined;
  /** Fires the loop's pending task and lets everything it started settle. */
  drive(loop: SyncLoop): Promise<void>;
}

/**
 * The scheduler seam, driven by hand. This is why `schedule` is injected: the
 * two loops have to be steppable in an order the test chooses, and fake
 * timers hang this suite.
 */
function manualScheduler(): ManualScheduler {
  const tasks: ScheduledTask[] = [];
  const schedule: Schedule = (loop, delayMs, run) => {
    const task: ScheduledTask = { loop, delayMs, run, ran: false, cancelled: false };
    tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };
  function pendingFor(loop: SyncLoop): ScheduledTask | undefined {
    return tasks.find((task) => task.loop === loop && !task.ran && !task.cancelled);
  }
  /**
   * Waits for the tick `drive` just started to *finish*, instead of trusting a
   * fixed sleep to outlast it.
   *
   * `tick` calls `schedule(loop, ...)` only after `await runOnce(loop)` has
   * returned, and `runOnce` awaits `applyBatch` -- which is also what wakes
   * the leader's own subscribers. So a *fresh* pending task for this loop is a
   * positive marker that the whole tick landed: page applied, cursor written,
   * subscribers woken, backoff recomputed. It cannot be mistaken for the task
   * just fired, because `sync.ts` keeps at most one pending task per loop and
   * the driven one is already marked `ran`.
   *
   * The three outcomes that schedule nothing on purpose -- a retired backfill,
   * a stopped handle, and a refusal ladder that has given up -- leave no
   * marker, and they are exactly what this file's `pendingFor(loop) ===
   * undefined` assertions are about. Those fall through to the sleep they
   * always had, so nothing here waits *less* than it used to and no assertion
   * changes meaning; the budget only bounds how long a missing marker costs.
   *
   * Why this is not a sleep with a bigger number: a tick needs about nine
   * event-loop turns, which 15ms clears on an idle machine and does not clear
   * when `node --test` is running eleven other files beside this one. That is
   * issue #81 in `store/store.test.ts`, and it surfaced here too -- "the
   * backfill retires on a null cursor and the tail keeps running" and "a
   * failed response is not read for its body" both failed on
   * `pendingFor('tail')` being `undefined` when two full suites ran at once.
   */
  const MARKER_BUDGET_MS = 150;
  async function landed(loop: SyncLoop): Promise<void> {
    const deadline = Date.now() + MARKER_BUDGET_MS;
    while (pendingFor(loop) === undefined && Date.now() < deadline) await delay(2);
    await settle();
  }

  return {
    schedule,
    pendingFor,
    async drive(loop: SyncLoop): Promise<void> {
      const task = pendingFor(loop);
      if (task === undefined) throw new Error(`no pending ${loop} task to drive`);
      task.ran = true;
      // The return value is asserted, not ignored: `run` is typed `() => void`
      // and TypeScript accepts an `async` function there, so a loop that
      // handed its own async tick straight to the scheduler would type-check
      // and then leak every rejection past its `catch` (`store/notify.ts`'s
      // `invoke` documents what that costs under `node --test`). A synchronous
      // wrapper returns `undefined`; an `async` one returns a promise.
      const returned: unknown = task.run();
      assert.equal(returned, undefined, 'the loop hands the scheduler a synchronous wrapper, not an async function whose rejection would escape');
      await landed(loop);
    },
  };
}

function ok(body: unknown): SyncResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

interface StubFetch {
  fetch: SyncFetch;
  urls: string[];
}

function stubFetch(handler: (url: string) => Promise<SyncResponse> | SyncResponse): StubFetch {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url: string): Promise<SyncResponse> => {
      urls.push(url);
      return handler(url);
    },
  };
}

/** Routes by exact url, and fails loudly on anything unrouted rather than answering a default that would hide a wrong request. */
function routes(table: Readonly<Record<string, unknown>>): (url: string) => SyncResponse {
  return (url: string): SyncResponse => {
    if (!Object.hasOwn(table, url)) throw new Error(`unrouted sync request: ${url}`);
    return ok(table[url]);
  };
}

/**
 * A lease granted the moment it is asked for. `hold` must now return a
 * release function (`Lease`'s own doc in `sync.ts`); this fixture's is a
 * no-op, so the promise `onGranted` receives stays pending exactly as it
 * always did -- nothing in the tests that use this fixture ever calls
 * release, which is `manualLease` and the real `webLocksLease` tests' job
 * below.
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

/**
 * A lease the test grants when it chooses -- how a follower's promotion is
 * driven -- and can release when it chooses, driving `stop()`'s own release
 * path without a real Web Lock.
 */
function manualLease(): { lease: Lease; grant: () => void; release: () => void } {
  let granted: ((release: Promise<void>) => void) | undefined;
  let resolveRelease: (() => void) | undefined;
  return {
    lease: {
      hold(onGranted): () => void {
        granted = onGranted;
        return () => {
          resolveRelease?.();
        };
      },
    },
    grant(): void {
      granted?.(
        new Promise<void>((resolve) => {
          resolveRelease = resolve;
        }),
      );
    },
    release(): void {
      resolveRelease?.();
    },
  };
}

/** Starts a sync instance and registers its teardown. `now` is a constant unless a test overrides it. */
function start(
  db: IDBDatabase,
  fetch: SyncFetch,
  locks: Lease,
  overrides: Partial<Pick<SyncDeps, 'now' | 'fetchDeadlineMs'>> = {},
): { sched: ManualScheduler; handle: SyncHandle } {
  const sched = manualScheduler();
  const handle = startSync({
    ...(overrides.fetchDeadlineMs === undefined ? {} : { fetchDeadlineMs: overrides.fetchDeadlineMs }),
    db,
    fetch,
    schedule: sched.schedule,
    now: overrides.now ?? ((): number => 1000),
    locks,
  });
  cleanups.push(() => {
    handle.stop();
  });
  return { sched, handle };
}

function countRows(db: IDBDatabase): Promise<number> {
  return request(db.transaction('rows', 'readonly').objectStore('rows').count());
}

/** Writes the cursors and the token together, the way `bootstrapCursors` does -- how a test stands in for a previous session or another tab. */
async function seedMeta(db: IDBDatabase, cursors: Cursors, generation: string): Promise<void> {
  const tx = db.transaction('meta', 'readwrite');
  await Promise.all([writeCursors(tx, cursors), writeGeneration(tx, generation)]);
  await new Promise<void>((resolve, reject) => {
    tx.addEventListener('complete', () => resolve(), { once: true });
    tx.addEventListener('abort', () => reject(tx.error ?? new Error('aborted')), { once: true });
  });
}

/** Replaces `console.error` for the duration of one test, restored by `afterEach` whether it passed or threw. */
function captureErrors(): string[] {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]): void => {
    messages.push(args.map((arg) => String(arg)).join(' '));
  };
  cleanups.push(() => {
    console.error = original;
  });
  return messages;
}

let leaseCounter = 0;
/** `holdLease` never releases, so a name reused across tests would queue the second test's grant behind the first's forever. */
function freshLeaseName(): string {
  leaseCounter += 1;
  return `test-sync-lease-${String(leaseCounter)}`;
}

const ALPHA = { id: 7, title: 'Alpha', updatedAt: 40 };
const BETA = { id: 3, title: 'Beta', updatedAt: 5 };

test('an empty client bootstraps, then runs both cursors', async () => {
  const db = await freshDb();
  const fetch = stubFetch(
    routes({
      '/api/sync/bootstrap': { since: 40, before: 41, generation: 'gen-1' },
      '/api/sync?since=40': {
        ops: [{ op: 'upsert', table: 'media_item', id: 7, value: ALPHA }],
        cursor: 42,
        generation: 'gen-1',
      },
      '/api/sync/backfill?before=41': {
        ops: [{ op: 'create', table: 'media_item', id: 3, value: BETA }],
        cursor: 39,
        generation: 'gen-1',
      },
    }),
  );
  const { sched } = start(db, fetch.fetch, grantedLease());
  // The eager bootstrap is in flight, so these are conditions rather than
  // facts: `start` returns before it has been answered.
  await eventually(async () => {
    assert.deepEqual(fetch.urls, ['/api/sync/bootstrap'], 'no cursors in meta, so the one call before either loop runs is the bootstrap');
    assert.deepEqual(await readCursors(db), { since: 40, before: 41 }, 'both cursors come from the pivot the bootstrap named: since = W - 1 and before = W');
    assert.equal(await readGeneration(db), 'gen-1');
  }, 'the eager bootstrap to land');

  let wakes = 0;
  cleanups.push(
    subscribe('media_item', 7, () => {
      wakes += 1;
    }),
  );

  await sched.drive('tail');
  assert.deepEqual(fetch.urls, ['/api/sync/bootstrap', '/api/sync?since=40'], 'the tail asks for ops above its cursor');
  assert.deepEqual(await readCursors(db), { since: 42, before: 41 }, 'the tail advanced since and left before alone');
  assert.deepEqual(await getRow(db, 'media_item', 7), ALPHA);
  assert.equal(
    wakes,
    1,
    'woken once, not twice: the leader broadcasts for the tabs that do not fetch, and every same-name channel in this tab receives that post -- so relaying it here as well would wake every subscriber a second time for its own batch',
  );

  await sched.drive('backfill');
  assert.deepEqual(
    fetch.urls,
    ['/api/sync/bootstrap', '/api/sync?since=40', '/api/sync/backfill?before=41'],
    'the backfill walks down from the same pivot, and asked for it without waiting on the tail',
  );
  assert.deepEqual(await readCursors(db), { since: 42, before: 39 }, 'the backfill advanced before and left the tail cursor alone');
  assert.deepEqual(await getRow(db, 'media_item', 3), BETA);

  assert.ok(sched.pendingFor('tail'), 'the tail is scheduled again');
  assert.ok(sched.pendingFor('backfill'), 'the backfill is scheduled again');
});

test('the backfill retires on a null cursor and the tail keeps running', async () => {
  const db = await freshDb();
  const fetch = stubFetch(
    routes({
      '/api/sync/bootstrap': { since: 10, before: 11, generation: 'gen-1' },
      '/api/sync/backfill?before=11': {
        ops: [{ op: 'create', table: 'media_item', id: 7, value: ALPHA }],
        cursor: 5,
        generation: 'gen-1',
      },
      '/api/sync/backfill?before=5': {
        ops: [{ op: 'create', table: 'media_item', id: 3, value: BETA }],
        cursor: null,
        generation: 'gen-1',
      },
      '/api/sync?since=10': { ops: [], cursor: 10, generation: 'gen-1' },
    }),
  );
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  await sched.drive('backfill');
  assert.deepEqual(await readCursors(db), { since: 10, before: 5 });
  assert.ok(sched.pendingFor('backfill'), 'a numeric cursor means there is more to walk');

  await sched.drive('backfill');
  assert.deepEqual(await readCursors(db), { since: 10, before: null }, 'a null cursor is stored, so exhaustion survives a reload');
  assert.deepEqual(await getRow(db, 'media_item', 3), BETA, 'the last page is applied -- a null cursor retires the walk, it does not discard the page carrying it');
  assert.equal(sched.pendingFor('backfill'), undefined, 'exhaustion is permanent: the walk is not scheduled again');

  await sched.drive('tail');
  await sched.drive('tail');
  assert.deepEqual(
    fetch.urls,
    [
      '/api/sync/bootstrap',
      '/api/sync/backfill?before=11',
      '/api/sync/backfill?before=5',
      '/api/sync?since=10',
      '/api/sync?since=10',
    ],
    'the tail kept polling after the backfill retired, and the retired walk made no further request',
  );
  assert.ok(sched.pendingFor('tail'), 'the tail is scheduled for the rest of the session');
});

test('a walk that already retired is not resumed on a later session', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: null }, 'gen-1');
  const fetch = stubFetch(routes({ '/api/sync?since=10': { ops: [], cursor: 10, generation: 'gen-1' } }));
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  assert.deepEqual(fetch.urls, [], 'cursors are already stored, so nothing is bootstrapped');
  await sched.drive('backfill');
  assert.deepEqual(fetch.urls, [], 'a stored before of null means the walk is over -- no request, not a request for the first page');
  assert.equal(sched.pendingFor('backfill'), undefined);

  await sched.drive('tail');
  assert.deepEqual(fetch.urls, ['/api/sync?since=10'], 'the tail still runs');
});

test('a mismatched generation wipes, re-bootstraps, and broadcasts, in that order', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: 11 }, 'gen-old');
  const tx = db.transaction('rows', 'readwrite');
  await request(tx.objectStore('rows').put({ table: 'media_item', id: 7, value: ALPHA }));
  assert.equal(await countRows(db), 1, 'the stale replica has something in it to lose');

  const events: string[] = [];

  // Read *synchronously* from inside the handler, settled by the test
  // afterwards: the point of the ordering is that a tab re-reading when it
  // hears about the reset sees a consistent store, so the read has to start at
  // the instant it is told.
  let cursorsAtReset: Promise<Cursors | undefined> | undefined;
  let generationAtReset: Promise<string | undefined> | undefined;
  cleanups.push(
    subscribeReset(() => {
      events.push('announced');
      const metaTx = db.transaction('meta', 'readonly');
      cursorsAtReset = readCursors(metaTx);
      generationAtReset = readGeneration(metaTx);
    }),
  );

  // "The other tab": `broadcast` opens and closes its own sender and a channel
  // never hears its own posts, so proving delivery needs a second channel.
  const other = new BroadcastChannel(CHANNEL_NAME);
  cleanups.push(() => {
    other.close();
  });
  const heard: ChannelMessage[] = [];
  other.addEventListener('message', (event: MessageEvent<ChannelMessage>) => {
    if (event.data.type === 'reset') heard.push(event.data);
  });

  const answers = routes({
    '/api/sync?since=10': { ops: [], cursor: 10, generation: 'gen-new' },
    '/api/sync/bootstrap': { since: 0, before: 1, generation: 'gen-new' },
  });
  const fetch = stubFetch(async (url: string): Promise<SyncResponse> => {
    events.push(`fetch ${url}`);
    if (url === '/api/sync/bootstrap') events.push(`rows at re-bootstrap: ${String(await countRows(db))}`);
    return answers(url);
  });

  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();
  await sched.drive('tail');
  await settle();

  assert.deepEqual(
    events,
    ['fetch /api/sync?since=10', 'fetch /api/sync/bootstrap', 'rows at re-bootstrap: 0', 'announced'],
    'the sequence, not the end state: the wipe commits before the re-bootstrap is even asked for, and nothing is announced until the new cursors are written',
  );
  assert.deepEqual(await cursorsAtReset, { since: 0, before: 1 }, 'a tab reading the moment it is told finds the new pivot, not a half-wiped store');
  assert.equal(await generationAtReset, 'gen-new', 'and the new token, written in the same transaction as the cursors');
  assert.deepEqual(heard, [{ type: 'reset', generation: 'gen-new' }], 'the other tab is told, because only the leader could have noticed');
  assert.equal(await countRows(db), 0, 'the replica of the database that no longer exists is gone whole');
  assert.equal(await getRow(db, 'media_item', 7), undefined);
  assert.ok(sched.pendingFor('tail'), 'both loops restart against the new pivot');
  assert.ok(sched.pendingFor('backfill'), 'including the walk, which has a fresh pivot to descend from');
});

test('a follower promoted to leader re-checks the generation before its first fetch', async () => {
  const db = await freshDb();
  // What this tab read when it started: the old database's pivot and token.
  await seedMeta(db, { since: 10, before: 11 }, 'gen-old');

  const fetch = stubFetch(
    routes({
      '/api/sync?since=100': {
        ops: [{ op: 'upsert', table: 'media_item', id: 7, value: ALPHA }],
        cursor: 105,
        generation: 'gen-new',
      },
    }),
  );
  const { lease, grant } = manualLease();
  const { sched } = start(db, fetch.fetch, lease);
  await settle();
  assert.deepEqual(fetch.urls, [], 'a follower fetches nothing');
  assert.equal(sched.pendingFor('tail'), undefined, 'and schedules nothing');

  // Another tab held the lease, hit a mismatch, and reset -- then its own tab
  // closed, which is how this one gets elected in the middle of it.
  await seedMeta(db, { since: 100, before: 101 }, 'gen-new');
  const rowTx = db.transaction('rows', 'readwrite');
  await request(rowTx.objectStore('rows').put({ table: 'media_item', id: 3, value: BETA }));

  grant();
  await settle();
  await sched.drive('tail');

  assert.deepEqual(
    fetch.urls,
    ['/api/sync?since=100'],
    'the first fetch after promotion reads the cursor out of meta, not one this tab read before the reset',
  );
  assert.equal(await countRows(db), 2, 'and the token it compares against is the one in meta, so the new database is not mistaken for a mismatch and wiped');
  assert.deepEqual(await getRow(db, 'media_item', 3), BETA, 'the row the previous leader replicated after its reset survives');
  assert.deepEqual(await readCursors(db), { since: 105, before: 101 });
});

test('only the lease holder fetches', async () => {
  // One real Web Lock, two instances. Not a stub that says no: `holdLease`
  // requests without `ifAvailable`, so the second genuinely queues behind the
  // first, which is what the browser does to a second tab.
  const db = await freshDb();
  const name = freshLeaseName();
  const answers = routes({
    '/api/sync/bootstrap': { since: 40, before: 41, generation: 'gen-1' },
    '/api/sync?since=40': { ops: [], cursor: 40, generation: 'gen-1' },
  });

  const first = stubFetch(answers);
  const leader = start(db, first.fetch, webLocksLease(name));
  await settle();

  const second = stubFetch(answers);
  const follower = start(db, second.fetch, webLocksLease(name));
  await settle();

  assert.deepEqual(first.urls, ['/api/sync/bootstrap'], 'the holder bootstraps');
  assert.deepEqual(second.urls, [], 'the second instance made no request at all');
  assert.equal(follower.sched.pendingFor('tail'), undefined, 'and scheduled no loop to make one later');
  assert.ok(leader.sched.pendingFor('tail'), 'while the holder is polling');

  await leader.sched.drive('tail');
  assert.deepEqual(second.urls, [], 'still nothing, while the holder keeps fetching');
});

test('stopping the leader releases the lease so a queued follower is promoted and fetches', async () => {
  // The defect this fix exists for, reproduced with two real `Store`-level
  // instances instead of two tabs: `Shell.tsx`'s ordinary sign-in journey
  // (mount, 401, demote to `SignIn`, sign back in) creates exactly this
  // shape in one tab -- a first `Store` that stops, and a second one already
  // queued behind its lease. Before `holdLease` became releasable, `stop()`
  // freed nothing and the second instance queued forever, never fetching --
  // which is why `packages/e2e/tests/shell.spec.ts` is what first caught it.
  // `node --test`'s `navigator.locks` being per-process is what lets this
  // file model the same shape directly, the same way `only the lease holder
  // fetches` above does for the non-releasing half of the story.
  const db = await freshDb();
  const name = freshLeaseName();
  const answers = routes({
    '/api/sync/bootstrap': { since: 40, before: 41, generation: 'gen-1' },
    '/api/sync?since=40': { ops: [], cursor: 40, generation: 'gen-1' },
  });

  const first = stubFetch(answers);
  const leader = start(db, first.fetch, webLocksLease(name));
  await settle();
  assert.deepEqual(first.urls, ['/api/sync/bootstrap'], 'the first instance leads and bootstraps');

  const second = stubFetch(answers);
  const follower = start(db, second.fetch, webLocksLease(name));
  await settle();
  assert.deepEqual(second.urls, [], 'queued behind the first, exactly as a second Store in one tab would be');

  leader.handle.stop();
  await settle();

  // Not a second `/api/sync/bootstrap`: the leader's own bootstrap already
  // wrote the cursors to this shared `db` (`ensureBootstrapped` only
  // bootstraps when nothing is stored), and the follower reads that same
  // meta once promoted. The property this test is for is that it schedules
  // and fetches *at all* -- before this fix it never got this far, queued
  // behind a lease `stop()` could not release.
  assert.ok(
    follower.sched.pendingFor('tail'),
    'once the leader stops and releases the lease, the queued instance is promoted and schedules its own tail loop',
  );

  await follower.sched.drive('tail');
  assert.deepEqual(
    second.urls,
    ['/api/sync?since=40'],
    'and the promoted instance actually fetches -- the property this fix exists for',
  );
});

test('a lease released for a reason other than this instance\'s own stop() still cancels both loops', async () => {
  // `manualLease`'s `release()` exists for exactly this: `leader.ts`'s own
  // doc names a lease settling out from under its holder -- a browser
  // tearing a Web Lock down when the tab itself closes -- as a case
  // `stop()` never has to run for at all. `stop()` already cancels both
  // loops directly and *also* releases the lease, so a test built only
  // around `stop()` (the one above) cannot tell "releasing stops the loops"
  // apart from "stop() stops the loops and happens to release too". Driving
  // `release()` without ever calling `handle.stop()` isolates the property
  // `sync.ts`'s own `release.then(() => { leading = false; stopLoops(); })`
  // exists for.
  const db = await freshDb();
  const answers = routes({
    '/api/sync/bootstrap': { since: 40, before: 41, generation: 'gen-1' },
    '/api/sync?since=40': { ops: [], cursor: 40, generation: 'gen-1' },
  });
  const fetch = stubFetch(answers);
  const { lease, grant, release } = manualLease();
  const { sched } = start(db, fetch.fetch, lease);

  grant();
  await eventually(() => {
    assert.deepEqual(fetch.urls, ['/api/sync/bootstrap'], 'granted, so this instance leads and bootstraps');
    assert.ok(sched.pendingFor('tail'), 'and schedules its poll');
  }, 'the grant to bootstrap and schedule');

  release();
  // Waiting for an absence, which is normally the trap this file's sibling
  // fix is about -- safe only because the assertion just above established
  // that the task *did* exist. So its disappearance can only be the
  // cancellation under test, never "not scheduled yet".
  await eventually(() => {
    assert.equal(
      sched.pendingFor('tail'),
      undefined,
      'the lease releasing on its own -- never through this instance\'s own stop() -- still cancels the pending tail task',
    );
    assert.equal(sched.pendingFor('backfill'), undefined, 'and the backfill');
  }, 'the release to cancel both loops');
});

test('a follower relays what the leader broadcasts to its own subscribers', async () => {
  const db = await freshDb();
  const { lease } = manualLease();
  start(db, stubFetch(routes({})).fetch, lease);

  let rowWakes = 0;
  cleanups.push(
    subscribe('media_item', 7, () => {
      rowWakes += 1;
    }),
  );
  let resetWakes = 0;
  cleanups.push(
    subscribeReset(() => {
      resetWakes += 1;
    }),
  );

  const leaderTab = new BroadcastChannel(CHANNEL_NAME);
  cleanups.push(() => {
    leaderTab.close();
  });
  const changed = serializeChanged({ touched: new Map([['media_item', [7]]]), inserted: new Map() });
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- that argument belongs to `Window.postMessage`; `BroadcastChannel.postMessage` has no origin to name
  leaderTab.postMessage({ type: 'changed', changed } satisfies ChannelMessage);
  await settle();
  assert.equal(rowWakes, 1, 'a follower never applies a batch, so this is the only way its subscribers ever hear anything');

  // eslint-disable-next-line unicorn/require-post-message-target-origin -- see above
  leaderTab.postMessage({ type: 'reset', generation: 'gen-2' } satisfies ChannelMessage);
  await settle();
  assert.equal(resetWakes, 1, 'a follower cannot discover a reset on its own -- it does not fetch');
});

test('a create on the tail is refused, and nothing of the batch is applied or logged', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: 11 }, 'gen-1');
  const secret = { id: 7, title: 'ROW-CONTENTS-NEVER-LOGGED', updatedAt: 1 };
  const fetch = stubFetch(
    routes({
      '/api/sync?since=10': {
        ops: [
          { op: 'upsert', table: 'media_item', id: 3, value: BETA },
          { op: 'create', table: 'media_item', id: 7, value: secret },
        ],
        cursor: 20,
        generation: 'gen-1',
      },
    }),
  );
  const messages = captureErrors();
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();
  await sched.drive('tail');

  assert.equal(await getRow(db, 'media_item', 7), undefined, 'the offending op is not applied');
  assert.equal(await getRow(db, 'media_item', 3), undefined, 'and neither is the rest of the batch -- the batch is refused whole');
  assert.deepEqual(await readCursors(db), { since: 10, before: 11 }, 'so the cursor does not advance past a page that was never applied');
  assert.equal(messages.length, 1, 'refused loudly rather than silently');
  assert.ok(messages[0]?.includes('cannot emit a "create" op'), `expected the report to name the kind, got: ${String(messages[0])}`);
  assert.ok(messages[0]?.includes('["media_item", 7]'), 'and the table and id');
  assert.ok(!messages[0]?.includes('ROW-CONTENTS-NEVER-LOGGED'), 'and never the row');
  assert.ok(sched.pendingFor('tail'), 'and retried, since the page may be the only thing wrong');
});

test('an upsert on the backfill is refused', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: 11 }, 'gen-1');
  const fetch = stubFetch(
    routes({
      '/api/sync/backfill?before=11': {
        ops: [{ op: 'upsert', table: 'media_item', id: 7, value: ALPHA }],
        cursor: 5,
        generation: 'gen-1',
      },
    }),
  );
  const messages = captureErrors();
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();
  await sched.drive('backfill');

  assert.equal(await getRow(db, 'media_item', 7), undefined, 'an upsert from the walk would overwrite, which is exactly what a create must never do');
  assert.deepEqual(await readCursors(db), { since: 10, before: 11 });
  assert.equal(messages.length, 1);
  assert.ok(messages[0]?.includes('cannot emit a "upsert" op'), `expected the report to name the kind, got: ${String(messages[0])}`);
});

test('a failed response is not read for its body, and the loop backs off and recovers', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: 11 }, 'gen-1');
  let bodyReads = 0;
  let failuresLeft = 3;
  const fetch = stubFetch((url: string): SyncResponse => {
    assert.equal(url, '/api/sync?since=10');
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return {
        ok: false,
        status: 503,
        json: (): Promise<unknown> => {
          bodyReads += 1;
          return Promise.resolve({});
        },
      };
    }
    return ok({ ops: [], cursor: 10, generation: 'gen-1' });
  });
  const messages = captureErrors();
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  await sched.drive('tail');
  assert.equal(sched.pendingFor('tail')?.delayMs, 1000, 'the first failure backs off one second');
  await sched.drive('tail');
  assert.equal(sched.pendingFor('tail')?.delayMs, 2000, 'then two');
  await sched.drive('tail');
  assert.equal(sched.pendingFor('tail')?.delayMs, 4000, 'then four');
  assert.equal(bodyReads, 0, 'a failed response is never read for its body -- the status is the whole of what a retry turns on, and a body is where a row would be echoed back');
  assert.equal(messages.length, 3, 'each attempt reported');
  assert.ok(messages[0]?.includes('answered 503'), `expected the status in the report, got: ${String(messages[0])}`);

  await sched.drive('tail');
  assert.equal(sched.pendingFor('tail')?.delayMs, 3000, 'a success clears the ladder and the tail returns to its interval');
});

test('a rejected fetch is contained, reported and retried', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: 11 }, 'gen-1');
  const fetch = stubFetch(() => Promise.reject(new Error('network down')));
  const messages = captureErrors();
  const { sched } = start(db, fetch.fetch, grantedLease());
  // `drive` throws outright if the loop it is handed has nothing pending, so
  // this waits for the bootstrap to have scheduled one.
  await eventually(() => {
    assert.ok(sched.pendingFor('tail'), 'the bootstrap scheduled the tail');
  }, 'the loops to be scheduled');
  await sched.drive('tail');

  assert.equal(messages.length, 1, 'a rejection inside the tick is caught rather than escaping as an unhandled rejection');
  assert.ok(messages[0]?.includes('network down'));
  assert.equal(sched.pendingFor('tail')?.delayMs, 1000);
  assert.deepEqual(await readCursors(db), { since: 10, before: 11 }, 'and nothing moved');
});

test('the tail holds a fixed rate rather than a fixed delay', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: 11 }, 'gen-1');
  const fetch = stubFetch(routes({ '/api/sync?since=10': { ops: [], cursor: 10, generation: 'gen-1' } }));
  // Every reading is a further two seconds on: the tick "takes" 2s of its
  // own 3s interval, so the next one is due in 1s, not 3.
  let clock = 0;
  const { sched } = start(db, fetch.fetch, grantedLease(), {
    now: (): number => {
      clock += 2000;
      return clock;
    },
  });
  await settle();

  await sched.drive('tail');
  assert.equal(sched.pendingFor('tail')?.delayMs, 1000, 'three seconds after the poll started, not after it finished');
});

test('neither loop writes back the cursor the other just advanced', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: 11 }, 'gen-1');
  const tailPage = deferred<SyncResponse>();
  const answers = routes({
    '/api/sync/backfill?before=11': {
      ops: [{ op: 'create', table: 'media_item', id: 3, value: BETA }],
      cursor: 5,
      generation: 'gen-1',
    },
  });
  const fetch = stubFetch((url: string) =>
    url === '/api/sync?since=10' ? tailPage.promise : answers(url),
  );
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  // The tail's request is in flight and its tick is parked on it.
  await sched.drive('tail');
  assert.deepEqual(await readCursors(db), { since: 10, before: 11 }, 'nothing applied yet');

  // The walk runs to completion underneath it and advances `before`.
  await sched.drive('backfill');
  assert.deepEqual(await readCursors(db), { since: 10, before: 5 });

  tailPage.resolve(
    ok({ ops: [{ op: 'upsert', table: 'media_item', id: 7, value: ALPHA }], cursor: 20, generation: 'gen-1' }),
  );
  await settle();

  assert.deepEqual(
    await readCursors(db),
    { since: 20, before: 5 },
    'the tail re-read the pair inside its critical section, so it advanced its own half and carried the walk\'s forward -- writing back the 11 it read before its fetch would have silently re-walked six log entries',
  );
  assert.deepEqual(await getRow(db, 'media_item', 7), ALPHA);
  assert.deepEqual(await getRow(db, 'media_item', 3), BETA);
});

test('a page whose cursor moved under it is discarded rather than applied', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: 11 }, 'gen-old');
  const tailPage = deferred<SyncResponse>();
  const answers = routes({
    // The walk is the one that notices the rebuild, and resets.
    '/api/sync/backfill?before=11': { ops: [], cursor: null, generation: 'gen-new' },
    '/api/sync/bootstrap': { since: 0, before: 1, generation: 'gen-new' },
  });
  const fetch = stubFetch((url: string) =>
    url === '/api/sync?since=10' ? tailPage.promise : answers(url),
  );
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  await sched.drive('tail');
  await sched.drive('backfill');
  assert.deepEqual(await readCursors(db), { since: 0, before: 1 }, 'the reset happened while the tail request was in flight');

  // The in-flight page belongs to the new database -- the request was answered
  // after the rebuild -- so its generation matches and only the cursor betrays
  // it: 999 is a position in a log this replica no longer has.
  tailPage.resolve(
    ok({ ops: [{ op: 'upsert', table: 'media_item', id: 7, value: ALPHA }], cursor: 999, generation: 'gen-new' }),
  );
  await settle();

  assert.deepEqual(
    await readCursors(db),
    { since: 0, before: 1 },
    'the page was computed against a cursor that no longer exists, so it is dropped: writing 999 over a fresh pivot would ask for ops above the whole log and answer nothing for as long as the install lives',
  );
  assert.equal(await getRow(db, 'media_item', 7), undefined, 'and its ops go with it');
});

test('stop cancels both loops', async () => {
  const db = await freshDb();
  const fetch = stubFetch(
    routes({
      '/api/sync/bootstrap': { since: 40, before: 41, generation: 'gen-1' },
    }),
  );
  const { sched, handle } = start(db, fetch.fetch, grantedLease());
  await settle();
  assert.ok(sched.pendingFor('tail'));
  assert.ok(sched.pendingFor('backfill'));

  handle.stop();
  assert.equal(sched.pendingFor('tail'), undefined, 'the pending tail task is cancelled, not left to fire');
  assert.equal(sched.pendingFor('backfill'), undefined);
  handle.stop();
  assert.deepEqual(fetch.urls, ['/api/sync/bootstrap'], 'and a second stop is harmless');
});

test('a reset un-retires the walk, so a rebuilt library is backfilled again', async () => {
  // Finding 2 of task 6's review: the reset's restart of the backfill was
  // unpinned -- deleting `schedule('backfill', ...)` left every test green,
  // because `pendingFor('backfill')` was satisfied by a task scheduled
  // *before* the reset. So this drives the walk to retirement first, which
  // leaves nothing pending for it, and only then forces the reset. Without
  // the restart the walk stays dead and the rebuilt library is never
  // backfilled -- silent, permanent, and indistinguishable from an empty
  // server.
  const db = await freshDb();
  await writeCursors(db, { since: 10, before: 5 });
  await writeGeneration(db, 'gen-old');

  const answers = routes({
    // The walk retires: a null cursor means current state is exhausted.
    '/api/sync/backfill?before=5': { ops: [], cursor: null, generation: 'gen-old' },
    // Then the tail sees a different database.
    '/api/sync?since=10': { ops: [], cursor: 10, generation: 'gen-new' },
    '/api/sync/bootstrap': { since: 0, before: 9, generation: 'gen-new' },
  });
  const fetch = stubFetch(answers);
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  await sched.drive('backfill');
  await settle();
  assert.equal(sched.pendingFor('backfill'), undefined, 'the walk retired, so nothing is queued for it');
  assert.equal((await readCursors(db))?.before, null, 'and retirement is recorded, not merely remembered');

  await sched.drive('tail');
  await settle();

  assert.deepEqual(await readCursors(db), { since: 0, before: 9 }, 'the reset wrote a fresh pivot');
  assert.ok(sched.pendingFor('backfill'), 'and queued the walk again, which nothing else would have done');
});

test('a bootstrap that has not answered yet blocks both loops and announces nothing', async () => {
  // Two properties in one test, both of which I had recorded as untestable or
  // accepted, and the whole-branch review was right that a deferred response
  // reaches them.
  //
  // Ruling 21's accepted cost, now pinned: the bootstrap fetch runs *inside*
  // the mutex -- deliberately, since it decides the pivot both loops use --
  // so while it is in flight neither loop can make progress. That is a real
  // stall with no timeout behind it, and a test is how it stops being
  // folklore.
  //
  // Ruling 20's ordering, partly: nothing is announced while the bootstrap is
  // pending. That pins the announcements as *after* the fetch. It does not
  // pin them after the meta commit -- the review's mutant moves the broadcast
  // inside `bootstrapCursors`, between its fetch and its write, and both
  // orders look identical from out here once the response lands. The
  // sibling test above pins `emitReset` against a synchronous read; this is
  // the half that was reachable.
  const db = await freshDb();
  await writeCursors(db, { since: 10, before: null });
  await writeGeneration(db, 'gen-old');

  const held = deferred<SyncResponse>();
  const announced: ('emitReset' | 'broadcast')[] = [];
  cleanups.push(subscribeReset(() => { announced.push('emitReset'); }));
  const other = new BroadcastChannel(CHANNEL_NAME);
  cleanups.push(() => { other.close(); });
  other.addEventListener('message', () => { announced.push('broadcast'); });

  const fetch = stubFetch((url: string): Promise<SyncResponse> | SyncResponse => {
    if (url === '/api/sync/bootstrap') return held.promise;
    return ok({ ops: [], cursor: 10, generation: 'gen-new' });
  });
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  await sched.drive('tail');
  await settle();

  // `assert.equal(length, 0)` rather than `deepEqual(announced, [])`: the
  // latter narrows `announced` to `never[]` for the rest of the function, so
  // the `includes` below stops compiling.
  assert.equal(announced.length, 0, 'nothing is announced while the bootstrap is still in flight');
  // Sharper than ruling 21 recorded, and measured here rather than reasoned:
  // `reset()` wipes *before* it bootstraps, so a stalled bootstrap does not
  // merely block both loops -- it leaves the replica already emptied, with no
  // cursors and no announcement that anything happened. A tab reading during
  // the stall sees an empty library and has been told nothing about it.
  assert.equal(await readCursors(db), undefined,
    'the wipe has already committed, so the stall is not a pause -- it is an empty replica');

  held.resolve(ok({ since: 0, before: 9, generation: 'gen-new' }));
  await settle();

  assert.deepEqual(await readCursors(db), { since: 0, before: 9 }, 'the pivot lands once the bootstrap answers');
  assert.ok(announced.includes('emitReset'), 'and only then is it announced');
  db.close();
});

test('refusals are retried, but stop after the limit rather than forever', async () => {
  // The whole-branch review's finding 2. Retrying a refusal is right -- the
  // request is identical, but the *server's* state can change, and the
  // sibling test above says so in its own message. What was wrong is that it
  // never stopped: a genuinely bad endpoint was polled every thirty seconds
  // for the life of the tab, reported only to the console, looking healthy
  // from outside.
  const db = await freshDb();
  await writeCursors(db, { since: 10, before: null });
  await writeGeneration(db, 'g');

  // A `create` on the tail: the server may not send one there, ever.
  const fetch = stubFetch(routes({
    '/api/sync?since=10': {
      ops: [{ op: 'create', table: 'person', id: 1, value: { name: 'x' } }],
      cursor: 11,
      generation: 'g',
    },
  }));
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  // Four refusals: still asking, because the row behind it might be fixed.
  await sched.drive('tail');
  await settle();
  assert.ok(sched.pendingFor('tail'), 'retried once');
  await sched.drive('tail');
  await settle();
  await sched.drive('tail');
  await settle();
  await sched.drive('tail');
  await settle();
  assert.ok(sched.pendingFor('tail'), 'still asking at four');

  // The fifth stops it.
  await sched.drive('tail');
  await settle();
  assert.equal(sched.pendingFor('tail'), undefined, 'and the fifth stops asking rather than polling forever');
  assert.deepEqual(await readCursors(db), { since: 10, before: null }, 'no refused page ever moved a cursor');
  db.close();
});

test('a transient failure still backs off and retries', async () => {
  // The other side of the split: an HTTP failure is exactly what a retry is
  // for, and must keep the ladder it had before.
  const db = await freshDb();
  await writeCursors(db, { since: 10, before: null });
  await writeGeneration(db, 'g');
  const fetch = stubFetch((): SyncResponse => ({ ok: false, status: 503, json: () => Promise.resolve({}) }));
  const { sched } = start(db, fetch.fetch, grantedLease());
  await settle();

  await sched.drive('tail');
  await settle();

  assert.ok(sched.pendingFor('tail'), 'a 503 is retried');
});

test('a request that outlives the deadline is aborted rather than stalling both loops', async () => {
  // Ruling 21's gap, closed. The two bootstrap fetches run inside the mutex,
  // so before this an unanswered request stalled *both* loops indefinitely --
  // with the replica already wiped and nothing announced. The deadline is
  // injected so this does not take a real minute.
  const db = await freshDb();
  let sawSignal: AbortSignal | undefined;
  const fetch: SyncFetch = (_url: string, signal: AbortSignal) => {
    sawSignal = signal;
    // Never answers on its own: only the signal can end it.
    return new Promise<SyncResponse>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
    });
  };
  const { sched } = start(db, fetch, grantedLease(), { fetchDeadlineMs: 20 });
  await settle();
  await delay(60);

  assert.ok(sawSignal !== undefined, 'the fetch is handed a signal');
  assert.ok(sawSignal.aborted, 'which aborts once the deadline passes');
  // The loop recovered into its backoff rather than sitting in the mutex.
  assert.ok(sched.pendingFor('tail'), 'so the loop is retrying rather than stalled');
  db.close();
});
