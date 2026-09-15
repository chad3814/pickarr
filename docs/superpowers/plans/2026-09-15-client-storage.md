# Client Storage Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replicate the server's library into IndexedDB and answer components from that replica, with both sync cursors running concurrently under a one-tab lease.

**Architecture:** One IndexedDB object store keyed `['table', 'id']` with sparse indexes on nested `value.*` paths, so a tombstone drops out of every index while staying findable at its key. A `meta` store holds the cursors, the generation token and the schema version. Ops and the cursor advance commit in one transaction. A Web Locks lease elects one tab to fetch; the rest read and listen on a `BroadcastChannel`.

**Tech Stack:** TypeScript, IndexedDB, Web Locks, BroadcastChannel, `fake-indexeddb` for tests. No React in this slice.

**Spec:** `docs/superpowers/specs/2026-09-15-client-storage-design.md`

## Global Constraints

- **Never the `any` type.** Not in source, not in tests, not behind a cast. Wire values are `unknown` and get narrowed.
- **No cast to silence a type error.** If a cast is needed, the types are wrong — say so in the report rather than casting.
- **Every read is async**, including ones answerable from memory. Spec §1.1: this is the decision that cannot be revisited, because an async surface can move into a worker and a sync one cannot.
- **`create` never overwrites; `delete` writes a tombstone.** Spec §4. These are the two things the server cannot enforce. If `apply` is wrong, a stale backfill page reverts newer state or resurrects a deleted row and nothing server-side notices.
- **The cursor advance is in the same transaction as the ops it covers.** Spec §4.
- **Subscribers fire after the transaction commits, never inside it.** Spec §4.
- **No URL, path or credential enters the replica.** The projections already exclude `link`, `guid`, `storagePath` and `lastError`; nothing here may add one back, and nothing may log a row's contents.
- **This slice adds no React, no route, no component and no styling.** Spec §1.2.
- **Depends on `sync-wire`** for the camelCase wire, the six host read shapes and the `generation` field. If that branch has not merged when a task needs it, stop and report rather than shimming.
- Gate: `npm run typecheck`, `npm run test:server`, `npm run test:web`, `npm run lint` (exit 0, exactly 124 warnings, 0 in `packages/contract` and `packages/host`), `npm run build`, `npm run test-hygiene`.
- `CLAUDE.md`'s testing hazards apply in full. The two that bite here: never hand a live object to `node:assert` as an operand, and spy on the real `setTimeout` rather than replacing it.

---

## File Structure

```
packages/web/src/store/
  idb.ts       promise wrappers for IDBRequest and IDBTransaction        (task 1)
  db.ts        openStore, StoredRow, the schema and its indexes          (task 1)
  meta.ts      cursors, generation, schema version                       (task 1)
  apply.ts     the three op rules, atomic with the cursor advance        (task 2)
  rows.ts      the read surface                                          (task 3)
  notify.ts    the subscription registry                                 (task 4)
  leader.ts    the Web Locks lease and BroadcastChannel fan-out          (task 5)
  sync.ts      bootstrap, the two loops, the generation check            (task 6)
  gather.ts    host-owned composition for one media item                 (task 7)
  index.ts     createStore, the public surface                           (task 8)

packages/web/test/store/
  harness.ts   fake-indexeddb wiring, a fresh database per test          (task 1)
  *.test.ts    one file per source module; `.test.ts` runs in the server suite
```

`idb.ts` exists because every IndexedDB call is an event-emitter and the rest of this
code reads far better as `await`. It is four small functions and nothing else may wrap
a request.

---

### Task 1: The store, its schema, and the meta accessors

**Files:**
- Create: `packages/web/src/store/idb.ts`
- Create: `packages/web/src/store/db.ts`
- Create: `packages/web/src/store/meta.ts`
- Create: `packages/web/test/store/harness.ts`
- Test: `packages/web/test/store/db.test.ts`

**Interfaces:**
- Produces: `StoredRow`, `openStore(name: string): Promise<IDBDatabase>`, `SCHEMA_VERSION`, `request<T>(r: IDBRequest<T>): Promise<T>`, `done(tx: IDBTransaction): Promise<void>`, `readCursors`, `writeCursors`, `readGeneration`, `writeGeneration`, `Cursors`.
- `fake-indexeddb` is already a dev dependency of `@pickarr/web`.

- [ ] **Step 1: Write the failing schema test**

```ts
// packages/web/test/store/db.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { request } from '../../src/store/idb.ts';

test('the store is keyed by table and id together', async () => {
  const db = await freshDb();
  const names = [...db.objectStoreNames].toSorted();
  assert.deepEqual(names, ['meta', 'rows']);
  const rows = db.transaction('rows').objectStore('rows');
  assert.deepEqual(rows.keyPath, ['table', 'id']);
  assert.deepEqual([...rows.indexNames].toSorted(),
    ['by_media_item', 'by_rss_item', 'by_table', 'by_table_updated']);
  db.close();
});

test('a tombstone is findable by key and invisible to every value index', async () => {
  const db = await freshDb();
  const tx = db.transaction('rows', 'readwrite');
  const rows = tx.objectStore('rows');
  rows.put({ table: 'rss_item', id: 1, value: { mediaItemId: 7, updatedAt: 5 } });
  rows.put({ table: 'rss_item', id: 2 });
  await new Promise((r, j) => { tx.oncomplete = () => r(null); tx.onerror = () => j(tx.error); });

  const byItem = await request(db.transaction('rows').objectStore('rows')
    .index('by_media_item').getAll(7));
  assert.equal(byItem.length, 1, 'the tombstone is not in the index');

  const tomb = await request(db.transaction('rows').objectStore('rows').get(['rss_item', 2]));
  assert.ok(tomb !== undefined, 'the tombstone is still at its key');
  db.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test "packages/web/test/store/db.test.ts"`
Expected: FAIL, cannot find `./harness.ts`.

- [ ] **Step 3: Write `idb.ts`**

```ts
/**
 * Promise wrappers for IndexedDB's event-emitter API.
 *
 * Four functions, and nothing else in this package may wrap a request: a
 * second wrapper is where one caller starts forgetting that a rejected
 * transaction still has to be observed, and IndexedDB reports an abort on the
 * transaction rather than on the request that caused it.
 */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

/** Resolves when `tx` commits; rejects if it aborts or errors. */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
  });
}
```

- [ ] **Step 4: Write `db.ts`**

`SCHEMA_VERSION = 1`. `openStore(name)` opens at that version and, in
`onupgradeneeded`, creates:

```ts
const rows = db.createObjectStore('rows', { keyPath: ['table', 'id'] });
rows.createIndex('by_media_item', 'value.mediaItemId');
rows.createIndex('by_rss_item', 'value.rssItemId');
rows.createIndex('by_table_updated', ['table', 'value.updatedAt']);
rows.createIndex('by_table', 'table');
db.createObjectStore('meta', { keyPath: 'key' });
```

`StoredRow` is exactly spec §3.2 — `table`, `id`, and an optional `value?: unknown`.
The docblock must say why `value` is nested rather than spread: IndexedDB skips a
record whose index key path is absent, so the nesting is what makes a tombstone
invisible to `by_media_item` while still retrievable at `['table', id]`. Measured in
spec §2.8.

`openStore` also handles `onblocked` — another tab holding an older version open stalls
the upgrade indefinitely otherwise, and a hung open with no error is the worst failure
this file can have. Reject with a named error.

- [ ] **Step 5: Write `harness.ts`**

```ts
import 'fake-indexeddb/auto';
import { openStore } from '../../src/store/db.ts';

let counter = 0;

/** A database no other test shares, so tests need no cleanup order. */
export async function freshDb(): Promise<IDBDatabase> {
  counter += 1;
  return openStore(`test-${String(counter)}`);
}
```

A per-test database name rather than deleting a shared one: `deleteDatabase` blocks on
any open connection, so a test that forgets to close leaves the *next* test hanging
with no indication which one was at fault.

- [ ] **Step 6: Write `meta.ts`**

```ts
export interface Cursors { since: number; before: number | null; }
```

`before: null` means the backfill has retired (spec §5). Accessors take a transaction
or a database so a caller can join them to an existing transaction — task 2 needs
exactly that, and an accessor that always opens its own transaction cannot be made
atomic with anything.

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --conditions development --test "packages/web/test/store/db.test.ts"`
Expected: PASS, 2 tests.

- [ ] **Step 8: Add the meta round-trip test and run it**

Cursors and generation survive a close and reopen; a fresh database answers `undefined`
for both, which is what task 6 bootstraps on.

- [ ] **Step 9: Gate and commit**

```bash
npm run typecheck && npm run lint && npm run test:server
git add packages/web/src/store packages/web/test/store
git commit -m "Key the replica the way the protocol keys rows"
```

---

### Task 2: Applying ops

**Files:**
- Create: `packages/web/src/store/apply.ts`
- Test: `packages/web/test/store/apply.test.ts`

**Interfaces:**
- Consumes: `StoredRow`, `request`, `done`, `Cursors`, the meta accessors.
- Produces: `applyBatch(db: IDBDatabase, ops: readonly SyncOp[], cursors: Cursors): Promise<Changed>` where `Changed` is `{ touched: ReadonlyMap<string, readonly number[]>; inserted: ReadonlyMap<string, readonly number[]> }`, keyed by table.
- `SyncOp` is `{ op: 'create' | 'upsert' | 'delete'; table: string; id: number; value?: unknown }` — mirror it locally in `packages/web/src/store/wire.ts`; do not import from `@pickarr/host`.

`Changed` distinguishes touched from inserted because task 4's two signals need
different sets, and `applyBatch` is the only place that knows which ops found nothing
at their key.

- [ ] **Step 1: Write the failing tests for the three rules**

```ts
test('a create does not overwrite a row already held', async () => {
  const db = await freshDb();
  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'new' } }], c(1));
  await applyBatch(db, [{ op: 'create', table: 'person', id: 1, value: { name: 'stale' } }], c(2));
  const held = await request(db.transaction('rows').objectStore('rows').get(['person', 1]));
  assert.deepEqual(held, { table: 'person', id: 1, value: { name: 'new' } });
  db.close();
});

test('a create does not overwrite a tombstone, so a stale page cannot resurrect a deleted row', async () => {
  const db = await freshDb();
  await applyBatch(db, [{ op: 'delete', table: 'person', id: 1 }], c(1));
  await applyBatch(db, [{ op: 'create', table: 'person', id: 1, value: { name: 'back' } }], c(2));
  const held = await request(db.transaction('rows').objectStore('rows').get(['person', 1]));
  assert.deepEqual(held, { table: 'person', id: 1 }, 'still a tombstone');
  db.close();
});

test('an upsert over a tombstone revives the row', async () => { /* … */ });
test('a delete leaves a tombstone rather than removing the record', async () => { /* … */ });
```

- [ ] **Step 2: Run them and watch them fail**

Expected: FAIL, `applyBatch` is not defined.

- [ ] **Step 3: Write `applyBatch`**

One `readwrite` transaction over both stores. For each op:

```ts
if (op.op === 'create') {
  const held = await request(store.get([op.table, op.id]));
  if (held !== undefined) continue;            // including a tombstone
  store.put({ table: op.table, id: op.id, value: op.value });
  insertedFor(op.table).push(op.id);
} else if (op.op === 'upsert') {
  const held = await request(store.get([op.table, op.id]));
  store.put({ table: op.table, id: op.id, value: op.value });
  if (held === undefined) insertedFor(op.table).push(op.id);
} else {
  store.put({ table: op.table, id: op.id });   // tombstone: no `value`
}
touchedFor(op.table).push(op.id);
```

Then write the cursors **into the same transaction**, and only then `await done(tx)`.

The docblock carries what the code cannot show: that these two rules are the whole of
what the server cannot enforce, and what breaks if either is dropped. Spec §4 and
`sync/tail.ts`'s `SyncOp` on the server both state them; cite them rather than
restating the argument.

- [ ] **Step 4: Run the tests**

Expected: PASS, 4 tests.

- [ ] **Step 5: Add the atomicity and idempotence tests**

```ts
test('a batch that fails part-way leaves neither its rows nor its cursor', async () => { /* abort the tx */ });
test('applying the same page twice leaves the store identical', async () => { /* … */ });
test('two appliers interleaved over one page converge', async () => { /* … */ });
```

For the first, inject the failure by putting a value IndexedDB refuses to
structured-clone — a function — as a row's `value`. That aborts the transaction the way
a real failure does. Do **not** abort the transaction by calling `tx.abort()` from the
test: that tests IndexedDB's abort, not this function's participation in it.

- [ ] **Step 6: Run them, then mutation-test**

Four mutations, each must fail a test **by name**:
1. `create` puts unconditionally → test 1 and test 2 fail.
2. `delete` calls `store.delete(...)` instead of putting a tombstone → test 4 fails, and so does test 2, which is the point.
3. The cursor write moves after `await done(tx)` → the atomicity test fails.
4. `inserted` records every op rather than only the ones that found nothing → task 4's test fails once it exists; note it and re-check then.

Revert each by copy-aside plus `md5 -q`, never `git checkout --`.

- [ ] **Step 7: Gate and commit**

---

### Task 3: The read surface

**Files:**
- Create: `packages/web/src/store/rows.ts`
- Test: `packages/web/test/store/rows.test.ts`

**Interfaces:**
- Produces exactly spec §7's five functions. `getRow` resolves `undefined` for a tombstone *and* for an absence — spec §9 says the provider cannot tell those apart and must not pretend to.
- `listByTable(table, { fromUpdatedAt?, direction, limit })` walks `by_table_updated`.

- [ ] **Step 1: Write the failing tests**

```ts
test('byMediaItem returns rows from several tables in one query', async () => {
  // seed rss_item, role and tv_release all with mediaItemId 7, plus a fourth row
  // with mediaItemId 8, and assert exactly the three come back.
});

test('getRow answers undefined for a tombstone', async () => { /* … */ });

test('listByTable refuses a table that projects no updatedAt', async () => {
  await assert.rejects(() => listByTable(db, 'role', { direction: 'next', limit: 10 }),
    /role.*updatedAt/);
});
```

That last one is spec §7's rule: `role` and the six plugin tables project no
`updatedAt`, so asking for them in modification order is a programming error. Returning
an empty page would read as "this table is empty", which is a lie a caller cannot
detect. The list of five permitted tables is a local constant with the measurement in
its docblock (spec §3.2).

- [ ] **Step 2: Run, fail, implement, run**

- [ ] **Step 3: Mutation-test**

Two mutations: `listByTable` returns `[]` instead of throwing for an unsupported table;
`getRow` returns the `StoredRow` rather than `undefined` for a tombstone.

- [ ] **Step 4: Gate and commit**

---

### Task 4: Subscriptions

**Files:**
- Create: `packages/web/src/store/notify.ts`
- Test: `packages/web/test/store/notify.test.ts`

**Interfaces:**
- Produces spec §8's three functions plus `emit(changed: Changed): void` and `emitReset(): void`, called by tasks 2 and 6 respectively.
- Registry: `Map<string, Set<() => void>>` keyed `` `${table}:${id}` ``.

- [ ] **Step 1: Write the failing tests**

```ts
test('a subscriber for a changed row fires, and one for an untouched row does not', async () => { /* … */ });

test('a subscriber reading inside its callback sees the whole batch', async () => {
  // Subscribe, and in the callback read the row. The value read must be the
  // batch's, which is what "after commit" buys and what firing inside the
  // transaction would break.
});

test('subscribeInserts reports a row no per-row subscription covered', async () => {
  // The gap per-row subscriptions cannot close, and the tail's entire job.
});

test('unsubscribing stops delivery and leaves other subscribers alone', async () => { /* … */ });
```

- [ ] **Step 2: Run, fail, implement, run**

Emission iterates the changed rows and looks each up, so it costs O(rows changed)
rather than a scan of every subscriber. A handler that throws must not stop the others
— catch per handler and report, because one component's bug is not a reason the rest of
the app stops updating.

- [ ] **Step 3: Wire `applyBatch` to `emit`, after `await done(tx)`**

- [ ] **Step 4: Mutation-test**

Move `emit` to before `await done(tx)` → the read-inside-callback test fails. Make a
throwing handler propagate → the isolation test fails.

- [ ] **Step 5: Gate and commit**

---

### Task 5: The lease and the channel

**Files:**
- Create: `packages/web/src/store/leader.ts`
- Test: `packages/web/test/store/leader.test.ts`

**Interfaces:**
- Produces: `holdLease(name: string, onGranted: (release: Promise<void>) => void): void`, `isLeader(): boolean`, `broadcast(msg: ChannelMessage): void`, `onMessage(cb: (msg: ChannelMessage) => void): () => void`.
- `ChannelMessage` is `{ type: 'changed'; changed: SerializedChanged } | { type: 'reset'; generation: string }`.

Web Locks and `BroadcastChannel` both work in Node 26 unstubbed — measured, spec §2.7 —
so these tests drive the real APIs. `navigator.locks` is per-process in Node and
per-origin in a browser, which makes two requesters in one test the right model for two
tabs.

- [ ] **Step 1: Write the failing tests**

```ts
test('one holder at a time: a second requester is not granted while the first holds', async () => {
  // Uses ifAvailable so the second returns a null lock rather than queueing.
});

test('the lease releases when its holder finishes, and the next requester is granted', async () => { /* … */ });

test('a message broadcast by one channel reaches another', async () => { /* … */ });
```

- [ ] **Step 2: Run, fail, implement, run**

A `BroadcastChannel` must be closed or the Node process will not exit — every test
closes its channels, and `holdLease`'s release path closes the one it opened.

- [ ] **Step 3: Gate and commit**

---

### Task 6: Bootstrap, the two loops, and the generation check

**Files:**
- Create: `packages/web/src/store/sync.ts`
- Test: `packages/web/test/store/sync.test.ts`

**Interfaces:**
- Consumes: `applyBatch`, the meta accessors, `leader.ts`, an injected `fetch` and an injected scheduler.
- Produces: `startSync(deps: SyncDeps): { stop(): void }` where `SyncDeps` is `{ db, fetch, schedule, now, locks }`.

**Everything external is injected.** No `globalThis.fetch`, no bare `setTimeout`, no
`requestIdleCallback`. `schedule` is the seam that lets a test drive both loops
deterministically without fake timers, which hang this suite (`CLAUDE.md`).

- [ ] **Step 1: Write the failing tests**

```ts
test('an empty client bootstraps, then runs both cursors', async () => {
  // No cursors in meta -> GET /api/sync/bootstrap -> both loops start from what it said.
});

test('the backfill retires on a null cursor and the tail keeps running', async () => { /* … */ });

test('a mismatched generation wipes, re-bootstraps, and broadcasts, in that order', async () => {
  // Order matters: a tab that re-reads before the commit sees a half-wiped store.
  // Assert the sequence, not just the end state.
});

test('a follower promoted to leader re-checks the generation before its first fetch', async () => { /* … */ });

test('only the lease holder fetches', async () => {
  // Two sync instances, one lease. The second must make no request at all.
});
```

- [ ] **Step 2: Run, fail, implement, run**

The tail sends `since` and the backfill sends `before`; both read `generation` off every
response and compare against `meta`. A `create` op arriving on the tail, or an `upsert`
on the backfill, is a server bug — refuse the batch and report rather than applying it,
because the two client obligations are keyed off the op kind and applying the wrong one
silently is exactly the failure they exist to prevent.

- [ ] **Step 3: Mutation-test**

1. Drop the generation comparison → the mismatch test fails.
2. Broadcast before the wipe commits → the ordering test fails.
3. Let a non-holder fetch → the lease test fails.
4. Treat `before: null` as "keep going" → the retirement test fails.

- [ ] **Step 4: Gate and commit**

---

### Task 7: The host-owned gatherer

**Files:**
- Create: `packages/web/src/store/gather.ts`
- Test: `packages/web/test/store/gather.test.ts`

**Interfaces:**
- Produces: `gatherMediaItem(db, mediaItemId): Promise<GatheredItem | undefined>`.
- `GatheredItem` carries the item, its releases, the downloads under those, its roles paired with their people, artwork URLs, `pluginId`, and `feedId`s.

Plugin-blind by construction: it knows the six host table names and no plugin table
name appears in it. Spec §7 — that is what makes a new plugin a new directory rather
than an edit here.

- [ ] **Step 1: Write the failing tests**

```ts
test('one media item is gathered from a single byMediaItem query', async () => { /* … */ });

test('downloads are attached to the release that owns them, not to the item', async () => { /* … */ });

test('a role is paired with its person, and a role whose person has not arrived yet is kept', async () => {
  // Mid-backfill this is normal: log order is not group order (sync spec §5.2), so a
  // role can arrive before its person. Dropping it would make the cast silently short.
});

test('artwork is three urls, not rows', async () => {
  // poster | background | logo, addressed by (kind, mediaItemId). Spec §1.2 and #79.
});

test('feedId and downloadClientId are surfaced as ids, because the replica cannot resolve them', async () => {
  // Spec §2.4. A test that pins the limitation, so a later change to it is deliberate.
});
```

- [ ] **Step 2: Run, fail, implement, run**

- [ ] **Step 3: Gate and commit**

---

### Task 8: The public surface

**Files:**
- Create: `packages/web/src/store/index.ts`
- Test: `packages/web/test/store/store.test.ts`

**Interfaces:**
- Produces: `createStore(deps): Promise<Store>`, where `Store` exposes the five reads, the three subscriptions, `gatherMediaItem`, and `stop()`.

A factory taking its dependencies, not a module-level singleton: a singleton cannot be
tested twice in one process, and every seam this slice added exists so the tests can
drive it.

- [ ] **Step 1: Write one end-to-end test**

Boot a store against a stubbed `fetch` that serves a bootstrap, one tail page and two
backfill pages, the second retiring. Drive the scheduler. Then assert: every row is
queryable, `gatherMediaItem` assembles one, a subscriber fired, and the cursors in
`meta` match the last page served.

This is the test that would have caught a wiring error no unit test can see, because
every task until now tested its own module against a hand-built store.

- [ ] **Step 2: Run, fail, implement, run**

- [ ] **Step 3: Full gate and commit**

```bash
npm run typecheck && npm run lint && npm run test-hygiene && npm run build && npm test
```

---

## Self-Review

**Spec coverage.** §3 → task 1. §4 → task 2. §5 → tasks 5 and 6. §6 → task 6. §7 →
tasks 3 and 7. §8 → task 4. §10's fifteen properties map to tasks as: 1-5 and 7-8 →
task 2; 6 → task 2 step 5; 9 → tasks 3 and 7; 10-11 → task 4; 12-13 → task 6; 14 →
tasks 5 and 6; 15 → task 6. No property is unclaimed.

**Interfaces.** `Changed` is produced in task 2 and consumed in task 4; `Cursors` in
task 1 and consumed in tasks 2 and 6; `SyncOp` is mirrored locally in task 2 and used
in task 6. `emit` is defined in task 4 and called from task 2's `applyBatch`, which
means task 2 lands with its emission call commented out or absent — **task 4 step 3 is
where it is wired, and task 2's mutation 4 cannot be checked until then.** Both are
noted in place.

**Known gap, deliberate.** Nothing here exercises a real browser. `navigator.locks` and
`BroadcastChannel` behave in Node, and `fake-indexeddb` implements the schema (spec
§2.7, §2.8), but "behaves in Node" is not "behaves in Safari". The first slice with a
route should drive this through Playwright, which the repo already has.
