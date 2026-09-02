import type { HostFetch } from '@pickarr/contract';

/** The default `release` a slot starts with, before its gate promise's executor assigns the real resolver. */
const noop = (): void => {};

/**
 * One active request per hostname; everything else to that hostname queues
 * behind it. The hostname is derived from the url inside `enqueue`, so a
 * plugin has no way to opt out of the serialisation — it is a property of
 * this queue, not a habit a caller could skip.
 *
 * `tails` holds, per hostname, a promise that resolves once the slot is
 * free for the next request. It is deliberately a *gate*, not the previous
 * request's own result: a gate always settles, so a request that rejects
 * still lets the next one in. A request's actual outcome is carried by the
 * promise `enqueue` returns to its caller, never by the gate.
 */
export function createHostFetch(deps: { fetch: typeof globalThis.fetch }): HostFetch {
  const tails = new Map<string, Promise<unknown>>();

  function enqueue<T>(hostname: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(hostname) ?? Promise.resolve();

    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    tails.set(hostname, gate);

    return previous.then(async () => {
      try {
        return await task();
      } finally {
        // Runs whether `task` resolved or rejected. Drop this and a
        // rejected request never releases its hostname's gate, so every
        // later request to that hostname waits on a promise that can never
        // settle -- the queue is wedged forever, silently.
        release();
      }
    });
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
  };
}
