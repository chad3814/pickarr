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
 * **`tables: ['movie_detail']`, for exactly one column.** Spec §7.2 puts
 * `MovieRead.runtimeMinutes` and `tagline` out of scope, but `imdb_id` is
 * this plugin's own external-link identity, and `MediaDetails` is shared
 * by three plugins, two of which have no IMDb identity at all -- so the
 * link can only be supplied from here, via `extraLinks`.
 *
 * **The year in the title needs no table**, which is why it is here and
 * not behind the `tables` declaration above: `release_date` is a
 * `media_item` column and arrives on `CardProps.item`. See {@link movieHeadline}.
 */
import type { ReactElement } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import {
  CardHeading,
  MediaDetails,
  ReleaseList,
  useExpansion,
  type BrowserPlugin,
  type CardProps,
  type PluginRows,
} from '@pickarr/plugin-ui';

/**
 * This item's `movie_detail` row, or `undefined`.
 *
 * Narrowed rather than asserted: `PluginRows` holds `unknown`, and the
 * replica outlives the build that wrote it -- a row from an older client
 * may not carry `imdbId` at all. A row that does not match is declined,
 * which costs an IMDb badge rather than throwing inside a card.
 */
function movieRowFrom(rows: PluginRows): { readonly imdbId: string | null } | undefined {
  const row = rows['movie_detail']?.[0];
  if (typeof row !== 'object' || row === null || !('imdbId' in row)) return undefined;
  const { imdbId } = row;
  if (imdbId !== null && typeof imdbId !== 'string') return undefined;
  return { imdbId };
}

/**
 * `Title (2024)`, or the bare title when this film has no usable year.
 *
 * **The year comes from `media_item.release_date`, not from a plugin
 * table** -- the date is already on `CardProps.item`, so it needs none of
 * the `movie_detail` row this card declares `tables` for.
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

/** `BrowserPlugin.caption` for a film: the headline the card already shows, `Title (Year)`. `rows` carry nothing a film's name needs. */
export function movieCaption(item: MediaItemSyncRead): string {
  return movieHeadline(item.title, item.releaseDate);
}

function MovieCard({ item, rows, gathered, onExpandedChange, initiallyExpanded, submit, identify }: CardProps): ReactElement {
  const { expanded, toggle } = useExpansion(onExpandedChange, initiallyExpanded);

  // IMDb is this plugin's to supply: `imdb_id` is a `movie_detail` column,
  // and `MediaDetails` is shared by three plugins, two of which have no
  // IMDb identity at all.
  const imdbId = movieRowFrom(rows)?.imdbId ?? null;
  const extraLinks = imdbId === null ? [] : [{ label: 'IMDb', href: `https://www.imdb.com/title/${imdbId}/` }];

  return (
    <>
      <CardHeading headline={movieCaption(item)} expanded={expanded} onToggle={toggle} />
      {expanded && gathered !== undefined && (
        <>
          <MediaDetails item={item} gathered={gathered} extraLinks={extraLinks} />
          <ReleaseList releases={gathered.releases} submit={submit} identify={identify} pluginId={item.pluginId} />
        </>
      )}
    </>
  );
}

export const movieBrowser: BrowserPlugin = {
  id: 'movie',
  label: 'Movies',
  tables: ['movie_detail'],
  tile: 'poster',
  caption: movieCaption,
  Card: MovieCard,
};
