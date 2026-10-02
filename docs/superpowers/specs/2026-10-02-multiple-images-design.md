# Several images per kind: store them, sync them, show them all

Issue #79.

## Problem

Each media item can hold several posters, backgrounds and logos (`UNIQUE (media_item_id,
url)`), and each person several pictures, but the writer collapses every kind to one row
on each attach (`keepOnly`) and the route serves the lowest-id row (`LIMIT 1`). Providers
return many ranked images; Pickarr keeps one and the operator never sees the others.

## Goal

Keep the five best images per kind per media item and per person, ranked as the job
already ranks them; replicate the rows (not the files) to the browser; serve each image by
its own id; show every stored image in the card's gallery. No operator choice is stored:
the card uses the top-ranked image and the gallery steps through the rest.

## Decisions already made

| Question | Decision |
|---|---|
| How many per kind | 5, chosen by the artwork job's existing `bestImage` ordering (configured language, then language-neutral, then score, then url). |
| Picking | None. 1.x's modal was a viewer, not a persisted choice; the issue's "picker" framing is dropped. |
| People | Widened too: up to five pictures per person, same ranking. |
| Logos | Stored, ranked and synced like the others; still rendered nowhere. |
| URL scheme | Per-row: `GET /api/artwork/:kind/:id` where `:id` is the artwork row's id. |
| Replica | The four artwork tables are synced; projections carry no `url` and no `path`. No replica schema bump. |

## Facts this design rests on

Read from the tree on 2026-10-02:

- `poster`/`background`/`logo`: `id, media_item_id, title, language, url, width, height, created_at, path` (`background` also `description`), `UNIQUE (media_item_id, url)`. `person_image` (migration 23): `id, person_id, title, language, url, width, height, created_at, path`, `UNIQUE (person_id, url)`. None has `updated_at` or any rank. Latest migration is 26.
- `MediaWriter.attachPoster/attachBackground/attachLogo/attachPersonImage` upsert on `(owner, url)` then call `keepOnly(table, owner, url)`, which deletes every other row for the owner and unlinks their files (`media/writer.ts:99-146`). `dropMediaItemRows` deletes the three media artwork tables' rows and returns their paths.
- `ArtworkStore.put/putPerson` hash `(owner, url)` to a path; same url twice → same path.
- The artwork job (`openmetadata/src/artwork/job.ts`) picks one image per kind with `bestImage(images, language)` over `ProviderImage = { url, language, score }`; TMDB and TVDB return full ranked lists, TPDB at most one poster and one background. `ImageInit = { url, title, language, bytes }`.
- `GET /api/artwork/:kind/:mediaItemId` (`api/artwork-route.ts`, `api/server.ts:977`) is guarded; `ARTWORK_QUERY` per kind is `SELECT path … WHERE <owner> = ? AND path IS NOT NULL ORDER BY id ASC LIMIT 1`; weak ETag; no `Cache-Control`.
- `HOST_SYNCED_TABLES` has ten tables; each has a `selectSql` case and a `*SyncRead` in `contract/src/sync.ts`; lockstep tests pin shape, names, no path/url columns, three triggers, integer id, and the count. `migration 23`'s test asserts `person_image` has no triggers. Migrations 16/17/19 show `installSyncTriggers` + `seedSyncLog`.
- Replica: rows land in the generic `rows` store; `by_media_item` indexes `value.mediaItemId`, `by_person` indexes `value.personId`; `gather.ts` and `catalog-apply.ts` filter `by_media_item` results by table name; `TABLES_WITH_UPDATED_AT` excludes `role` for lacking `updatedAt`.
- `gather.ts` builds `GatheredItem.artwork` as three URL strings and `GatheredRole.imageUrl` as one; `plugin-ui`'s `MediaDetails` renders the poster, opens `Gallery` (already a multi-image lightbox with prev/next, failure-skip, focus handling) over poster → background → cast pictures; cast thumbnails come from `imageUrl`; `useGatheredItem` re-gathers on `media_item` changes, download inserts and (Phase 6) each release row.
- e2e: `seedTvRelease({ withPoster })` and `media-details.spec.ts` intercept `/api/artwork/poster/:id`.

## 1. Storing several images

### 1.1 Rank

Migration 27: `ALTER TABLE <t> ADD COLUMN rank INTEGER NOT NULL DEFAULT 0` for `poster`,
`background`, `logo`, `person_image`. Plain `ADD COLUMN`: no rebuild. `ImageInit` gains
`rank: number`; each attach writes `rank` on insert and on conflict, so a re-run that
reorders rewrites ranks in place.

### 1.2 The job

`ARTWORK_KEEP = 5` in `openmetadata/src/artwork/job.ts`. For each kind of the media item
and for each person, the job sorts with `bestImage`'s ordering (factored out as
`rankImages(images, language): ProviderImage[]`), takes the first `ARTWORK_KEEP`, downloads
them (failures skip one image, as today), attaches each with `rank` = its index in that
order, then calls `keepTop(kind, owner, urlsKept)` once. A kind may hold fewer than five.

### 1.3 `keepTop`

`keepOnly(table, owner, url)` becomes `keepTop(table, owner, urls: readonly string[])`:
delete every row for the owner whose `url` is not in `urls` and unlink their files. Table
names stay spelled out per statement (the hygiene script reads them). The writer's
"widening a slot is issue #79" comment goes. `artworkPaths` and `dropMediaItemRows` are
unchanged.

## 2. Reaching them

### 2.1 Sync

`poster`, `background`, `logo`, `person_image` join `HOST_SYNCED_TABLES` (fourteen tables).
Projections:

```ts
export interface ArtworkSyncRead {          // poster, background, logo
  id: number; mediaItemId: number; width: number; height: number;
  language: string | null; rank: number; createdAt: number;
}
export interface PersonImageSyncRead {
  id: number; personId: number; width: number; height: number;
  language: string | null; rank: number; createdAt: number;
}
```

No `url` (a provider URL; the `rss_item.link` rule) and no `path` (a local filename).
Migration 27 ends with `installSyncTriggers(db, [the four tables])` and `seedSyncLog` for
their existing rows, so replicas receive what the host already holds on their next tail
tick without a resync. The `migration 23 … does not replicate it` test flips to assert
the triggers exist.

### 2.2 The replica

No schema bump. Rows enter the generic `rows` store; the three media artwork tables enter
`by_media_item`, `person_image` enters `by_person`. `gather.ts` and `catalog-apply.ts`
already filter `by_media_item` reads by table name; the catalog's affected-tables `switch`
ignores the new tables. `TABLES_WITH_UPDATED_AT` is untouched (artwork rows have only
`createdAt`, like `role`).

### 2.3 The route

`GET /api/artwork/:kind/:id`, guarded as today, `:id` now the artwork row's id:

```sql
poster:     SELECT path FROM poster       WHERE id = ? AND path IS NOT NULL
background: SELECT path FROM background   WHERE id = ? AND path IS NOT NULL
logo:       SELECT path FROM logo         WHERE id = ? AND path IS NOT NULL
person:     SELECT path FROM person_image WHERE id = ? AND path IS NOT NULL
```

404, ETag, sniffing and the existence-oracle note are unchanged. The browser builds a URL
from a row it holds, never from `(kind, mediaItemId)`.

## 3. The browser

### 3.1 Gathering

```ts
export interface GatheredImage { id: number; url: string; width: number; height: number; language: string | null; rank: number; }
export interface GatheredArtwork { posters: readonly GatheredImage[]; backgrounds: readonly GatheredImage[]; logos: readonly GatheredImage[]; }
// GatheredItem.artwork: GatheredArtwork   (each list sorted by rank, then id)
// GatheredRole.images: readonly GatheredImage[]   (replaces imageUrl; sorted by rank, then id)
```

`url` is `/api/artwork/<kind>/<id>` with `kind` ∈ `poster|background|logo|person`.
`gatherMediaItem` keeps the artwork rows it already reads from `by_media_item`;
`gatherRole` reads `person_image` rows from `by_person`. `plugin-ui`'s view types
(`ArtworkUrlsView`, `GatheredRoleView.imageUrl`) change to match. `useGatheredItem` adds
`subscribeTouched` on the four artwork tables, re-gathering when a touched row's owner is
this item or one of its gathered people (the Phase 6 per-release pattern).

### 3.2 Display

`MediaDetails`: the detail image is `posters[0]`; with no poster row the placeholder
renders directly. The gallery receives every poster in rank order, then every background,
then each top-billed cast member's pictures in rank order; captions are the item title or
the person's name. The poster button opens at `posters[0]`; a cast thumbnail (its
`images[0]`) opens at that person's first picture; a cast member with no picture renders
the placeholder and no button, as today. `Gallery` itself is unchanged. Logos are not
rendered.

### 3.3 Fixtures

Web and plugin-ui tests build `artwork` as rows; the e2e harness's `seedTvRelease({
withPoster })` seeds a `poster` row and exposes its id so specs intercept
`/api/artwork/poster/<rowId>`.

## 4. Edge cases

- **Fewer than five available**: the kind holds what arrived; nothing pads.
- **A re-run that reorders**: ranks rewritten in place; rows that fell out of the top five are deleted with their files; survivors keep their ids, so cached URLs stay valid.
- **A failed download**: no row, as today; the gallery shows what arrived.
- **Pre-upgrade rows** rank 0 by default; each kind held one row, so no ambiguity until the next job reranks.
- **Replica index growth**: up to 15 extra `by_media_item` rows per item, read and discarded by table in `gather` and the catalog recompute.
- **Old browser bundle after the host upgrade** requests `/api/artwork/poster/<mediaItemId>`, now a row id: a wrong image or 404 until reload. Accepted; the same operator deploys both halves and there is no replica schema bump to force a reload.
- **Dropping a media item** still deletes its artwork rows and files; the new delete triggers emit tombstones for them.
- **A person shared by two items**: their pictures are per person, read once per card through `by_person`.

## 5. Testing

Every test is written to fail first.

- **Host**: migration 27 adds `rank` to the four tables, installs their triggers and seeds the log; `keepTop` keeps the named urls and deletes the rest with their files; attach writes `rank` and rewrites it on conflict; the route serves by row id for each kind and 404s an unknown id; the query-plan test asserts each query seeks by primary key; the sync lockstep tests pass for fourteen tables; no projection carries `url` or `path`.
- **Job**: seven posters → five stored in `rankImages` order with ranks 0–4; a person with three pictures → three; a re-run with a changed order rewrites ranks and drops the fallen; one failed download skips one image.
- **Web**: `gatherMediaItem` returns the three lists sorted by rank then id with per-row URLs; `gatherRole` returns `images`; `MediaDetails` shows `posters[0]`, the placeholder with no rows, and a gallery ordered posters → backgrounds → cast pictures; `useGatheredItem` re-gathers on an artwork row for this item and not for another.
- **e2e**: seed an item with two posters; the detail image is the rank-0 row's URL; step the gallery to the second poster and assert "2 of N" and its URL.
- **Mutations** (each must redden a test): `keepTop` deletes nothing; `ARTWORK_KEEP = 6`; every rank written as 0; gather sorts by id not rank; the route ignores `:id`; a projection includes `url`.

## Out of scope

- Choosing or pinning an image.
- Rendering logos.
- A disk budget beyond the cap.
- `Cache-Control` on artwork responses.
- Reranking pre-upgrade rows before their next job.
