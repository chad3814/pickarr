/**
 * Movies's browse card.
 *
 * **The expander comes from `@pickarr/plugin-ui` and is not written here
 * (issue #106).** `useExpansion` owns the open/closed state and the rule
 * that *every* transition is reported to web, closing included;
 * `CardHeading` owns the `<h2>` and its `aria-expanded`. This card supplies
 * a headline and gates its own body, which is all that differs between the
 * three shipped plugins today.
 *
 * `plugin-ui/src/expansion.tsx` has why those two are shared and why they
 * are two pieces rather than one card component. `test/expansion.test.tsx`
 * fails if any plugin hand-writes `aria-expanded` again.
 *
 * **No `tables`.** This card reads no replica row: spec §7.2 puts
 * `MovieRead.runtimeMinutes` and `tagline` out of scope, and declaring a
 * table a card does not read would make the page fetch rows nothing uses.
 * When that content lands it goes in the body gate below.
 *
 * **The year in the title needs no table either**, which is why it is here
 * and not behind a `tables` declaration: `release_date` is a `media_item`
 * column and arrives on `CardProps.item`. See {@link movieHeadline}.
 */
import type { ReactElement } from 'react';
import { CardHeading, ReleaseList, useExpansion, type BrowserPlugin, type CardProps } from '@pickarr/plugin-ui';

/**
 * `Title (2024)`, or the bare title when this film has no usable year.
 *
 * **The year comes from `media_item.release_date`, not from a plugin
 * table**, so this card still declares no `tables` -- the date is already
 * on `CardProps.item`.
 *
 * **The first four characters, never a `Date`.** `release_date` is the
 * lookup service's own ISO `yyyy-mm-dd` string, and parsing it introduces
 * a timezone where there is none: `new Date('2009-01-01').getFullYear()`
 * is **2008** anywhere west of UTC, so a film would be labelled a year
 * early for half the planet and correctly for whoever wrote the test.
 * This is the same rule, and the same reason, as `resolveYear` in
 * `@pickarr/openmetadata` -- which is why `Title (2024)` here matches the
 * `{title} ({year})` a film library path is named by.
 *
 * Anything not shaped like four digits contributes nothing. A film with no
 * release date renders exactly what it rendered before, rather than
 * `Title ()`.
 */
export function movieHeadline(title: string, releaseDate: string | null): string {
  const year = releaseDate === null ? '' : releaseDate.slice(0, 4);
  return /^[0-9]{4}$/.test(year) ? `${title} (${year})` : title;
}

function MovieCard({ item, gathered, onExpandedChange, submit }: CardProps): ReactElement {
  const { expanded, toggle } = useExpansion(onExpandedChange);

  return (
    <>
      <CardHeading headline={movieHeadline(item.title, item.releaseDate)} expanded={expanded} onToggle={toggle} />
      {expanded && gathered !== undefined && <ReleaseList releases={gathered.releases} submit={submit} />}
    </>
  );
}

export const movieBrowser: BrowserPlugin = {
  id: 'movie',
  label: 'Movies',
  tables: [],
  Card: MovieCard,
};
