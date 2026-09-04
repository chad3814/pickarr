import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';

export interface ArtworkStore {
  /**
   * Measures `bytes` and writes them to `dir`, keyed on `(mediaItemId, url)`
   * -- matching the `UNIQUE (media_item_id, url)` index on every artwork
   * table exactly, not just the url half of it. Keying on the url alone let
   * two media items that happen to share a poster url collide on one path:
   * dropping either item's row then unlinked the file the other item's row
   * still named. Two items that share a url now get two files -- a
   * duplicated few kilobytes, which is the right trade against the
   * alternative of content-addressing the bytes themselves, which would need
   * reference counting to know when a shared file is finally safe to delete.
   *
   * The path is a pure function of `(mediaItemId, url)` alone. It does not
   * depend on the measured type, so a url whose reported type changes
   * between two fetches (a CDN re-serving the same image as png instead of
   * jpg, say) still resolves to the same path and overwrites in place,
   * rather than writing a second path and orphaning the first. Width and
   * height, unlike the path, do come from the bytes and are remeasured every
   * call.
   *
   * Refuses bytes `image-size` cannot measure, rather than storing them with
   * invented dimensions: 1.x did the latter and needed `reclassify-artwork`
   * to repair the rows it produced. An html error page served with status
   * 200, or a truncated download, both look like this -- rejecting here lets
   * the job that fetched them retry instead of caching the mistake.
   */
  put(mediaItemId: number, url: string, bytes: Uint8Array): Promise<{ path: string; width: number; height: number }>;
  /**
   * Best-effort in the sense that it never throws: `dropMediaItem` calls
   * this only after the row it belonged to is already deleted, so raising
   * here would have nothing left to roll back to, and a caller that stopped
   * on this error would still have deleted the row that pointed here.
   *
   * Not silent about everything, though. A file already gone is what
   * idempotent removal means and stays unlogged; anything else -- `EACCES`,
   * `EPERM`, a directory that became something else underneath this
   * process -- is logged, because otherwise a permissions problem on the
   * artwork directory would let files accumulate without bound and nothing
   * would ever say why.
   */
  remove(path: string): Promise<void>;
}

/**
 * `crypto.subtle`, not a blocking hash: this runs on the same path as the
 * fetch that downloaded `bytes`, and the async form is the house rule for
 * anything that would otherwise block the loop.
 *
 * Keyed on `(mediaItemId, url)`, not `url` alone -- see `ArtworkStore.put`.
 * `String(mediaItemId)` is always a run of decimal digits with no `:` in it,
 * so the `:` inserted here is an unambiguous boundary: two different
 * `(mediaItemId, url)` pairs can never produce the same input string, even
 * if one url happens to contain a `:` of its own.
 */
async function hashKey(mediaItemId: number, url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${mediaItemId}:${url}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Caches artwork bytes on disk, named and measured so the file and the row
 * that points at it can never disagree -- see `MediaWriter`, the only
 * caller. `dir` defaults to `artwork/` beside the database file in whatever
 * composes this (mirroring 1.x's `resolveArtworkDir`); this constructor just
 * takes the resolved path. `log` is where `remove` reports an unlink that
 * failed for a reason other than the file already being gone.
 */
export function createArtworkStore(
  dir: string,
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void,
): ArtworkStore {
  // Created lazily, once, on the first write -- not eagerly here, so a store
  // built for a host that never attaches any artwork never touches the
  // filesystem at all.
  let dirReady: Promise<void> | undefined;
  function ensureDir(): Promise<void> {
    dirReady ??= mkdir(dir, { recursive: true }).then(() => undefined);
    return dirReady;
  }

  return {
    async put(mediaItemId, url, bytes) {
      let width: number | undefined;
      let height: number | undefined;
      try {
        ({ width, height } = imageSize(bytes));
      } catch (err) {
        throw new Error(`artwork store: bytes for ${url} could not be measured as an image`, { cause: err });
      }
      // `image-size` reports width/height as possibly `undefined` even when
      // it does not throw -- treated as a refusal too, exactly as 1.x's
      // `classifyArtwork` does (packages/core/src/media/classify.ts).
      if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        throw new Error(`artwork store: bytes for ${url} have no measurable dimensions`);
      }
      const name = await hashKey(mediaItemId, url);
      // A fixed suffix, not the measured type: see the interface doc on why
      // the path must depend on nothing but (mediaItemId, url).
      const path = join(dir, `${name}.bin`);
      await ensureDir();
      await writeFile(path, bytes);
      return { path, width, height };
    },

    async remove(path) {
      try {
        await unlink(path);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === 'ENOENT') return; // already gone -- this is what idempotent removal looks like
        log('artwork store: could not remove a cached file', { path, error: err });
      }
    },
  };
}
