import type { QualityTokens } from './client.ts';

export function formatQuality(quality: QualityTokens): string {
  const parts: string[] = [];
  if (quality.resolution !== undefined) parts.push(`${quality.resolution}p`);
  if (quality.source !== undefined) parts.push(quality.source);
  if (quality.videoCodec !== undefined) parts.push(quality.videoCodec);
  if (quality.releaseGroup !== undefined) parts.push(quality.releaseGroup);
  return parts.length === 0 ? 'unknown quality' : parts.join(' · ');
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * A string with something in it, or `null`.
 *
 * `maybeStr` in `db/row.ts` folds only `NULL` and `undefined` into `null`, so an
 * empty column reaches the view as an empty string and nothing upstream
 * normalises it. Every consumer that would render such a value has to decide
 * what an empty one means, and for all of them so far the answer is "the same
 * as absent": an empty provider title renders a heading with no text, an empty
 * context part renders a span the sibling separator then decorates so the line
 * reads ` · 2023-04-15`, and an empty synopsis renders a paragraph whose margin
 * is blank space with nothing in it.
 *
 * Here rather than private to a component because `groupTitle` needs the same
 * question answered the same way. `commit.ts`'s `isText` guards the same class
 * of value for `display`'s own optional strings, but only against `undefined`,
 * so it is not this.
 */
export function text(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * A running time in seconds, as `1h 30m` (or `30m` under an hour) — the
 * provider stores `duration_s`, but nobody reading a card wants to do
 * seconds-to-minutes arithmetic in their head. Rounded to the nearest minute
 * rather than truncated, so a duration a few seconds shy of a boundary does
 * not read as a whole minute shorter than it is.
 */
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/**
 * How long ago something started, as a single coarse unit — `3h`, `2d`,
 * `45m` — never a live-updating clock: the row re-renders on the next poll
 * like everything else on this screen, and the number is only ever as fresh
 * as that poll. Floored rather than rounded, so "missing for 1h" cannot read
 * as an hour that has not actually elapsed yet.
 */
export function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'under a minute';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}
