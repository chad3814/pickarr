import { scoreStandardQuality, type QualityTokens } from '@pickarr/plugin-api';

/**
 * How much an upscale gives up against a native encode of the same resolution.
 *
 * The magnitude is bounded on both sides, and both bounds are load-bearing:
 *
 *  - it must exceed everything below resolution in `scoreStandardQuality`, or
 *    an upscale in a preferred source and codec would still outrank a native
 *    file. That ceiling is 7 * 10_000 (source) + 5 * 1_000 (codec) + 1 (the
 *    size tiebreak, which is normalised to at most 1) = 75_001.
 *  - it must stay below one resolution unit, 1_000_000, or a 2160p upscale
 *    would lose to a native 1080p and the upgrade path would prefer the
 *    smaller file.
 *
 * Anything in that range behaves identically; 100_000 sits clear of both.
 * A tie here is not harmless — `flagUpgrade` acts on a better-or-equal score,
 * so an upscale that merely ties a native 2160p is enough to trash the native
 * file and re-download the stretched one.
 */
const UPSCALE_PENALTY = 100_000;

/**
 * Scene releases usually omit a source token when they are the original rip
 * straight from the site, and state one explicitly when they are a re-encode.
 * Treating a missing source as a site rip therefore ranks originals above
 * re-encodes, which is the opposite of the generic default.
 */
export function scoreScene(quality: QualityTokens): number {
  const base =
    quality.source === undefined
      ? scoreStandardQuality({ ...quality, source: 'siterip' })
      : scoreStandardQuality(quality);

  return quality.extras?.['upscaled'] === true ? base - UPSCALE_PENALTY : base;
}
