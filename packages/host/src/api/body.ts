import type { IncomingMessage } from 'node:http';
import { json } from './answer.ts';
import type { Answer } from './answer.ts';

/**
 * The capped, json-parsing body reader `server.ts`'s `handle` calls for
 * every method but `GET`, plus the two fixed refusals it answers with.
 *
 * Split out of `server.ts` (issue #89): a capped stream reader is not
 * routing, and this is the one place that decides how much a client may
 * send and how long it may take to send it.
 */

/** Enough for a feed; small enough that an unbounded client cannot make the host buy memory. */
export const MAX_BODY_BYTES = 16 * 1024;

/** The fixed 413 an oversized body is refused with -- fixed for the same reason `UNKNOWN_ROUTE` is: nothing of the body it refused is ever worth repeating. */
export const PAYLOAD_TOO_LARGE = json(413, { error: 'payload too large' });

/**
 * The fixed 400 a body that is not valid json is refused with.
 *
 * **`refusal`, and no `error` beside it.** This and `invalid-shape` are the
 * only two answers this API gives that share a status, so before this they
 * were told apart by an english string and by nothing else -- which is the
 * one thing the constraint on refusal codes forbids. They now carry the same
 * single-field shape the `409` and `422` refusals already carried, so a
 * client branches on `refusal` for every answer `POST /api/feeds` refuses a
 * *body* with, rather than on `refusal` sometimes and prose the rest of the
 * time. The prose is gone rather than kept alongside: a body carrying both
 * is a body a client can still be tempted to read the wrong half of.
 */
export const MALFORMED_BODY = json(400, { refusal: 'malformed-body' });

/**
 * Reads `request`'s body for anything but a `GET` -- `handle` never calls
 * this for one -- capped at `MAX_BODY_BYTES` and refused with 413 the
 * moment the running total exceeds it, **before** the bytes collected so far
 * are parsed or handed anywhere. Refused with 400 if what was collected does
 * not parse as json.
 *
 * Listened for with `'data'`/`'end'` rather than `for await`: `IncomingMessage`
 * (`node:http`'s own typings) declares its async iterator `AsyncIterator<any>`,
 * with no way to say the chunks are `Buffer`s short of asserting it -- and an
 * assertion here would be exactly the cast the brief this module was written
 * against refuses. The listener below types its own callback `(chunk:
 * Buffer)`, which needs no assertion: it is a stricter parameter than the
 * listener signature promises, which every `EventEmitter#on` overload in
 * `@types/node` already allows.
 *
 * The over-cap branch does **not** call `request.destroy()`: destroying the
 * request stream before the client has finished sending tears down the
 * shared socket underneath the response this function's caller still has to
 * write -- measured, as a `fetch` `SocketError` on the 413 this was meant to
 * deliver. `settled` guarding the `'data'` handler is what stands in for it:
 * bytes past the cap are still drained (so the stream still reaches `'end'`
 * and the connection can be reused) but never pushed onto `chunks`, so
 * nothing over the cap is held in memory either way.
 */
export function readBody(request: IncomingMessage): Promise<{ body: unknown } | { refusal: Answer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: { body: unknown } | { refusal: Answer }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        finish({ refusal: PAYLOAD_TOO_LARGE });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      // **No body at all is not a malformed one**, and telling the two
      // apart is what makes `DELETE /api/mappings/:id` answerable.
      // `JSON.parse('')` throws, so before this line every bodiless
      // non-`GET` request was refused `400 malformed-body` *here*, ahead of
      // the router -- and a `DELETE` carries no body, which is exactly what
      // `fetch(url, { method: 'DELETE' })` sends. The per-route `methods`
      // entry could not have reached that, because this runs first.
      //
      // The alternative was to skip this call for `DELETE` in `handle`,
      // which was rejected: a request whose stream is never read leaves
      // bytes on the socket if a client did send some, and the rule would
      // then be about the method rather than about what arrived.
      //
      // **What this changes for the routes that already existed**: a `POST`
      // with a completely empty body now answers `invalid-shape` rather
      // than `malformed-body`. Both are 400 and both carry a code, so the
      // constraint the two exist to satisfy is untouched -- and
      // `invalid-shape` is the more honest of the two, since there was
      // nothing to parse and so nothing malformed.
      // `test/api/server.test.ts` pins that on `POST /api/feeds` as well
      // as on a mapping route, because the routes this moved are the ones
      // it was not written for.
      //
      // **`=== ''` and not a trim**, deliberately. `'   '` is a body, it
      // does not parse, and it still answers `malformed-body` -- pinned
      // beside the empty case. Trimming would widen "the client sent no
      // body" to "the client sent nothing but spaces", which is a
      // different claim and one this function has no reason to make.
      //
      // **A `DELETE` that does send a body is still read and still
      // checked**, since this is about what arrived rather than about the
      // method: `DELETE` with `{not json` is `malformed-body`, pinned in
      // the same test.
      if (text === '') {
        finish({ body: undefined });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish({ refusal: MALFORMED_BODY });
        return;
      }
      finish({ body: parsed });
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
