/**
 * A release's video resolution, read off its filename.
 *
 * **Read here because 2.0 stores one nowhere.** `rss_item.resolution` is the
 * lookup state (`contract`'s `Resolution`), not a video resolution --
 * `contract/src/tokens.ts` has the whole of that, and issue #98 tracks
 * storing a real one. Until something does, the filename is the only
 * evidence a client holds, and a release name states its resolution
 * outright far more often than not.
 *
 * **A display hint, never a fact to act on.** Nothing that files or ranks a
 * release may read this: it is a pattern over a string a stranger wrote,
 * and `null` means only that the name did not say.
 */

/**
 * A scan height and its scan letter, standing as a whole token -- bounded by
 * the start or end of the name or by anything that is not a letter or a
 * digit, so `.1080p.`, `[720p]` and `_480p_` match and `21080p` and
 * `1080px` do not.
 */
const SCAN = /(?<![a-z0-9])(4320|2160|1440|1080|720|576|480|360)([pi])(?![a-z0-9])/i;

/** `4K` or `UHD` as a whole token, which a name uses in place of `2160p`. */
const UHD = /(?<![a-z0-9])(?:4k|uhd)(?![a-z0-9])/i;

/**
 * `'1080p'`, `'2160p'` and so on, or `null` when `filename` names none.
 *
 * An explicit scan height wins over `4K`/`UHD`: a name carrying both, such as
 * `UHD.BluRay.1080p`, is a 1080p encode of a UHD source.
 */
export function videoResolutionOf(filename: string): string | null {
  const scan = SCAN.exec(filename);
  if (scan !== null) return `${scan[1] ?? ''}${(scan[2] ?? '').toLowerCase()}`;
  return UHD.test(filename) ? '2160p' : null;
}
