import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  holdLease,
  isLeader,
  broadcast,
  onMessage,
  serializeChanged,
  deserializeChanged,
  CHANNEL_NAME,
} from '../../src/store/leader.ts';
import type { ChannelMessage } from '../../src/store/leader.ts';
import type { Changed } from '../../src/store/apply.ts';

/** A lease name no other test in this file shares. Most tests here never release, so a name reused across them would still queue one test's grant behind another's forever; a few now do release deliberately, and giving every test its own name keeps that from depending on run order either way. */
let leaseCounter = 0;
function freshLeaseName(): string {
  leaseCounter += 1;
  return `test-lease-${String(leaseCounter)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('one holder at a time: a second requester is not granted while the first holds', async () => {
  // Uses ifAvailable so the second returns a null lock rather than queueing.
  const name = freshLeaseName();
  await navigator.locks.request(name, { mode: 'exclusive' }, async () => {
    const second = await navigator.locks.request(
      name,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => lock,
    );
    assert.equal(second, null, 'a second exclusive request for the same name is refused, not queued, while the first holds it');
  });
});

test('the lease releases when its holder finishes, and the next requester is granted', async () => {
  const name = freshLeaseName();
  let secondGranted = false;
  let finishFirst: (() => void) | undefined;
  const firstShouldFinish = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });

  // Requested first, so it is the one granted; held open until the test
  // tells it to finish, below.
  const first = navigator.locks.request(name, { mode: 'exclusive' }, async () => {
    await firstShouldFinish;
  });

  // Requested only once the first is certainly already granted, so this one
  // queues behind it rather than racing it for the grant -- the case
  // `ifAvailable` above deliberately does not cover.
  await delay(10);
  const second = navigator.locks.request(name, { mode: 'exclusive' }, () => {
    secondGranted = true;
  });

  await delay(10);
  assert.equal(secondGranted, false, 'the queued request is not granted while the first holder is still running');

  finishFirst?.();
  await first;
  await second;
  assert.equal(secondGranted, true, 'the queued request is granted once the first holder finishes');
});

test('holdLease grants the lease and flips isLeader, and the release it hands the caller stays pending', async () => {
  const name = freshLeaseName();

  await new Promise<void>((resolve) => {
    holdLease(name, (release) => {
      assert.equal(isLeader(), true, 'isLeader reflects a grant this tab just received');

      const outcome = Promise.race([
        release.then(() => 'released' as const),
        delay(20).then(() => 'still-held' as const),
      ]);
      void outcome.then((result) => {
        assert.equal(result, 'still-held', 'release does not settle while the lease is still held (spec §5: "for its lifetime")');
        resolve();
      });
    });
  });
});

test('a second holdLease call for the same name is not granted while the first holds it', async () => {
  const name = freshLeaseName();
  let secondGranted = false;

  await new Promise<void>((resolve) => {
    holdLease(name, () => {
      holdLease(name, () => {
        secondGranted = true;
      });
      void delay(20).then(() => {
        assert.equal(secondGranted, false, 'a second holdLease for the same lease name never fires its onGranted while the first still holds it');
        resolve();
      });
    });
  });
});

test('releasing lets a second holdLease call for the same name be granted', async () => {
  // The property the fix exists for: `Shell.tsx`'s ordinary sign-in journey
  // creates a second `Store` -- and so a second `holdLease` call for
  // `'pickarr-sync'` -- in the same tab once the first `Store`'s 401 demotes
  // it to `SignIn` and the visitor signs back in. Before this fix that
  // second call queued forever, because nothing about the first lease was
  // ever releasable. `node --test`'s `navigator.locks` is per-process, which
  // for once is exactly what this needs: two sequential `holdLease` calls in
  // one process model the two sequential `Store`s in one tab precisely.
  const name = freshLeaseName();
  let firstGranted = false;
  const release = holdLease(name, () => {
    firstGranted = true;
  });
  await delay(20);
  assert.equal(firstGranted, true, 'the first holder must actually be granted before this test releases it');
  assert.equal(isLeader(), true, 'the first holder is leading while it holds the lease');

  let secondGranted = false;
  holdLease(name, () => {
    secondGranted = true;
  });
  await delay(20);
  assert.equal(secondGranted, false, 'a second holdLease call still queues while the first has not released');

  release();
  assert.equal(isLeader(), false, 'releasing clears leading synchronously -- not only once the queued holder is later granted');

  await delay(20);
  assert.equal(secondGranted, true, 'releasing the first holder lets the queued second one be granted');
});

test('releasing a still-queued holder does not clear leading claimed by a different, already-granted holder', async () => {
  // Finding 9: `release()` used to clear the module-global `leading`
  // unconditionally, even when the holder calling it was never the one that
  // set it. A lease released while still queued behind a genuine holder
  // therefore made `isLeader()` answer `false` while that other holder was
  // still actively leading -- contradicting `isLeader`'s own docblock
  // ("whether *this* tab is the one holding a lease").
  const name = freshLeaseName();
  let firstGranted = false;
  const releaseFirst = holdLease(name, () => {
    firstGranted = true;
  });
  await delay(20);
  assert.equal(firstGranted, true, 'the first holder must actually be granted before this test proceeds');
  assert.equal(isLeader(), true, 'the first holder is leading while it holds the lease');

  // A second holdLease call for the same name queues behind the first and is
  // never granted during this test's life.
  let secondGranted = false;
  const releaseSecond = holdLease(name, () => {
    secondGranted = true;
  });
  await delay(20);
  assert.equal(secondGranted, false, 'the second holder is still queued, not granted');

  releaseSecond();
  assert.equal(
    isLeader(),
    true,
    'a still-queued holder\'s release must not clear leading claimed by the still-active first holder',
  );

  releaseFirst();
  assert.equal(isLeader(), false, 'the first holder\'s own release does clear leading');
});

test('releasing a lease is idempotent, and a second call does not reach into a later holder of the same name', async () => {
  // This module has already been bitten twice by a release-style closure
  // that was not idempotent -- `onMessage`'s own shared subscriber count,
  // pinned by this file's "unsubscribing twice does not corrupt the shared
  // subscriber count" test below. This is the same shape one level up: a
  // release function must not still be "live" the second time it is called,
  // or a stale call from an old holder could give up a lease a completely
  // different, later holder now depends on.
  const name = freshLeaseName();
  const release = holdLease(name, () => {
    // Granted, then released below.
  });
  await delay(20);
  release();
  assert.doesNotThrow(() => { release(); }, 'a second release call on an already-released lease must not throw');

  let secondGranted = false;
  holdLease(name, () => {
    secondGranted = true;
  });
  await delay(20);
  assert.equal(secondGranted, true, 'the lease is free after the first holder released it');

  // The stale, already-spent release from the *first* holder must not reach
  // the *second* holder's lease.
  release();
  await delay(20);
  const thirdSeesItHeld = await navigator.locks.request(name, { ifAvailable: true }, (lock) => lock === null);
  assert.equal(thirdSeesItHeld, true, "a stale release call from an earlier holder must not release a different, later holder's lease");
});

test('releasing before the lease is even granted is honoured, not lost', async () => {
  const name = freshLeaseName();
  // Something else holds the lease first, so this test's own `holdLease`
  // call is still queued when it is released.
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const blocker = navigator.locks.request(name, { mode: 'exclusive' }, async () => {
    await blocked;
  });

  let granted = false;
  const release = holdLease(name, () => {
    granted = true;
  });
  release();

  unblock?.();
  await blocker;
  await delay(20);

  assert.equal(granted, true, 'holdLease cannot withdraw a request already made, so the callback still fires once the blocker frees the lease');
  assert.equal(isLeader(), false, 'a holder that released before its own grant must never report itself leading');

  const freeAfterwards = await navigator.locks.request(name, { ifAvailable: true }, (lock) => lock !== null);
  assert.equal(freeAfterwards, true, 'the lease is free immediately, not held by the pre-released holder');
});

test('a message broadcast reaches another channel listening on the same name', async () => {
  // Models "the other tab": a raw channel this test owns and must close
  // itself, exactly as the module's own doc explains a `BroadcastChannel`
  // needs -- `broadcast` opens and closes its own sender, so this is the
  // only channel this test is responsible for.
  const other = new BroadcastChannel(CHANNEL_NAME);
  try {
    const received = new Promise<ChannelMessage>((resolve) => {
      other.addEventListener('message', (event: MessageEvent<ChannelMessage>) => {
        resolve(event.data);
      }, { once: true });
    });

    const msg: ChannelMessage = { type: 'reset', generation: 'gen-1' };
    broadcast(msg);

    assert.deepEqual(await received, msg);
  } finally {
    other.close();
  }
});

test('onMessage receives a message posted by another channel, and stops once unsubscribed', async () => {
  const received: ChannelMessage[] = [];
  const unsubscribe = onMessage((msg) => {
    received.push(msg);
  });

  const other = new BroadcastChannel(CHANNEL_NAME);
  try {
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- that argument belongs to `Window.postMessage`; `BroadcastChannel.postMessage` has no origin to name
    other.postMessage({ type: 'reset', generation: 'gen-2' } satisfies ChannelMessage);
    await delay(10);
    assert.deepEqual(received, [{ type: 'reset', generation: 'gen-2' }]);

    unsubscribe();
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- see above
    other.postMessage({ type: 'reset', generation: 'gen-3' } satisfies ChannelMessage);
    await delay(10);
    assert.deepEqual(received, [{ type: 'reset', generation: 'gen-2' }], 'nothing further arrives once unsubscribed');
  } finally {
    other.close();
  }
});

test('a Changed round-trips through serializeChanged, a real broadcast, and deserializeChanged', async () => {
  const changed: Changed = {
    touched: new Map([['person', [1, 2]], ['media_item', [7]]]),
    inserted: new Map([['person', [2]]]),
  };

  const received = new Promise<ChannelMessage>((resolve) => {
    const unsubscribe = onMessage((msg) => {
      unsubscribe();
      resolve(msg);
    });
  });

  broadcast({ type: 'changed', changed: serializeChanged(changed) });

  const msg = await received;
  assert.equal(msg.type, 'changed');
  if (msg.type !== 'changed') throw new Error('unreachable: asserted above');

  const roundTripped = deserializeChanged(msg.changed);
  assert.deepEqual(
    Array.from(roundTripped.touched.entries()).toSorted(),
    Array.from(changed.touched.entries()).toSorted(),
  );
  assert.deepEqual(
    Array.from(roundTripped.inserted.entries()).toSorted(),
    Array.from(changed.inserted.entries()).toSorted(),
  );
});

test('serializeChanged carries table names and ids only -- no row value ever named', () => {
  const changed: Changed = {
    touched: new Map([['person', [1]]]),
    inserted: new Map(),
  };
  const serialized = serializeChanged(changed);
  assert.deepEqual(serialized, { touched: [['person', [1]]], inserted: [] });
  // The wire form round-trips through JSON with nothing beyond table names
  // and numeric ids -- a row's `value` has no field to ride along in, even
  // by accident, because `Changed` itself never carried one.
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), { touched: [['person', [1]]], inserted: [] });
});

test('a holder that throws on being granted stops claiming leadership', async () => {
  // Without this, `leading` stayed true forever while the callback had failed
  // -- so `isLeader()` contradicted its own doc comment, and in a browser
  // (which releases the lock on a synchronous throw) a second tab could take
  // the lease while this one still claimed it. Two tabs fetching is the one
  // thing the lease exists to prevent.
  const name = `throw-${String(process.hrtime.bigint())}`;
  holdLease(name, () => { throw new Error('cannot sync'); });
  // Long enough for the lock to be granted and the callback to run.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isLeader(), false, 'a failed holder does not report itself leader');

  // And the lock is free for someone else.
  const second = await navigator.locks.request(name, { ifAvailable: true }, (lock) => lock !== null);
  assert.equal(second, true, 'the lease was released rather than held by a holder that failed');
});

test('serializeChanged round-trips an empty map and an empty id list', async () => {
  // Neither edge was in the shipped suite, and both are reachable: a batch of
  // only skipped creates touches nothing, and `bucket` creates an array before
  // anything is pushed into it.
  const empty = { touched: new Map(), inserted: new Map() };
  const backEmpty = deserializeChanged(serializeChanged(empty));
  assert.equal(backEmpty.touched.size, 0);
  assert.equal(backEmpty.inserted.size, 0);

  const withEmptyList = {
    touched: new Map([['person', []]]),
    inserted: new Map<string, readonly number[]>(),
  };
  const back = deserializeChanged(serializeChanged(withEmptyList));
  assert.deepEqual(back.touched.get('person'), []);
  assert.equal(back.inserted.size, 0);
});

test('unsubscribing twice does not corrupt the shared subscriber count', async () => {
  // The bug this pins hung a whole test file with every test passing and no
  // test name attached. `subscribers` is shared by every caller, so an
  // unsubscribe that decremented on each call took it to -1 -- and the *next*
  // `onMessage` then brought it back to 0, opened a channel, and its own
  // unsubscribe saw -1 instead of 0 and never closed it. An open
  // BroadcastChannel keeps the Node process alive.
  //
  // Asserted through the observable consequence rather than by reading the
  // counter: after a double unsubscribe, a fresh subscriber must still be
  // able to receive, and its own unsubscribe must still close things down.
  const offTwice = onMessage(() => { /* ignored */ });
  offTwice();
  offTwice();

  const seen: ChannelMessage[] = [];
  const off = onMessage((msg) => { seen.push(msg); });
  const sender = new BroadcastChannel(CHANNEL_NAME);
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- see above
  sender.postMessage({ type: 'reset', generation: 'after-double-unsubscribe' } satisfies ChannelMessage);
  sender.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  off();

  assert.deepEqual(seen, [{ type: 'reset', generation: 'after-double-unsubscribe' }],
    'a subscriber registered after a double unsubscribe still receives');
});
