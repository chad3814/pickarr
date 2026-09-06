import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQPromise } from '../../src/jobs/qpromise.ts';

test('a pending promise reports pending and neither resolved nor rejected', async () => {
  let resolve!: (value: number) => void;
  const inner = new Promise<number>((res) => {
    resolve = res;
  });
  const q = makeQPromise(inner);

  assert.equal(q.isPending(), true);
  assert.equal(q.isResolved(), false);
  assert.equal(q.isRejected(), false);

  resolve(1);
  await q;
});

test('a resolved promise reports resolved and passes its value through', async () => {
  const q = makeQPromise(Promise.resolve(42));

  assert.equal(await q, 42);
  assert.equal(q.isPending(), false);
  assert.equal(q.isResolved(), true);
  assert.equal(q.isRejected(), false);
});

test('a rejected promise reports rejected and still rejects its caller', async () => {
  const failure = new Error('boom');
  const q = makeQPromise(Promise.reject(failure));

  await assert.rejects(q, (err) => err === failure);
  assert.equal(q.isPending(), false);
  assert.equal(q.isResolved(), false);
  assert.equal(q.isRejected(), true);
});

test('the flags are functions, not properties', () => {
  assert.equal(typeof makeQPromise(Promise.resolve()).isPending, 'function');
});
