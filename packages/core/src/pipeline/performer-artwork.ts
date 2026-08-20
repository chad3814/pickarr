import type { DatabaseSync } from 'node:sqlite';
import { performersNeedingArtwork, setPerformerArtwork } from '../db/performers.ts';
import { cacheImage, performerArtworkKey, type ArtworkDeps } from '../media/artwork.ts';

/**
 * Caches whatever artwork the named performers still need, and records where it
 * went.
 *
 * A leaf module rather than a function on either pass, for the reason
 * `backoffFor` documents where it does the same: `pipeline/metadata.ts` and
 * `pipeline/performers.ts` both need this, and sharing it *from* either one makes
 * the two passes import each other. `metadata.ts` already imports
 * `enqueuePerformerSearch` from `performers.ts`, so putting this there would
 * complete exactly the cycle that comment describes as working only by accident.
 *
 * Both passes need it because both can be the writer that first links a
 * performer, and until this existed only one of them cached anything. The scene
 * pass's loop ran at the end of `lookUpOne`, which finishes *before*
 * `enqueuePerformerSearch` is called for that group — so a performer the search
 * later linked was never in the set that loop looked at, on that tick or any
 * other. `face_url` was recorded and `face_path` stayed null, and `hasAvatar`
 * reads the path, so every performer the search found rendered with no avatar.
 *
 * Never throws: `cacheImage` answers `null` for a fetch that failed, and a
 * missing avatar is decoration lost, not an answer lost. Both callers have
 * already committed the link by the time they get here, deliberately — a cast
 * must not be undone by a dead image url.
 *
 * `performersNeedingArtwork` and the per-kind check below guard different things.
 * The query's WHERE is an OR across the two url/path pairs, so it skips only a
 * performer who needs neither image — the common case, once most of the table is
 * already cached — sparing that performer the loop entirely. It still returns a
 * performer who needs just one of the two, because the OR is satisfied by either
 * half. The per-kind `path !== null` check is what stops that performer's
 * *other*, already-cached half from being fetched again: one url succeeding while
 * the other 404s or times out is an ordinary partial failure, not a
 * hypothetical, and this is the only thing standing between it and a repeat fetch
 * every time another group names the same performer.
 */
export async function cachePerformerArtwork(
  artwork: ArtworkDeps,
  db: DatabaseSync,
  performerIds: readonly number[],
): Promise<void> {
  for (const performer of performersNeedingArtwork(db, performerIds)) {
    for (const kind of ['face', 'image'] as const) {
      const url = kind === 'face' ? performer.faceUrl : performer.imageUrl;
      const path = kind === 'face' ? performer.facePath : performer.imagePath;
      if (url === null || path !== null) continue;
      // Sequential on purpose: these are remote fetches against one provider,
      // and both callers already walk their rows one at a time rather than
      // opening the throttle their cooldown logic exists to respect.
      // eslint-disable-next-line no-await-in-loop -- one provider, one performer at a time; not batched on purpose
      const stored = await cacheImage(artwork, performerArtworkKey(performer.id, kind), url);
      if (stored !== null) setPerformerArtwork(db, performer.id, kind, stored);
    }
  }
}
