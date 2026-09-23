/**
 * XXX's browse card.
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
 * **This card now declares one table, where it declared none.** Spec §7.2
 * put `XxxRead.siteName` out of scope and this card's `tables` was `[]` on
 * the strength of it; the site is what tells two scenes with the same
 * title apart, so it is in scope now and `xxx_scene` is fetched. That is a
 * real cost -- web reads this table for every card on the page -- and it
 * is the whole reason `tables` is a declaration rather than a free read.
 */
import type { ReactElement } from 'react';
import { CardHeading, ReleaseList, useExpansion, type BrowserPlugin, type CardProps, type PluginRows } from '@pickarr/plugin-ui';

/** The replica table this card reads, named once so the declaration and the read cannot drift. */
const SCENE_TABLE = 'xxx_scene';

/**
 * This scene's site name, or `undefined` when there is none to show.
 *
 * **Narrowed with `in`, never asserted.** `PluginRows` is
 * `readonly unknown[]` deliberately: a replica outlives the build that
 * wrote it, so a row here may have been written by an older contract than
 * this code compiles against, and `as XxxRead` would turn that into a
 * runtime read of a field that is not there. `plugin.ts`'s own
 * `PluginRows` doc states the rule; this is it applied.
 *
 * Three things all read as "no site", and deliberately render the same
 * nothing rather than three different somethings:
 *
 * - the table was declared but this item has no scene row;
 * - the row is there and `siteName` is `null`, which the host's own left
 *   join produces for a scene whose site is unknown (`sync.ts`: "a scene
 *   whose site is unknown is still a scene worth having");
 * - the row is shaped like nothing this build understands.
 *
 * The empty string is excluded too. It is not a site name, and it would
 * render an empty `<small>` -- a flex item with no content, which pushes
 * the layout around for no visible reason.
 */
export function siteNameOf(rows: PluginRows): string | undefined {
  for (const row of rows[SCENE_TABLE] ?? []) {
    if (typeof row !== 'object' || row === null) continue;
    if (!('siteName' in row)) continue;
    const { siteName } = row;
    if (typeof siteName === 'string' && siteName !== '') return siteName;
  }
  return undefined;
}

function XxxCard({ item, rows, gathered, onExpandedChange, submit }: CardProps): ReactElement {
  const { expanded, toggle } = useExpansion(onExpandedChange);
  const site = siteNameOf(rows);

  return (
    <>
      {/*
        `trailing`, not appended to `headline`: the site is set apart on
        purpose -- pushed right and dimmed by web's stylesheet -- because
        it labels the scene rather than naming it. A film's year goes the
        other way (`plugin-movie/src/browser.tsx` builds `Title (2024)`
        into the headline itself), because `Title (2024)` is what a film
        is actually called.

        Omitting the prop when there is no site, rather than passing an
        empty string, is what keeps `CardHeading` from rendering an empty
        element -- see its own doc.
      */}
      <CardHeading
        headline={item.title}
        {...(site === undefined ? {} : { trailing: site })}
        expanded={expanded}
        onToggle={toggle}
      />
      {expanded && gathered !== undefined && <ReleaseList releases={gathered.releases} submit={submit} />}
    </>
  );
}

export const xxxBrowser: BrowserPlugin = {
  id: 'xxx',
  label: 'XXX',
  tables: [SCENE_TABLE],
  Card: XxxCard,
};
