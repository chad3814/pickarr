import type { QualityTokens } from './types.ts';

const RESOLUTION_WEIGHT = 1_000_000;
const SOURCE_WEIGHT = 10_000;
const CODEC_WEIGHT = 1_000;

const SOURCE_RANK: Record<string, number> = {
  cam: 0,
  webrip: 2,
  web: 3,
  'web-dl': 4,
  siterip: 4,
  hdtv: 3,
  bluray: 6,
  remux: 7,
};

const VIDEO_CODEC_RANK: Record<string, number> = {
  divx: 0,
  xvid: 0,
  h264: 2,
  x264: 2,
  avc: 2,
  h265: 4,
  x265: 4,
  hevc: 4,
  av1: 5,
};

function rank(table: Record<string, number>, token: string | undefined): number {
  if (token === undefined) return 1;
  return table[token.toLowerCase().replace(/[\s._]/g, '')] ?? 1;
}

/**
 * Ranks a release on the dimensions every media type shares. Scores are only
 * ever compared between releases in the same group, so the absolute value
 * carries no meaning across plugins.
 *
 * The weights are deliberately ordered by magnitude so a lower tier can never
 * overtake a higher one: resolution beats source, source beats codec, and size
 * only ever breaks ties.
 */
export function scoreStandardQuality(quality: QualityTokens): number {
  const resolution = quality.resolution ?? 0;
  const sizeTiebreak = Math.min(quality.sizeBytes ?? 0, 500_000_000_000) / 500_000_000_000;

  return (
    resolution * RESOLUTION_WEIGHT +
    rank(SOURCE_RANK, quality.source) * SOURCE_WEIGHT +
    rank(VIDEO_CODEC_RANK, quality.videoCodec) * CODEC_WEIGHT +
    sizeTiebreak
  );
}
