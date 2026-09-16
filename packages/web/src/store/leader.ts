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
 * **A `BroadcastChannel` keeps whatever process holds it alive until it is
 * closed** (measured: an open one with no listeners left a Node process
 * running past its own last line, killed only by an external signal).
 * `broadcast` and `onMessage` are written so every channel this module
 * opens is closed by the same call that stops needing it -- see each for
 * how. `holdLease` opens none, and needs no matching close: measured, a
 * `navigator.locks.request` whose callback's promise never settles does not
 * keep a process alive the way an open channel does, so the lease this
 * module holds "for its lifetime" (spec §5) costs nothing to leave that way.
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
 * Reset to `false` in exactly one place, and only there: when the callback
 * handed the lease throws. `holdLease` otherwise never releases (see its own
 * doc), so there is no moment after a *successful* grant at which it is
 * honest to say this tab is no longer leading -- but a holder that could not
 * start is not leading, and saying otherwise let a second tab take the lease
 * while this one still claimed it. This paragraph said "never reset" until
 * that fix landed beneath it.
 */
let leading = false;

export function isLeader(): boolean {
  return leading;
}

/**
 * Requests the exclusive Web Lock named `name`, and calls `onGranted` once
 * this tab holds it -- design spec §5: one tab fetches, and holding this
 * lock is what decides which one.
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
 * `release`, the promise handed to `onGranted`, never settles. Spec §5 holds
 * the lease "for its lifetime": a browser tears the lock down when the tab
 * itself is torn down, and no line of this module ever runs at that moment
 * to resolve anything, in production or in this suite. It exists so a
 * caller that wants a hook for "notice if I am ever no longer leader" --
 * task 6's sync loop, stopping its timers -- has one to attach `.then()`
 * to; this module's own tests prove it *stays* pending for as long as the
 * lease is held, not that it eventually settles, because it does not.
 */
export function holdLease(name: string, onGranted: (release: Promise<void>) => void): void {
  navigator.locks
    .request(name, { mode: 'exclusive' }, () => {
      leading = true;
      const release = new Promise<void>(() => {
        // Never settles -- see this function's doc comment.
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
        console.error('pickarr: the lease holder threw on being granted', name, err);
        return;
      }
      return release;
    })
    .catch((err: unknown) => {
      // A rejection here means the browser refused or aborted the request
      // itself (e.g. an invalid `name`), not that leadership was lost --
      // `release` above never rejects, only never settling. Reported rather
      // than thrown into nothing, matching `store/notify.ts`'s subscriber
      // errors: one failed lease request is not a reason the rest of the
      // module goes silent.
      console.error('pickarr: requesting lease', name, 'failed', err);
    });
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
