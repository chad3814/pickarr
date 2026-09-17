/**
 * The client's whole relationship with Better Auth: three calls against the
 * routes `packages/host/src/api/server.ts` mounts at `/api/auth` ahead of the
 * session guard, and the one predicate that tells a caller it needs to show
 * `SignIn` again.
 *
 * **Global Constraint, and it shapes every function here:** the client never
 * reads, stores or forwards a session token. `credentials: 'same-origin'`
 * puts the cookie on every request; the browser's own jar is what carries it
 * back, and nothing in this module ever names the cookie, reads `Set-Cookie`,
 * or copies it anywhere. Each function hands its caller the raw `Response`
 * it got from `fetch` and never calls `.json()` or `.text()` on it itself --
 * a refusal's body is the likeliest place for a server-authored string to
 * leak into the DOM or a log, and the way to guarantee it never does here is
 * to never read it here. `SignIn.tsx` decides what a caller sees, in its own
 * words.
 */

/**
 * Where Better Auth is mounted, spelled exactly as `packages/host/src/api/server.ts`'s
 * `AUTH_BASE` does -- verified against that source rather than assumed, since
 * a mismatch here would 404 against a route that exists.
 */
const AUTH_BASE = '/api/auth';

/**
 * `POST`s one Better Auth route with a JSON body, `credentials: 'same-origin'`
 * so the request carries whatever session cookie the browser already holds
 * (and receives whatever `Set-Cookie` the route answers with, entirely inside
 * the browser's own jar -- this function never touches it). `body` is
 * optional because `signOut`'s route needs none; sending an empty JSON body
 * with a `content-type` header the endpoint would then try to parse is worse
 * than sending neither.
 */
function postAuth(path: string, body?: Record<string, string>): Promise<Response> {
  const init: RequestInit = { method: 'POST', credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetch(`${AUTH_BASE}${path}`, init);
}

/**
 * Signs in with a password. Resolves to the raw `Response` -- 200 on
 * success, 401 with Better Auth's own error code on a wrong password -- for
 * the caller to inspect by status only (see this module's header comment).
 */
export function signIn(email: string, password: string): Promise<Response> {
  return postAuth('/sign-in/email', { email, password });
}

/**
 * Claims the install. `SIGN_UP_PATH` and `CLAIM_TOKEN_FIELD` in
 * `packages/host/src/auth/instance.ts` fix both the route and the body field
 * the claim token has to arrive under.
 *
 * **`name` is a field this module invents, not one the form collects.**
 * Better Auth's `sign-up/email` schema requires a `name: z.string()` with no
 * default (verified against the installed package's
 * `api/routes/sign-up.mjs`), and Pickarr's claim flow has no product use for
 * a display name -- there is exactly one account this install will ever
 * have. The email is already a value the caller typed and unique by
 * construction, so it stands in rather than a literal placeholder string
 * that would be identical across every install.
 */
export function signUp(email: string, password: string, claimToken: string): Promise<Response> {
  return postAuth('/sign-up/email', { email, password, name: email, claimToken });
}

/**
 * Ends the session. The route's own body schema is fully optional (verified
 * against `api/routes/sign-out.mjs`), so this sends none.
 *
 * Ending the session here is only half of sign-out -- the shell (task 6) also
 * has to stop the store, or it retries a 401 on the backoff ladder against a
 * session that is never coming back. That half belongs to the caller, which
 * is why this function does only the one thing its name says.
 */
export function signOut(): Promise<Response> {
  return postAuth('/sign-out');
}

/**
 * Whether a response is the guard's fixed 401 (`packages/host/src/api/server.ts`'s
 * `UNAUTHORIZED`) -- the ordinary way, per the design spec's §4, that this
 * client discovers it needs to show `SignIn` again: any read can answer it,
 * not just the three calls above.
 *
 * Typed structurally on `status` alone, rather than on `Response`, so a
 * caller can hand it either a real `fetch` `Response` or `store/sync.ts`'s
 * `SyncResponse` -- both satisfy it, and this module has no reason to import
 * either concrete type to ask one question of either.
 */
export function isUnauthenticated(res: { readonly status: number }): boolean {
  return res.status === 401;
}
