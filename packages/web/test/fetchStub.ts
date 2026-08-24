/**
 * Installing a `fetch` stub used to need a cast, because `typeof fetch` takes
 * `RequestInfo | URL` and every stub in this suite only ever wants the url as a
 * `string`. Under `strictFunctionTypes` the narrower handler is not *assignable*
 * to `typeof fetch`, so the assignment had to be asserted — and the form the
 * suite reached for was a double cast through `unknown`, which spells the one
 * type the project bans.
 *
 * Widening in one place removes the cast from every call site instead of
 * respelling it. A single `as typeof fetch` would also have compiled — assertion
 * uses the comparable relation, which is bivariant in parameters — but that
 * leaves 40 unchecked casts in the suite, each free to drift from the handler it
 * describes. This file asserts nothing.
 */

/**
 * What a stub is handed: the request URL as a string, and the init the caller
 * passed.
 */
export type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Widens a URL-and-init handler into a real `typeof fetch`.
 *
 * All three input shapes are unwrapped, not just `string`. `String(input)` would
 * be shorter and is what one call site used to do, but it turns a `Request` into
 * the literal `'[object Request]'`. Nothing under `packages/web/src` calls
 * `fetch` with anything but a string today, so no component test can catch that;
 * `fetchStub.test.ts` pins all three shapes so a future caller cannot start
 * silently receiving that string.
 */
export function fetchStub(handler: FetchHandler): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  };
}

/**
 * `new Response(JSON.stringify(body), …)` with the content type set — the
 * boilerplate every stub in the suite used to repeat inline.
 *
 * Generic rather than taking a `JsonValue`-shaped parameter: the call sites hand
 * it interfaces (`ConfigResponse`, `MetadataView`, …), and an interface has no
 * implicit index signature, so `ConfigResponse` is not assignable to
 * `{ [key: string]: JsonValue }` — checked, and it is a TS2345. `body: object`
 * does compile for every call site there is today, but it refuses a bare string
 * or `null`, both of which are bodies a route may legitimately answer with. An
 * unconstrained type parameter accepts all of them and writes neither banned
 * type.
 */
export function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
