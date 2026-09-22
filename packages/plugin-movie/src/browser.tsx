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
 */
import type { ReactElement } from 'react';
import { CardHeading, ReleaseList, useExpansion, type BrowserPlugin, type CardProps } from '@pickarr/plugin-ui';

function MovieCard({ item, gathered, onExpandedChange, submit }: CardProps): ReactElement {
  const { expanded, toggle } = useExpansion(onExpandedChange);

  return (
    <>
      <CardHeading headline={item.title} expanded={expanded} onToggle={toggle} />
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
