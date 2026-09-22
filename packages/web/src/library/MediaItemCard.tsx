/**
 * One row of the paged per-category list, expanded into a media item's
 * releases. Self-contained and driven entirely by `item` and `source`: the
 * list this card renders inside holds neither state nor knowledge of
 * `store/gather.ts` on this card's behalf.
 *
 * **The title and poster render immediately from `item`, before anything is
 * gathered.** `item` is the `MediaItemSyncRead` the list already holds, so
 * the card's collapsed state costs nothing beyond what the list already
 * paid for. The rest -- releases, and whatever download each has -- comes
 * from `useGatheredItem` and is fetched only once this card expands.
 *
 * **Artwork is not replicated** (design spec §1.2, #79). The poster below is
 * a request to `/api/artwork/poster/:mediaItemId`, which 404s for most items
 * for a long while yet; `onError` swaps it out rather than letting a broken
 * image blank the rest of the card.
 */
import { useState, type ReactElement } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import { useGatheredItem, type GatheredSource } from './useGatheredItem.ts';
import { ReleaseList } from '@pickarr/plugin-ui';
import type { PickSubmit } from './postPick.ts';

/**
 * This card does not yet render a plugin's own body -- that is
 * `packages/web/src/plugins/registry.ts` and the rewrite of this component
 * that consumes it, both later tasks in this slice -- so there is no
 * `BrowserPlugin.tables` to pass `useGatheredItem` yet. A stable
 * module-level empty array rather than a `[]` literal at the call site:
 * `useGatheredItem`'s own doc says a fresh literal there is a new
 * dependency every render, tearing its subscriptions down and rebuilding
 * them on every render this component makes for reasons unrelated to
 * `tables`.
 */
const NO_TABLES: readonly string[] = [];

export interface MediaItemCardProps {
  source: GatheredSource;
  item: MediaItemSyncRead;
  /**
   * Submits one pick, handed straight to `ReleaseList` and never called
   * here. Required and threaded from `Shell.tsx` rather than defaulted to
   * the real `postPick`, for the reason `ReleaseList.tsx`'s docblock gives:
   * a default doing network I/O is invisible at the call site, and a test
   * that forgets it gets a real `fetch` under jsdom.
   */
  submit: PickSubmit;
}

export function MediaItemCard({ source, item, submit }: MediaItemCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const gathered = useGatheredItem(source, item.id, expanded, NO_TABLES);

  return (
    <article>
      {!posterFailed && (
        <img
          src={`/api/artwork/poster/${String(item.id)}`}
          alt={item.title}
          onError={() => {
            setPosterFailed(true);
          }}
        />
      )}
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((value) => !value);
          }}
        >
          {item.title}
        </button>
      </h2>
      {expanded && gathered !== undefined && <ReleaseList releases={gathered.releases} submit={submit} />}
    </article>
  );
}
