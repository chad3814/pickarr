import type { DownloadedFile, ImportPlan, ParsedRelease } from '@pickarr/plugin-api';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.wmv', '.m4v', '.mov', '.mpg']);
const JUNK_PATTERN = /(^|[^a-z])(sample|proof|screens?|trailer)([^a-z]|$)/i;

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

export function planSceneImport(
  media: ParsedRelease,
  files: DownloadedFile[],
): ImportPlan | null {
  const candidates = files
    .filter((candidate) => VIDEO_EXTENSIONS.has(extensionOf(candidate.relativePath)))
    .filter((candidate) => !JUNK_PATTERN.test(candidate.relativePath));

  if (candidates.length === 0) return null;

  let chosen = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.sizeBytes > chosen.sizeBytes) chosen = candidate;
  }

  const site = sanitizeSegment(media.display.subtitle ?? 'Unknown');
  const date = sanitizeSegment(media.display.date ?? 'Unknown');
  const scene = sanitizeSegment(media.display.title);

  return {
    files: [
      {
        source: chosen.absolutePath,
        destination: `${site}/${date} - ${scene}${extensionOf(chosen.relativePath)}`,
      },
    ],
  };
}
