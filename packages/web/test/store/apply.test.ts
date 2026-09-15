import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { request } from '../../src/store/idb.ts';
import { readCursors } from '../../src/store/meta.ts';
import type { Cursors } from '../../src/store/meta.ts';
import { applyBatch, MalformedOpError } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';

/** A `Cursors` for a given tail position -- the backfill has no bearing on these tests. */
function c(since: number): Cursors {
  return { since, before: null };
}

async function heldRow(db: IDBDatabase, table: string, id: number): Promise<unknown> {
  return request(db.transaction('rows').objectStore('rows').get([table, id]));
}

test('a create does not overwrite a row already held', async () => {
  const db = await freshDb();
  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'new' } }], c(1));
  await applyBatch(db, [{ op: 'create', table: 'person', id: 1, value: { name: 'stale' } }], c(2));
  const held = await heldRow(db, 'person', 1);
  assert.deepEqual(held, { table: 'person', id: 1, value: { name: 'new' } });
  db.close();
});

test('a create does not overwrite a tombstone, so a stale page cannot resurrect a deleted row', async () => {
  const db = await freshDb();
  await applyBatch(db, [{ op: 'delete', table: 'person', id: 1 }], c(1));
  await applyBatch(db, [{ op: 'create', table: 'person', id: 1, value: { name: 'back' } }], c(2));
  const held = await heldRow(db, 'person', 1);
  assert.deepEqual(held, { table: 'person', id: 1 }, 'still a tombstone');
  db.close();
});

test('an upsert over a tombstone revives the row', async () => {
  const db = await freshDb();
  await applyBatch(db, [{ op: 'delete', table: 'person', id: 1 }], c(1));
  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'revived' } }], c(2));
  const held = await heldRow(db, 'person', 1);
  assert.deepEqual(held, { table: 'person', id: 1, value: { name: 'revived' } });
  db.close();
});

test('a delete leaves a tombstone rather than removing the record', async () => {
  const db = await freshDb();
  await applyBatch(db, [{ op: 'upsert', table: 'person', id: 1, value: { name: 'here' } }], c(1));
  await applyBatch(db, [{ op: 'delete', table: 'person', id: 1 }], c(2));
  const held = await heldRow(db, 'person', 1);
  assert.ok(held !== undefined, 'the record is still at its key');
  assert.deepEqual(held, { table: 'person', id: 1 }, 'no value key at all');
  db.close();
});

test('a batch that fails part-way leaves neither its rows nor its cursor', async () => {
  const db = await freshDb();
  const ops: SyncOp[] = [
    { op: 'upsert', table: 'person', id: 1, value: { name: 'ok' } },
    // A function cannot be structured-cloned; IndexedDB refuses it, which
    // is what a real mid-batch failure looks like -- not a manual tx.abort()
    // from the test, which would only prove IndexedDB's own abort works.
    { op: 'upsert', table: 'person', id: 2, value: () => {} },
  ];

  await assert.rejects(applyBatch(db, ops, c(5)));

  const held = await heldRow(db, 'person', 1);
  assert.equal(held, undefined, 'the op ahead of the failure did not commit either');
  const cursors = await readCursors(db);
  assert.equal(cursors, undefined, 'the cursor did not advance');
  db.close();
});

test('applying the same page twice leaves the store identical', async () => {
  const db = await freshDb();
  const ops: SyncOp[] = [
    { op: 'upsert', table: 'person', id: 1, value: { name: 'one' } },
    { op: 'delete', table: 'person', id: 2 },
  ];
  await applyBatch(db, ops, c(10));
  const first = [await heldRow(db, 'person', 1), await heldRow(db, 'person', 2)];
  const firstCursors = await readCursors(db);

  await applyBatch(db, ops, c(10));
  const second = [await heldRow(db, 'person', 1), await heldRow(db, 'person', 2)];
  const secondCursors = await readCursors(db);

  assert.deepEqual(second, first);
  assert.deepEqual(secondCursors, firstCursors);
  db.close();
});

test('two appliers interleaved over one page converge', async () => {
  const db = await freshDb();
  const ops: SyncOp[] = [
    { op: 'upsert', table: 'person', id: 1, value: { name: 'converged' } },
    { op: 'delete', table: 'person', id: 2 },
  ];

  await Promise.all([applyBatch(db, ops, c(10)), applyBatch(db, ops, c(10))]);

  const held1 = await heldRow(db, 'person', 1);
  const held2 = await heldRow(db, 'person', 2);
  assert.deepEqual(held1, { table: 'person', id: 1, value: { name: 'converged' } });
  assert.deepEqual(held2, { table: 'person', id: 2 });
  assert.deepEqual(await readCursors(db), { since: 10, before: null });
  db.close();
});

test('a create or upsert with no value is refused rather than written as an indistinguishable tombstone', async () => {
  const db = await freshDb();
  const malformed: SyncOp = { op: 'upsert', table: 'person', id: 1 };
  await assert.rejects(applyBatch(db, [malformed], c(1)), MalformedOpError);
  const held = await heldRow(db, 'person', 1);
  assert.equal(held, undefined, 'the refused op wrote nothing');
  db.close();
});

test('a batch is exactly one transaction, so its rows and its cursor cannot be committed apart', async () => {
  // The property the task's own mutation 3 could not isolate: a version that
  // wrote the cursor in a *second* transaction after the first committed left
  // both end states identical whenever nothing failed, and the one fault the
  // brief sanctions (a value IndexedDB cannot clone) always fails upstream of
  // the cursor write. Counting transactions pins it structurally instead --
  // a typed Proxy, so no cast is needed.
  const db = await freshDb();
  let transactions = 0;
  const counted = new Proxy<IDBDatabase>(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (...args: Parameters<IDBDatabase['transaction']>) => {
          transactions += 1;
          return target.transaction(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  await applyBatch(counted, [
    { op: 'upsert', table: 'person', id: 1, value: { name: 'a' } },
    { op: 'upsert', table: 'person', id: 2, value: { name: 'b' } },
    { op: 'delete', table: 'person', id: 3 },
  ], { since: 9, before: 4 });

  assert.equal(transactions, 1, 'the ops and the cursor advance share one transaction');
  db.close();
});
