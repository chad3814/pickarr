import type { ServerResponse } from 'node:http';
import type { ArtworkResponse } from './artwork-route.ts';
import type { StaticResponse } from './static-route.ts';

/**
 * What a route answers, before anything is written to a socket.
 *
 * Artwork and the static bundle are the two routes that do not answer JSON,
 * and each already returns a status/headers/body triple of its own
 * (`ArtworkResponse`, `StaticResponse`) that the routing module has no
 * business reinterpreting. Keeping routing separate from writing is what
 * lets every route be a function of its request.
 *
 * **`empty` is the fourth, and it is not `json` with an absent body.** A
 * `204` must carry no body and no `Content-Length` at all, and `server.ts`'s
 * `writeJson` composes both from `JSON.stringify(body)` -- which for
 * `undefined` answers `undefined`, so `Buffer.byteLength` would throw and a
 * successful delete would become a 500. `DELETE /api/mappings/:id` is the
 * only route that answers this kind today.
 *
 * **Pulled out of `server.ts` (issue #89), not left beside `readBody`.**
 * `./body.ts`'s fixed refusals (`PAYLOAD_TOO_LARGE`, `MALFORMED_BODY`) are
 * `Answer`s too, and giving this type its own module is what lets `body.ts`
 * build one without importing the router to get it -- and without the
 * router importing `body.ts` just to get `Answer` back.
 */
export type Answer =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'empty'; status: number }
  | { kind: 'artwork'; artwork: ArtworkResponse }
  | { kind: 'static'; file: StaticResponse }
  // A response the route keeps open: `attach` writes the headers and owns
  // the socket from then on. Only `/api/sync/events`.
  | { kind: 'stream'; attach: (response: ServerResponse) => void };

export function json(status: number, body: unknown): Answer {
  return { kind: 'json', status, body };
}
