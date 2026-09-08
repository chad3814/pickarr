/**
 * The sync cursor every paginated read route walks forward with. Imports
 * nothing from the project -- it touches nothing but a string, so nothing
 * under `src/api` importing this risks a cycle back through `host.ts`.
 */

/**
 * A page boundary: the `updatedAt`/`id` of the last row a client has seen.
 * Both are the row's own values, not a hash of them, so the next page's
 * query is a plain `(updatedAt, id) > (cursor.updatedAt, cursor.id)`
 * comparison against the same columns the row was ordered by.
 */
export interface Cursor {
  updatedAt: number;
  id: number;
}

/**
 * One page size for every paginated route, not a knob each route sets for
 * itself -- a per-route page size is a second thing to get wrong for no
 * client that has ever asked for it.
 */
export const PAGE_SIZE = 200;

/** Matches a cursor half that is exactly one or more decimal digits -- no
 * sign, no decimal point, no exponent, no leading/trailing whitespace. This
 * is checked instead of handing the half to `Number()` because `Number()`
 * accepts all of those (hex, scientific notation, a leading `+`, blank
 * strings coerce to `0`) and would turn a client's typo into a cursor
 * `encodeCursor` never produced. */
const DIGITS = /^\d+$/;

/**
 * Opaque to a caller by construction, not by contract: base64url of
 * `<updatedAt>.<id>` is only enough to stop a client hand-building a
 * cursor and depending on its shape. It is **not signed and not
 * tamper-proof** -- anyone can decode, edit, and re-encode one, and this
 * function would accept the result. Nothing here defends against that;
 * the query the cursor drives is scoped to data the caller is already
 * allowed to see, so a forged cursor can only move the page boundary, not
 * read anything the caller couldn't otherwise reach.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.updatedAt}.${cursor.id}`).toString('base64url');
}

/**
 * `undefined` means "no cursor was sent" -- the first page, not an error.
 * A cursor that fails to decode, or decodes to something malformed, means
 * exactly the same thing: `null`. The two causes are different (nothing
 * sent vs. garbage sent) but the response to both is identical on purpose
 * -- a client that sends a cursor this route never produced gets a first
 * page back, which it can recover from by paging forward again, where a
 * thrown error would fail every single poll until whatever sent the bad
 * cursor was fixed.
 *
 * "Malformed" covers: not base64url at all, base64url of something with
 * no `.`, a well-formed pair whose `updatedAt` or `id` half is not all
 * digits (covers non-numeric, negative, and fractional halves alike,
 * since `-`, `.`, and letters are all rejected by the same digits-only
 * check), and an empty string.
 */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) {
    return null;
  }

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('.');
  if (separator === -1) {
    return null;
  }

  const updatedAtPart = decoded.slice(0, separator);
  const idPart = decoded.slice(separator + 1);
  if (!DIGITS.test(updatedAtPart) || !DIGITS.test(idPart)) {
    return null;
  }

  return { updatedAt: Number(updatedAtPart), id: Number(idPart) };
}
