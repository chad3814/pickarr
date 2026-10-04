# Image grid browse: posters for films, backgrounds for television and adult

Date: 2026-10-04. Phase 8.

## Problem

A category page is a text list. Each row is a headline button, and an item's
poster appears only once the row is expanded into its detail section. Phase 7
(#79) stores and replicates five images per kind for every item, and the only
place a person sees any of them is one expanded card at a time. A library of
posters and backgrounds is browsed by reading titles.

## Goal

A second view of each category page: a grid of one image per item, posters
for films, backgrounds for television and adult, with filter and search
applying to it exactly as they apply to the list. Activating a tile opens the
same card the list expands, in a dialog over the grid. Nothing about the list
changes.

## Decisions already made

| Question | Decision |
|---|---|
| Replace or add | Add. A List / Grid toggle beside Show and Search, in the URL like them. List stays the default, so an untouched URL and an untouched user see no change. |
| Tile action | A dialog over the grid holding the same `MediaItemCard`, detail section open from the start. Not an in-place expansion and not the gallery alone. |
| Missing image | A placeholder tile carrying the title. Every item in the filtered result stays visible, so the grid and the list agree on what is there. |
| Which kind per plugin | A plugin declaration, `BrowserPlugin.tile`. Films declare `poster`; television and adult declare `background`. |
| How a tile finds its image | The catalog record carries the rank-0 `poster` and `background` row ids. No read per tile. Chosen over a read per tile (the cost #110 just removed, since `by_media_item` returns every release too) and over a new rows index (a read per tile and a reindex of every replica). |
| Replica schema | `SCHEMA_VERSION` 4 → 5. A bump wipes the stores and the next start bootstraps, as every bump has done; nothing migrates in place. |

## Facts this design rests on

Each measured or read on this tree, not assumed.

- `recomputeOne` (`packages/web/src/store/catalog-apply.ts`) reads every row
  of an item through one `by_media_item` `getAll`, and the artwork rows come
  back in that read already: `poster`, `background`, `logo` and
  `person_image` all carry `mediaItemId` or `personId` and are indexed. The
  two ids this design adds cost no further read.
- `useCatalogItems` resolves records to `media_item` rows with one `getRows`
  per page, so a tile has its title and its image ids from the same page
  fetch the list already makes.
- `listCatalog` serves `filter: 'all'` with an empty term through the
  `by_plugin_updated` index, so the grid can read through the catalog in the
  unfiltered case the list serves from the rows store.
- A `SCHEMA_VERSION` bump runs `deleteObjectStore` over every existing store
  in `upgradeneeded` (`packages/web/src/store/db.ts`), so the next start finds
  no meta and bootstraps. With #112 the tail catches up a long backlog in
  under a minute rather than hours, which is what makes a bump acceptable on a
  large replica.
- `Gallery.tsx` holds its own backdrop, `role="dialog"`, `aria-modal`, focus
  trap, Escape handler and focus return. Nothing else in `plugin-ui` has a
  dialog, so there is one implementation to lift, not two to merge.
- `useExpansion` (`packages/plugin-ui/src/expansion.tsx`) starts closed and
  takes no initial value. `MediaItemCard` fetches the gather only while the
  plugin's card reports itself expanded.
- `test/plugins/registry.test.ts` fails if a plugin id appears anywhere under
  `web/src` outside `plugins/registry.ts`. The grid must learn the kind from
  the plugin, never from a literal.
- `/api/artwork/:kind/:id` serves by artwork row id (#79), so a tile needs
  exactly the id the record carries and nothing else.

## 1. Data

### 1.1 The record

`CatalogRecord` gains two fields:

```ts
poster: number | null;      // the rank-0 poster row id, ties by lowest id
background: number | null;  // the rank-0 background row id, ties by lowest id
```

The order is `toImages`' order: `rank` ascending, then `id` ascending. `logo`
and `person_image` are not carried; nothing browses by them. `isCatalogRecord`
requires both fields, so a record from before this version is not one, which
is moot after the wipe but keeps the guard honest.

`SCHEMA_VERSION` becomes 5. The catalog's two indexes are unchanged.

### 1.2 Recompute

`recomputeOne` picks the two ids from the `linked` rows it already holds,
filtering by `table` and sorting as `toImages` does. The #108 `picked`
shortcut, the haystack and the person reads are untouched.

`affectedMediaItems` learns `poster` and `background`: an op on either, insert
or tombstone, marks the item named by `mediaItemId` on the op's value or its
pre-image as affected, with a `PickedHint` of nothing, so an artwork-only
batch costs the item no release read. A rank-0 image arriving after the item,
a re-rank, or a tombstone therefore rewrites the record and wakes the grid
through `subscribeCatalog`, the path the list already uses. `logo` and
`person_image` ops still affect nothing.

The module doc's cost sentence becomes: two reads per affected item plus one
per role with a person id, and the two image ids come from the first of them.

## 2. The plugin seam

### 2.1 `BrowserPlugin.tile`

```ts
readonly tile: 'poster' | 'background';
```

Required and undefaulted, for the reason `DestinationsProps.plugins` is: a
default would let a plugin render a grid nobody chose. `movieBrowser` declares
`'poster'`; `tvBrowser` and `xxxBrowser` declare `'background'`. Web reads
`pluginFor(item.pluginId).tile` and never a literal.

### 2.2 Opening expanded

`CardProps` gains `initiallyExpanded?: boolean`, and `useExpansion` takes it
as the starting value of its state:

```ts
export function useExpansion(onExpandedChange: (expanded: boolean) => void, initiallyExpanded = false): Expansion
```

The three plugin cards pass `initiallyExpanded` straight through, one line
each. `MediaItemCard` gains the same optional prop and seeds its own
`expanded` state from it, so the gather starts on mount when the dialog asks
for it. The heading stays a toggle inside the dialog; collapsing it there is
allowed and does nothing surprising.

### 2.3 `Dialog`

`plugin-ui` gains `Dialog`, lifted from `Gallery`: the backdrop that closes on
click, the `role="dialog"` `aria-modal="true"` container, focus moved in on
open, the Tab and Shift+Tab trap, Escape, and focus returned to the opener on
close. Props: `label` or `labelledBy`, `onClose`, `children`. `Gallery` becomes
its first caller and keeps its own controls, heading and image stepping; its
tests pass unchanged against the lifted code, and the trap and Escape tests
move to `Dialog`'s own file. The backdrop class becomes `dialog-backdrop`, and
`library.css` renames its rule.

Nothing else crosses the seam. The tile is web's component, as the `<article>`
is; the plugin never sees the grid, an image url or a catalog record.

## 3. The browser

### 3.1 URL state and controls

`useBrowseQuery` gains `view: 'list' | 'grid'`, read from `?view=grid` and
written like `filter`: `list` writes no parameter, anything unrecognised
parses to `list`, and a change replaces the history entry. `view` travels with
`filter` and `q`, so `/movie?view=grid&filter=unpicked&q=dune` is one
bookmarkable state and switching views keeps the filter and the typed search.

`BrowseControls` gains a second radio group, `<fieldset><legend>View</legend>`
with List and Grid, inside the same `form[role="search"]` as Show and the
search box. `Category` passes `controls.view` and `controls.setView` through.

`view` is a category-page parameter only. The unmatched page, the activities
page and settings ignore it.

### 3.2 Source

In grid view `Category` lists through the catalog for every query, the empty
filter included: `useCatalogItems(store, { pluginId, filter, term })`. The
list view is untouched and keeps `useMediaItems` for the unfiltered case.

`useCatalogItems`' result gains `records: ReadonlyMap<number, CatalogRecord>`
for the resolved page, so a tile has its two ids with no further read.
`ItemList` ignores it.

Switching views remounts the result component through a `key` that includes
the view, the discipline `FilteredList` already applies to filter and term, so
the list's page window and the grid's open dialog cannot leak into each other.

### 3.3 Tiles

`ItemGrid` renders:

```html
<ul class="tiles" data-tile="poster">          <!-- or "background" -->
  <li>
    <button type="button" aria-haspopup="dialog">
      <img src="/api/artwork/poster/41" alt="" />
      <span>Severance</span>
    </button>
  </li>
</ul>
```

- The kind is `pluginFor(pluginId).tile`; the id is the record's field for
  that kind.
- The button's accessible name is the visible title, so the image carries an
  empty `alt`.
- A record whose id for the kind is `null`, or whose image fires `error`,
  renders `ImagePlaceholder` with the label `No poster for <title>` (or `No
  background for <title>`) in the image's place, under the same caption. The
  error latches per tile, as the card's poster does, and is reset when the
  record's id changes, so an image that 404s and then arrives is tried once
  more.
- Poster tiles are 2:3 and background tiles 16:9, sized by two new tokens,
  `--size-tile-poster` and `--size-tile-background`, laid out with `repeat(auto-fill,
  minmax(var(--size-tile-…), 1fr))`. `library.css` keys the rules on
  `.tiles` and `[data-tile]`.
- Paging reuses `useInfiniteScroll` and the sentinel; the empty states reuse
  `emptySentence`, and the unfiltered empty state reads `Nothing here yet.` as
  the list's does.
- The grid fetches `usePluginRows` for the page's ids exactly as `ItemList`
  does, so the dialog's card has its plugin rows ready.

### 3.4 The dialog

`ItemGrid` holds one `openId`. Activating a tile sets it; a second activation
replaces it. While set, the grid renders:

```tsx
<Dialog label={item.title} onClose={close}>
  <button type="button" onClick={close}>Close</button>
  <MediaItemCard source={store} item={item} rows={pluginRows.get(item.id) ?? emptyRows}
                 submit={submit} identify={identify} initiallyExpanded />
</Dialog>
```

Picking, retrying and identifying inside the dialog are the card's own
behaviour and reach the same `submit` and `identify`; the card re-gathers live
on the same subscriptions. Escape, the backdrop and Close each clear `openId`,
and `Dialog` returns focus to the tile that opened it. The gallery opened from
inside the dialog is a second `Dialog` over the first; Escape closes the
topmost, which the gallery's own handler already stops from propagating.

If the open item leaves the page's records, because a filter no longer matches
it or its row was tombstoned, the dialog closes and focus returns to the grid's
list element, since the tile is gone.

## 4. Edge cases

- **A replica mid-bootstrap.** Catalog records trail `media_item` rows by one
  batch at most, since both are written in the same transaction; the grid
  lists records, so it never shows an item without a record. An item whose
  images have not replicated yet shows the placeholder and swaps to the image
  when the catalog rewrites it.
- **An image that 404s then arrives.** The latch is per record id. A re-rank
  that changes the rank-0 id resets it; the same id served after a transient
  failure does not retry until the page is reloaded, which is the card's
  behaviour today.
- **Keyboard only.** Tiles are buttons in a list, so Tab reaches each, Enter
  and Space open the dialog, and the dialog's trap and focus return are
  `Dialog`'s. No roving tabindex: a grid of buttons is a list of controls, not
  a composite widget.
- **`?view=grid` on a non-category route.** Ignored; only `Category` reads it.
- **A plugin with no `tile`.** Does not compile. The registry test does not
  need a new rule.

## 5. Testing

Each item is a test the plan must place; the mutations are what each must
redden.

- **Store** (`catalog-apply.test.ts`): a scrambled batch yields the rank-0
  ids by rank then id; a later higher-ranked poster rewrites `poster`; a
  tombstone of the rank-0 background falls back to the next; a `logo` or
  `person_image` batch leaves the record alone; an artwork-only batch costs
  zero `by_rss_item` reads. Mutations: swap the two ids; pick the highest
  rank; drop the two tables from `affectedMediaItems`.
- **Hooks**: `useBrowseQuery` parses `view`, writes nothing for `list`, keeps
  `filter` and `q` across a view change; `useCatalogItems` hands back
  `records` for the page. Mutations: write `view=list`; drop `records`.
- **Components** (`Category.test.tsx`, new `ItemGrid.test.tsx`): the toggle
  switches views and the URL; a film grid uses `/api/artwork/poster/<id>` and
  a television grid `/api/artwork/background/<id>`, each from the plugin's
  declaration; a null id shows the placeholder under the title; an image
  `error` latches to the placeholder and a changed id retries; a tile's name
  is the title; activating a tile opens one dialog labelled by the title with
  the detail section already showing; Escape, backdrop and Close each close
  it and return focus to the tile; a pick inside reaches `submit` with the
  release id; a second tile replaces the first dialog. Mutations: ignore
  `tile`; never latch; let two dialogs open; skip the focus return.
- **plugin-ui**: `Dialog`'s trap, Escape and focus-return tests, moved from
  the gallery's file; the gallery's own tests pass unchanged; `useExpansion`
  honours `initiallyExpanded`; the registry test still passes.
- **e2e** (new `grid.spec.ts`): `Harness.seedArtwork(kind, mediaItemId, rank)`
  beside `seedPoster`; seed a television item with a background, deep-link to
  `/tv?view=grid`, assert the tile's `img` has `naturalWidth > 0`, open the
  dialog, pick a release inside it and watch the status replace the button,
  press Escape and assert focus is on the tile. One token-compared
  computed-style pin on `.tiles` per #90.

## Out of scope

- Sorting or grouping the grid; it follows the catalog's newest-first order.
- Showing more than one image per tile, or hovering through an item's images.
- A grid for the unmatched page, which has no media items.
- Virtualising the grid. Paging through the sentinel is what the list does.
