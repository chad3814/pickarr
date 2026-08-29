import { text } from './format.ts';
import type { GroupView } from './client.ts';

/**
 * What a group is called, wherever it is shown.
 *
 * The provider's title when there is one, the plugin's parsed title otherwise.
 * Phase 2 adopted the provider's on the card — the parsed title is
 * performer-name-led where the provider returns the scene's actual title — and
 * this is that rule, moved out of the card now that the master list shows a
 * title too.
 *
 * It is a function rather than a copy in each place because the two disagreeing
 * is a defect that has already happened once: the card's artwork button kept
 * `display.title` after the heading had adopted the provider's, so a
 * screen-reader user heard a name that appeared nowhere on screen. One rule,
 * one call.
 *
 * `title` lives inside the `'confirmed'` member of the `MetadataView` union, so
 * the narrowing is what makes every other state fall back — there is no
 * provider title to read on a group nobody has asked about yet.
 */
export function groupTitle(group: GroupView): string {
  const answered = group.metadata.state === 'confirmed' ? group.metadata : null;
  return text(answered?.title) ?? group.display.title;
}
