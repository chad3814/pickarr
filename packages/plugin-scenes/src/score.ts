import { scoreStandardQuality, type QualityTokens } from '@pickarr/plugin-api';

/**
 * Scene releases usually omit a source token when they are the original rip
 * straight from the site, and state one explicitly when they are a re-encode.
 * Treating a missing source as a site rip therefore ranks originals above
 * re-encodes, which is the opposite of the generic default.
 */
export function scoreScene(quality: QualityTokens): number {
  if (quality.source !== undefined) return scoreStandardQuality(quality);
  return scoreStandardQuality({ ...quality, source: 'siterip' });
}
