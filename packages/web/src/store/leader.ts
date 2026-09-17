/**
 * Leader election over Web Locks, and the `BroadcastChannel` that carries
 * what changed to every tab that is not the leader (design spec §5, §6).
 *
 * Two unrelated mechanisms share this file because they share a caller:
 * task 6's sync loop holds the lease to decide *whether* it fetches, and
 * reads/sends the channel to learn or announce *what* changed regardless of
 * which tab it is. Neither depends on the other's state -- a follower calls
 * `onMessage` without ever holding the lease, and `holdLease` never touches
 * the channel.
 *
 * **`holdLease` releases on request, and used not to.** This module's own
 * doc used to say the lease is held "for its lifetime" (spec §5) and that
 * costs nothing to leave unreleasable, on the theory that a browser tears
 * the lock down when the tab does and nothing else ever needs to end it.
 * That theory assumed exactly one `Store` per tab, for the tab's whole life
 * -- `store/index.ts`'s own doc names the assumption. It does not hold:
 * `Shell.tsx`'s ordinary sign-in journey (mount, 401, demote to `SignIn`,
 * sign back in, mount a *second* `Store` in the same tab) and its ordinary
 * sign-out journey (stop one `Store`, later mount another) both create a
 * second lease request in one tab while the first is still queued or still
 * held, and an unreleasable lease left that second request permanently
 * behind the first -- every count stuck at zero for the rest of the tab's
 * life, caught by `packages/e2e/tests/shell.spec.ts`. `holdLease` now
 * returns a function that settles the same `release` promise `onGranted` is
 * handed, so a caller that is done leading (`sync.ts`'s `stop()`) can say so
 * without needing the tab itself to close.
 *
 * **A `BroadcastChannel` keeps whatever process holds it alive until it is
 * closed** (measured: an open one with no listeners left a Node process
 * running past its own last line, killed only by an external signal).
 * `broadcast` and `onMessage` are written so every channel this module
 * opens is closed by the same call that stops needing it -- see each for
 * how. `holdLease` opens none, so it has no matching close of that kind to
 * worry about; releasing the lease is a different question, answered above.
 */
import type { Changed } from './apply.ts';

/**
 * The one channel name `broadcast` and `onMessage` share. Not a parameter of
 * either, unlike `holdLease`'s lease `name`: every tab needs to agree on
 * exactly one channel to hear a reset or a change on, where a lease name is
 * whatever the caller wants it keyed by (and, in this module's own tests,
 * different per test so one test's lease cannot queue behind another's).
 */
export const CHANNEL_NAME = 'pickarr-sync';

/**
 * `Changed`'s wire shape (`store/apply.ts`), for `{ type: 'changed' }`
 * messages.
 *
 * `Changed` keys `touched` and `inserted` with `ReadonlyMap<string,
 * readonly number[]>`. A `Map` is on the HTML structured-clone algorithm's
 * list of supported types, and measured here (Node 26) it does cross a
 * `BroadcastChannel` as a real `Map` on the other side -- but this task's
 * brief records that it does not survive as one in every engine a Pickarr
 * client might run in, and this module ships to whichever engine that is,
 * not just the one running its own tests. An array of `[table, ids]` pairs
 * is supported wherever structured clone is supported at all, which is why
 * `serializeChanged` produces one instead of handing `postMessage` the `Map`
 * itself.
 */
export type SerializedBucket = ReadonlyArray<readonly [string, readonly number[]]>;

export interface SerializedChanged {
  touched: SerializedBucket;
  inserted: SerializedBucket;
}

/** `Changed` -> its wire shape. See {@link SerializedChanged} for why. */
export function serializeChanged(changed: Changed): SerializedChanged {
  return {
    touched: Array.from(changed.touched.entries()),
    inserted: Array.from(changed.inserted.entries()),
  };
}

/** The inverse of {@link serializeChanged}. */
export function deserializeChanged(serialized: SerializedChanged): Changed {
  return {
    touched: new Map<string, readonly number[]>(serialized.touched),
    inserted: new Map<string, readonly number[]>(serialized.inserted),
  };
}

/**
 * Everything one tab tells the others across {@link CHANNEL_NAME}.
 *
 * Carries table names and ids only, on both branches -- never a row's
 * `value` (Global Constraints: no row contents in a message). `changed`
 * already satisfies this by construction (`Changed`'s own shape), and
 * `reset` has nothing to carry beyond the generation it minted (spec §6).
 */
export type ChannelMessage =
  | { type: 'changed'; changed: SerializedChanged }
  | { type: 'reset'; generation: string };

/**
 * Whether *this* tab is the one holding a lease it requested through
 * {@link holdLease}.
 *
 * A single flag, not one per lease name, because Pickarr only ever holds
 * one lease per tab in production (spec §5's `'pickarr-sync'`); this
 * module's own tests use distinct names purely so one test's lease cannot
 * queue behind another's, not to model one tab wanting two leases at once.
 *
 * Reset to `false` in two places: when the callback handed the lease throws,
 * and when the release function {@link holdLease} returns is called. Both
 * are "this tab is no longer leading" -- a holder that could not start was
 * never leading, and a holder that gave the lease up on purpose stops being
 * one -- and saying otherwise in either case let a second tab take the lease
 * while this one still claimed it. This paragraph said "reset in exactly one
 * place" until the second one was added, to close exactly that gap for a
 * voluntary release.
 */
let leading = false;

export function isLeader(): boolean {
  return leading;
}

/**
 * Requests the exclusive Web Lock named `name`, and calls `onGranted` once
 * this tab holds it -- design spec §5: one tab fetches, and holding this
 * lock is what decides which one. Returns a function the caller can call to
 * give the lease up voluntarily.
 *
 * Requested with no `ifAvailable`: a caller behind the current holder
 * queues rather than being told no, because a follower has nothing more
 * useful to do with "not now" than wait for exactly this callback anyway.
 * Two `holdLease` calls for the same `name` model two tabs correctly for
 * that reason -- Node's `navigator.locks` is per-process rather than
 * per-origin (this task's brief), so both calls queue on the one lock
 * manager the process has, exactly as two tabs would on the one their
 * shared origin has.
 *
 * `release`, the promise handed to `onGranted`, settles exactly when the
 * returned function is called, and not otherwise -- a browser also tears
 * the lock down when the tab itself is torn down, but nothing in this module
 * needs to run at that moment, since there is nothing left to notify. Before
 * this function returned a way to call that promise's resolver directly, the
 * comment here said the promise "never settles" and called that fact a
 * feature: spec §5 holds the lease "for its lifetime", and a lease released
 * only by the tab closing costs nothing to leave that way. That reasoning
 * assumed one `Store` per tab, forever (`store/index.ts`'s own doc names the
 * assumption); this module's own doc above explains why it does not hold and
 * points at the spec that caught it.
 *
 * The returned function is idempotent: a second call, or a call after the
 * lease was already given up some other way (the callback threw), does
 * nothing. This module has already been bitten twice by a release-style
 * closure that was not -- `onMessage`'s own doc tells that story for a
 * shared subscriber count -- so the guard here is a `released` flag checked
 * before anything else runs, the same shape.
 *
 * A caller that releases before this tab's request has even been granted is
 * honoured, not ignored: the lease is still requested and still eventually
 * granted (this module has no way to withdraw a `navigator.locks.request`
 * once made), but the `release` promise `onGranted` receives is already
 * resolved, so a caller reading `mayFetch()`-style state off it after that
 * point sees "not leading" immediately rather than after a further release
 * call nobody would think to make twice.
 */
export function holdLease(name: string, onGranted: (release: Promise<void>) => void): () => void {
  let resolveRelease: (() => void) | undefined;
  let released = false;
  // Whether *this* holder is the one that set `leading = true` -- distinct
  // from `released`, which only says whether this holder has given up its
  // own claim. Guards the returned `release` function below: without it, a
  // holder still queued behind another one's genuine grant could clear
  // `leading` out from under that other holder purely by being released
  // first, making `isLeader()` answer `false` while a holder that actually
  // leads still holds the lock -- contradicting `isLeader`'s own docblock.
  // Set alongside `leading` in the callback below, never independently.
  let grantedHere = false;

  navigator.locks
    .request(name, { mode: 'exclusive' }, () => {
      // Not unconditionally `true`: the returned function may already have
      // been called while this request was still queued (see this
      // function's own doc), and a holder that gave the lease up before it
      // ever led must not report itself leading now that the grant has
      // finally arrived.
      leading = !released;
      grantedHere = !released;
      const release = new Promise<void>((resolve) => {
        resolveRelease = resolve;
        if (released) resolve();
      });
      try {
        onGranted(release);
      } catch (err) {
        // A caller that throws on being handed the lease cannot sync, so
        // holding the lock would keep every other tab from trying. Clearing
        // the flag and returning releases it, which is the only outcome that
        // leaves the module honest: without this, `leading` stayed `true`
        // forever while the callback had failed, so `isLeader()` contradicted
        // its own doc comment and -- in a browser, which releases the lock on
        // a synchronous throw -- a second tab could take the lease while this
        // one still claimed to hold it. Two tabs fetching is the one thing the
        // lease exists to prevent.
        leading = false;
        released = true;
        console.error('pickarr: the lease holder threw on being granted', name, err);
        return;
      }
      return release;
    })
    .catch((err: unknown) => {
      // A rejection here means the browser refused or aborted the request
      // itself (e.g. an invalid `name`), not that leadership was lost --
      // `release` above only ever resolves, never rejects. Reported rather
      // than thrown into nothing, matching `store/notify.ts`'s subscriber
      // errors: one failed lease request is not a reason the rest of the
      // module goes silent.
      console.error('pickarr: requesting lease', name, 'failed', err);
    });

  return function release(): void {
    if (released) return;
    released = true;
    // Only this holder's own grant may clear the module-global flag -- a
    // release fired while still queued (`grantedHere` still `false`) has
    // nothing of its own to give up, and must not clear a different,
    // already-granted holder's `leading = true` out from under it.
    if (grantedHere) leading = false;
    resolveRelease?.();
  };
}

let channel: BroadcastChannel | undefined;
let subscribers = 0;

function sharedChannel(): BroadcastChannel {
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/**
 * Sends `msg` to every channel listening on {@link CHANNEL_NAME} **including
 * the ones in this tab**, and that last part is the trap.
 *
 * A `BroadcastChannel` does not deliver a channel object's own posts back to
 * *that object* (measured), which is why proving delivery needs a second
 * channel standing in for "the other tab". But this function opens a channel
 * of its own per call, so {@link onMessage}'s shared channel -- in this very
 * tab -- is a different object and does receive every post. Measured both
 * ways: a channel posting to itself receives nothing, and a second channel in
 * the same process receives everything.
 *
 * An earlier version of this comment said "never this one", and a consumer
 * that believed it woke every subscriber twice and announced every reset
 * twice. A tab that both broadcasts and listens has to drop its own messages
 * itself; `store/sync.ts` does that by ignoring anything that arrives while
 * it holds the lease.
 *
 * Opens a fresh channel, posts, and closes it in the same call rather than
 * reusing {@link onMessage}'s shared one: delivery to other channels does
 * not depend on the sender staying open afterwards (measured), so closing
 * immediately costs nothing, and a tab that only ever broadcasts -- the
 * ordinary case, since only the leader does (spec §5, §6) -- never leaves a
 * channel open for this module to have to remember later.
 */
export function broadcast(msg: ChannelMessage): void {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- that argument belongs to `Window.postMessage`; `BroadcastChannel.postMessage` takes one argument and has no origin to name
  ch.postMessage(msg);
  ch.close();
}

/**
 * Calls `cb` with every message this tab receives on {@link CHANNEL_NAME},
 * until the returned function is called.
 *
 * The channel behind this is opened on the first subscriber and closed on
 * the last -- the same trade `store/notify.ts`'s registries make, deleting
 * their own empty `Set` rather than leaving it behind, extended here to a
 * resource that (unlike a `Set`) costs something to leave open: see this
 * file's own doc comment for what a channel nobody closes does to whatever
 * process holds it.
 */
export function onMessage(cb: (msg: ChannelMessage) => void): () => void {
  const ch = sharedChannel();
  subscribers += 1;
  const listener = (event: MessageEvent<ChannelMessage>): void => {
    try {
      cb(event.data);
    } catch (err) {
      // One subscriber's bug is not a reason the others stop hearing
      // changes -- same reasoning as `store/notify.ts`'s subscriber errors.
      console.error('pickarr: a leader.ts message subscriber threw', err);
    }
  };
  ch.addEventListener('message', listener);
  let unsubscribed = false;
  return () => {
    // **Idempotent, and that is load-bearing rather than tidy.** The count
    // below is shared by every subscriber, so a closure that decremented on
    // each call would take it negative the second time -- and then the *next*
    // `onMessage` brings it back to 0, opens a channel, and its own
    // unsubscribe finds `subscribers === -1` instead of `0` and never closes
    // it. An open `BroadcastChannel` keeps the Node process alive, so the
    // symptom is a test file that passes every test and never exits, with no
    // test name attached.
    //
    // Measured exactly that way: `sync.test.ts`'s "stop cancels both loops"
    // calls `handle.stop()` twice to assert a second stop is harmless, and
    // with an unguarded closure it was the opposite -- the file hung as soon
    // as any later test started sync. The test asserting the property was the
    // thing violating it.
    if (unsubscribed) return;
    unsubscribed = true;
    ch.removeEventListener('message', listener);
    subscribers -= 1;
    if (subscribers === 0) {
      ch.close();
      channel = undefined;
    }
  };
}
