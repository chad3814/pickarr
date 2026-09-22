/**
 * `plugin-tv`'s browser card: the headline a collapsed row reads (design
 * spec §4, acceptance 1), and the release list once the card expands.
 *
 * **Imports nothing from node, and not this package's own `index.ts`.**
 * `index.ts` reaches `@pickarr/openmetadata` and, through it, `node:sqlite`
 * -- exactly the import `npm run build`'s browser bundle cannot carry
 * (Global Constraint). This module reaches into the package only through
 * `./headline.ts`, which is itself node-free, and otherwise only into
 * `@pickarr/contract` and `@pickarr/plugin-ui`.
 *
 * **The headline comes from `rows`, never from `gathered`.** `rows` is on
 * `CardProps` unconditionally, including on a card nobody has expanded yet
 * (`@pickarr/plugin-ui`'s own doc); `gathered` is `undefined` until the
 * expand-time gather lands. An earlier version of this design routed a
 * card's rows through that gather instead, which made the collapsed
 * headline impossible to build, and was reworked for exactly that reason.
 * `release` below is read from `rows` alone, so it is available on the very
 * first render.
 *
 * **No wrapper element of its own.** `web/src/library/MediaItemCard.tsx`
 * renders the `<article>` that *is* one card, puts the poster in it, and
 * renders this body beneath -- so a body opening an `<article>` of its own
 * would make two per row: `web/src/styles/library.css`'s `article img`
 * rule would stop reaching the poster, and
 * `packages/e2e/tests/shell.spec.ts`'s `getByRole('article')` would resolve
 * to two elements and fail Playwright's strict mode. Web keeps the poster
 * and the card element; a plugin owns everything below it (design spec §2).
 */
import type { ReactElement } from 'react';
import type { TvRead } from '@pickarr/contract';
import { CardHeading, ReleaseList, useExpansion, type BrowserPlugin, type CardProps } from '@pickarr/plugin-ui';
import { tvHeadline } from './headline.ts';

/**
 * The one table this plugin's card reads. Also `packages/plugin-tv/src/migrations.ts`'s
 * table name and `packages/plugin-tv/src/sync.ts`'s `SyncedTable.table`, and
 * (not imported here -- see this file's own doc) `index.ts`'s `TV_PLUGIN_ID`
 * prefix that `migratePlugin` enforces every one of this plugin's table
 * names to start with.
 */
const TV_RELEASE_TABLE = 'tv_release';

/**
 * Narrows one `tv_release` row to `TvRead`, with `in` guards rather than a
 * cast -- a replica persists across client builds, so a row an older build
 * wrote is read against today's contract, and a row that does not match
 * declines here instead of reaching `tvHeadline` and throwing (Global
 * Constraint).
 *
 * **Checks only the fields `tvHeadline` dereferences -- `seriesTitle`,
 * `seasonNumber` and `episodeNumber` -- and no more**, the same restraint
 * `store/gather.ts`'s own predicates take
 * (`packages/web/src/store/gather.ts:79`: "Each predicate checks the fields
 * this module itself dereferences, and no more"). `TvRead.kind` is not
 * checked, for the reason `headline.ts`'s own docblock gives: nothing on
 * this card's path reads it either, so checking it would be a second
 * statement of a rule this module does not use.
 */
function isTvRelease(value: unknown): value is TvRead {
  return (
    typeof value === 'object' &&
    value !== null &&
    'seriesTitle' in value &&
    typeof value.seriesTitle === 'string' &&
    'seasonNumber' in value &&
    (value.seasonNumber === null || typeof value.seasonNumber === 'number') &&
    'episodeNumber' in value &&
    (value.episodeNumber === null || typeof value.episodeNumber === 'number')
  );
}

/**
 * This item's `tv_release` row, or `undefined` when there is none or the one
 * present does not match `TvRead`'s shape (`isTvRelease`). `tv_release`
 * carries a unique index on `media_item_id`
 * (`packages/plugin-tv/src/migrations.ts`'s `tv_release_media_item`), so
 * `rows.tv_release` never legitimately holds more than one row for the item
 * this card renders -- `.find` rather than reading `[0]` directly, so a
 * malformed leading row does not hide a well-formed one behind it.
 */
function tvRelease(rows: CardProps['rows']): TvRead | undefined {
  return (rows[TV_RELEASE_TABLE] ?? []).find(isTvRelease);
}

/**
 * The expander is `@pickarr/plugin-ui`'s, not this card's (issue #106).
 * `useExpansion` owns the state and the rule that every transition is
 * reported to web, closing included; `CardHeading` owns the `<h2>` and its
 * announcement. What is left here is the only thing that differs between
 * the three shipped cards: which string the headline is.
 */
function TvCard({ item, rows, gathered, onExpandedChange, submit }: CardProps): ReactElement {
  const { expanded, toggle } = useExpansion(onExpandedChange);
  const release = tvRelease(rows);
  // An item with no `tv_release` row, or one that failed `isTvRelease`,
  // renders `item.title` alone -- there is no series or episode number to
  // build a headline out of.
  const headline = release === undefined ? item.title : tvHeadline(release, item.title);

  return (
    <>
      <CardHeading headline={headline} expanded={expanded} onToggle={toggle} />
      {expanded && gathered !== undefined && <ReleaseList releases={gathered.releases} submit={submit} />}
    </>
  );
}

export const tvBrowser: BrowserPlugin = {
  id: 'tv',
  label: 'TV',
  tables: [TV_RELEASE_TABLE],
  Card: TvCard,
};
