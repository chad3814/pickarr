import type { ActivityHost, ActivityRequest, HostFetch } from '@pickarr/contract';
import { createBoundedQueue } from '../util/bounded-queue.ts';
import type { BoundedQueue } from '../util/bounded-queue.ts';
import { redactUrl } from '../clients/redact.ts';

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
 * exempt from the per-hostname concurrency limit this module builds.
 */
export interface QueuedFetch extends HostFetch {
  text(url: string, init?: RequestInit): Promise<string>;
  /**
   * What each hostname's queue holds right now, by method and redacted
   * target -- the Activities page's view of this layer. Only hostnames with
   * something waiting or in flight appear, sorted by hostname.
   */
  snapshot(): readonly ActivityHost[];
  /** Every hostname a request has been made to since construction, in first-seen order. */
  seen(): readonly string[];
}

/**
 * What a response body may say about a request: the redacted url's origin and
 * path, so userinfo, query string and fragment are all gone. Falls back to
 * cutting the redacted string at its `?` if that string no longer parses as a
 * url (redaction can rewrite the authority). Computed once; the raw url is
 * never kept.
 */
function targetOf(url: string): string {
  const redacted = redactUrl(url);
  try {
    const parsed = new URL(redacted);
    return parsed.origin + parsed.pathname;
  } catch {
    // Not a url after redaction; fall through to the string cut.
  }
  const query = redacted.indexOf('?');
  return query === -1 ? redacted : redacted.slice(0, query);
}

/**
 * Thrown by `fetched` below for any non-2xx response, carrying the numeric
 * `status` alongside the message. Without this, telling a 401 or 403 apart
 * from any other failure meant pattern-matching this class's own message
 * text (`failed: 401 Unauthorized`) -- which breaks the moment that text is
 * reworded, and it already was once this slice, when `redactText` went in.
 * Subclassing `Error` rather than a plain object keeps every existing
 * `instanceof Error`/message-matching test passing unchanged.
 */
export class FetchFailedError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'FetchFailedError';
    this.status = status;
  }
}

/**
 * Requests are queued per hostname with a configurable number allowed to run
 * at once. The hostname is computed from the url in `json`/`bytes` and
 * passed into `enqueue`, never accepted from the caller as its own
 * parameter, so a plugin has no way to opt out of its queue -- that stays a
 * property of this function, not a habit a caller could skip. What is
 * configurable is only how many requests to that hostname may be in flight
 * together.
 *
 * Both numbers come from two resolver functions, `limitFor` and
 * `timeoutFor`, rather than from values fixed at construction; `fetch/settings.ts`
 * is where the real ones are built. `limitFor` is asked on every enqueue and
 * `timeoutFor` when a request starts, so a saved change reaches requests
 * already waiting. A plugin cannot reach either one -- it holds only
 * `HostFetch` -- so both stay properties of the host's configuration rather
 * than something a caller can opt out of.
 */
export function createHostFetch(
  deps: {
    fetch: typeof globalThis.fetch;
    /** How many requests to `hostname` may run at once. Asked on every enqueue; see `fetch/settings.ts`. */
    limitFor: (hostname: string) => number;
    /** How long one request to `hostname` may take. Asked when the request starts, not when it is enqueued. */
    timeoutFor: (hostname: string) => number;
    /** Called when a request is enqueued, starts or settles; `main.ts` wires the event hub. */
    onChange?: () => void;
  },
): QueuedFetch {
  const timeoutFor = deps.timeoutFor;

  // One `BoundedQueue` per hostname, built lazily on that hostname's first
  // request.
  interface HostState {
    queue: BoundedQueue;
    waiting: Set<ActivityRequest>;
    inFlight: Set<ActivityRequest>;
  }
  const hosts = new Map<string, HostState>();

  function hostFor(hostname: string): HostState {
    const existing = hosts.get(hostname);
    if (existing) return existing;

    const created: HostState = {
      queue: createBoundedQueue(deps.limitFor(hostname)),
      waiting: new Set(),
      inFlight: new Set(),
    };
    hosts.set(hostname, created);
    return created;
  }

  function enqueue<T>(hostname: string, task: () => Promise<T>): Promise<T> {
    const state = hostFor(hostname);
    // Re-read on every request so a saved change is in force for this
    // request's slot decision. `setLimit` with the same value is a no-op.
    state.queue.setLimit(deps.limitFor(hostname));
    return state.queue.run(task);
  }

  /**
   * One request, under its hostname's timeout, from the moment its queue
   * slot is granted through reading its body -- the body is inside the
   * window deliberately, matching 1.x, where the signal stays live across
   * `await response.text()`: a host that answers with headers and then
   * stalls the stream wedges a slot exactly as one that never answers at
   * all. `read` is called INSIDE the race for that reason, and
   * `queue.test.ts`'s stalled-body test fails if it is moved outside --
   * otherwise the race settles on the response and the body read hangs on
   * afterwards, still holding the slot and the job claim.
   *
   * **The timeout is armed inside the queued task, not before `enqueue`.**
   * It was armed before `enqueue` for one slice, so that `timeoutMs` meant
   * "how long one request may take, measured from when it was asked for",
   * deliberately including time spent waiting for a slot. That is the wrong
   * meaning for a ceiling whose number comes from the far end: the lookup
   * service's platform allows a request five minutes, so a chunk that spent
   * two of them queued behind its siblings would get three -- and fail a
   * request the service would have answered. A per-hostname ceiling is a
   * statement about that service's own behaviour, and queue position is not
   * part of it. Armed here, `timeoutMs` means how long the *request* may
   * take, which is the only thing the far end's number describes. The number
   * is read there too, so a ceiling saved while a request waited is the one
   * it runs under.
   *
   * **What bounds total wall time instead.** Not this. A caller that passes
   * no signal has no bound on `queue wait + timeoutMs`, and the depth of a
   * hostname's queue is not bounded either -- one handler may ask for as
   * many images from one CDN as it likes. The bound is the caller's own
   * signal, composed below: every plugin call originates in a job, and
   * `run-job.ts` races the handler against `JOB_TIMEOUT_MS`, passing that
   * signal down (see `openmetadata/src/client.ts`'s `signal` doc). That
   * ceiling is deliberately above the largest per-hostname timeout, so a
   * slow service fails as a timeout naming the url rather than as a job
   * killed for running long -- two very different things to read in a log.
   * A caller outside a job, passing no signal, is the one shape with no
   * total bound; there is none today.
   *
   * Two mechanisms, both load-bearing:
   *
   * - **The composed signal** cancels a real request (undici aborts the
   *   socket and errors a body already streaming), so a timed-out fetch
   *   stops costing anything. A caller's own signal is composed with the
   *   timeout rather than replaced by it, so passing one cannot silently
   *   opt out of the timeout and the timeout cannot silently discard it.
   * - **The race** is what makes this *reject* rather than hang if the
   *   `fetch` it was handed ignores the signal -- and rejecting is what
   *   lets the hostname's `BoundedQueue.run` release the slot, in its own
   *   `finally`.
   *
   * **The `callerSignal.aborted` short-circuit** is what the old
   * `timeout.aborted` one became. That one existed because a timeout armed
   * before the wait could already have expired by the time the task ran;
   * one armed inside the task never has, so that exact check is dead. The
   * case it protected against is not: a request can still spend the whole
   * wait becoming pointless, only now it is the caller's ceiling that
   * expires rather than this timeout. Without the check the task would get
   * its slot and spend a real request on an answer whose job died minutes
   * ago -- and make everything behind it wait while it did. Neither signal
   * releases a queue *position* early, here or before this change: the task
   * settles when its turn comes, and settling without a network call is the
   * whole of what either short-circuit buys.
   */
  async function fetched<T>(
    url: string,
    init: RequestInit | undefined,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const hostname = new URL(url).hostname;
    const state = hostFor(hostname);
    const record: ActivityRequest = { method: init?.method ?? 'GET', target: targetOf(url) };
    const callerSignal = init?.signal ?? undefined;
    // Aborted in the `finally` below, which is what detaches the listener:
    // otherwise every completed request would leave one attached to a
    // signal with up to `timeoutMs` still to run.
    const settled = new AbortController();
    try {
      state.waiting.add(record);
      deps.onChange?.();
      return await enqueue(hostname, () => {
        const timeoutMs = timeoutFor(hostname);
        state.waiting.delete(record);
        state.inFlight.add(record);
        deps.onChange?.();
        if (callerSignal?.aborted === true) {
          return Promise.reject(new Error(
            `fetch ${redactUrl(url)} abandoned: the caller aborted while it waited for a slot`,
          ));
        }
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
        const onTimeout = new Promise<never>((_resolve, reject) => {
          timeout.addEventListener('abort', () => {
            reject(new Error(`fetch ${redactUrl(url)} timed out after ${timeoutMs}ms`));
          }, { once: true, signal: settled.signal });
        });
        return Promise.race([
          (async () => {
            const res = await deps.fetch(url, { ...init, signal });
            if (!res.ok) {
              throw new FetchFailedError(`fetch ${redactUrl(url)} failed: ${res.status} ${res.statusText}`, res.status);
            }
            return read(res);
          })(),
          onTimeout,
        ]);
      });
    } finally {
      settled.abort();
      state.waiting.delete(record);
      state.inFlight.delete(record);
      deps.onChange?.();
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

    seen(): readonly string[] {
      return [...hosts.keys()];
    },

    snapshot(): readonly ActivityHost[] {
      return [...hosts.entries()]
        .filter(([, state]) => state.waiting.size > 0 || state.inFlight.size > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([hostname, state]) => ({
          hostname,
          limit: state.queue.limit(),
          inFlight: [...state.inFlight],
          waiting: [...state.waiting],
        }));
    },
  };
}
