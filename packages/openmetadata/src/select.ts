/**
 * Which entries of a finished download a plugin copies into its library
 * (design spec 2026-09-22 §3-§4).
 *
 * Pure: it reads relative paths and nothing else, so the host keeps the
 * filesystem and this module keeps the judgement. Generic over the entry so
 * the objects chosen are the objects passed in -- the engine hands them
 * straight back to `LibraryImporter.place`, which checks they belong to the
 * download.
 */

/** Spec §3, verbatim. Lower case; extensions are lower-cased before lookup. */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'webm', 'iso',
]);

/**
 * `S` + one or two digits, `E` + one to three digits, then any further
 * `E<digits>` or `-E<digits>` groups (spec §4.2). For example
 * `Show.S01E01-E02.mkv` names season 1, episodes [1, 2].
 */
const MARKER = /s(\d{1,2})e(\d{1,3})((?:-?e\d{1,3})*)/i;
const FURTHER_EPISODE = /e(\d{1,3})/gi;

export type Expectation =
  | { readonly kind: 'single' }
  | { readonly kind: 'episodes'; readonly season: number | null };

export type SelectionRefusalCode =
  | 'no-video-file'
  | 'too-many-video-files'
  | 'episode-marker-missing'
  | 'episode-marker-duplicate';

export interface SelectionRefusal {
  readonly refusal: SelectionRefusalCode;
}

export interface Selection<T> {
  readonly chosen: readonly T[];
}

function lastSegment(relativePath: string): string {
  const segments = relativePath.split('/');
  return segments[segments.length - 1] ?? '';
}

/** Spec §3: a video extension, and no `sample` anywhere in the relative path. */
export function isCandidate(relativePath: string): boolean {
  if (relativePath.toLowerCase().includes('sample')) return false;
  const name = lastSegment(relativePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return VIDEO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** The season and every episode a filename's marker names, or `null`. */
export function episodeMarker(filename: string): { season: number; episodes: readonly number[] } | null {
  const match = MARKER.exec(filename);
  if (match === null) return null;
  const [, season, first, rest] = match;
  if (season === undefined || first === undefined) return null;
  const further = [...(rest ?? '').matchAll(FURTHER_EPISODE)].map((group) => Number(group[1]));
  return { season: Number(season), episodes: [Number(first), ...further] };
}

function selectEpisodes<T extends { readonly relativePath: string }>(
  candidates: readonly T[],
  season: number | null,
): Selection<T> | SelectionRefusal {
  const markers = candidates.map((entry) => episodeMarker(lastSegment(entry.relativePath)));
  // Spec order: missing, then another season, then a duplicate.
  const present = markers.filter((marker) => marker !== null);
  if (present.length !== markers.length) return { refusal: 'episode-marker-missing' };
  if (season !== null && present.some((marker) => marker.season !== season)) {
    return { refusal: 'too-many-video-files' };
  }
  const seen = new Set<string>();
  for (const marker of present) {
    for (const episode of marker.episodes) {
      const key = `${marker.season}:${episode}`;
      if (seen.has(key)) return { refusal: 'episode-marker-duplicate' };
      seen.add(key);
    }
  }
  return { chosen: candidates };
}

export function select<T extends { readonly relativePath: string }>(
  entries: readonly T[],
  expectation: Expectation | 'unmatched',
): Selection<T> | SelectionRefusal {
  // Spec §4.3: an unmatched release is copied whole; there is nothing to
  // judge it against.
  if (expectation === 'unmatched') return { chosen: entries };
  const candidates = entries.filter((entry) => isCandidate(entry.relativePath));
  if (candidates.length === 0) return { refusal: 'no-video-file' };
  if (expectation.kind === 'single') {
    return candidates.length === 1 ? { chosen: candidates } : { refusal: 'too-many-video-files' };
  }
  return selectEpisodes(candidates, expectation.season);
}
