import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import { getRow } from '../../src/store/rows.ts';
import type { Changed } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { subscribe, subscribeInserts, subscribeTable, subscribeReset, emit, emitReset } from '../../src/store/notify.ts';

/**
 * A `Changed` naming one touched row, optionally inserted -- most tests here
 * exercise the registry directly and have no need of a real `applyBatch`.
 */
function changedOf(table: string, id: number, inserted: boolean): Changed {
  return {
    touched: new Map([[table, [id]]]),
    inserted: inserted ? new Map([[table, [id]]]) : new Map(),
  };
}

test('a subscriber for a changed row fires, and one for an untouched row does not', () => {
  let watched = 0;
  let ignored = 0;
  const unwatch = subscribe('person', 1, () => {
    watched += 1;
  });
  const unignore = subscribe('person', 2, () => {
    ignored += 1;
  });

  emit(changedOf('person', 1, false));

  unwatch();
  unignore();
  assert.equal(watched, 1, 'the subscribed row fired');
  assert.equal(ignored, 0, 'the untouched row did not');
});

test('a subscriber reading inside its callback sees the whole batch', async () => {
  // This exercises `applyBatch`'s own wiring (task 3), not a manual `emit`
  // call: the claim under test is that by the time `applyBatch` fires a
  // subscriber, its transaction has already committed, not merely that
  // `emit` fanned out correctly.
  const db = await freshDb();
  let committed = false;
  // Wraps `db.transaction` so the test can see the transaction's own
  // `complete` event, without changing what `applyBatch` is handed -- the
  // same technique `apply.test.ts` uses to count transactions.
  const watched = new Proxy<IDBDatabase>(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (...args: Parameters<IDBDatabase['transaction']>) => {
          const tx = target.transaction(...args);
          tx.addEventListener('complete', () => {
            committed = true;
          });
          return tx;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  let sawCommitted: boolean | undefined;
  // Started inside the callback and settled by the test afterwards. A
  // subscriber is synchronous by contract, so it cannot await its own read --
  // and reading through `getRow` rather than a raw request means this needs no
  // cast, which the plan's Global Constraints forbid. It also exercises the
  // surface a real component would use.
  let pending: Promise<unknown> | undefined;
  const unsubscribe = subscribe('person', 1, () => {
    sawCommitted = committed;
    // A read started here queues behind nothing: the write transaction has
    // already committed by the time this callback runs, so a fresh
    // transaction sees the batch immediately rather than the wait a
    // still-open write transaction would impose.
    pending = getRow(db, 'person', 1);
  });

  const ops: SyncOp[] = [{ op: 'upsert', table: 'person', id: 1, value: { name: 'batch' } }];
  await applyBatch(watched, ops, { since: 1, before: null });
  const sawValue = await pending;

  unsubscribe();
  db.close();
  assert.equal(sawCommitted, true, "the callback ran only once the transaction's own commit had already fired");
  assert.deepEqual(sawValue, { name: 'batch' }, "the callback's read saw the committed batch");
});

test('subscribeInserts reports a row no per-row subscription covered', async () => {
  const db = await freshDb();
  const insertedIds: (readonly number[])[] = [];
  const unsubscribe = subscribeInserts('person', (ids) => {
    insertedIds.push(ids);
  });

  const ops: SyncOp[] = [{ op: 'upsert', table: 'person', id: 99, value: { name: 'new' } }];
  await applyBatch(db, ops, { since: 1, before: null });

  unsubscribe();
  db.close();
  assert.deepEqual(insertedIds, [[99]], 'a row nobody had subscribed to by id is still announced');
});

test('subscribeInserts does not fire for a batch that only updates a row already visible', async () => {
  const db = await freshDb();
  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'first' } }], { since: 1, before: null });

  const insertedIds: (readonly number[])[] = [];
  const unsubscribe = subscribeInserts('person', (ids) => {
    insertedIds.push(ids);
  });

  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'second' } }], { since: 2, before: null });

  unsubscribe();
  db.close();
  assert.deepEqual(insertedIds, [], 'updating a row already visible to readers is not an insert');
});

test('subscribeTable fires for an update and a delete, which subscribeInserts does not', async () => {
  // The two are registered side by side on purpose: the assertion is the
  // *difference* between them, and either count alone would pass with the
  // wrong subscription kind wired up. This is the gap that shipped -- a
  // whole-table reader on `subscribeInserts` never heard a row change or
  // leave, so `useFeeds` showed a deleted feed until a reload.
  const db = await freshDb();
  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'first' } }], { since: 1, before: null });

  let tableWakes = 0;
  const insertWakes: (readonly number[])[] = [];
  const unTable = subscribeTable('person', () => {
    tableWakes += 1;
  });
  const unInserts = subscribeInserts('person', (ids) => {
    insertWakes.push(ids);
  });

  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'second' } }], { since: 2, before: null });
  await applyBatch(db, [{ op: 'delete', table: 'person', id: 1 }], { since: 3, before: null });

  unTable();
  unInserts();
  db.close();
  assert.equal(tableWakes, 2, 'the update and the delete each woke the table subscriber');
  assert.deepEqual(insertWakes, [], 'and neither is an insert');
});

test('subscribeTable fires once per batch, not once per row', () => {
  // A table subscriber re-reads the whole table, so a forty-row batch
  // waking it forty times would be forty redundant reads. Spelled as an
  // exact count rather than `>= 1`, which every wrong implementation here
  // would also satisfy.
  let wakes = 0;
  const unsubscribe = subscribeTable('person', () => {
    wakes += 1;
  });

  emit({ touched: new Map([['person', [1, 2, 3]]]), inserted: new Map() });

  unsubscribe();
  assert.equal(wakes, 1);
});

test('subscribeTable does not fire for a batch that touched only another table', () => {
  let wakes = 0;
  const unsubscribe = subscribeTable('person', () => {
    wakes += 1;
  });

  emit(changedOf('rss_feed', 1, true));

  unsubscribe();
  assert.equal(wakes, 0);
});

test('unsubscribing stops delivery and leaves other subscribers alone', () => {
  let a = 0;
  let b = 0;
  const unsubA = subscribe('person', 1, () => {
    a += 1;
  });
  const unsubB = subscribe('person', 1, () => {
    b += 1;
  });

  unsubA();
  emit(changedOf('person', 1, false));
  unsubB();

  assert.equal(a, 0, 'the unsubscribed callback did not fire');
  assert.equal(b, 1, 'the remaining subscriber on the same key still fired');
});

test('a handler that throws does not stop the others from firing', () => {
  let survived = false;
  const unsubThrower = subscribe('person', 1, () => {
    throw new Error('boom');
  });
  const unsubSurvivor = subscribe('person', 1, () => {
    survived = true;
  });

  emit(changedOf('person', 1, false));

  unsubThrower();
  unsubSurvivor();
  assert.equal(survived, true, 'a throwing handler must not stop another handler on the same key');
});

test('subscribeReset fires every registered reset subscriber', () => {
  let calls = 0;
  const unsubscribe = subscribeReset(() => {
    calls += 1;
  });

  emitReset();
  unsubscribe();
  emitReset();

  assert.equal(calls, 1, 'fired once while subscribed, and not again after unsubscribing');
});

test('emit looks up only the rows a batch touched: an untouched key in the same table does not fire', () => {
  let fired = 0;
  const unsubscribe = subscribe('person', 2, () => {
    fired += 1;
  });

  emit({
    touched: new Map([['person', [1, 3, 4]]]),
    inserted: new Map(),
  });

  unsubscribe();
  assert.equal(fired, 0, 'id 2 was never in the touched set');
});

test('an async subscriber that rejects is contained, not left as an unhandled rejection', async () => {
  // The case the types invite and do not prevent: a listener is `() => void`,
  // and TypeScript accepts an `async` function there because `Promise<void>`
  // is assignable to `void`. Without the promise catch in `invoke`, this
  // rejection escapes and `node --test` attributes it to whichever test is
  // running -- measured, it corrupted an unrelated result rather than merely
  // warning.
  const db = await freshDb();
  let other = 0;
  const offAsync = subscribe('person', 1, async () => {
    await Promise.resolve();
    throw new Error('async boom');
  });
  const offSync = subscribe('person', 1, () => { other += 1; });

  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { n: 1 } }], { since: 1, before: null });
  // Long enough for a rejection to surface if nothing caught it.
  await new Promise((resolve) => setTimeout(resolve, 10));

  offAsync();
  offSync();
  db.close();
  assert.equal(other, 1, 'the other handler still ran, and the run was not poisoned');
});

test('unsubscribing twice does not detach subscribers that arrived in between', async () => {
  // The whole-branch review's blocking finding, and the silent twin of the
  // BroadcastChannel bug two commits earlier. The unsubscribe closure captured
  // the Set that existed when it was made; once that set emptied and was
  // dropped from the registry, a second call deleted the *key* -- taking with
  // it whatever set had been created there since. Reproduced before fixing:
  // this woke nobody at all.
  const db = await freshDb();
  const fired: string[] = [];
  const first = subscribe('person', 1, () => { fired.push('first'); });
  first();
  const second = subscribe('person', 1, () => { fired.push('second'); });
  const third = subscribe('person', 1, () => { fired.push('third'); });
  first();

  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { n: 1 } }], { since: 1, before: null });

  assert.deepEqual(fired, ['second', 'third'], 'the later subscribers are still attached');
  second();
  third();
  db.close();
});

test('the same holds for subscribeInserts, which shares the registry helper', async () => {
  const db = await freshDb();
  const seen: string[] = [];
  const first = subscribeInserts('person', () => { seen.push('first'); });
  first();
  const second = subscribeInserts('person', () => { seen.push('second'); });
  first();

  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 5, value: { n: 5 } }], { since: 1, before: null });

  assert.deepEqual(seen, ['second']);
  second();
  db.close();
});
