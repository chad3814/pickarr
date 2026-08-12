import type { GroupIdentity, MetadataQuery } from '@pickarr/plugin-api';

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
