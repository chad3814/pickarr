/**
 * The two cursors a client runs concurrently (design spec §5) -- a tail of
 * log ops from the present (`GET /api/sync?since=<n>`) and a backwards walk
 * over the log (`GET /api/sync/backfill?before=<n>`) -- plus the one call
 * that hands an empty client the pair it starts both from
 * (`GET /api/sync/bootstrap`).
 *
 * **No SQL here.** Each route parses and validates its own query parameters
 * -- `/api/sync/bootstrap` has none -- and calls `tailSince`,
 * `backfillBefore` or `bootstrapCursors` (`sync/tail.ts`,
 * `sync/backfill.ts`, `sync/bootstrap.ts`) for everything else: the same
 * split `reads.ts` keeps for every other route, and the reason this file
 * exists rather than the logic living in `server.ts`.
 *
 * **A malformed cursor is a `400`, never a silent `0`.** `decodeCursor` and
 * `decodeUnionCursor` in `./cursor.ts` treat a malformed value the same as no
 * value at all -- deliberately, for the paginated routes they serve, where
 * "start from the beginning" is always a safe fallback because the client
 * only ever loses a little progress on one paged stream. That reasoning does
 * not carry over here: `since` is a client's entire watermark for the tail,
 * and treating a typo'd or truncated one as `0` would silently hand back a
 * full resync of everything that plugin owns, answering `200` and looking
 * exactly like success. So this module refuses instead, with a `400`, for
 * `since` and for a `before` that was actually supplied but does not parse.
 */
import type { DatabaseSync } from 'node:sqlite';
import { backfillBefore } from '../sync/backfill.ts';
import { BOOTSTRAP_ITEMS, bootstrapCursors } from '../sync/bootstrap.ts';
import type { SyncRegistry } from '../sync/registry.ts';
import { tailSince } from '../sync/tail.ts';
import { PAGE_SIZE } from './cursor.ts';

/**
 * Matches a cursor: decimal digits, no sign, no decimal point, nothing else
 * -- and **at most 15 of them**.
 *
 * **The bound is not tidiness; without it this route emitted cursors it then
 * refused.** `/^\d+$/` accepted `since=1000000000000000000000` (22 digits),
 * `tailSince` returned it unchanged for an empty page, and `JSON.stringify`
 * serialised the `Number` as `1e+21`. A client echoing its own cursor back --
 * which is the entire protocol -- got a `400`, permanently. Measured:
 *
 * ```
 * since accepted (22 digits): true
 * wire body: {"ops":[],"cursor":1e+21}
 * cursor echoed as: 1e+21 | accepted again by /^\d+$/: false
 * ```
 *
 * Same class, one step earlier: any value above `Number.MAX_SAFE_INTEGER`
 * (9007199254740991) is bound to `node:sqlite` with silent precision loss
 * rather than refused, so two distinct cursors can become one query.
 *
 * **15, because every 15-digit value is safe on both counts.** The largest is
 * 999999999999999, below `Number.MAX_SAFE_INTEGER`, so it is exact; and it is
 * far below 1e21, so `JSON.stringify` writes it as plain digits and this
 * regex takes it back. A cursor is a `sync_log.id`, one row per changed row,
 * so 10^15 is more entries than any database will hold by a margin no real
 * library approaches. Bounding the digit count rather than testing
 * `Number.isSafeInteger` also refuses the input *up front*, which a
 * thousand-digit string of leading zeros would otherwise walk past.
 *
 * `./cursor.ts`'s own `DIGITS` is deliberately left alone: a malformed cursor
 * there means "first page", not a `400`, so an over-long one costs a client
 * a little progress once rather than failing every poll it makes.
 */
const DIGITS = /^\d{1,15}$/;

/** What each route below answers, before `server.ts` writes it to a socket. */
export interface SyncAnswer {
  status: number;
  body: unknown;
}

function json(status: number, body: unknown): SyncAnswer {
  return { status, body };
}

/** The fixed 400 for a `since` that is missing or is not a bare non-negative integer. */
const MALFORMED_SINCE = json(400, { error: 'since must be a non-negative integer' });

/** The fixed 400 for a `before` that was supplied and is not a bare non-negative integer. */
const MALFORMED_BEFORE = json(400, { error: 'before must be a non-negative integer' });

/**
 * `since` as `tailSince` wants it, or `null` for anything that is not a bare
 * non-negative integer -- including the empty string, which a query
 * parameter set with no value (`?since=`) produces, and which is a real
 * request a client can send rather than the same thing as omitting `since`
 * altogether. Both are refused: this route has no "first page" concept the
 * way the paginated ones do, so there is no safe default to fall back to.
 */
function parseSince(raw: string | null): number | null {
  if (raw === null || !DIGITS.test(raw)) return null;
  return Number(raw);
}

/**
 * `GET /api/sync?since=<n>`: ops above `since`, resolved to current state.
 *
 * `since` is required -- there is no "no cursor" reading of this route the
 * way `before` has one on the backfill, because the tail has nothing to
 * start from except a watermark the client already holds.
 */
export function syncAnswer(
  deps: { raw: DatabaseSync; registry: SyncRegistry },
  params: URLSearchParams,
): SyncAnswer {
  const since = parseSince(params.get('since'));
  if (since === null) return MALFORMED_SINCE;

  const page = tailSince(deps.raw, deps.registry, since, PAGE_SIZE);
  return json(200, { ops: page.ops, cursor: page.cursor });
}

/**
 * `GET /api/sync/backfill?before=<n>`: ops below `before`, resolved to
 * current state (design spec §5.2).
 *
 * **One bare log position, where this cursor used to be three numbers in one
 * token.** The walk paged current state on a `(created_at, id)` keyset and
 * carried a watermark alongside it, because it needed a threshold to skip
 * rows the tail owned; the walk now reads the log itself, and disjointness is
 * the arithmetic of `id < before` against the tail's `id > since`. So there
 * is no keyset to encode, no watermark to thread, and nothing a client can
 * half supply. `before` and `since` are now the same kind of value -- a
 * `sync_log.id` -- which is what lets `/api/sync/bootstrap` hand out both in
 * one answer.
 *
 * **No `before` at all is the first page**, not a malformed cursor -- this
 * route's own "start from the beginning" case, and the one place in this
 * file where an absent value is not refused. A `before` that *was* supplied
 * but does not parse is refused all the same, for the reason this module's
 * doc gives.
 *
 * **The body carries no log position of its own.** It used to return the
 * watermark, so a client could start its tail without a second round trip;
 * `/api/sync/bootstrap` answers that question directly now, for both cursors
 * at once and before either has been called. And there is deliberately no
 * number dating the page: every op here is a `create`, which a client applies
 * only if it does not already hold the row, and the tail's `delete`
 * tombstones rather than removes -- so a page read before a write and applied
 * after it is a no-op rather than an overwrite or a resurrection, with
 * nothing for the client to compare. An earlier draft returned an `asOf` per
 * page and asked the client to check it against its own tail cursor;
 * `sync/tail.ts`'s `SyncOp` has why the op kind replaced it.
 */
export function backfillAnswer(
  deps: { raw: DatabaseSync; registry: SyncRegistry },
  params: URLSearchParams,
): SyncAnswer {
  const supplied = params.get('before');
  if (supplied !== null && !DIGITS.test(supplied)) return MALFORMED_BEFORE;
  const before = supplied === null ? null : Number(supplied);

  const page = backfillBefore(deps.raw, deps.registry, before, PAGE_SIZE);
  return json(200, { ops: page.ops, cursor: page.cursor });
}

/**
 * `GET /api/sync/bootstrap`: the cursor pair an empty client starts both
 * cursors from (design spec §5.4).
 *
 * **No parameters, and nothing to get wrong.** The one thing a client with
 * nothing has to be told is where to start, and it is one number in two
 * forms -- the pivot itself as `before`, and one below it as `since`, so the
 * entry at the pivot is the tail's rather than nobody's. A client could
 * derive neither: computing the floor needs `media_item.updated_at` per
 * category and two `sync_log` lookups, none of which is on the wire.
 *
 * **Both, from one call, rather than the backfill's first page carrying a
 * watermark.** That is what the old shape did, and it forced the two cursors
 * to be started in an order: the tail could not begin until a backfill page
 * had come back with the mark. They are independent now -- a client asks
 * once, then runs both concurrently from the first request, which is what §5
 * asks of it.
 *
 * `sync/bootstrap.ts` does the computing; this hands it the shipped target
 * and serialises the answer, keeping this module free of SQL like the two
 * routes above.
 */
export function bootstrapAnswer(deps: { raw: DatabaseSync }): SyncAnswer {
  return json(200, bootstrapCursors(deps.raw, BOOTSTRAP_ITEMS));
}
