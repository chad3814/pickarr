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
import { ReleaseList } from './ReleaseList.tsx';

export interface MediaItemCardProps {
  source: GatheredSource;
  item: MediaItemSyncRead;
}

export function MediaItemCard({ source, item }: MediaItemCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const gathered = useGatheredItem(source, item.id, expanded);

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
      {expanded && gathered !== undefined && <ReleaseList releases={gathered.releases} />}
    </article>
  );
}
