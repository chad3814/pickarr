/**
 * The grid view of a category (design spec 2026-10-04 §3.3, §3.4): one
 * tile per item showing the image kind its plugin declared, and a dialog
 * holding the item's card when a tile is activated.
 *
 * **Why the catalog record and not a read per tile.** The record carries
 * the rank-0 `poster` and `background` ids (§1), picked during the
 * recompute from rows it already read, so a page of tiles costs the same
 * two requests the filtered list already makes. A read per tile through
 * `by_media_item` would return every release and role too -- the cost #110
 * removed from the card -- and a new rows index would be a read per tile
 * and a reindex of every replica.
 *
 * **The kind comes from the plugin.** `pluginFor(pluginId).tile` is the one
 * place that knows whether this category is browsed by poster or by
 * background; `test/plugins/registry.test.ts` refuses a plugin id spelled
 * here, which is what keeps that true.
 *
 * **One dialog, the same card.** Activating a tile opens `MediaItemCard`
 * with `initiallyExpanded`, so picking, retrying and identifying inside the
 * dialog are the card's own behaviour against the same `submit` and
 * `identify`. If the open item leaves the page -- a filter no longer
 * matches it, or it was tombstoned -- the dialog closes and focus goes to
 * the list, since the tile that would take it back is gone.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import { Dialog, ImagePlaceholder, type IdentifySubmit } from '@pickarr/plugin-ui';
import { pluginFor } from '../plugins/registry.ts';
import { artworkUrl } from '../store/gather.ts';
import type { CatalogRecord } from '../store/catalog.ts';
import type { CatalogItemsResult } from './useCatalogItems.ts';
import type { GatheredSource } from './useGatheredItem.ts';
import { usePluginRows, emptyPluginRows, type PluginRowsSource } from './usePluginRows.ts';
import { useInfiniteScroll } from './useInfiniteScroll.ts';
import { MediaItemCard } from './MediaItemCard.tsx';
import type { PickSubmit } from './postPick.ts';

export interface GridSource extends GatheredSource, PluginRowsSource {}

export interface ItemGridProps {
  store: GridSource;
  pluginId: string;
  tables: readonly string[];
  submit: PickSubmit;
  identify: IdentifySubmit;
  result: CatalogItemsResult;
  emptyMessage: string;
}

type TileKind = 'poster' | 'background';

/** The kind as a placeholder label spells it: `No poster for …`, `No background for …`. */
function kindLabel(kind: TileKind): string {
  return kind === 'poster' ? 'poster' : 'background';
}

interface TileProps {
  item: MediaItemSyncRead;
  kind: TileKind;
  imageId: number | null;
  onOpen: (id: number) => void;
}

function Tile({ item, kind, imageId, onOpen }: TileProps): ReactElement {
  // Latched per image id, not per tile: a 404 on this id stays a
  // placeholder, and a re-rank that changes the id is a fresh attempt.
  const [failedId, setFailedId] = useState<number | null>(null);
  const showImage = imageId !== null && failedId !== imageId;
  // The placeholder is an `svg role="img"` with its own name, which would
  // otherwise be folded into the button's name ("No poster for X X"); naming
  // the button by its caption keeps it exactly the title either way.
  const captionId = useId();
  return (
    <li>
      <button type="button" aria-haspopup="dialog" aria-labelledby={captionId} onClick={() => { onOpen(item.id); }}>
        {showImage ? (
          <img src={artworkUrl(kind, imageId)} alt="" onError={() => { setFailedId(imageId); }} />
        ) : (
          <ImagePlaceholder label={`No ${kindLabel(kind)} for ${item.title}`} />
        )}
        <span id={captionId}>{item.title}</span>
      </button>
    </li>
  );
}

export function ItemGrid({ store, pluginId, tables, submit, identify, result, emptyMessage }: ItemGridProps): ReactElement | null {
  const { items, records, loadMore, done, empty } = result;
  // `pluginFor` is typed `undefined` for an unregistered id. `Shell.tsx` builds
  // the category routes with `BROWSER_PLUGINS.map(...)`, so a category only
  // mounts for a registered id and the fallback is for the type, not a
  // reachable case.
  const kind: TileKind = pluginFor(pluginId)?.tile ?? 'poster';

  const mediaItemIds = useMemo(() => items.map((item) => item.id), [items]);
  const pluginRows = usePluginRows(store, mediaItemIds, tables);
  const emptyRows = useMemo(() => emptyPluginRows(tables), [tables]);
  const sentinel = useInfiniteScroll(loadMore, !done);

  const [openId, setOpenId] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const openItem = openId === null ? undefined : items.find((item) => item.id === openId);

  // The open item left the page: close, and put focus somewhere real.
  useEffect(() => {
    if (openId !== null && openItem === undefined) {
      setOpenId(null);
      listRef.current?.focus();
    }
  }, [openId, openItem]);

  if (items.length === 0 && !empty) return null;
  if (empty) return <p>{emptyMessage}</p>;

  return (
    <div>
      <ul className="tiles" data-tile={kind} ref={listRef} tabIndex={-1}>
        {items.map((item) => (
          <Tile key={item.id} item={item} kind={kind} imageId={imageFor(records.get(item.id), kind)} onOpen={setOpenId} />
        ))}
      </ul>
      {!done && (
        <>
          <div ref={sentinel} data-testid="load-more-sentinel" />
          <button type="button" onClick={loadMore}>Load more</button>
        </>
      )}
      {openItem !== undefined && (
        <Dialog label={openItem.title} className="item-dialog" onClose={() => { setOpenId(null); }}>
          <button type="button" onClick={() => { setOpenId(null); }}>Close</button>
          <MediaItemCard
            source={store}
            item={openItem}
            rows={pluginRows.get(openItem.id) ?? emptyRows}
            submit={submit}
            identify={identify}
            initiallyExpanded
          />
        </Dialog>
      )}
    </div>
  );
}

function imageFor(record: CatalogRecord | undefined, kind: TileKind): number | null {
  if (record === undefined) return null;
  return kind === 'poster' ? record.poster : record.background;
}
