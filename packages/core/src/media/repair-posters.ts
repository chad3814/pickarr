import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CROP_MARKER, backgroundFromCrop } from '../clients/theporndb.ts';
import { postersMatching, setBackgroundImage, type StoredPoster } from '../db/metadata.ts';
import { cacheImage, type ArtworkDeps } from './artwork.ts';

/**
 * Replaces posters that are really 800x1200 crops of a scene's background
 * with the background itself.
 *
 * This existed because the fix in `readPosterUrl` only helped scenes looked
 * up *after* it shipped. Rows answered before that held a crop URL and a
 * cached file to match, and nothing re-fetched them: the metadata worker
 * skips caching whenever `poster_path` is already set, precisely so a
 * re-answer does not re-download a byte-identical image. The crop URL was
 * enough to run the repair — the original background is encoded inside it,
 * so this makes no provider API request and needs no credentials, only the
 * CDN.
 *
 * Provably unreachable since migration 15, and kept only pending a decision
 * to retire it rather than because it still has work to do. `openDatabase`
 * runs every migration before any query does; migration 15 nulls
 * `poster_url` for every row matching `%/800x1200/%` or `%/smart/%` (the same
 * shape `BACKGROUND_CROP_MARKER` recognises); and `readPosterCandidate` can
 * no longer store a new crop for `postersMatching` to find later. So by the
 * time this function's own query runs, on every database it could ever be
 * pointed at, it finds zero rows. Not deleted here: retiring it is the
 * project owner's call, not a decision to fold into an unrelated fix.
 *
 * Lives here rather than in `scripts/` so it can be tested. The script is a
 * thin harness over this function, on the same terms `parse-corpus.ts` states:
 * a second implementation over there would be free to drift from the one under
 * test.
 *
 * Safe to run twice. A repaired row no longer matches `BACKGROUND_CROP_MARKER`,
 * so a second pass does not see it; a row whose download failed keeps its old
 * url and file and is simply retried. (Both are moot while it finds nothing.)
 *
 * Predates the poster/background split and now writes the background pair:
 * what this recovers has always been a background image, mislabelled only
 * because `poster_path` was the only slot that existed when the crop was
 * first cached.
 */
export interface RepairPostersDeps {
  db: DatabaseSync;
  artwork: ArtworkDeps;
  log(message: string): void;
}

export interface RepairPostersResult {
  /** Rows found holding a synthesised poster. */
  looked: number;
  repaired: number;
  /** Rows left exactly as they were, to be retried by a later run. */
  failed: number;
}

/** The rows a run would act on, for a caller that wants to report before acting. */
export function postersNeedingRepair(db: DatabaseSync): StoredPoster[] {
  return postersMatching(db, BACKGROUND_CROP_MARKER);
}

export async function repairBackgroundPosters(
  deps: RepairPostersDeps,
): Promise<RepairPostersResult> {
  const rows = postersNeedingRepair(deps.db);
  const result: RepairPostersResult = { looked: rows.length, repaired: 0, failed: 0 };

  for (const row of rows) {
    const background = backgroundFromCrop(row.posterUrl);
    if (background === null) {
      // The marker matched but the URL does not decode to a CDN path — a
      // truncated row, or a thumbnailer URL shaped differently than any seen.
      // Left alone rather than blanked: an unreadable url is still a record of
      // what the provider said.
      deps.log(`repair: group ${row.groupId}: no background could be read from its poster url`);
      result.failed += 1;
      continue;
    }

    // The same key the original fetch used, so the common case — background
    // and crop are both JPEG — writes `<group_id>.jpg` straight over the file
    // already there, atomically, with no window where the poster route finds
    // nothing to serve. `cacheImage` never throws and logs its own failures.
    // eslint-disable-next-line no-await-in-loop -- one CDN, one image at a time; deliberately not batched
    const stored = await cacheImage(deps.artwork, String(row.groupId), background);
    if (stored === null) {
      result.failed += 1;
      continue;
    }

    // Database first, stale file second. A crash between the two leaves an
    // orphaned image file, which costs disk and nothing else; doing it the
    // other way round would leave a row naming a file that no longer exists,
    // and the background route would 404 for a group that has a perfectly
    // good image sitting next to it.
    //
    // Writes the background pair, not the poster one: this row's poster_path
    // named a synthesised crop, never a real poster, so `setBackgroundImage`
    // clears poster_url/poster_path along with filling background_url/
    // background_path — there is nothing left under the poster columns worth
    // keeping once the crop it described is gone.
    setBackgroundImage(deps.db, row.groupId, background, stored);

    // Only when the extension changed — a JPEG crop whose background is a
    // WebP, say. `cacheImage` derives the extension from the validated
    // content type, so the new file is `<group_id>.webp` and the old
    // `<group_id>.jpg` is now unreferenced. Same name means the rename above
    // already replaced it, and this must not delete what it just wrote.
    if (row.posterPath !== null && row.posterPath !== stored) {
      // eslint-disable-next-line no-await-in-loop -- part of this row's sequential repair
      await rm(join(deps.artwork.dir, row.posterPath), { force: true }).catch((error: Error) => {
        // `force` already tolerates a missing file, so reaching here means
        // something else — a permission problem. The row is repaired either
        // way; this is a leaked file, not a failed repair, and must not be
        // counted as one.
        deps.log(`repair: group ${row.groupId}: could not remove ${row.posterPath}: ${error.message}`);
      });
    }

    result.repaired += 1;
  }

  return result;
}
