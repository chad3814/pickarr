/**
 * One category's screen: `pluginId`'s media items, newest first, paged on
 * demand via `useMediaItems`, each row expanding into a `MediaItemCard`
 * (design spec §6, §7).
 *
 * **`data-testid={`category-${pluginId}`}` on the root element carries task
 * 4's route-mapping contract forward.** `Shell.test.tsx`'s three mapping
 * tests find whichever screen renders at `/tv`, `/movie` and `/xxx` by this
 * marker, not by its rendered prose, so this component's own text and
 * layout are free to change without touching those tests. That was the
 * point of choosing a marker: task 4 put it on the placeholder this
 * component replaced -- the placeholder and its docblock are gone, but the
 * contract is the marker, and it is kept here. The marker is on this outer
 * element regardless of whether `store` has arrived yet, so it is present
 * the instant the route matches.
 *
 * **`store` is `undefined` until `Shell`'s own store finishes opening**
 * (`Shell.tsx`'s state starts there, same as `useCounts`'s). Nothing is
 * fetched or rendered as a list until a store exists -- `CategoryList`
 * below is the piece that only mounts once one does, so `useMediaItems`
 * itself is never called with nothing to read from.
 */
import type { ReactElement } from 'react';
import { useMediaItems, type MediaItemsSource } from './useMediaItems.ts';
import { MediaItemCard } from './MediaItemCard.tsx';
import type { GatheredSource } from './useGatheredItem.ts';

/** Everything this screen needs from a store: `useMediaItems`'s two members, plus `MediaItemCard`'s own two (through `useGatheredItem`). A real `Store` satisfies this by structural assignment. */
export interface CategorySource extends MediaItemsSource, GatheredSource {}

export interface CategoryProps {
  store: CategorySource | undefined;
  /** `media_item.pluginId` for this category -- `'tv' | 'movie' | 'xxx'` in practice, but this component does not need to know the closed set (`useCounts.ts`'s own doc on why a category is a plugin id, not a table). */
  pluginId: string;
}

export function Category({ store, pluginId }: CategoryProps): ReactElement {
  return (
    <section data-testid={`category-${pluginId}`}>
      {store === undefined ? null : <CategoryList store={store} pluginId={pluginId} />}
    </section>
  );
}

interface CategoryListProps {
  store: CategorySource;
  pluginId: string;
}

function CategoryList({ store, pluginId }: CategoryListProps): ReactElement | null {
  const { items, loadMore, done, empty } = useMediaItems(store, pluginId);

  // `items.length === 0 && !empty` is the one state `empty` cannot yet
  // distinguish from "still loading" on its own -- see `useMediaItems.ts`'s
  // own doc on `empty`. Rendering nothing here, rather than "Nothing here
  // yet", is what keeps that message honest: it appears only once the first
  // page has actually resolved to zero rows.
  if (items.length === 0 && !empty) return null;

  if (empty) return <p>Nothing here yet.</p>;

  return (
    <div>
      {items.map((item) => (
        <MediaItemCard key={item.id} source={store} item={item} />
      ))}
      {!done && (
        <button type="button" onClick={loadMore}>
          Load more
        </button>
      )}
    </div>
  );
}
