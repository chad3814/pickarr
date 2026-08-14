import type { GroupIdentity } from '@pickarr/plugin-api';

/**
 * The number of leading words a performer query is built from.
 *
 * Two, because a performer is billed as a first and last name and two words is
 * the shortest run that can distinguish one. One word is not merely weaker, it
 * is actively wrong: `resolve-sites.ts` documents `Free.Use.Fantasy` confirming
 * the real-but-wrong site `Free` on a one-word retry, and a one-word performer
 * query has the same failure with a worse consequence — a name written onto a
 * group's cast rather than a site guessed at.
 */
const WORDS = 2;

/**
 * The first two words of the group's title, or `null` when it has fewer.
 *
 * `display.title` is already the right text to cut: `buildRelease` puts the site
 * in `display.subtitle`, the date in `display.date`, and the quality suffix into
 * `quality` — so the title is the scene title alone and this function needs no
 * stripping rules of its own. Adding any here would be a second place that
 * decides what a title is.
 *
 * Punctuation inside a word is preserved. `Katie O'Neil` and `Anne-Marie Smith`
 * are how the provider spells those names, so a query with the punctuation
 * removed is a query it cannot match. Normalisation belongs to *comparison*,
 * which happens in the host's match rule against a returned name — not to the
 * query, which has to look like the thing being searched for.
 */
export function scenePerformerQuery(group: GroupIdentity): string | null {
  const words = group.display.title.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length < WORDS) return null;
  return words.slice(0, WORDS).join(' ');
}
