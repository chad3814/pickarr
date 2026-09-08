/**
 * The sync cursors every paginated read route walks forward with. Imports
 * nothing from the project -- it touches nothing but a string, so nothing
 * under `src/api` importing this risks a cycle back through `host.ts`.
 *
 * **Two cursor types, not one.** `Cursor` keys a single table by
 * `(updatedAt, id)`; `UnionCursor` keys the download union by
 * `(updatedAt, transport, id)`, because `id` alone is a per-table rowid and
 * so not a key across two tables. See `UnionCursor` for the whole argument.
 * Two, and not five: `Cursor` is issued by three routes over three
 * different key spaces, and `Cursor`'s own doc argues why those three are
 * one type rather than three branded ones.
 *
 * **And the compiler keeps them apart, both ways round.** Each carries a
 * `keyedBy` tag naming its own key, because structurally a `UnionCursor` is
 * a `Cursor` with an extra field and so was assignable to one. See `keyedBy`
 * on `Cursor` for the route that compiled and served page 1 forever.
 */

/**
 * A page boundary on one table: the `updatedAt`/`id` of the last row a client
 * has seen. Both are the row's own values, not a hash of them, so the next
 * page's query is a plain `(updatedAt, id) > (cursor.updatedAt, cursor.id)`
 * comparison against the same columns the row was ordered by.
 *
 * **Three routes issue this one type over three different key spaces, and
 * that is decided rather than overlooked.** `/api/media` keys
 * `media_item.updated_at`/`id`; `/api/rss-items` keys
 * `rss_item.updated_at`/`id`; `/api/deletions` keys
 * `deleted_media_item.deleted_at`/`media_item_id`. All three encode to the
 * same two-part string, so a *client* that muddles them resumes at a
 * position in the wrong key space -- decoding cleanly, reporting nothing,
 * and skipping rows. `UnionCursor` below calls a cursor whose meaning
 * depends on which route issued it "the shape of a later bug", and the words
 * apply to these three exactly as written. Giving each stream its own
 * `keyedBy` was considered and declined, on three grounds:
 *
 * 1. **The mix-up is a client's, and a cursor crosses to a client as an
 *    opaque string.** There is no type at the boundary where it happens, so
 *    no brand can reach it. What `keyedBy` closed was a *server*-side
 *    wiring bug -- `rssItemsSince(raw, decodeUnionCursor(...))`, which
 *    compiled -- and per-stream brands could only close the server-side
 *    analogue of that.
 * 2. **Which is already covered, and measured rather than assumed.** Three
 *    crossings were written into `server.ts` and run. The two same-arity
 *    swaps -- the deletions route calling `mediaItemsSince`, and the media
 *    route calling `deletionsSince` -- typecheck cleanly and fail two and
 *    three existing tests respectively. So does the arity-changing one, the
 *    media route calling `rssItemsSince` with `pluginId` dropped: three
 *    failures. Every failure is on a page's contents, not on a compile or a
 *    binding error. That is a behavioural net rather than a compile-time
 *    one, and it is the net that catches a wrong *reader* as well as a
 *    wrong cursor.
 * 3. **The brand would assert what no code can check.** `UnionCursor`'s tag
 *    mirrors a runtime difference -- three parts on the wire instead of
 *    two, and a decoder that refuses the other shape. Two `Cursor`s from
 *    different streams are the same runtime value out of the same decoder,
 *    so a per-stream tag would be an author's annotation with nothing
 *    behind it, and the author who annotates the wrong stream is the author
 *    who would have called the wrong reader.
 *
 * What would change the decision: a third two-argument `Cursor` reader, or
 * one route holding two streams' cursors at once. Then the crossings stop
 * being refused by arity, and the brand is the cheap answer -- the pattern
 * is right here on `keyedBy`.
 */
export interface Cursor {
  updatedAt: number;
  id: number;
  /**
   * The key this cursor is a boundary on, as a tag no two cursor types
   * share. Nothing reads it; it exists so the two types are not assignable
   * to one another.
   *
   * Structural typing gave that away in one direction and kept it in the
   * other, which is worse than giving it away in both -- it invites the
   * belief that the compiler is watching. A `UnionCursor` has `updatedAt`
   * and `id` and so *was* a `Cursor`, which is how
   * `rssItemsSince(raw, decodeUnionCursor(since(params)))` typechecked: it
   * compiled, and then every cursor that route handed a client came back as
   * a three-part string, decoded to `null` on the plain decoder, and served
   * page 1 again -- so a client past `PAGE_SIZE` rss items never advanced,
   * with nothing anywhere reporting it. The reverse mix-up was already
   * refused, only because `Cursor` happens to have no `transport`.
   *
   * With a differing `keyedBy` on each, neither direction compiles:
   * `TS2345 ... Type '"updatedAt, transport, id"' is not assignable to type
   * '"updatedAt, id"'` in argument position, `TS2375` in an annotated
   * assignment, and `TS2353 ... 'transport' does not exist in type 'Cursor'`
   * for a fresh object literal, which excess-property checking refuses on
   * its own. The one shape that still compiles is a value that has never
   * been *named* as either type: an inferred `const` carrying `transport`
   * is assignable to `Cursor`, because excess-property checking applies to
   * literals and not to variables. Measured, all four.
   *
   * Nothing in the tree exploits that: every cursor either comes out of a
   * decoder (annotated return), is one of `reads.ts`'s two `BEGINNING`
   * constants (annotated), or is an object literal in a contextually typed
   * position -- a `Keyed.key` field, an `encodeCursor` argument -- where the
   * literal rule applies. The one inferred variable of this shape,
   * `cursor.test.ts`'s `as const` union cursor, is only ever handed to
   * `encodeUnionCursor`. So the gap is precision about what the tag
   * defends, not a live hole.
   *
   * **Optional, and set by nothing.** It is a compile-time tag and has no
   * business existing at runtime: a required field would have to be written
   * at every construction site and would turn up in the object a decoder
   * returns, where it is a field no client asked for. `readonly` so nothing
   * can write it, optional so nothing has to -- a caller that only
   * round-trips the opaque string never learns it is here.
   */
  readonly keyedBy?: 'updatedAt, id';
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

  // `Buffer.from(x, 'base64url')` never throws: invalid characters, bad
  // padding and non-ascii all yield empty or garbage bytes, which the
  // digits-only checks below then reject. That is why there is no try/catch
  // here -- and it is a property of *this* primitive, not of base64 decoding
  // generally. `atob` throws a `DOMException` on every one of those inputs,
  // so swapping to it without adding a catch would turn a malformed cursor
  // from "start from the beginning" into a 500 on every poll.
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

/**
 * A page boundary over the **union** of `torrent_download` and `nzb_download`.
 *
 * A second cursor type rather than a third optional field on `Cursor`,
 * because the two things being paged genuinely have different keys.
 * `(updated_at, id)` is a key on any single table, where `id` is that table's
 * `INTEGER PRIMARY KEY`. It is **not** a key across the union: `id` is a
 * per-table rowid, so a `torrent_download` row and an `nzb_download` row can
 * carry the same `(updated_at, id)` pair exactly, and a cursor naming that
 * pair cannot say which of the two was already served. Adding `transport`
 * makes the triple a genuine total order, because `transport` is constant
 * within each branch of the union and the two values are disjoint.
 *
 * One cursor type with an optional third field was rejected twice over:
 * `exactOptionalPropertyTypes` makes an optional field awkward at every
 * construction site, and a cursor whose meaning depends on which route issued
 * it is the shape of a later bug -- a downloads cursor handed to the media
 * route would decode without complaint and page from the wrong key. That is
 * an argument about an optional field carrying *data*, and not about
 * `keyedBy` below, which nothing ever writes or reads: an optional field no
 * construction site sets costs no construction site anything.
 *
 * **And it is not an argument this file has acted on everywhere it applies.**
 * Three routes issue a plain `Cursor` over three different key spaces, so
 * "a cursor whose meaning depends on which route issued it" describes them
 * too. That was decided, not missed: see `Cursor`'s own doc for the three
 * grounds it was declined on and for what would change the answer. Read the
 * sentence above as the reason *this* type is separate, not as a rule the
 * module keeps everywhere.
 *
 * `transport` is spelled as a literal union here rather than imported. The
 * original reason was a cycle -- the union lived in `reads.ts`, which imports
 * this module -- and Task 4 moved it to `@pickarr/contract`, which imports
 * nothing from the host, so that reason is gone. The restatement stays for
 * the one this module's own doc gives: it imports nothing at all, and a
 * cursor is a string. The two declarations are structurally identical, which
 * is what makes a `Transport` assignable to this field.
 */
export interface UnionCursor {
  updatedAt: number;
  transport: 'nzb' | 'torrent';
  id: number;
  /**
   * This union's own key, named differently from `Cursor`'s so the two types
   * are mutually unassignable rather than one-way. See `Cursor.keyedBy` for
   * the mix-up that compiled without it, and for why the tag is optional and
   * never set.
   */
  readonly keyedBy?: 'updatedAt, transport, id';
}

/** See `encodeCursor` for why base64url is opacity and not protection. */
export function encodeUnionCursor(cursor: UnionCursor): string {
  return Buffer.from(`${cursor.updatedAt}.${cursor.transport}.${cursor.id}`).toString('base64url');
}

/**
 * `null` for "no cursor sent" and for a malformed one alike, for exactly the
 * reasons `decodeCursor` gives.
 *
 * "Malformed" covers everything `decodeCursor` refuses plus one more: a
 * middle part that is not one of the two transports. A cursor produced by
 * `encodeCursor` -- two parts, no transport -- is malformed here too, and a
 * three-part union cursor is malformed to `decodeCursor`, so neither route
 * can be resumed with the other's cursor by accident.
 */
export function decodeUnionCursor(raw: string | undefined): UnionCursor | null {
  if (raw === undefined) {
    return null;
  }

  // No try/catch, for the reason `decodeCursor` spells out: this `Buffer.from`
  // overload never throws, and the checks below reject whatever it yields.
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const first = decoded.indexOf('.');
  if (first === -1) {
    return null;
  }
  const second = decoded.indexOf('.', first + 1);
  if (second === -1) {
    return null;
  }

  const updatedAtPart = decoded.slice(0, first);
  const transportPart = decoded.slice(first + 1, second);
  // Everything after the second separator, so a fourth part lands here and is
  // refused by the digits check rather than being silently ignored.
  const idPart = decoded.slice(second + 1);
  if (!DIGITS.test(updatedAtPart) || !DIGITS.test(idPart)) {
    return null;
  }
  if (transportPart !== 'nzb' && transportPart !== 'torrent') {
    return null;
  }

  return { updatedAt: Number(updatedAtPart), transport: transportPart, id: Number(idPart) };
}
