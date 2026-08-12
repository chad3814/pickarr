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

function comparisonKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Whole days between two ISO dates, or `null` if either is unusable. */
function daysApart(left: string | null, right: string | null): number | null {
  if (left === null || right === null) return null;
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(a - b) / MS_PER_DAY;
}

function sameSite(candidate: MetadataCandidate, query: MetadataQuery): boolean {
  const wanted = query.siteName;
  if (wanted === undefined) return false;
  return comparisonKey(candidate.siteName) === comparisonKey(wanted);
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
    const hit = onSite.find((c) => comparisonKey(c.title) === wanted);
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
    const titled = finalists.filter((entry) => comparisonKey(entry.candidate.title) === wanted);
    if (titled.length > 0) finalists = titled;
  }

  const reason = `ambiguous: ${inWindow.length} candidates within date window`;
  if (finalists.length !== 1) {
    for (const entry of inWindow) nearMisses.push({ candidate: entry.candidate, reason });
    return { confirmed: null, nearMisses };
  }

  const winner = finalists[0]!.candidate;
  for (const entry of inWindow) {
    if (entry.candidate !== winner) nearMisses.push({ candidate: entry.candidate, reason });
  }
  return { confirmed: winner, nearMisses };
}
