import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchImpl } from '../clients/theporndb.ts';

/**
 * The largest poster that will be written.
 *
 * This is the only place Pickarr writes remote binary content to disk, so the
 * ceiling is a hard one: without it a hostile or merely broken response fills
 * the volume the SQLite database lives on.
 */
export const MAX_POSTER_BYTES = 5 * 1024 * 1024;

/**
 * Content types accepted, and the extension each is stored under.
 *
 * The extension is derived from the *validated* type and never from the URL,
 * so a URL ending `.php`, or containing `..%2f`, cannot steer the path.
 */
const POSTER_EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

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
 * running total exceeds `MAX_POSTER_BYTES`, the reader is cancelled — which
 * releases the underlying connection — and the function returns `null`
 * without ever finding out how large the body actually was.
 *
 * Returns the concatenated bytes when the whole body arrived within the cap,
 * or `null` when the body was missing or oversize (already logged).
 */
async function readBodyWithinCap(
  response: Response,
  groupId: number,
  log: (message: string) => void,
): Promise<Uint8Array | null> {
  const body = response.body;
  if (body === null) {
    log(`poster for group ${groupId}: response had no body`);
    return null;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    // Chunks of a single stream must be read one at a time, in order — there
    // is nothing here to parallelise.
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    total += value.byteLength;

    // A chunk can straddle the limit, so the total is checked after adding
    // each one, not before.
    if (total > MAX_POSTER_BYTES) {
      // eslint-disable-next-line no-await-in-loop -- one cancellation, ending the loop; nothing to batch it with
      await reader.cancel();
      log(`poster for group ${groupId}: exceeded ${MAX_POSTER_BYTES} bytes, aborted`);
      return null;
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Downloads one poster, returning the filename stored or `null`.
 *
 * Never throws: a poster is decoration, and a group's metadata answer must be
 * written whether or not its image could be fetched.
 *
 * The filename is `<group_id>.<ext>` — an integer from our own database, which
 * cannot contain a path separator. That is safer than sanitising a
 * provider-supplied string and needs no argument about whether the sanitising
 * is exhaustive.
 */
export async function cachePoster(
  deps: ArtworkDeps,
  groupId: number,
  url: string,
): Promise<string | null> {
  const temp = join(deps.dir, `.${groupId}.part`);
  try {
    await mkdir(deps.dir, { recursive: true });

    const response = await deps.fetchImpl(url);
    if (!response.ok) {
      deps.log(`poster for group ${groupId}: HTTP ${response.status}`);
      return null;
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const extension = POSTER_EXTENSIONS.get(contentType);
    if (extension === undefined) {
      deps.log(`poster for group ${groupId}: refused content type ${contentType || 'none'}`);
      return null;
    }

    // Content-Length is attacker-controlled — absent under chunked encoding,
    // and nothing stops a hostile server sending a small one alongside a huge
    // body — so this is an optimisation to skip reading an already-too-large
    // response, never the boundary itself. The running total checked while
    // streaming below is that boundary.
    const declaredLengthHeader = response.headers.get('content-length');
    const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
    if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > MAX_POSTER_BYTES) {
      deps.log(`poster for group ${groupId}: declared ${declaredLength} bytes exceeds the cap`);
      return null;
    }

    const bytes = await readBodyWithinCap(response, groupId, deps.log);
    if (bytes === null) return null;

    // Temp then rename: a crash between the two leaves a dotfile, never a
    // truncated image that reads as valid.
    const name = `${groupId}.${extension}`;
    await writeFile(temp, bytes);
    await rename(temp, join(deps.dir, name));
    return name;
  } catch (error) {
    deps.log(`poster for group ${groupId} failed: ${(error as Error).message}`);
    await rm(temp, { force: true }).catch(() => undefined);
    return null;
  }
}
