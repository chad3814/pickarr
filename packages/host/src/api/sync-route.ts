/**
 * The two cursors a client runs concurrently (design spec §5): a tail of log
 * ops from the present (`GET /api/sync?since=<n>`), and a backwards walk over
 * current state (`GET /api/sync/backfill?before=<createdAt>.<id>`).
 *
 * **No SQL here.** Both routes parse and validate their own cursor and call
 * `tailSince`/`backfillBefore` (`sync/tail.ts`, `sync/backfill.ts`) for
 * everything else -- the same split `reads.ts` keeps for every other route,
 * and the reason this file exists rather than the logic living in
 * `server.ts`.
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
import type { BackfillCursor } from '../sync/backfill.ts';
import type { SyncRegistry } from '../sync/registry.ts';
import { tailSince } from '../sync/tail.ts';
import { PAGE_SIZE } from './cursor.ts';

/** Matches a cursor half that is exactly one or more decimal digits -- no sign, no decimal point, nothing else. */
const DIGITS = /^\d+$/;

/** What both routes below answer, before `server.ts` writes it to a socket. */
export interface SyncAnswer {
  status: number;
  body: unknown;
}

function json(status: number, body: unknown): SyncAnswer {
  return { status, body };
}

/** The fixed 400 for a `since` that is missing or is not a bare non-negative integer. */
const MALFORMED_SINCE = json(400, { error: 'since must be a non-negative integer' });

/** The fixed 400 for a `before` that was supplied but does not parse as `<createdAt>.<id>`. */
const MALFORMED_BEFORE = json(400, { error: 'before must be <createdAt>.<id>, both non-negative integers' });

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

/** `<createdAt>.<id>`, matching `encodeBeforeCursor`'s own encoding below. */
function parseBeforeCursor(raw: string): BackfillCursor | null {
  const separator = raw.indexOf('.');
  if (separator === -1) return null;
  const createdAtPart = raw.slice(0, separator);
  const idPart = raw.slice(separator + 1);
  if (!DIGITS.test(createdAtPart) || !DIGITS.test(idPart)) return null;
  return { createdAt: Number(createdAtPart), id: Number(idPart) };
}

/** The wire form of a backfill cursor -- the inverse of `parseBeforeCursor`. */
function encodeBeforeCursor(cursor: BackfillCursor): string {
  return `${cursor.createdAt}.${cursor.id}`;
}

/**
 * `GET /api/sync/backfill?before=<createdAt>.<id>`: one page of current
 * state, newest first, plus the log's watermark at the moment the page was
 * read (design spec §5.2).
 *
 * **No `before` at all is the first page**, not a malformed cursor -- this
 * route's own "start from the beginning" case, and the one place in this
 * file where an absent value is not refused. A `before` that *was* supplied
 * but does not parse is refused all the same, for the reason this module's
 * doc gives.
 */
export function backfillAnswer(
  deps: { raw: DatabaseSync; registry: SyncRegistry },
  params: URLSearchParams,
): SyncAnswer {
  const raw = params.get('before');
  let before: BackfillCursor | null;
  if (raw === null) {
    before = null;
  } else {
    const parsed = parseBeforeCursor(raw);
    if (parsed === null) return MALFORMED_BEFORE;
    before = parsed;
  }

  const page = backfillBefore(deps.raw, deps.registry, before, PAGE_SIZE);
  return json(200, {
    ops: page.ops,
    cursor: page.cursor === null ? null : encodeBeforeCursor(page.cursor),
    watermark: page.watermark,
  });
}
