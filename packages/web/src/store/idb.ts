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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

/** Resolves when `tx` commits; rejects if it aborts or errors. */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
  });
}
