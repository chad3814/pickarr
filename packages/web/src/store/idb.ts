/**
 * Promise wrappers for IndexedDB's event-emitter API.
 *
 * Four functions, and nothing else in this package may wrap a request: a
 * second wrapper is where one caller starts forgetting that a rejected
 * transaction still has to be observed, and IndexedDB reports an abort on the
 * transaction rather than on the request that caused it.
 */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener('success', () => resolve(req.result), { once: true });
    req.addEventListener(
      'error',
      () => reject(req.error ?? new Error('indexeddb request failed')),
      { once: true },
    );
  });
}

/**
 * Resolves when `tx` commits; rejects if it aborts or errors.
 *
 * `addEventListener` rather than the `on*` properties throughout this module,
 * and not only because the linter asks: an assignment silently replaces
 * whatever was registered before it, so a caller that wrapped a transaction
 * twice would see the first wrapper's promise never settle. `{ once: true }`
 * also drops each listener after it fires, which matters for `abort` and
 * `error` on a transaction that reports both.
 */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve(), { once: true });
    tx.addEventListener(
      'abort',
      () => reject(tx.error ?? new Error('indexeddb transaction aborted')),
      { once: true },
    );
    tx.addEventListener(
      'error',
      () => reject(tx.error ?? new Error('indexeddb transaction failed')),
      { once: true },
    );
  });
}
