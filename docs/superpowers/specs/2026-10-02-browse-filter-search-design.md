# Browse filter and search: Picked, Unpicked, and a search box over the replica

## Problem

A category page lists every media item newest-first and offers nothing to narrow it. An
operator who wants the items they have not picked yet, or one title among hundreds, scrolls.
Pickarr 1.x had a search box; it went with the 1.x SPA (commit 30e8120) and nothing replaced
it in the replica architecture.

## Goal

On each category page: a filter that shows All, Picked or Unpicked items, and a search box
that matches a typed phrase against an item's title, release year, release filenames and the
names of the people in it. Both keep up with typing, survive a reload, and cost the default
view nothing.

## Decisions already made

| Question | Decision |
|---|---|
| "Picked" means | At least one of the item's releases has a download row, in any status including `failed`. This is the rule the card already applies when it hides the Pick button. |
| Search matches | Title, release year, every release filename, every person's name. Case-insensitive substring of one phrase. |
| Where state lives | The URL: `/tv?filter=unpicked&q=dune`, per category. |
| Filter control | A radio group, three native radios in a fieldset. |
| Where the work happens | The browser, over the replica. A derived IndexedDB object store, `catalog`, maintained inside `applyBatch`'s transaction. Not an in-memory map (lost on reload, needs a build phase) and not a host route (the replica holds everything the host would search). |

## Facts this design rests on

Read from the tree on 2026-10-02:

- The category page is `Category.tsx` → `CategoryList` → `useMediaItems(store, pluginId)`, which pages `media_item` 24 at a time through `listByTablePlugin` on the `by_table_plugin_updated` index, newest `updatedAt` first, and re-reads on `subscribeInserts('media_item')`. Infinite-scroll sentinel plus a `Load more` button.
- Nothing in the web or contract packages names "picked". A release's downloads are the `torrent_download` and `nzb_download` rows with its id in `rssItemId` (`by_rss_item` index). An item's releases and roles are the rows with its id in `mediaItemId` (`by_media_item` index). The host never deletes download rows.
- `person` is synced with `name`; `role` is synced with `mediaItemId`, `personId`, `role`, `name`, no `updatedAt`. There is no index on `personId`.
- `MediaItemSyncRead.releaseDate` is a string or null. `RssItemSyncRead.lookupJson` is replicated but bounded.
- The replica database (`store/db.ts`) is `SCHEMA_VERSION = 2` with object stores `rows` (`keyPath: ['table','id']`, indexes `by_media_item`, `by_rss_item`, `by_table_updated`, `by_table_plugin_updated`, `by_table`) and `meta`. A version bump deletes and recreates every store. There is no text index, and IndexedDB cannot index booleans.
- `applyBatch` (`store/apply.ts`) opens one `readwrite` transaction over `rows` and `meta`, reads every touched key, writes the ops, writes the cursors, and aborts explicitly on any failure. Sequential awaits inside it are safe; a macrotask gap is what would end the transaction. It returns `Changed = { touched, inserted }` keyed by table, and `sync.ts` fires `notify.ts` from it.
- `sync.ts`'s `wipe()` clears `rows` and `meta` in one transaction on a generation mismatch.
- No `useSearchParams`, no radio group, no search input exists in the web package. Stylesheets use structural selectors; no component sets a class, and `library.css` says it will not be the first.
- The nav count per category is `countByPlugin('media_item', id)`.

## 1. The catalog

### 1.1 Schema

`SCHEMA_VERSION` becomes 3. The upgrade recreates every store, so an existing install
re-bootstraps from the host and the catalog fills as rows arrive. There is no build phase
and no migration code.

A second object store, `catalog`, `keyPath: 'id'`, one record per media item:

```ts
interface CatalogRecord {
  id: number;          // media_item id
  pluginId: string;
  updatedAt: number;   // the media item's, so a filtered page sorts exactly as All does
  picked: 0 | 1;       // 1 when any release has any download row
  haystack: string;    // lowercased; title, year, each filename, each person's name; newline-joined
}
```

Indexes on `catalog`:

- `by_plugin_picked_updated` on `['pluginId', 'picked', 'updatedAt', 'id']` for Picked and Unpicked.
- `by_plugin_updated` on `['pluginId', 'updatedAt', 'id']` for All with a search term.

One new index on `rows`: `by_person` on `'value.personId'`, so a person's rename can find the
roles that carry it.

### 1.2 The haystack

Parts, in this order, each lowercased, joined with `\n`:

1. the title;
2. the first four characters of `releaseDate` when it is a string of at least four characters, else nothing;
3. each release's `filename`, in `rss_item` id order;
4. each role's person `name`, in role id order, where the person row is present.

Whitespace inside a part is collapsed to single spaces. `lookupJson`, descriptions and
provider references are not in it. Newline joining means a phrase cannot match across two
parts.

### 1.3 Maintenance inside `applyBatch`

A catalog phase runs after the write loop and before `writeCursors`, in the same transaction
(which now also names `catalog`). It is a recompute of affected records, not a patch:

1. **Which media items an op affects.**
   - `media_item`: its own id.
   - `rss_item`: `value.mediaItemId` when non-null, plus the previous row's `mediaItemId` when it differs (a release being matched moves from `null` to an id, or from one id to another).
   - `torrent_download`, `nzb_download`: the `mediaItemId` of the `rss_item` named by `rssItemId`, read in-transaction; nothing if that release is absent or unmatched.
   - `role`: `value.mediaItemId`, plus the previous row's when it differs.
   - `person`: the `mediaItemId` of every `role` row in `by_person` for this person id.
   - A tombstone uses the previous row's values for the above. Every other table affects nothing.
2. **For each affected id**, read the `media_item` row. If it is absent or a tombstone, delete the catalog record. Otherwise read `by_media_item` (releases and roles), `by_rss_item` for each release, and `getRows('person', …)` for the roles' people, and `put` one fresh record.

Reads issued after the loop's `put`s see the batch's own writes, so a release and its
download in one batch resolve correctly in either order, and a partner that arrives in a
later batch triggers its own recompute. Order never matters. A failure anywhere aborts the
transaction with the rows and the cursor, as today.

`Changed` gains `catalog: number[]`, the affected media item ids whose record was written or
deleted. `notify.ts` gains a seventh registry, `subscribeCatalog(cb: (ids: number[]) => void)`,
fired by `sync.ts` from `Changed` beside the others and relayed to follower tabs the way
`touched` is.

### 1.4 Cost

Each affected media item is two reads, plus one per release and one per role that names a person, and one write (an item that is absent costs two reads). A bootstrap page of several
hundred ops over distinct items is a few thousand local requests. §5 includes a timed test as a
regression tripwire.

### 1.5 Reset

`wipe()` clears `catalog` in the same transaction as `rows` and `meta`.

## 2. Store reads

In a new `packages/web/src/store/catalog.ts`:

```ts
export type PickedFilter = 'all' | 'picked' | 'unpicked';
export interface CatalogQuery {
  pluginId: string;
  filter: PickedFilter;
  term: string;             // already trimmed, lowercased, whitespace-collapsed; '' for none
}
export interface ListCatalogOptions { from?: { updatedAt: number; id: number }; limit: number; }
export async function listCatalog(db, query, opts): Promise<readonly CatalogRecord[]>;
```

`listCatalog` opens a `prev` cursor on `by_plugin_picked_updated` bounded to
`[pluginId, picked]` when the filter is `picked` or `unpicked`, else on `by_plugin_updated`
bounded to `[pluginId]`; `from` is exclusive, as in `listByTable`. With an empty term it
drains `limit` records: index-backed paging. With a term it advances the cursor keeping
records whose `haystack.includes(term)`, until `limit` matches or the range ends. The term
is tested on the catalog record only, never on `rows`.

Calling `listCatalog` with `filter: 'all'` and an empty term is allowed and equivalent to
`listByTablePlugin`, but the page does not do it (§3).

`Store` gains `listCatalog` and `subscribeCatalog`.

## 3. The page

### 3.1 Controls

`Category.tsx` renders, above the list, `<form role="search" aria-label="Filter and search">`
containing:

- `<fieldset><legend>Show</legend>` with three native radios named `filter`, labelled `All`, `Picked`, `Unpicked`.
- `<label>Search <input type="search" autocomplete="off"></label>`. No placeholder.

`library.css` lays the form out with structural selectors (`form[role='search'] …`); no class.

### 3.2 URL state

Read and written with `useSearchParams`:

- `filter`: `picked` | `unpicked`; anything else, or absent, reads as `all`.
- `q`: kept as typed in the input; for matching it is trimmed, lowercased and whitespace-collapsed.
- Writes use `{ replace: true }`, so typing adds no history entries.
- `all` with an empty `q` writes no params at all; the default URL stays `/<plugin>`.
- Typing is debounced 150 ms before the URL (and so the query) changes; clearing the field is immediate.

Each category route has its own params, so switching category starts from All and empty.

### 3.3 Rendering

- `filter === 'all' && term === ''`: `CategoryList` renders through `useMediaItems` exactly as today. Zero catalog reads.
- Otherwise a new `useCatalogItems(store, query)` hook, in `library/useCatalogItems.ts`, drives it. It pages `listCatalog` 24 at a time (`PAGE_SIZE` from `useMediaItems.ts`), resolves the records' ids through `getRows('media_item', ids)` preserving catalog order, and exposes the same `{ items, loadMore, done, empty }` shape, so the sentinel, the `Load more` button, `usePluginRows` and `MediaItemCard` are shared. It re-reads from the top on `subscribeCatalog`, coalesced like Unmatched's refresh. A query change resets the window.
- Empty results render `<p>` with the filter and term in words: `Nothing matches "dune" among unpicked items`; `Nothing matches "dune"`; `No picked items yet`; `No unpicked items`.
- The nav count is unchanged: total `media_item` rows per plugin.

## 4. Edge cases

- **A release matched after the fact.** The batch recomputes the new item and, when there was one, the old. Unmatched releases are in no record.
- **An item whose only download failed** is picked.
- **A person renamed** reaches every item they appear in through `by_person`.
- **A role whose person has not replicated yet** contributes no name until the person arrives, which recomputes the item.
- **Half-synced replica.** The catalog holds what the rows hold; the page shows what has arrived, as All does.
- **A term with `%`, `_`, `.` or `*`** is a literal substring.
- **A multi-word term** is one phrase. Parts are newline-joined, so it cannot match across a title and a filename.
- **No `releaseDate`** contributes no year.
- **An old tab on schema 2** closes its connection in the `versionchange` handler `openStore` already has, and now also reloads the page: the old bundle cannot speak schema 3, and it would otherwise keep its Web Lock lease, leaving a new tab a follower with nothing to follow. The reload loads the new bundle, and the old document's lock releases with it.
- **A category with no items** shows the controls and `Nothing here yet.` as today under All; under a filter or term it shows the matching empty sentence.

## 5. Testing

Every test is written to fail first.

- **Store**
  - `applyBatch` over one batch holding a media item, two releases, one download, two roles and two people, in scrambled order, yields one record with the right `pluginId`, `updatedAt`, `picked = 1`, and a haystack containing the title, year, both filenames and both names.
  - A later batch with a download for an unpicked item flips `picked` to 1.
  - A release rematched from item A to item B rewrites both records.
  - A person rename rewrites the haystack of every item they are in.
  - A media item tombstone deletes its record; a role tombstone removes the name.
  - A refused batch (`DuplicateOpError`, `MalformedOpError`) leaves the catalog untouched.
  - `wipe()` clears the catalog.
  - `listCatalog`: picked and unpicked ranges, All-with-term range, newest first, `limit`, cursor resume with `from`, ties on `updatedAt`, a term matching only a filename, a term matching only a person, a term matching nothing, a term with `%`.
  - `Changed.catalog` lists exactly the affected ids; `subscribeCatalog` hears them.
  - A timed test: a 500-op batch over 100 items applies within a stated budget on `fake-indexeddb`, as a regression tripwire.
- **Web**
  - The toolbar renders three radios and a search input with their accessible names.
  - The controls reflect the URL on load, and the URL reflects the controls; `all` with empty `q` writes no params; writes replace rather than push.
  - The default view performs zero catalog reads and still uses `useMediaItems`.
  - A filter change lists through the catalog; `Load more` pages a filtered list; a catalog wake re-reads.
  - Typing is debounced: the scheduler is asked for 150 ms (spy on `setTimeout`, no fake timers); clearing is immediate.
  - Each empty sentence appears for its case.
  - Items render through the same card with plugin rows.
- **e2e**
  - Seed two items in one category; pick one release; choose Unpicked and see only the other; under All search the picked item's filename and see only it; reload and see the same state from the URL.
- **Mutations** (each must redden a test): haystack skips filenames; `picked` set only for `delivered`; the rematch path skips the previous `mediaItemId`; `wipe()` leaves the catalog; `listCatalog` ignores `from`; the default view reads the catalog; the URL write pushes instead of replaces; the debounce delay is 0.

## Out of scope

- Picked or unpicked counts in the nav.
- Sort options.
- Search on the Unmatched page.
- A text index or ranking.
- Searching `lookupJson` or descriptions.
