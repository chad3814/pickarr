/**
 * The session-expired signal: how a write that met a 401 tells the shell to
 * send the operator back to sign-in, without waiting for the sync tail's
 * next poll to discover the same thing (issue #94).
 *
 * **A module-level registry, because the writers are not components.**
 * `sendJson` is called from plain `post*` functions that are wired into the
 * screens as module-level constants (`mappingSubmit`, `feedRemovalSubmit`,
 * ...), so there is no prop or context to thread a callback through without
 * rewiring every one of them. `Shell` subscribes for its own lifetime and is
 * the only production subscriber; nothing else may call
 * {@link notifySessionExpired} except `sendJson`, and a test only to prove
 * this module's own contract.
 *
 * {@link SESSION_EXPIRED_MESSAGE} is re-exported from here so every web
 * write path names one sentence through one import. It lives in
 * `@pickarr/plugin-ui` because the pick path's message map does, and that
 * package must not import web -- see its own doc there.
 */
export { SESSION_EXPIRED_MESSAGE } from '@pickarr/plugin-ui';

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Registers `cb` to hear every expired write. Returns the unsubscribe.
 *
 * **The unsubscribe is idempotent**, on `store/notify.ts`'s `add`: a second
 * call is a no-op rather than a second `delete`. With a `Set` keyed on the
 * function a repeat delete of the *same* function would be harmless -- until
 * the same function is subscribed again, when a stale closure's second call
 * would silently detach the live registration. The flag closes that.
 */
export function subscribeSessionExpired(cb: Listener): () => void {
  // A wrapper per registration, so one function subscribed twice is two
  // registrations and each unsubscribe removes only its own.
  const entry: Listener = () => {
    cb();
  };
  listeners.add(entry);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    listeners.delete(entry);
  };
}

/**
 * Tells every subscriber a write met a 401. A subscriber that throws does
 * not stop the rest, and nothing escapes to the caller: `sendJson` never
 * throws, and a listener's bug must not become the write's.
 */
export function notifySessionExpired(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      console.error('pickarr: a session-expired subscriber threw', err);
    }
  }
}
