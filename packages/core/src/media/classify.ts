import { imageSize } from 'image-size';

export type ArtworkKind = 'poster' | 'background';

/**
 * Which slot a downloaded image belongs in, from the image itself.
 *
 * URL shape is a decent heuristic and an unreliable rule. Of the three
 * studio-CDN images in this library whose shape nothing in the payload records,
 * one is a background and one is a poster — and the guess their filenames
 * invite (`1x.webp` and `scenedefault` read like stills, `tour_carlykiss.jpg`
 * reads like a thumbnail) gets the first right and the second wrong. A rule
 * built on URLs would have misfiled one of the only two anyone could verify.
 *
 * Square counts as a poster: the destination that crops it least is the 2:3
 * slot, and a square scene still is likelier to be a cropped portrait than a
 * cropped landscape.
 *
 * `null` for anything that cannot be measured. The caller then has bytes it
 * cannot place, which is a reason to store nothing rather than to guess — and
 * it never throws, because this runs inside the metadata worker's tick.
 *
 * Known limitation: EXIF orientation is not read, so a JPEG stored landscape
 * with a rotation flag that makes it *display* portrait is classified as a
 * background. TPDB's CDN is unlikely to serve one; a studio CDN is where it
 * would appear. The fix, if it is ever needed, is an orientation read here plus
 * a re-run of `reclassify-artwork`, not a schema change.
 */
export function classifyArtwork(bytes: Uint8Array): ArtworkKind | null {
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = imageSize(bytes));
  } catch {
    return null;
  }
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return null;
  return width > height ? 'background' : 'poster';
}
