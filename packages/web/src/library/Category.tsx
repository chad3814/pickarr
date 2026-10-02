/**
 * One category's screen: `pluginId`'s media items, newest first, paged on
 * demand, each row expanding into a `MediaItemCard`
 * (design spec §6, §7). The unfiltered view pages `rows` through
 * `useMediaItems`; a picked filter or a search term pages the derived
 * `catalog` store through `useCatalogItems` (browse-filter-search design
 * spec §3), with the filter and term read from the URL by `useBrowseQuery`.
 *
 * **`data-testid={`category-${pluginId}`}` on the root element is the
 * route-mapping contract.** `Shell.test.tsx`'s per-category
 * mapping tests find whichever screen renders at each plugin's own path by
 * this marker, not by its rendered prose, so this component's own text and
 * layout are free to change without touching those tests. That was the
 * point of choosing a marker. It first sat on a placeholder this component
 * replaced; the placeholder is gone and the marker moved here. The marker is
 * on this outer
 * element regardless of whether `store` has arrived yet, so it is present
 * the instant the route matches.
 *
 * **`store` is `undefined` until `Shell`'s own store finishes opening**
 * (`Shell.tsx`'s state starts there, same as `useCounts`'s). Nothing is
 * fetched or rendered as a list until a store exists -- `DefaultList` and
 * `FilteredList` below are the pieces that only mount once one does, so
 * `useMediaItems` and `useCatalogItems` themselves are never called with nothing to read from.
 *
 * **Plugin rows are fetched here, once per page, and handed to each card.**
 * `usePluginRows` reads the whole page's rows in one batched query as soon
 * as the list hook resolves a page of ids -- before any card expands --
 * because a collapsed card needs its plugin's rows too (design spec §4,
 * acceptance 1), and a per-card fetch gated on expansion cannot answer for
 * one that never expands.
 *
 * **And again whenever one of those rows replicates in late.** A plugin row
 * is not promised to arrive in the same `/api/sync` batch as its media
 * item, and while nothing here watched for it the card rendered
 * `item.title` permanently -- see `usePluginRows.ts`'s own doc for the
 * contract sentence that makes the late batch reachable and for what the
 * subscription costs. One listener per declared table lives here, above the
 * list, not one per card.
 */
import { useMemo, type ReactElement } from 'react';
import { useMediaItems, type MediaItemsResult, type MediaItemsSource } from './useMediaItems.ts';
import { useCatalogItems, type CatalogItemsSource } from './useCatalogItems.ts';
import { useBrowseQuery, type BrowseQuery } from './useBrowseQuery.ts';
import { BrowseControls } from './BrowseControls.tsx';
import { MediaItemCard } from './MediaItemCard.tsx';
import type { GatheredSource } from './useGatheredItem.ts';
import { usePluginRows, emptyPluginRows, type PluginRowsSource } from './usePluginRows.ts';
import { useInfiniteScroll } from './useInfiniteScroll.ts';
import type { IdentifySubmit } from '@pickarr/plugin-ui';
import type { PickSubmit } from './postPick.ts';

/** Everything this screen needs from a store: `useMediaItems`'s two (`listByTablePlugin`, `subscribeTouched`), `useCatalogItems`' three (`listCatalog`, `getRows`, `subscribeCatalog`), `useGatheredItem`'s four (`gatherMediaItem`, `subscribe`, `subscribeInserts`, `getRows`), and `usePluginRows`' three (`pluginRowsByMediaItems`, `subscribeTouched`, `getRows`) -- `getRows` is shared by three of the four and `subscribeTouched` by two. A real `Store` satisfies this by structural assignment. */
export interface CategorySource extends MediaItemsSource, CatalogItemsSource, GatheredSource, PluginRowsSource {}

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
  /**
   * Identifies a release (Requery and Edit), forwarded to each card and
   * never called here, for the reason `submit` is a prop. `undefined`
   * exactly when `store` is: the shell builds it from the store, so the two
   * arrive together, and neither is needed for the marker and controls this
   * renders before then.
   */
  identify: IdentifySubmit | undefined;
}

/** The sentence a filtered or searched list shows when it resolves to nothing. */
export function emptySentence(query: BrowseQuery): string {
  if (query.term === '') {
    return query.filter === 'picked' ? 'No picked items yet' : 'No unpicked items';
  }
  const among = query.filter === 'all' ? '' : ` among ${query.filter} items`;
  return `Nothing matches "${query.q}"${among}`;
}

export function Category({ store, pluginId, tables, submit, identify }: CategoryProps): ReactElement {
  const { query, controls } = useBrowseQuery();
  return (
    <section data-testid={`category-${pluginId}`}>
      <BrowseControls
        filter={controls.filter}
        input={controls.input}
        onFilter={controls.setFilter}
        onInput={controls.setInput}
      />
      {store === undefined || identify === undefined ? null : query.filter === 'all' && query.term === '' ? (
        <DefaultList store={store} pluginId={pluginId} tables={tables} submit={submit} identify={identify} />
      ) : (
        <FilteredList
          key={`${query.filter}|${query.term}`}
          store={store}
          pluginId={pluginId}
          tables={tables}
          submit={submit}
          identify={identify}
          query={query}
        />
      )}
    </section>
  );
}

interface ListProps {
  store: CategorySource;
  pluginId: string;
  tables: readonly string[];
  submit: PickSubmit;
  identify: IdentifySubmit;
}

/** The unfiltered view: pages the `rows` store directly, with no catalog read. */
function DefaultList({ store, pluginId, tables, submit, identify }: ListProps): ReactElement | null {
  const result = useMediaItems(store, pluginId);
  return <ItemList store={store} tables={tables} submit={submit} identify={identify} result={result} emptyMessage="Nothing here yet." />;
}

/** A picked filter and/or a search term: pages the derived `catalog` store. */
function FilteredList({ store, pluginId, tables, submit, identify, query }: ListProps & { query: BrowseQuery }): ReactElement | null {
  const result = useCatalogItems(store, { pluginId, filter: query.filter, term: query.term });
  return <ItemList store={store} tables={tables} submit={submit} identify={identify} result={result} emptyMessage={emptySentence(query)} />;
}

interface ItemListProps {
  store: CategorySource;
  tables: readonly string[];
  submit: PickSubmit;
  identify: IdentifySubmit;
  result: MediaItemsResult;
  emptyMessage: string;
}

function ItemList({ store, tables, submit, identify, result, emptyMessage }: ItemListProps): ReactElement | null {
  const { items, loadMore, done, empty } = result;

  // Stable across renders unless `items` itself changes (the
  // state in `useMediaItems` and `useCatalogItems` alike, replaced wholesale
  // rather than mutated in place): a fresh
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

  // Scrolling loads the next page; the button below still does too. See
  // `useInfiniteScroll` for why both, and note the order in the markup: the
  // sentinel sits *above* the button, so reaching the button by keyboard
  // means the scroll has already had its chance.
  const sentinel = useInfiniteScroll(loadMore, !done);

  // `items.length === 0 && !empty` is the one state `empty` cannot yet
  // distinguish from "still loading" on its own -- see `useMediaItems.ts`'s
  // own doc on `empty`, which `useCatalogItems` honours too. Rendering nothing
  // here, rather than "Nothing here
  // yet", is what keeps that message honest: it appears only once the first
  // page has actually resolved to zero rows.
  if (items.length === 0 && !empty) return null;

  if (empty) return <p>{emptyMessage}</p>;

  return (
    <div>
      {items.map((item) => (
        <MediaItemCard
          key={item.id}
          source={store}
          item={item}
          rows={pluginRows.get(item.id) ?? emptyRows}
          submit={submit}
          identify={identify}
        />
      ))}
      {!done && (
        <>
          {/*
            Not `aria-hidden`: it holds no content and has no role, so it is
            already nothing to a screen reader, and an empty element with an
            explicit hidden attribute reads as a mistake to the next person.
          */}
          <div ref={sentinel} data-testid="load-more-sentinel" />
          <button type="button" onClick={loadMore}>
            Load more
          </button>
        </>
      )}
    </div>
  );
}
