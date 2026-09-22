/**
 * The line a TV card's expander button reads before anyone expands it:
 * series title, `SxxEyy` where either number is present, then the media
 * item's own title -- unless that title just repeats the series title
 * (design spec §4, acceptance 1).
 *
 * **No branch on `kind`.** `TvRead.kind` is `'series' | 'season' |
 * 'episode'`, and the three differ from each other only in which of
 * `seasonNumber`/`episodeNumber` is `null` -- a series names neither, a
 * season names only its own number, an episode may name both. Branching on
 * `kind` here would be a second statement of that same rule, one that could
 * disagree with the numbers on a row where the two drift -- a stale or
 * hand-edited `kind` with numbers that no longer match it, say. Reading the
 * numbers directly means there is only one rule to keep in sync with the
 * data, and it is the data itself.
 */
import type { TvRead } from '@pickarr/contract';

/** Two digits minimum, and never truncated: episode 147 is `E147`. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function tvHeadline(tv: TvRead, title: string): string {
  const number =
    (tv.seasonNumber === null ? '' : `S${pad(tv.seasonNumber)}`) +
    (tv.episodeNumber === null ? '' : `E${pad(tv.episodeNumber)}`);
  const parts = [tv.seriesTitle, number, title === tv.seriesTitle ? '' : title];
  return parts.filter((part) => part !== '').join(' ');
}
