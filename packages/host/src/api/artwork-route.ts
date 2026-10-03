/**
 * Serves artwork bytes for one artwork row: a media item's poster,
 * background or logo, or a person's picture, each addressed by its own row id. Separate from the server (`server.ts`, Task 6) so it
 * is testable without a socket -- everything here is a plain function over
 * an injected `readFile` and `stat`, never a real filesystem -- and so the
 * server itself stays routing: parse the request, call `readArtwork`, write
 * the response.
 *
 * **`person` is a widening of this module, not a second one.** All four
 * kinds serve the identical shape once a path is known: stat it, honour
 * `If-None-Match`, sniff the content type, read it. What differs between a
 * media item's three kinds and a person's one is only which table
 * `ARTWORK_QUERY[kind]` names -- and that was already the axis
 * `ArtworkKind`/`ARTWORK_QUERY` vary on, so `person` is one more entry in
 * each rather than a reason to duplicate the stat/etag/sniff logic below in
 * a parallel `readPersonArtwork`. `readArtwork`'s `id` is a row id in
 * whichever table `kind` names, and no kind's query sees another's ids.
 *
 * **No content type is stored, and none should be added.**
 * `packages/host/src/artwork/store.ts`'s `put` names the file
 * `<hash of (mediaItemId, url)>.bin` -- a fixed suffix, not the measured
 * type -- precisely so the path stays a pure function of `(mediaItemId,
 * url)`; `putPerson` does the same for `(personId, url)`, in a hash
 * namespace disjoint from `put`'s (see that method's docblock). That is what
 * lets a CDN re-serving the same url as a jpeg instead of a png overwrite
 * the same file in place rather than orphaning the old one under a
 * different name. A `content_type` column recorded at write time would be a
 * second source of truth that exact re-serve desyncs: the column would go on
 * describing bytes that are no longer on disk. Sniffing the magic bytes here
 * instead cannot drift, because it is derived from the very bytes being
 * served on this request -- there is nothing to store because there is
 * nothing that needs remembering between requests.
 *
 * **The ETag is weak, and that is forced, not chosen.** The same reasoning
 * that rules out a stored content type rules out a strong ETag: the cached
 * path is a hash of `(mediaItemId, url)` or `(personId, url)`, *not* of the
 * content, so it survives a re-fetch that changes the bytes at that path. A
 * strong ETag asserts byte-for-byte identity across requests that share
 * one; here it would be a lie a cache would believe. `W/"<mtimeMs>-<size>"`
 * plus `Last-Modified` is what the filesystem actually knows about the
 * file, and no more.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface ArtworkResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export type ArtworkKind = 'poster' | 'background' | 'logo' | 'person';

/**
 * One query per kind, not one query built from a template. `poster`,
 * `background`, `logo` and `person` are the only four tables this ever
 * reads (the last of those, `person_image`, is what `person` names -- there
 * is no table literally called `person` in this query), and the table name
 * in each string below is the module's own literal -- never `kind`
 * itself -- so nothing routes a caller-influenced value into SQL text, even
 * though `kind`'s type already restricts it to these four words. Same
 * convention `reads.ts` follows for `qualify`'s table aliases.
 *
 * **Keyed by the artwork row's own `id`**, not by its owner: an owner has
 * several images of a kind, and the URL names the one wanted. A client
 * learns the ids from the replicated artwork rows (`sync/tables.ts`).
 *
 * `AND path IS NOT NULL`: `path` is nullable on every one of the four
 * tables, so a row recorded before its bytes were fetched is a 404 by its
 * own id rather than a `stat` of the string `'null'`.
 *
 * **Exported for the same reason `reads.ts` exports `SYNC_QUERIES`**, so a
 * test can measure each statement. They are not in `SYNC_QUERIES` itself
 * because that record is keyed by the `reads.ts` function that runs each
 * statement and these four have no function there, and putting them in it
 * would make `reads.ts` import this module, which its own doc says it does
 * not do. The plan test makes its own completeness assertion over these
 * four keys: each query seeks the table's primary key and none sorts.
 */
export const ARTWORK_QUERY: Record<ArtworkKind, string> = {
  poster: 'SELECT path FROM poster WHERE id = ? AND path IS NOT NULL',
  background: 'SELECT path FROM background WHERE id = ? AND path IS NOT NULL',
  logo: 'SELECT path FROM logo WHERE id = ? AND path IS NOT NULL',
  person: 'SELECT path FROM person_image WHERE id = ? AND path IS NOT NULL',
};

/**
 * The row's `path`, or `null` for a row that has none.
 *
 * `ARTWORK_QUERY` already refuses null-path rows, so no row reaching here
 * carries one -- this stays because it is the one place a column becomes a
 * filesystem path, and `String(null)` is the string `'null'`. Without the
 * check a query that stopped filtering would `stat('null')` instead of
 * answering 404, which is the failure being guarded, not the one being
 * expected. `undefined` (the column absent from the row) is treated the same
 * as SQL `NULL`: neither has bytes to serve.
 */
function pathOf(row: unknown): string | null {
  const value = (row as { path: unknown }).path;
  return value === null || value === undefined ? null : String(value);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38]; // 'GIF8'
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // 'RIFF', WebP's outer container
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // 'WEBP'
const FTYP_SIGNATURE = [0x66, 0x74, 0x79, 0x70]; // 'ftyp', ISO base media's box name
const AVIF_SIGNATURE = [0x61, 0x76, 0x69, 0x66]; // 'avif'

/**
 * Whether `bytes` carries `signature` starting at `offset`. Checks the
 * length first and returns `false` rather than indexing past the end --
 * `noUncheckedIndexedAccess` is on, so `bytes[offset + index]` types as
 * `number | undefined` regardless, but the length check is what makes a
 * two-byte file fail this cleanly instead of comparing `undefined` against
 * every byte of a longer signature.
 */
function matches(bytes: Uint8Array, signature: readonly number[], offset: number): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Reads the magic bytes at the front of `bytes` and names the image type
 * they declare. Nothing here consults a database, a filename or a stored
 * column -- see the module doc for why. Two of the five checks need a
 * second window (WebP's container tag *and* its format tag; AVIF's box type
 * *and* its brand) so a short file that satisfies the first window and not
 * the second falls through to the next check rather than throwing, exactly
 * because `matches` bounds-checks each window on its own.
 *
 * Anything unrecognised is `application/octet-stream` -- refusing to serve
 * an image whose type cannot be named would turn "the CDN sent something
 * odd" into a 500 for bytes that a browser can still be handed as-is.
 */
export function sniffImageType(bytes: Uint8Array): string {
  if (matches(bytes, PNG_SIGNATURE, 0)) return 'image/png';
  if (matches(bytes, JPEG_SIGNATURE, 0)) return 'image/jpeg';
  if (matches(bytes, GIF_SIGNATURE, 0)) return 'image/gif';
  if (matches(bytes, RIFF_SIGNATURE, 0) && matches(bytes, WEBP_SIGNATURE, 8)) return 'image/webp';
  if (matches(bytes, FTYP_SIGNATURE, 4) && matches(bytes, AVIF_SIGNATURE, 8)) return 'image/avif';
  return 'application/octet-stream';
}

const NOT_FOUND: ArtworkResponse = { status: 404, headers: {}, body: null };

/**
 * Answers one artwork request: which kind, which row of it, and (via
 * `ifNoneMatch`) which cached copy the caller already holds.
 *
 * `id` is the artwork row's own id in the table `kind` names (`person_image`
 * for `person`), not the id of the media item or person that owns it.
 *
 * `ifNoneMatch` is not part of the brief's four-parameter signature for this
 * function, but is required by the behaviour the same brief describes --
 * "honour `If-None-Match` with a 304" -- and by the test of that behaviour,
 * which calls this function directly with no socket in between. Added as a
 * fifth, optional parameter rather than folded into `deps`, since `deps` is
 * specifically the pair of filesystem calls a test replaces; the caller's
 * request header is not one of those.
 *
 * Two situations answer 404 identically, and deliberately do not
 * distinguish themselves in the response: no row of `kind` with this id,
 * and a row whose `path` is still null. Both mean "no bytes exist to serve"
 * -- the second because the artwork was recorded before it was ever
 * fetched -- and a zero-length `200` for either would be cached by a
 * browser as a real (empty) image, staying broken until the cache entry
 * expires long after the bytes finally arrive.
 *
 * A file that the row's `path` names but that is no longer readable (the
 * artwork directory cleared by hand, say) gets the same 404: the row and the
 * disk have disagreed, and that is not this caller's fault to see as a 500.
 * Neither 404 names the path that was, or was not, found -- only a missing
 * row's `kind` and `id` are known outside this function, and this
 * function never returns the path either.
 */
export async function readArtwork(
  raw: DatabaseSync,
  kind: ArtworkKind,
  id: number,
  deps: {
    readFile: (path: string) => Promise<Uint8Array>;
    stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  },
  ifNoneMatch?: string,
): Promise<ArtworkResponse> {
  const row = raw.prepare(ARTWORK_QUERY[kind]).get(id);
  if (row === undefined) return NOT_FOUND;

  const path = pathOf(row);
  if (path === null) return NOT_FOUND;

  let info: { mtimeMs: number; size: number };
  try {
    info = await deps.stat(path);
  } catch {
    return NOT_FOUND;
  }

  // Weak by construction: see the module doc for why a strong ETag cannot
  // be honest here. `size` alone would miss a same-size overwrite; `mtimeMs`
  // alone would miss a rewrite that happens to land in the same millisecond
  // on a coarse filesystem clock. Together they are what `stat` actually
  // knows, and no more.
  const etag = `W/"${info.mtimeMs}-${info.size}"`;
  const lastModified = new Date(info.mtimeMs).toUTCString();

  if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
    return { status: 304, headers: { ETag: etag, 'Last-Modified': lastModified }, body: null };
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(path);
  } catch {
    return NOT_FOUND;
  }

  return {
    status: 200,
    headers: {
      'Content-Type': sniffImageType(bytes),
      ETag: etag,
      'Last-Modified': lastModified,
    },
    body: bytes,
  };
}
