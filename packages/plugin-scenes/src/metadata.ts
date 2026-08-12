import type {
  GroupIdentity,
  MetadataCandidate,
  MetadataQuery,
  MetadataRejection,
  MetadataVerdict,
} from '@pickarr/plugin-api';

/**
 * The key's site segment, which since migration 4 is exactly the
 * comparison-key form — lowercased, alphanumerics only. `parse.ts` builds it
 * with the same expression `siteComparisonKey` uses, so a provider's site name
 * can be compared against it with no normalisation on our side.
 */
export function siteSegmentOf(identityKey: string): string {
  return identityKey.split(':')[0] ?? '';
}

/**
 * A group is askable only when it has a site. `display.subtitle` is that site's
 * canonical name; a group without one came from a release whose site could not
 * be settled, and those are exactly the names the README says need a configured
 * site list to file correctly. Searching such a group's title across every site
 * the service knows would return same-titled scenes from elsewhere, and the
 * confirmation rule would be left with nothing to corroborate against.
 */
export function sceneMetadataQuery(group: GroupIdentity): MetadataQuery | null {
  const siteName = group.display.subtitle;
  if (siteName === undefined || siteName.length === 0) return null;

  const title = group.display.title.trim();
  if (title.length === 0) return null;

  // Built by spreading rather than assigning `undefined`: tsconfig sets
  // `exactOptionalPropertyTypes`, so an absent date must be an absent property.
  const date = group.display.date;
  return {
    queries: [title],
    siteName,
    ...(date === undefined ? {} : { date }),
  };
}

/**
 * How far a scene's published date may sit from the date in the release name.
 *
 * Scene dates are wiggly. The date a release name carries is the one whoever
 * packaged it used, which is not reliably the date the site published under:
 * timezones, staggered regional releases and a site's own backdating each move
 * it by a day or two.
 *
 * This is a filter, not a decision. A site publishing daily has five scenes
 * inside this window, so the window narrows the field and the tiebreak settles
 * it — and where the tiebreak cannot, nothing is confirmed.
 */
export const DATE_TOLERANCE_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Lowercase, alphanumerics only — or `null` for "no usable key".
 *
 * `null` rather than `''` matters: punctuation-only text (`'!!!'`, `'???'`) and
 * an absent query both collapse to the empty string, and `'' === ''` would
 * confirm a scene on no evidence at all. Every comparison below requires both
 * sides to be a non-null key, so an unusable key can never equal another one —
 * including another unusable one.
 */
function comparisonKey(text: string): string | null {
  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key.length > 0 ? key : null;
}

/** Two comparison keys, believed equal only when both are usable and match. */
function keysMatch(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left === right;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An ISO `yyyy-mm-dd` date as milliseconds since the epoch, or `null` if the
 * string is not one.
 *
 * `Date.parse` alone is not enough: it accepts `"2021-11"` (defaulting the day)
 * and rolls `"2021-02-30"` into March rather than rejecting it. Requiring the
 * exact shape and then round-tripping the parsed value back to a string catches
 * both — an overflowed date never renders back to the string that produced it.
 */
function parseIsoDate(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const rendered = new Date(ms).toISOString().slice(0, 10);
  return rendered === value ? ms : null;
}

/** Whole days between two ISO dates, or `null` if either is unusable. */
function daysApart(left: string | null, right: string | null): number | null {
  if (left === null || right === null) return null;
  const a = parseIsoDate(left);
  const b = parseIsoDate(right);
  if (a === null || b === null) return null;
  return Math.abs(a - b) / MS_PER_DAY;
}

function sameSite(candidate: MetadataCandidate, query: MetadataQuery): boolean {
  const wanted = query.siteName;
  if (wanted === undefined) return false;
  return keysMatch(comparisonKey(candidate.siteName), comparisonKey(wanted));
}

export function confirmSceneMetadata(
  candidates: readonly MetadataCandidate[],
  query: MetadataQuery,
): MetadataVerdict {
  const nearMisses: MetadataRejection[] = [];
  const onSite: MetadataCandidate[] = [];

  for (const candidate of candidates) {
    if (sameSite(candidate, query)) onSite.push(candidate);
    else nearMisses.push({ candidate, reason: 'site differed' });
  }

  // Dateless group: the title is the only axis left, so it must be exact.
  if (query.date === undefined) {
    const wanted = comparisonKey(query.queries[0] ?? '');
    const matches =
      wanted === null ? [] : onSite.filter((c) => keysMatch(comparisonKey(c.title), wanted));

    // More than one on-site scene shares the title key: there is no date to
    // break the tie, and picking the first would be exactly the "by array
    // position" mistake the dated path's tiebreak refuses to make.
    if (matches.length > 1) {
      const reason = `ambiguous: ${matches.length} candidates share this title`;
      for (const candidate of onSite) {
        nearMisses.push({
          candidate,
          reason: matches.includes(candidate) ? reason : 'title differed',
        });
      }
      return { confirmed: null, nearMisses };
    }

    const hit = matches[0];
    for (const candidate of onSite) {
      if (candidate !== hit) nearMisses.push({ candidate, reason: 'title differed' });
    }
    return { confirmed: hit ?? null, nearMisses };
  }

  const inWindow: { candidate: MetadataCandidate; distance: number }[] = [];
  for (const candidate of onSite) {
    const distance = daysApart(candidate.date, query.date);
    if (distance === null || distance > DATE_TOLERANCE_DAYS) {
      nearMisses.push({ candidate, reason: 'date outside window' });
    } else {
      inWindow.push({ candidate, distance });
    }
  }

  if (inWindow.length === 0) return { confirmed: null, nearMisses };
  if (inWindow.length === 1) {
    return { confirmed: inWindow[0]!.candidate, nearMisses };
  }

  // Several plausible scenes. Narrow by closest date, then by title; confirm
  // only if exactly one survives. Picking by position in the response would
  // attach another scene's performers to the card and never say so.
  const closest = Math.min(...inWindow.map((entry) => entry.distance));
  let finalists = inWindow.filter((entry) => entry.distance === closest);

  if (finalists.length > 1) {
    const wanted = comparisonKey(query.queries[0] ?? '');
    const titled =
      wanted === null
        ? []
        : finalists.filter((entry) => keysMatch(comparisonKey(entry.candidate.title), wanted));
    if (titled.length > 0) finalists = titled;
  }

  // Still tied: this is the genuinely ambiguous outcome the table exists to
  // count, so it keeps the `ambiguous:` label.
  if (finalists.length !== 1) {
    const reason = `ambiguous: ${inWindow.length} candidates within date window`;
    for (const entry of inWindow) nearMisses.push({ candidate: entry.candidate, reason });
    return { confirmed: null, nearMisses };
  }

  // A decided tiebreak: the loser was not ambiguous, it simply lost. Labelling
  // it `ambiguous:` would inflate the very count meant to measure how often
  // the rule sits at its edge.
  const winner = finalists[0]!.candidate;
  for (const entry of inWindow) {
    if (entry.candidate !== winner) {
      nearMisses.push({ candidate: entry.candidate, reason: 'lost tiebreak' });
    }
  }
  return { confirmed: winner, nearMisses };
}
