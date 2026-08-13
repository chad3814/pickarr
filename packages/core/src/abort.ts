/**
 * Turns a signal's eventual `abort` into a promise rejection, so that any
 * number of awaits can be bounded by one deadline.
 *
 * This exists because passing `init.signal` is not on its own enough here.
 * `fetchImpl` is an injected dependency rather than necessarily the real
 * `fetch`, so a test double — or any other wrapper — may never look at the
 * signal at all; and even a real `fetch`'s body reader is a separate object
 * from the request promise, with its own reads to bound. Racing every step
 * against this one promise bounds the whole operation regardless of what the
 * pieces underneath honour. The signal is still passed to `fetch`, because
 * that is what actually aborts the socket; this only guarantees the caller
 * stops waiting.
 *
 * `signal.reason` is what a rejection carries, so an `AbortSignal.timeout`
 * surfaces as its own `TimeoutError` rather than something this function
 * invents.
 */
export function abortRejection(signal: AbortSignal): Promise<never> {
  const rejection = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
  // There can be real async work between creating this promise and racing it —
  // a `mkdir` and the fetch itself, at one call site — so it can reject before
  // anything has raced it yet, and Node reports that as an unhandled rejection
  // even though the `Promise.race` a tick later would have handled it.
  // Attaching a no-op handler marks `rejection` as handled for that
  // bookkeeping only: it is the same promise, with the same eventual value,
  // that every race actually runs against.
  rejection.catch(() => undefined);
  return rejection;
}
