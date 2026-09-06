import type { HostFetch } from '@pickarr/contract';
import { createBoundedQueue, isValidLimit } from '../util/bounded-queue.ts';
import type { BoundedQueue } from '../util/bounded-queue.ts';

/**
 * `createHostFetch`'s actual return shape: `HostFetch`'s two methods plus
 * `text`, for the one caller so far that needs a body neither `json` nor
 * `bytes` gives it -- the feed reader, reading XML. Not part of `HostFetch`
 * itself: widening that contract would hand every plugin a method none of
 * them use, for the sake of a caller that is not a plugin at all. A plugin
 * still only ever sees `HostFetch` through `PluginContext.fetch`; only host
 * wiring, holding the concrete value this function returns, can reach
 * `text` -- and reaching it costs nothing extra, because it runs through
 * this same instance's `enqueue`, so a feed's host shares its per-hostname
 * budget with any `json`/`bytes` call to that same host, rather than being
 * exempt from the limit Task 2 built.
 */
export interface QueuedFetch extends HostFetch {
  text(url: string, init?: RequestInit): Promise<string>;
}

/**
 * The concurrency budget `createHostFetch` enforces per hostname. `default`
 * applies to any hostname without its own entry in `perHost`; both are
 * counts of requests allowed to run at once, not a rate. Never exported from
 * `@pickarr/contract`: unlike `HostFetch`, nothing here is reachable from
 * `PluginContext` -- it is consumed only by `createHostFetch`'s
 * construction-time `deps`, a host-wide policy a plugin never sees.
 */
export interface FetchLimits {
  /** Applied to any hostname without a specific entry. */
  default: number;
  /** Keyed by exact hostname, e.g. `{ 'cdn.example.com': 10 }`. */
  perHost?: Readonly<Record<string, number>>;
}

/**
 * A limit of 0 or below is not "disable this host" -- handed to
 * `createBoundedQueue`, it would make `running >= limit` true before any
 * request to that hostname has ever run, so the very first one queues
 * behind a slot nothing will ever grant. Nothing later would observe that:
 * no error, no timeout, just a promise that never settles.
 * `createBoundedQueue` rejects a bad limit too, but only once a hostname's
 * first request builds its queue, and only by value. Checking here, at
 * `createHostFetch` construction, rejects it immediately and names which
 * config key -- `'default'` or the hostname -- is at fault, rather than
 * let a bad value surface invisibly whenever that hostname's first request
 * happens to be made.
 */
function assertValidLimit(name: string, value: number): void {
  // `isValidLimit` rather than a second copy of the comparison: the rule is
  // the queue's, and only the message is this layer's, which is what names
  // the offending config key for whoever has to fix it.
  if (!isValidLimit(value)) {
    throw new Error(`fetch limit for '${name}' must be an integer of at least 1, got ${value}`);
  }
}

function assertValidLimits(limits: FetchLimits | undefined): void {
  if (!limits) return;
  assertValidLimit('default', limits.default);
  for (const [hostname, value] of Object.entries(limits.perHost ?? {})) {
    assertValidLimit(hostname, value);
  }
}

/**
 * A timeout of 0 or below, a fraction, or `NaN` is the same class of mistake
 * `assertValidLimit` above exists for, and the same answer: refuse it at
 * construction, by name and value. Left unchecked, every one of them
 * constructs silently and then fails every single request afterwards:
 * probed directly, `0` gives a signal already aborting, so every request
 * times out instantly, while `-1`, `1.5` and `NaN` throw a `RangeError`
 * about "delay" from inside `AbortSignal.timeout` -- naming neither this
 * parameter nor this function, so the value that caused it appears nowhere
 * in the diagnosis.
 */
function assertValidTimeout(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`fetch timeoutMs must be an integer of at least 1, got ${value}`);
  }
}

/**
 * How long one request may take before it is aborted -- 1.x's own number
 * (`FETCH_TIMEOUT_MS` in `packages/core/src/feeds/fetch-feed.ts`), applied
 * here rather than at each call site so that every caller of
 * `json`/`bytes`/`text` gets it without having to remember to. Measured from
 * the call, not from the moment a hostname slot is granted, so the time spent
 * queued counts against it too -- see `fetched` below for why that is where
 * the signal is armed.
 *
 * Without it, a request that never settles is the one failure nothing above
 * this can survive: it would hold its hostname's own queue slot, and with it
 * one of the dispatcher's concurrency slots (`jobs/dispatcher.ts`), for as
 * long as the process runs. `Host.stop()` abandons an in-flight handler
 * rather than waiting on it, so a hang here no longer keeps
 * `SIGINT`/`SIGTERM` from ending the process -- it would only starve that
 * one slot of ever running anything else.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Requests are queued per hostname with a configurable number allowed to run
 * at once. The hostname is computed from the url in `json`/`bytes` and
 * passed into `enqueue`, never accepted from the caller as its own
 * parameter, so a plugin has no way to opt out of its queue -- that stays a
 * property of this function, not a habit a caller could skip. What is
 * configurable is only how many requests to that hostname may be in flight
 * together; the default is one, so every caller that never sets `limits`
 * behaves exactly as before.
 *
 * `timeoutMs` exists so a test can watch a hung request actually time out
 * without waiting the full thirty seconds; nothing in production sets it,
 * and there is no other way to reach it -- a plugin holds only `HostFetch`.
 */
export function createHostFetch(
  deps: { fetch: typeof globalThis.fetch; limits?: FetchLimits; timeoutMs?: number },
): QueuedFetch {
  assertValidLimits(deps.limits);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertValidTimeout(timeoutMs);

  // One `BoundedQueue` per hostname, built lazily on that hostname's first
  // request so a hostname never mentioned in `deps.limits` never gets an
  // entry it doesn't need.
  const queues = new Map<string, BoundedQueue>();

  function queueFor(hostname: string): BoundedQueue {
    const existing = queues.get(hostname);
    if (existing) return existing;

    const limit = deps.limits?.perHost?.[hostname] ?? deps.limits?.default ?? 1;
    const created = createBoundedQueue(limit);
    queues.set(hostname, created);
    return created;
  }

  function enqueue<T>(hostname: string, task: () => Promise<T>): Promise<T> {
    return queueFor(hostname).run(task);
  }

  /**
   * One request, under the timeout, from the moment it is asked for through
   * reading its body -- the body is inside the window deliberately, matching
   * 1.x, where the signal stays live across `await response.text()`: a host
   * that answers with headers and then stalls the stream wedges a slot
   * exactly as one that never answers at all. `read` is called INSIDE the
   * race for that reason, and `queue.test.ts`'s stalled-body test fails if it
   * is moved outside -- otherwise the race settles on the response and the
   * body read hangs on afterwards, still holding the slot and the job claim.
   *
   * **The timeout is armed here, before `enqueue`, not inside the queued
   * task.** Armed inside -- where it was until this was measured -- a
   * request's clock only started once its hostname's slot was granted, so a
   * waiter's wall clock was `its own budget + however long everyone ahead of
   * it took`. Each task ahead does release within `timeoutMs` (the race
   * below is what guarantees that), so the old bound was not unbounded; it
   * was `(queue position) x timeoutMs`, and nothing bounds the depth -- one
   * handler may ask for as many images from one CDN as it likes. At the
   * default limit of one, ten hung requests ahead of it are enough for the
   * eleventh to outlive `run-job.ts`'s five-minute job ceiling and settle
   * against a row its own timeout has already failed. Armed here, the
   * deadline is independent of
   * queue position and `timeoutMs` means what its name says: how long one
   * request may take, measured from when it was asked for.
   *
   * The cost is taken deliberately: under a burst deep enough to exhaust the
   * budget, a request that spent it waiting is rejected rather than served
   * late, and its job retries on `backoff.ts`'s curve -- the mechanism the
   * jobs subsystem already has for exactly this. The rejected alternative was
   * a second, separate budget for the wait, which bounds the same thing with
   * another constant nothing configures.
   *
   * Three mechanisms, all load-bearing:
   *
   * - **The composed signal** cancels a real request (undici aborts the
   *   socket and errors a body already streaming), so a timed-out fetch stops
   *   costing anything. A caller's own signal is composed with the timeout
   *   rather than replaced by it, so passing one cannot silently opt out of
   *   the timeout and the timeout cannot silently discard it.
   * - **The race** is what makes this *reject* rather than hang if the
   *   `fetch` it was handed ignores the signal -- and rejecting is what lets
   *   the hostname's `BoundedQueue.run` release the slot, in its own
   *   `finally`. It races `onTimeout`, whose listener was attached before the
   *   wait, so a task woken at the moment its own budget expires rejects then
   *   rather than starting a fresh window.
   * - **The `timeout.aborted` short-circuit** covers the case where the
   *   budget was spent entirely on waiting: handing back the already-rejected
   *   `onTimeout` settles the task and frees the slot without spending a real
   *   request on an answer whose caller gave up `timeoutMs` ago. It is not
   *   redundant with the race -- `addEventListener('abort')` on an
   *   already-aborted signal never fires, so a task that reached the race
   *   this late would sit on a `fetch` that may never settle.
   */
  async function fetched<T>(
    url: string,
    init: RequestInit | undefined,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const hostname = new URL(url).hostname;
    const timeout = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? undefined;
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
    // Aborted in the `finally` below, which is what detaches the listener:
    // otherwise every completed request would leave one attached to a signal
    // with up to `timeoutMs` still to run.
    const settled = new AbortController();
    const onTimeout = new Promise<never>((_resolve, reject) => {
      timeout.addEventListener('abort', () => {
        reject(new Error(`fetch ${url} timed out after ${timeoutMs}ms`));
      }, { once: true, signal: settled.signal });
    });
    try {
      return await enqueue(hostname, () => (timeout.aborted ? onTimeout : Promise.race([
        (async () => {
          const res = await deps.fetch(url, { ...init, signal });
          if (!res.ok) {
            throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
          }
          return read(res);
        })(),
        onTimeout,
      ])));
    } finally {
      settled.abort();
    }
  }

  return {
    json<T>(url: string, init?: RequestInit): Promise<T> {
      return fetched(url, init, async (res) => {
        // `Response.json()` hands back `unknown` here, not `any` -- the
        // explicit annotation is what stops that from leaking any further.
        // The `T` below is the caller's assertion about that shape, not a
        // licence for this function to cast between unrelated types.
        const body: unknown = await res.json();
        return body as T;
      });
    },

    bytes(url: string, init?: RequestInit): Promise<Uint8Array> {
      return fetched(url, init, async (res) => new Uint8Array(await res.arrayBuffer()));
    },

    text(url: string, init?: RequestInit): Promise<string> {
      return fetched(url, init, (res) => res.text());
    },
  };
}
