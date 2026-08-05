import type { DownloadedFile, ImportPlan, ParsedRelease } from '@pickarr/plugin-api';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.wmv', '.m4v', '.mov', '.mpg']);
const JUNK_PATTERN = /(^|[^a-z])(sample|proof|screens?|trailer)([^a-z]|$)/i;

// The extension is lowercased unconditionally so that `scene.MP4` and
// `scene.mp4` produce the same destination path. This is load-bearing for
// destination stability (see titleCaseSlug below): the same identity must
// always resolve to the same path regardless of how the source file's
// extension happened to be cased.
function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index).toLowerCase();
}

/** Strips characters that are invalid or hazardous in a path segment. */
function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned : 'Unknown';
}

/**
 * Renders a normalized, hyphen-joined slug (e.g. `alex-coal`) as a
 * human-readable, title-cased segment (`Alex Coal`).
 *
 * Destinations are derived from `identityKey`'s slugs rather than from the
 * release's raw display strings so that any two releases the parser
 * considers the same scene -- same site, date, and scene slug -- always
 * resolve to the same path. Two releases can carry the same identity while
 * differing in casing, spacing, or punctuation (that is the whole point of
 * normalization in `identityKey`); deriving the path from the raw display
 * strings would let that surface variation leak into the path and split one
 * scene's files across two destinations.
 */
function titleCaseSlug(value: string): string {
  return value
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Counts path segments, e.g. `extras/scene.mp4` has depth 2. */
function pathDepth(relativePath: string): number {
  return relativePath.split('/').filter((segment) => segment.length > 0).length;
}

/**
 * Picks the best candidate among files that are all plausible imports.
 * Shallower paths win regardless of size, because release layouts put the
 * real content at (or near) the root and relegate bonus/extra content to
 * subfolders -- a large file nested in a subfolder is evidence of *more*
 * bonus content, not a better copy of the main scene. Size only breaks ties
 * between files at the same depth, where "biggest" is a reasonable proxy for
 * "most complete/highest quality" encode of the same content.
 */
function pickBest(candidates: DownloadedFile[]): DownloadedFile {
  let chosen = candidates[0]!;
  for (const candidate of candidates) {
    const candidateDepth = pathDepth(candidate.relativePath);
    const chosenDepth = pathDepth(chosen.relativePath);
    if (candidateDepth < chosenDepth) {
      chosen = candidate;
    } else if (candidateDepth === chosenDepth && candidate.sizeBytes > chosen.sizeBytes) {
      chosen = candidate;
    }
  }
  return chosen;
}

export function planSceneImport(
  media: ParsedRelease,
  files: DownloadedFile[],
): ImportPlan | null {
  const videoFiles = files.filter((candidate) =>
    VIDEO_EXTENSIONS.has(extensionOf(candidate.relativePath)),
  );

  if (videoFiles.length === 0) return null;

  // Junk filtering discriminates among candidates; it never empties the
  // result. If every video looks junk-named, the least-bad option (by depth
  // and size) is still a better outcome than refusing to import at all --
  // a lone "trailer_of_love.mp4" as the only file present is plausibly the
  // real scene, not evidence that nothing worth importing exists.
  const nonJunk = videoFiles.filter((candidate) => !JUNK_PATTERN.test(candidate.relativePath));
  const candidates = nonJunk.length > 0 ? nonJunk : videoFiles;

  const chosen = pickBest(candidates);

  const [siteSlug, date, sceneSlug] = media.identityKey.split(':');
  const site = sanitizeSegment(titleCaseSlug(siteSlug ?? 'unknown'));
  const scene = sanitizeSegment(titleCaseSlug(sceneSlug ?? 'unknown'));
  const dateSegment = sanitizeSegment(date ?? 'unknown');

  return {
    files: [
      {
        source: chosen.absolutePath,
        destination: `${site}/${dateSegment} - ${scene}${extensionOf(chosen.relativePath)}`,
      },
    ],
  };
}
