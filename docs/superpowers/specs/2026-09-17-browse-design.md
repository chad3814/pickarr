# The browse screens — design

**Status:** approved in chat 2026-09-17. Read-only; the pick loop is the slice after this one.

## 1. What this builds, and why now

2.0's client currently signs in and shows three numbers. The replica behind
those numbers already holds everything a real screen needs, and nothing
renders it. This slice renders it.

Read-only by decision. The entire server side of picking a release already
exists and is unreachable: `Host.requestDownload(rssItemId)` is on the host's
public interface with **no caller anywhere**, and behind it sits the plugin
hook `onDownloadRequest` → `ctx.downloads.submit` → the client adapter → a row
in `torrent_download` or `nzb_download` → replicated back to the browser
through the sync log. One HTTP route joins those ends. It is deliberately not
this slice: a browse screen is worth having on its own, and a write surface on
a host that has answered `GET`-only until now (`server.ts:821` returns 405 for
every other method) deserves its own design rather than riding along with a
data layer.

**Recorded so the next slice does not re-litigate it:** the agreed shape is a
single narrow route, `POST /api/picks`, taking an `rssItemId`, session-guarded
like every read, whose response says only whether the request was accepted.
The outcome arrives through the replica, not the response body.

## 2. What the replica already holds

Six host tables sync: `media_item`, `rss_item`, `torrent_download`,
`nzb_download`, `person`, `role`, plus the plugin-owned tables each plugin
declares. The read shapes are in `packages/contract/src/sync.ts`.

What matters for this design:

- `media_item` carries `title`, `description`, `releaseDate`, `provider`,
  `providerRef`, `pluginId`, `updatedAt`. Artwork is **not** replicated: it is
  reachable at `/api/artwork/:kind/:mediaItemId`, so a client requests the
  image and handles a 404.
- `rss_item` carries `filename`, `resolution`, `resolutionDetail`,
  `downloadType`, `rankingScore`, `feedId`, `deliveredAt`, and a **nullable**
  `mediaItemId`.
- The two download tables key off `rssItemId` and carry `status`, `attempts`,
  `percentage`, `deliveredAt`.
- **Category is `media_item.pluginId`** — one of `tv`, `movie`, `xxx`. It is
  not a separate column; the plugin that owns the item *is* the category, which
  is what `useCounts`'s `categoryOf` already reads.
- There is **no dismissed or set-aside concept** in 2.0's schema. 1.x's
  Dismissed screen has nothing to stand on and is not rebuilt.

`gatherMediaItem(db, mediaItemId)` in `store/gather.ts` already returns
everything one card needs: the media item, its `pluginId` hoisted, its
releases each with their downloads, its roles each paired with the person where
that person has arrived, and the artwork urls. This slice consumes it rather
than writing a second join.

## 3. The index, and the schema bump

### 3.1 The problem

A per-category list needs to page `media_item` filtered by `pluginId`, and no
index covers that. The replica has `by_media_item`, `by_rss_item`,
`by_table_updated` (`['table','value.updatedAt','id']`) and `by_table`.

Worse, the existing counts do not scale: `useCounts` reads **every**
`media_item` row (`ALL_ROWS`) and counts in memory, on every insert batch.

Three options were weighed. Filtering client-side over keyset pages needs no
schema change but can read most of a table to fill one screen of a sparse
category, and leaves the counts as they are. Maintaining a per-category id
list in `meta` invents an invariant that must hold across `apply`, tombstones
and generation resets — three places to drift. **Adding the index wins on
timing:** its only real cost is a full resync, and 2.0 is greenfield, starts on
an empty database, has one operator, and already has a tested backfill that
refills a replica from nothing. The same bump against a year of users is a
different conversation.

### 3.2 The change

`SCHEMA_VERSION` 1 → 2. The existing upgrade path deletes every object store
before recreating them (`db.ts`'s "delete before create, which is what makes
SCHEMA_VERSION's promise"), so a bump rebuilds rather than migrates, and the
replica refills through bootstrap + tail + backfill.

New index: `by_table_plugin_updated` on
`['table', 'value.pluginId', 'value.updatedAt', 'id']`.

Four components, for the same reason the existing one has three. `pluginId`
partitions, `updatedAt` orders, and `id` breaks ties — a cursor that omits the
tiebreak was **measured** skipping rows: five rows paged backwards two at a
time with three sharing one `updatedAt` served ids [1, 4, 5] and never served
2 or 3 from any page.

**One property comes free and is load-bearing, so it is stated rather than
left to be noticed.** IndexedDB omits any record missing a component of an
index's key path. So this index contains only rows that project `pluginId`,
which today is exactly `media_item` — `rss_item` has `feedId` and no
`pluginId`, and never enters. Tombstones nest the row under `value` and
therefore have no `value.pluginId`, so a deleted row drops out of this index
automatically. That is the same mechanism tombstones already rely on across
every `value.*` index, reused rather than reinvented.

### 3.3 The two readers

- `listByTablePlugin(db, table, pluginId, opts)` — a sibling of `listByTable`
  taking the same `ListByTableOptions` (`from`, `direction`, `limit`), not a
  new flag on it. Which index a call uses stays visible at the call site.
- Counts move off row reads entirely: `IDBIndex.count()` over the key range
  for one `pluginId`. Three range counts replace a full table scan.

## 4. Routes

Four, using the `react-router` v7 dependency that has been installed and
unused since task 3 deleted 1.x's routes:

| path | screen |
|---|---|
| `/tv`, `/movie`, `/xxx` | that category's media items, newest first |
| `/unmatched` | `rss_item`s whose `mediaItemId` is null |
| `/` | redirects to `/tv` |

The host already serves `index.html` for any non-`/api` path, and the e2e suite
already proves a deep link survives a refresh, so a category is linkable and
shareable. `/api` never falls through to `index.html`, which stays true.

`/tv` is the default because `CATEGORIES` in `useCounts.ts` already orders the
three that way and the nav renders them in that order; nothing deeper is meant
by it.

A media item is **not** individually addressable: cards expand in place. That
follows from the per-category decision, and a `/tv/:id` route is a later
addition this design does not foreclose.

## 5. Components

Small and focused, one responsibility each:

- `main.tsx` mounts `<BrowserRouter>`, which is where 1.x had it before task 3
  replaced the file — the router wraps everything, including `SignIn`, so that
  a deep link is preserved through signing in rather than discarded.
- `App.tsx` (exists) keeps its one job: `SignIn` when unauthenticated, `Shell`
  when not. It does not define routes.
- `shell/Shell.tsx` (exists) owns the four `<Route>`s and renders the outlet.
  Its nav becomes links carrying the counts instead of `<span>`s. Routes live
  here rather than in `App` because every one of them is a signed-in screen,
  and `App`'s own switch is the thing that decides whether any of them is
  reachable.
- `library/Category.tsx` — the paged list for one `pluginId`.
- `library/MediaItemCard.tsx` — one item, expanding in place.
- `library/ReleaseList.tsx` — releases with resolution, ranking score, and each
  download's status and percentage.
- `library/Unmatched.tsx` — the null-`mediaItemId` releases.
- `library/useMediaItems.ts` — keyset paging plus `subscribeInserts`, for one
  category.
- `library/useGatheredItem.ts` — `gatherMediaItem` on expand, plus `subscribe`.

### 5.1 A consequence stated up front

`gatherMediaItem` is 3+N transactions and **cannot** be made atomic, because
`rows.ts` does not accept a caller's transaction — a finding parked from the
storage slice's whole-branch review. An expanding card can therefore show a
release a moment before its download row, correcting on the next
notification. Acceptable for a read-only screen. It would not be acceptable if
a pick depended on that read, which is a second reason the write route is its
own slice.

## 6. Styling

`tokens.css` survived the 1.x deletion with the whole palette, spacing scale,
type scale and radii, and both themes keyed on `[data-theme]`. This slice
writes the **first** `components`-layer stylesheet in 2.0 against those
tokens — enough that cards, lists and the nav read properly. It is not a
visual design pass.

It also closes a gap recorded in `base.css` hours ago: 1.x styled `<nav>` with
a bare type selector and that rule was the one thing in the six deleted
stylesheets that reached 2.0's markup. What went was `position: sticky` and a
scroll cap on a nav of three items. `base.css` currently says the blank is a
gap rather than a decision; this slice is where someone lays the shell out on
purpose.

## 7. Testing

Each level where the thing can actually fail:

- **Store level** (`.test.ts`, `test:server`): the new index and
  `listByTablePlugin`. Including the property the storage review said had no
  production caller until now — the keyset must neither skip nor repeat a row
  tied on `updatedAt`, tested the way the three-part index was. Plus the range
  counts, including that a tombstone is not counted.
- **Schema**: a replica at v1 opening at v2 rebuilds and refills, rather than
  half-migrating. The mirror case — a **downgrade** bricks the replica — is
  parked from the storage review and stays parked; it is named here so this
  slice does not appear to have introduced it.
- **Component level** (`.test.tsx`, `test:web`): the hooks' paging and live
  updates, and each component's rendering including empty states.
- **Browser** (e2e): the schema bump only truly happens in a real IndexedDB,
  and the whole point of the previous slice was that happy-dom models a browser
  rather than being one.

### 7.1 The gap this slice must not inherit quietly

**Nothing in this project asserts anything about layout.** One computed
`font-weight` in the e2e deep-link spec is the entire styling net — which is
precisely why deleting a stylesheet silently unstyled the `<nav>` and no test
noticed.

So the screens this slice adds pin legibility the way `CLAUDE.md`'s longest
hazard entry demands: a real visible heading with the accessible name sourced
from it rather than duplicated into an `aria-label`, and at least one
assertion per screen that a deleted stylesheet would break. `getByRole` and
`toBeVisible()` do not close this: both are satisfied by an unstyled block of
text, and a component once shipped with ten passing tests, `role="dialog"`, an
`aria-label`, no visible heading and no stylesheet rule at all — the first
human to see it read it as an error.

## 8. Out of scope

- **Picking** — `POST /api/picks`, shape agreed above, next slice.
- **Dismissing** — no schema supports it.
- **A settings UI** — config is file, env and secrets.
- **A per-item route** — cards expand in place.
- **Search or filtering** beyond category.
- **A downgrade-safe replica** — parked, named in §7.

## 9. Acceptance

1. `/tv`, `/movie` and `/xxx` each list that category's media items, newest
   first, paging on demand.
2. A card expands to its releases, each showing resolution and any download's
   status.
3. `/unmatched` lists releases with no media item.
4. The nav's counts come from three range counts, not a table scan, and a
   tombstoned row is not counted.
5. A v1 replica opening at v2 rebuilds and refills.
6. Paging a category neither skips nor repeats a row tied on `updatedAt`.
7. Each screen has an assertion that fails if its stylesheet is deleted.
8. A deep link to a category survives a refresh, and `/api` still never falls
   through to `index.html`.
