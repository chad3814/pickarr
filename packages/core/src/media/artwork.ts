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

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_POSTER_BYTES) {
      deps.log(`poster for group ${groupId}: ${bytes.byteLength} bytes exceeds the cap`);
      return null;
    }

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
