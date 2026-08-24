import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { abortRejection } from '../abort.ts';
import type { FetchImpl } from '../clients/theporndb.ts';
import type { ArtworkKind } from './classify.ts';

/**
 * The largest image that will be written.
 *
 * This is the only place Pickarr writes remote binary content to disk, so the
 * ceiling is a hard one: without it a hostile or merely broken response fills
 * the volume the SQLite database lives on.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Content types accepted, and the extension each is stored under.
 *
 * The extension is derived from the *validated* type and never from the URL,
 * so a URL ending `.php`, or containing `..%2f`, cannot steer the path. Keys
 * are lowercase because RFC 9110 media types are case-insensitive, and a
 * server is free to send `IMAGE/JPEG`.
 */
const IMAGE_EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

/**
 * Total-operation deadline for one image download — the fetch, its headers,
 * and reading the *entire* streamed body, all against one clock.
 *
 * This is deliberately not a per-chunk timeout. A per-chunk timeout only
 * bounds the gap between two reads; a host that dribbles a single byte every
 * few seconds never trips one, and would keep this call — and the metadata
 * worker's `tryRun` mutex it runs under (see `pipeline/scheduler.ts`) — open
 * indefinitely while looking, to any per-chunk watchdog, perfectly healthy.
 * A single deadline covering the whole transfer has no such gap to exploit.
 *
 * The value is sized off `MAX_IMAGE_BYTES`: at a conservative 100 KB/s —
 * slower than any connection this service is expected to run over — the full
 * 5 MiB cap takes about 51 seconds to arrive. 60 seconds gives that a little
 * margin without leaving a stalled connection tying up a worker tick for
 * minutes.
 */
export const IMAGE_TIMEOUT_MS = 60_000;

export interface ArtworkDeps {
  readonly dir: string;
  readonly fetchImpl: FetchImpl;
  readonly log: (message: string) => void;
}

/**
 * Reads a response body a chunk at a time, refusing to buffer past the cap.
 *
 * This is the point of streaming: a hostile or broken response must not be
 * fully read into memory just to discover it is too large. The moment the
 * running total exceeds `MAX_IMAGE_BYTES`, the reader is cancelled — which
 * releases the underlying connection — and the function returns `null`
 * without ever finding out how large the body actually was.
 *
 * Returns the concatenated bytes when the whole body arrived within the cap,
 * or `null` when the body was missing or oversize (already logged).
 */
async function readBodyWithinCap(
  response: Response,
  url: string,
  log: (message: string) => void,
  timedOut: Promise<never>,
): Promise<Uint8Array | null> {
  const body = response.body;
  if (body === null) {
    log(`image ${url}: response had no body`);
    return null;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      // Chunks of a single stream must be read one at a time, in order —
      // there is nothing here to parallelise. Each read is raced against the
      // same total-operation deadline as the fetch that produced this body,
      // so a connection that stalls partway through streaming cannot outlive
      // it just because the headers already arrived.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await Promise.race([reader.read(), timedOut]);
      if (done) break;

      chunks.push(value);
      total += value.byteLength;

      // A chunk can straddle the limit, so the total is checked after adding
      // each one, not before.
      if (total > MAX_IMAGE_BYTES) {
        // eslint-disable-next-line no-await-in-loop -- one cancellation, ending the loop; nothing to batch it with
        await reader.cancel();
        log(`image ${url}: exceeded ${MAX_IMAGE_BYTES} bytes, aborted`);
        return null;
      }
    }
  } catch (error) {
    // The deadline fired mid-stream (or some other read failure occurred):
    // release the reader so the underlying socket is not pinned open
    // indefinitely, then let the caller's catch log this and return null the
    // same way every other image failure does.
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The validated bytes of a downloaded image and the extension its content type maps to. */
export interface FetchedImage {
  readonly bytes: Uint8Array;
  readonly extension: string;
}

/**
 * Downloads one image and validates it, returning its bytes and extension
 * without writing anything to disk.
 *
 * Never throws: an image is decoration, and a group's metadata answer must be
 * written whether or not its image could be fetched.
 *
 * There is no key here to log by — the key depends on classifying these
 * bytes (poster or background), which only happens once the caller has them
 * — so failures are logged against the URL instead.
 */
export async function fetchImage(deps: ArtworkDeps, url: string): Promise<FetchedImage | null> {
  // One deadline for the fetch and everything read from its body below — see
  // the comment on IMAGE_TIMEOUT_MS for why that must be a single
  // total-operation budget rather than a per-chunk one. Started before the
  // first `await` in this function (rather than immediately before the fetch
  // call) so nothing this function does can push the deadline later than the
  // moment `fetchImage` was called.
  const signal = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
  const timedOut = abortRejection(signal);
  try {
    const response = await Promise.race([deps.fetchImpl(url, { signal }), timedOut]);
    if (!response.ok) {
      await response.body?.cancel();
      deps.log(`image ${url}: HTTP ${response.status}`);
      return null;
    }

    // Media types are case-insensitive (RFC 9110): lowercase before lookup so
    // `IMAGE/JPEG` is treated the same as `image/jpeg`.
    const contentType =
      (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const extension = IMAGE_EXTENSIONS.get(contentType);
    if (extension === undefined) {
      await response.body?.cancel();
      deps.log(`image ${url}: refused content type ${contentType || 'none'}`);
      return null;
    }

    // Content-Length is attacker-controlled — absent under chunked encoding,
    // and nothing stops a hostile server sending a small one alongside a huge
    // body — so this is an optimisation to skip reading an already-too-large
    // response, never the boundary itself. The running total checked while
    // streaming below is that boundary.
    const declaredLengthHeader = response.headers.get('content-length');
    const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
    if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      deps.log(`image ${url}: declared ${declaredLength} bytes exceeds the cap`);
      return null;
    }

    const bytes = await readBodyWithinCap(response, url, deps.log, timedOut);
    if (bytes === null) return null;

    return { bytes, extension };
  } catch (error) {
    // `error` is not necessarily an Error — a rejected promise can carry
    // anything, and this function must never throw regardless of what it
    // carries.
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`image ${url} failed: ${message}`);
    return null;
  }
}

/**
 * Writes already-downloaded image bytes to `<key>.<extension>`, returning the
 * filename stored or `null`.
 *
 * Never throws: an image is decoration, and a group's metadata answer must be
 * written whether or not its image could be stored.
 */
export async function writeImage(
  deps: ArtworkDeps,
  key: string,
  bytes: Uint8Array,
  extension: string,
): Promise<string | null> {
  // Unique per call, not just per key: this pipeline will process groups in
  // a loop, and two overlapping downloads for the same key (a retry racing
  // the original, say) must not share one temp path. A shared path lets the
  // second writer's bytes land under the first writer's rename, or the
  // second rename fail ENOENT because the first already moved the file out
  // from under it — silently mixing two images' content.
  const temp = join(deps.dir, `.${key}.${randomUUID()}.part`);
  try {
    await mkdir(deps.dir, { recursive: true });

    // Temp then rename: both are on the same filesystem, and POSIX/NTFS
    // rename is atomic, so a reader can never observe a partially-written
    // file at the final name — a crash mid-write leaves an orphaned temp
    // file, never a truncated `<key>.<ext>`. This says nothing about
    // durability: neither the file nor its directory entry is fsync'd, so a
    // power loss immediately after a successful rename can still lose the
    // write and later show a missing or zero-length file.
    const name = `${key}.${extension}`;
    await writeFile(temp, bytes);
    await rename(temp, join(deps.dir, name));
    return name;
  } catch (error) {
    // Clean up before logging: a logger that itself throws (or a caller
    // whose `log` has side effects) must not orphan the temp file.
    await rm(temp, { force: true }).catch(() => undefined);
    // `error` is not necessarily an Error — a rejected promise can carry
    // anything, and this function must never throw regardless of what it
    // carries.
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`image ${key} failed: ${message}`);
    return null;
  }
}

/**
 * Downloads one image and writes it under `key`, returning the filename
 * stored or `null`. The composition of `fetchImage` and `writeImage`, kept
 * for callers that already know their key before the bytes arrive.
 *
 * The filename is `<key>.<ext>`. The key is composed by the caller from
 * integers of our own — a group id, or a performer id via
 * `performerArtworkKey` — which cannot contain a path separator. That is
 * safer than sanitising a provider-supplied string and needs no argument
 * about whether the sanitising is exhaustive.
 */
export async function cacheImage(deps: ArtworkDeps, key: string, url: string): Promise<string | null> {
  const fetched = await fetchImage(deps, url);
  if (fetched === null) return null;
  return writeImage(deps, key, fetched.bytes, fetched.extension);
}

/** Keys for a performer's two cached images. Integers only, by construction. */
export function performerArtworkKey(performerId: number, kind: 'face' | 'image'): string {
  return `performer-${kind}-${performerId}`;
}

/**
 * Keys for a group's two cached images.
 *
 * New group artwork stops using the bare group id, and that is load-bearing.
 * A background cached before migration 15 sits on disk at `<id>.jpg` and the
 * migration deliberately leaves it there. If a newly-fetched poster for that
 * group were also written to `<id>.jpg` it would overwrite the background —
 * so nothing writes the bare name again.
 */
export function groupArtworkKey(groupId: number, kind: ArtworkKind): string {
  return `group-${kind}-${groupId}`;
}
