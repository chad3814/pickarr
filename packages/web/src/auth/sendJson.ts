/**
 * The one `fetch` every write path in the client makes (issue #94).
 *
 * Ten write functions, across seven files, used to each hold their own copy
 * of the same `try { fetch; response.json() } catch { offline }` block,
 * inherited on purpose because two earlier fix rounds learned that such a
 * helper must never throw. The copies carried a defect along with the lesson: none of
 * them looked at a 401, so an expired session -- whose body is `{ error }`
 * with no `refusal` key -- fell into each path's `unrecognised` catch-all
 * and told the operator the host "may be a different version". This module
 * is where that is decided once.
 *
 * **Never throws.** It resolves to one of three things:
 *
 * - `offline` -- `fetch` rejected (or threw), or the body could not be read
 *   as JSON. The second is the argument `AddDownloadClient.tsx`'s
 *   `postDownloadClient` makes at length: every answer `api/server.ts` can
 *   produce under `/api` is JSON, so unparseable bytes came from something
 *   in front of Pickarr and the request did not reach the host. This is
 *   exactly what eight of the ten did with an unreadable body before they
 *   called this; `postFeedRemoval.ts`'s two answered their own `unexpected`
 *   there and now answer `unreachable` like the rest.
 * - `expired` -- the host answered 401 (`session.ts`'s
 *   {@link isUnauthenticated}). Decided on the status, before the body is
 *   read, because the guard's 401 is the one answer whose meaning is its
 *   status: it carries no `refusal` and never will. The session-expired
 *   signal fires once, so `Shell` returns the app to sign-in immediately.
 * - `answered` -- any other status, with its parsed body for the caller's
 *   own refusal parsing. A 204 carries no body by definition, so it is
 *   answered with `body: undefined` rather than read and reported offline;
 *   `postMapping.ts`'s `deleteMapping` is the caller that needs this.
 *
 * `credentials: 'same-origin'` puts whatever session cookie the browser
 * already holds on the request; nothing here reads, stores or forwards the
 * token itself (Global Constraint). Nothing here logs, and the `catch`
 * inspects no error: a `TypeError` from a rejected `fetch` names the url.
 */
import { isUnauthenticated } from './session.ts';
import { notifySessionExpired } from './sessionExpired.ts';

export type SendJsonResult =
  | { readonly outcome: 'offline' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'answered'; readonly status: number; readonly body: unknown };

export interface SendJsonInit {
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Serialised with `JSON.stringify` and sent with a JSON content type. Omitted: no body and no content type. */
  readonly body?: unknown;
}

/** Sends one write. See this file's docblock; in particular, this never throws. */
export async function sendJson(url: string, init: SendJsonInit): Promise<SendJsonResult> {
  const request: RequestInit = { method: init.method, credentials: 'same-origin' };
  if (init.body !== undefined) {
    request.headers = { 'content-type': 'application/json' };
    request.body = JSON.stringify(init.body);
  }

  let response: Response;
  try {
    response = await fetch(url, request);
  } catch {
    return { outcome: 'offline' };
  }

  if (isUnauthenticated(response)) {
    notifySessionExpired();
    return { outcome: 'expired' };
  }
  if (response.status === 204) return { outcome: 'answered', status: 204, body: undefined };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { outcome: 'offline' };
  }
  return { outcome: 'answered', status: response.status, body };
}
