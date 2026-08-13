# Metadata Layout Design

**Status:** approved design, not yet implemented
**Worktree:** `worktrees/metadata-layout`, branch `metadata-layout`

## Goal

Four changes to how confirmed scene metadata is presented on a media card:

1. A poster thumbnail in the card's upper-right corner, opening a modal with
   the full-size image scaled to fit the window. The modal closes via an X in
   its upper-right corner, a click outside it, or the Escape key.
2. A performer avatar thumbnail, about two lines high, before each performer's
   name. Clicking it opens the same modal with the larger image.
3. Each performer's name links to their ThePornDB page.
4. The metadata title links to the scene's ThePornDB page.

Only (1) is buildable against the data we already store. (2), (3) and (4)
require capturing fields the TPDb client currently discards, which is most of
the work.

## What we have today

`MetadataCandidate.performers` is `readonly string[]` — from
`packages/plugin-api/src/types.ts` through `theporndb.ts`, the
`group_metadata.performers` JSON column, `MetadataView`, and into
`MediaCard.tsx`, a performer is a bare name at every layer.
`readPerformerNames` (`theporndb.ts:179`) reads `name` off each performer
object and throws the rest away.

The poster is already fetched, size-capped, content-type validated, cached to
disk by `cachePoster` (`packages/core/src/media/artwork.ts`) and served from
`GET /api/groups/:id/poster`. Bullet 1 needs no backend work at all.

`group_metadata` stores `source_uuid` but no scene slug.

## Ground truth from the live API

Verified against `GET /scenes?per_page=1` on 2026-08-13, not inferred from
documentation. Two findings changed this design:

**The images and the canonical identity live on `performers[].parent`, not on
the performer.** A scene's `performers[]` entries are *site* performers:

```jsonc
{
  "id": "e233fe1f-…", "_id": 2750085,
  "slug": "6061-alice-maze",        // site-prefixed
  "site_id": 6061,
  "name": "Alice Maze",
  "image": null, "thumbnail": null, "face": null,   // all null
  "parent": {
    "id": "5c0dd4eb-…",
    "slug": "alice-maze",
    "name": "Alice Maze",
    "image":     "https://cdn.theporndb.net/performer/…/alice-maze.jpg",
    "thumbnail": "https://cdn.theporndb.net/performer/…/alice-maze-thumb.jpg",
    "face":      "https://thumb.theporndb.net/…/500x500/smart/…alice-maze.jpg"
  }
}
```

Reading `performers[].image` — which is what the field name invites, and what
a third-party Go client models — would ship a feature that renders zero
avatars. A `parent` is absent for performers that are themselves canonical
(`is_parent: true`) and, presumably, for site performers not yet linked to
one; both cases must degrade to a name with no avatar rather than a broken
`<img>`.

**A scene's `url` is the studio's URL**
(`https://www.futilestruggles.com/trial/gallery.php?id=2583&type=vids`), not a
TPDb page. The TPDb page is built from `slug`.

Our own `theporndb.ts` comment about the inverted id naming — scene `id` is
the uuid string, `_id` the integer — is **correct**, and the third-party model
that contradicts it is wrong. No change there.

TPDb page URL forms, confirmed by the maintainer of this repo against the live
site:

| Entity          | URL                                              |
| --------------- | ------------------------------------------------ |
| Scene           | `https://theporndb.net/scenes/<slug>`            |
| Performer       | `https://theporndb.net/performers/<slug>`        |
| Site performer  | `https://theporndb.net/performer-sites/<slug>`   |

A performer's uuid also resolves under `/performers/`. The site is a pure SPA
that answers 200 with identical meta tags for any path, valid or not, so URL
shapes cannot be validated by fetching them — this table is the record of what
was checked by hand.

## Data model

Migration **7**. Versions 1–6 exist, and `migrations.ts` carries two comments
about branches that collided on a version number; `migrate.ts` has a
duplicate-version guard.

```sql
CREATE TABLE performers (
  id          INTEGER PRIMARY KEY,
  source      TEXT    NOT NULL,          -- 'theporndb'
  source_uuid TEXT    NOT NULL,          -- parent.id, else the site performer's id
  slug        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,          -- 'performer' | 'performer-site'
  face_url    TEXT,
  face_path   TEXT,
  image_url   TEXT,
  image_path  TEXT,
  fetched_at  INTEGER NOT NULL,
  UNIQUE (source, source_uuid)
);

CREATE TABLE group_performers (
  group_id     INTEGER NOT NULL REFERENCES media_groups (id),
  performer_id INTEGER NOT NULL REFERENCES performers (id),
  position     INTEGER NOT NULL,
  PRIMARY KEY (group_id, performer_id)
);
CREATE INDEX group_performers_performer ON group_performers (performer_id);

ALTER TABLE group_metadata ADD COLUMN scene_slug TEXT;
```

A table rather than a richer JSON blob, for three reasons. Performers repeat
across scenes, so one row means one avatar fetch and one cached file however
many groups they appear in. `face_path`/`image_path` become
`<performer_id>.<ext>`, which keeps `cachePoster`'s argument that an integer
from our own database beats sanitising a provider-supplied string — a rule
worth preserving now that the string in question is attacker-influenced.
And the link needs somewhere stable to live.

**Identity is the uuid, presentation is the slug.** `source_uuid` is the
unique key so that an upstream slug rename does not orphan a row and re-fetch
its avatars; `slug` is what the href is built from. Both forms resolve for
performers, so this costs nothing and buys durability.

**`kind` decides the URL namespace**, and is set by the same branch that
decides where the avatar came from: a performer read from `parent` is
`'performer'`, a parentless site performer is `'performer-site'`. One decision,
recorded once, rather than two that could disagree.

`group_metadata.performers` — the existing JSON name array — **stays**. It is
the fallback for groups whose metadata was fetched before this change: they
keep showing their cast as plain names instead of losing it, and each group
switches to the join table as its refetch lands.

## Refetch of existing rows

Migration 7 inserts a `metadata_queue` row for every group with a confirmed
`group_metadata` row. The existing worker drains it at its normal rate.

This deliberately bypasses `enqueueMetadata`'s "already answered" guard. That
guard exists so a *lazy browse trigger* cannot re-ask forever
(`db/metadata.ts:104`); a one-time backfill is not that, and routing it
through the guard would mean weakening the guard.

## Fetching and caching

`readPerformerNames` becomes `readPerformers`, returning the new shape and
applying the parent-or-self rule above. `MetadataCandidate.performers` changes
from `readonly string[]` to `readonly MetadataPerformer[]`:

```ts
export interface MetadataPerformer {
  readonly sourceUuid: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: 'performer' | 'performer-site';
  readonly faceUrl: string | null;
  readonly imageUrl: string | null;
}
```

This is a breaking change to `@pickarr/plugin-api`, which is acceptable: the
packages are versioned together in one repo and `plugin-scenes` is the only
implementor.

`cachePoster` generalises to `cacheImage(deps, key, url)`. Its streaming size
cap, content-type allow-list, temp-then-rename and never-throws contract are
already correct and none of them are poster-specific; only the log wording and
the filename's provenance are. `MAX_POSTER_BYTES` becomes `MAX_IMAGE_BYTES`.

Two images are cached per performer: `face` (a 500×500 smart crop) for the
thumbnail and `image` (the full poster) for the modal. Roughly 140 KB per
performer, deduped across every scene they appear in. Scaling one image for
both jobs was considered and rejected — a full-body poster shrunk to two lines
high is unrecognisable, which is the whole point of the thumbnail.

Avatar fetches happen in the metadata worker, alongside the poster fetch, and
are skipped for a performer row that already has a cached path.

## API surface

- `GET /api/performers/:id/avatar` — the cached `face`.
- `GET /api/performers/:id/image` — the cached full image.

Both mirror the poster route: 404 when there is no cached file, and
`cache-control: public, max-age=86400` on a hit, for the same reason the
poster route gives (the file at an id never changes without the row changing).

`MetadataView.performers` changes from `string[]` to:

```ts
{
  id: number;            // our performer id, for the avatar routes
  name: string;
  url: string;           // absolute TPDb link
  hasAvatar: boolean;
  hasImage: boolean;
}[]
```

`MetadataView` gains `sceneUrl: string | null`, built from `scene_slug`.
Absolute URLs are built server-side so the namespace rule
(`/performers/` vs `/performer-sites/`) lives in one place rather than being
re-derived in the browser from a `kind` the client would have to understand.

Groups still on the legacy JSON fallback are reported through a *separate*
field, `performerNames: string[]`, rather than through `performers` with
placeholder values. The view populates `performers` when `group_performers`
has rows for the group and `performerNames` otherwise; the card renders
whichever is present.

Two fields, because there are genuinely two states. Folding them into one
would mean a sentinel id — `-1`, or `0` — on rows that have no performer
record, and every consumer would then have to know not to build an avatar URL
from it. A field that is absent cannot be misused; a field holding a value
that must not be dereferenced will be.

## Web

### `ImageModal`

One component serves the poster and both avatar sizes. Built on a native
`<dialog>` with `showModal()`: real focus trapping, real inertness for the
rest of the page, and a real backdrop, none of which are worth hand-rolling.

- X button in the upper-right corner.
- Click outside closes — on a native modal dialog, a click on the backdrop
  reports as a click on the `<dialog>` element itself, so the handler compares
  `event.target` to the dialog and ignores clicks on its children.
- Escape closes — native behaviour, surfaced through the dialog's `cancel`
  event so the React state that owns "which image is open" is updated rather
  than left out of sync with the DOM.
- The image is `max-width: 100vw; max-height: 100vh; object-fit: contain`, so
  it scales to fit the window in both axes without cropping.

### Testing constraint, and how it is handled

**happy-dom implements `showModal()` but not Escape-to-close.** Verified: an
open dialog given a bubbling, cancelable `keydown` with `key: 'Escape'` still
reports `open === true`, and fires neither `cancel` nor `close`.

So Escape cannot honestly be unit-tested here. A unit test asserting the
modal closes would fail against a correct implementation; one asserting it
stays open would pass against a broken one. Escape gets a Playwright spec in
`packages/e2e`, where a real browser can actually be asked. The X button and
the backdrop click are ordinary unit tests, since both are our own handlers.

This is the same family as the hazards already recorded in
`docs/known-issues.md`: a test whose environment does not implement the
behaviour under test cannot detect that behaviour changing.

### Card layout

The poster moves out of the `.metadata` section to the card's upper-right
corner, positioned against `article.media-card` (which is already the anchor
target and so already a positioned box's natural owner). It keeps its
unconstrained aspect ratio — the provider's images are frequently landscape,
as the existing comment notes.

Performers become a list of rows: avatar (about two lines high, fixed square,
`object-fit: cover`) followed by the name as an `<a>` to its TPDb page,
`target="_blank"` with `rel="noopener noreferrer"`. A performer with no cached
avatar renders the name alone, with no empty box and no broken image.

The metadata title becomes an `<a>` to the scene URL when one is known, and
stays a plain `<p>` when it is not.

## Out of scope

- Any change to how metadata is *matched* or confirmed.
- A manual "refresh metadata" control. The migration's one-time refetch covers
  the existing rows; a per-group refresh is a separate feature.
- Performer bio, measurements, aliases and the rest of `extras`. The API
  returns them; nothing here asks for them.
- Cleaning up cached avatar files for performers no longer referenced by any
  group. Worth an issue; not worth blocking this.
