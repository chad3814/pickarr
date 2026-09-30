/**
 * Every case the accepted-value rule has to decide, shared by
 * `normalizeVideoResolution`'s test and the host migration's SQL
 * restatement of it (`host/test/db/migrate.test.ts`), so the two cannot
 * disagree without one of them failing.
 */
export const VIDEO_RESOLUTION_CASES: readonly (readonly [unknown, string | null])[] = [
  ['480p', '480p'],
  ['720p', '720p'],
  ['1080p', '1080p'],
  ['1080i', '1080i'],
  ['2160p', '2160p'],
  ['4320p', '4320p'],
  ['1080P', '1080p'],
  ['1080', null],
  ['p', null],
  ['10800p', null],
  ['80p', null],
  ['4K', null],
  ['UHD', null],
  ['1080p/', null],
  [' 1080p', null],
  ['', null],
  [1080, null],
  [null, null],
  [undefined, null],
];
