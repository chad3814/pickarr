/**
 * One category's screen: `pluginId`'s media items, newest first, paged on
 * demand via `useMediaItems`, each row expanding into a `MediaItemCard`
 * (design spec §6, §7).
 *
 * **`data-testid={`category-${pluginId}`}` on the root element carries task
 * 4's route-mapping contract forward.** `Shell.test.tsx`'s per-category
 * mapping tests find whichever screen renders at each plugin's own path by
 * this marker, not by its rendered prose, so this component's own text and
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
 *
 * **Plugin rows are fetched here, once per page, and handed to each card.**
 * `usePluginRows` reads the whole page's rows in one batched query as soon
 * as `useMediaItems` resolves a page of ids -- before any card expands --
 * because a collapsed card needs its plugin's rows too (design spec §4,
 * acceptance 1), and a per-card fetch gated on expansion cannot answer for
 * one that never expands.
 */
import { useMemo, type ReactElement } from 'react';
import { useMediaItems, type MediaItemsSource } from './useMediaItems.ts';
import { MediaItemCard } from './MediaItemCard.tsx';
import type { GatheredSource } from './useGatheredItem.ts';
import { usePluginRows, emptyPluginRows, type PluginRowsSource } from './usePluginRows.ts';
import type { PickSubmit } from './postPick.ts';

/** Everything this screen needs from a store: `useMediaItems`'s two members, `MediaItemCard`'s own four (through `useGatheredItem`), and `usePluginRows`' one -- `subscribeInserts` is shared by two of the three. A real `Store` satisfies this by structural assignment. */
export interface CategorySource extends MediaItemsSource, GatheredSource, PluginRowsSource {}

export interface CategoryProps {
  store: CategorySource | undefined;
  /** `media_item.pluginId` for this category -- one of the registry's ids in practice, but this component does not need to know which (`useCounts.ts`'s own doc on why a category is a plugin id, not a table). */
  pluginId: string;
  /**
   * This category's plugin's declared replica tables
   * (`@pickarr/plugin-ui`'s `BrowserPlugin.tables`), threaded the same way
   * `pluginId` is. `Shell.tsx` passes the registry entry's own array by
   * reference: it is a module-level constant inside the plugin package, and
   * `usePluginRows` refetches the page whenever this reference changes, so
   * a copy made per render would refetch per render.
   */
  tables: readonly string[];
  /** Submits one pick, forwarded to each card's `ReleaseList` and never called here. A prop rather than a member of `CategorySource`: a store is the replica, and posting to `/api/picks` is not something a replica does. */
  submit: PickSubmit;
}

export function Category({ store, pluginId, tables, submit }: CategoryProps): ReactElement {
  return (
    <section data-testid={`category-${pluginId}`}>
      {store === undefined ? null : (
        <CategoryList store={store} pluginId={pluginId} tables={tables} submit={submit} />
      )}
    </section>
  );
}

interface CategoryListProps {
  store: CategorySource;
  pluginId: string;
  tables: readonly string[];
  submit: PickSubmit;
}

function CategoryList({ store, pluginId, tables, submit }: CategoryListProps): ReactElement | null {
  const { items, loadMore, done, empty } = useMediaItems(store, pluginId);

  // Stable across renders unless `items` itself changes (`useMediaItems`'s
  // own state, replaced wholesale rather than mutated in place): a fresh
  // `.map` every render would be a new array every render, and
  // `usePluginRows` refetches whenever this reference changes.
  const mediaItemIds = useMemo(() => items.map((item) => item.id), [items]);
  const pluginRows = usePluginRows(store, mediaItemIds, tables);

  // One empty-rows value for the whole list, for the same reason
  // `mediaItemIds` is memoised one line up: this is the `rows` prop every
  // card on the page gets until the batch lands, and for every id the batch
  // holds nothing for -- a fresh object per card per render would defeat any
  // memoisation a plugin's own `Card` applied to `rows`. Where the plugin
  // declared no tables at all -- two of the three shipped ones --
  // `emptyPluginRows` answers a single shared frozen value and this memo is
  // redundant; it is here for a plugin that declared some, whose empty-rows
  // object has a key per declared table in it.
  const emptyRows = useMemo(() => emptyPluginRows(tables), [tables]);

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
        <MediaItemCard
          key={item.id}
          source={store}
          item={item}
          rows={pluginRows.get(item.id) ?? emptyRows}
          submit={submit}
        />
      ))}
      {!done && (
        <button type="button" onClick={loadMore}>
          Load more
        </button>
      )}
    </div>
  );
}
