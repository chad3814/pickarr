import type { HostFetch } from '@pickarr/contract';

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
 * A hostname's concurrency budget: `running` counts requests currently
 * inside `task()`, capped at `limit`; `waiting` holds a resolver per
 * request that arrived once the cap was already hit, in arrival order.
 */
interface HostQueue {
  running: number;
  limit: number;
  waiting: Array<() => void>;
}

/**
 * A limit of 0 or below is not "disable this host" -- it is `q.running >=
 * q.limit` (e.g. `0 >= 0`) true before any request has ever run, so the
 * very first request queues behind a slot nothing will ever grant. Nothing
 * later would observe that: no error, no timeout, just a promise that never
 * settles. Reject it here, at construction, loudly and by name, rather than
 * clamp it -- clamping would silently substitute behaviour nobody asked for,
 * and rather than let it surface invisibly whenever the first request to
 * that hostname happens to be made.
 */
function assertValidLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
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
 * Requests are queued per hostname with a configurable number allowed to run
 * at once. The hostname is computed from the url in `json`/`bytes` and
 * passed into `enqueue`, never accepted from the caller as its own
 * parameter, so a plugin has no way to opt out of its queue -- that stays a
 * property of this function, not a habit a caller could skip. What is
 * configurable is only how many requests to that hostname may be in flight
 * together; the default is one, so every caller that never sets `limits`
 * behaves exactly as before.
 */
export function createHostFetch(deps: { fetch: typeof globalThis.fetch; limits?: FetchLimits }): QueuedFetch {
  assertValidLimits(deps.limits);

  const queues = new Map<string, HostQueue>();

  function queueFor(hostname: string): HostQueue {
    const existing = queues.get(hostname);
    if (existing) return existing;

    const limit = deps.limits?.perHost?.[hostname] ?? deps.limits?.default ?? 1;
    const created: HostQueue = { running: 0, limit, waiting: [] };
    queues.set(hostname, created);
    return created;
  }

  async function enqueue<T>(hostname: string, task: () => Promise<T>): Promise<T> {
    const q = queueFor(hostname);
    if (q.running >= q.limit) {
      await new Promise<void>((resolve) => { q.waiting.push(resolve); });
    }
    q.running += 1;
    try {
      return await task();
    } finally {
      // Runs whether `task` resolved or rejected. Drop either half of this
      // and a rejected request leaves its slot permanently occupied: every
      // later request to that hostname either queues past the real limit
      // (skip the decrement) or waits on a wake that never comes (skip the
      // shift) -- the queue is wedged forever, silently.
      q.running -= 1;
      q.waiting.shift()?.();
    }
  }

  async function request(url: string, init: RequestInit | undefined): Promise<Response> {
    const res = await deps.fetch(url, init);
    if (!res.ok) {
      throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res;
  }

  return {
    json<T>(url: string, init?: RequestInit): Promise<T> {
      const hostname = new URL(url).hostname;
      return enqueue(hostname, async () => {
        const res = await request(url, init);
        // `Response.json()` hands back `unknown` here, not `any` -- the
        // explicit annotation is what stops that from leaking any further.
        // The `T` below is the caller's assertion about that shape, not a
        // licence for this function to cast between unrelated types.
        const body: unknown = await res.json();
        return body as T;
      });
    },

    bytes(url: string, init?: RequestInit): Promise<Uint8Array> {
      const hostname = new URL(url).hostname;
      return enqueue(hostname, async () => {
        const res = await request(url, init);
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
      });
    },

    text(url: string, init?: RequestInit): Promise<string> {
      const hostname = new URL(url).hostname;
      return enqueue(hostname, async () => {
        const res = await request(url, init);
        return res.text();
      });
    },
  };
}
