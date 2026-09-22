/**
 * `plugin-movie`'s browser card: `item.title` in the expander button, and
 * the release list once the card expands -- the same output the shared
 * card (`web/src/library/MediaItemCard.tsx`) renders for this plugin
 * today. `MovieRead.runtimeMinutes`/`tagline` are out of scope for this
 * card (spec §7.2): porting this plugin across the seam unchanged is what
 * proves the seam is not TV-shaped, so `tables` below is `[]` and this
 * module reads nothing from `rows`.
 *
 * **Imports nothing from node, and not this package's own `index.ts`.**
 * `index.ts` reaches `@pickarr/openmetadata` and, through it, `node:sqlite`
 * -- exactly the import `npm run build`'s browser bundle cannot carry
 * (Global Constraint). This module reaches only into `@pickarr/plugin-ui`.
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
import { useState, type ReactElement } from 'react';
import { ReleaseList, type BrowserPlugin, type CardProps } from '@pickarr/plugin-ui';

function MovieCard({ item, gathered, onExpand, submit }: CardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            // `onExpand` is idempotent (`@pickarr/plugin-ui`'s own doc), but
            // it is called only on the transition into expanded rather than
            // on every click, so collapsing this card back down asks web for
            // nothing.
            if (!expanded) onExpand();
            setExpanded(!expanded);
          }}
        >
          {item.title}
        </button>
      </h2>
      {expanded && gathered !== undefined && <ReleaseList releases={gathered.releases} submit={submit} />}
    </>
  );
}

/**
 * `@pickarr/plugin-ui`'s `BrowserPlugin` for film. `id: 'movie'` matches
 * `index.ts`'s `MOVIE_PLUGIN_ID` and `MediaItemSyncRead.pluginId` for every
 * item this plugin creates (not imported from `index.ts` -- see this
 * file's own doc). `label: 'Movies'` is the single source of this plugin's
 * display name: `web/src/plugins/registry.ts` is what the nav and the
 * settings destination row both read it through, so there is no second
 * spelling to drift from. It used to have one -- `web/src/pluginLabels.ts`,
 * deleted when the registry landed. `tables: []` -- see this file's own
 * doc.
 */
export const movieBrowser: BrowserPlugin = {
  id: 'movie',
  label: 'Movies',
  tables: [],
  Card: MovieCard,
};
