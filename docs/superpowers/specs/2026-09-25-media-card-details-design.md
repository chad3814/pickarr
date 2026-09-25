# The media card's expanded detail section

**Date:** 2026-09-25
**Status:** proposed

## The problem

Expanding a browse card today reveals exactly one thing: the release
list. Everything the lookup service learned about the item — its
description, its release date, its cast, which provider identified it —
is in the replica and rendered nowhere. The poster exists too, and is
shown only as the small browse-list image outside the `<article>`.

So an operator deciding whether to download a release cannot see what
the thing *is* without leaving Pickarr.

## What this builds

A detail section inside the expanded card, above the release list:

```
┌────────────────────────────────────────────────────────┐
│ Blockers (2018)                                     ▾  │
├────────────────────────────────────────────────────────┤
│ ┌────────┐  [⛓][TMDb][IMDb]                            │
│ │        │                                             │
│ │ poster │  Three parents set out to stop their        │
│ │        │  daughters from losing their virginity…     │
│ └────────┘                                             │
│                                                        │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐                              │
│  │  │ │  │ │  │ │  │ │  │                              │
│  └──┘ └──┘ └──┘ └──┘ └──┘                              │
│  Leslie John Ike  Kathryn Graham                       │
│  Mann   Cena Barinholtz Newton  Phillips               │
│                                                        │
│  Release Date: 2018-04-06   data provided by The Movie │
│                                          Database      │
├────────────────────────────────────────────────────────┤
│ (release list, unchanged)                              │
└────────────────────────────────────────────────────────┘
```

Clicking the poster, or any person's picture, opens a gallery modal
over the images for that subject, captioned with the media item's title
or the person's name. Clicking a person's *name* opens their page on the
provider that identified them.

## Architecture

### The seam has to widen before anything renders

`GatheredItemView` — the whole of what a card receives about an item
beyond `item` itself — declares exactly one field:

```ts
export interface GatheredItemView {
  readonly releases: readonly GatheredReleaseView[];
}
```

Web's own `GatheredItem` already carries `roles` (each with its
`person` resolved), `artwork` (the three urls) and `feedIds`. None of
it crosses into `plugin-ui`. So the first task widens the view to carry
`roles` and `artwork`, mirrored the way `types.ts` already documents:
`web/src/store/gather.ts` stays the source, and its existing
compile-time check is what keeps the two declarations in step.

**No host change, no migration, no new query.** Everything this feature
renders is already replicated and already gathered; it is simply not
passed along. That is the single most important fact about this slice's
size, and it was established by reading `gather.ts` rather than assumed.

### The section is shared, not per-plugin

All three plugins render the same thing, so `MediaDetails` lives in
`@pickarr/plugin-ui` beside `ReleaseList` and each card composes it:

```tsx
{expanded && gathered !== undefined && (
  <>
    <MediaDetails item={item} gathered={gathered} extraLinks={…} />
    <ReleaseList releases={gathered.releases} submit={submit} />
  </>
)}
```

This is the second web-side-shaped component in `plugin-ui` after
`CardHeading`, and for the same reason: the alternative is three
copies that drift.

### External links

A pure function over `provider` and `providerRef`, because both are
`media_item` columns every card already has.

**Every url below was verified live, by status code, rather than
inferred from another provider's shape** — and one of them would have
been wrong:

| Provider | Media | Person |
|---|---|---|
| `tmdb` | `https://www.themoviedb.org/{movie\|tv}/{id}` | `https://www.themoviedb.org/person/{id}` |
| `tvdb` | `https://thetvdb.com/dereferrer/{series\|movie\|episode}/{id}` | `https://thetvdb.com/dereferrer/people/{id}` |
| `tpdb` | `https://theporndb.net/scenes/{uuid}` | `https://theporndb.net/performers/{uuid}` |
| imdb | `https://www.imdb.com/title/{ttid}/` | — |

**`https://thetvdb.com/series/184871` answers 404.** TheTVDB's pages are
slug-based and `/dereferrer/<type>/<id>` is the id-addressable route;
assuming symmetry with TMDB's `/tv/{id}` would have shipped a dead link
on every TheTVDB item. `dereferrer/season/{id}` also 404s, which costs
nothing because no media item is a season.

**Reference formats differ per provider and the link builder must
parse, not concatenate.** TMDB sends a composite — `tmdb:movie:335984`,
`tmdb:tv:1399:1:1` — where TheTVDB sends a bare id and ThePornDB sends a
bare uuid. `artwork/tmdb.ts`'s `tmdbId` and `artwork/tvdb.ts`'s `tvdbId`
exist because this exact assumption cost 743 dead jobs; this builder
reuses the same parse rather than repeating the mistake in the browser.
The TMDB composite is also where the media *type* comes from: the second
segment picks `movie` or `tv`.

A provider with no entry, or a reference that will not parse, renders no
icon — never a broken link.

**IMDb is the movie plugin's, not the shared component's.**
`movie_detail.imdb_id` is a plugin table's column, already on disk and
already populated by `plugin-movie/src/apply.ts` from the lookup
service's `details.imdbId`. It is missing only from the sync
projection. So `MediaDetails` takes an optional `extraLinks` prop and
the movie card supplies IMDb from its own row; `tv_series` has no
equivalent column and a ThePornDB scene has no IMDb identity, so both
pass nothing. This also means `plugin-movie` gains
`tables: ['movie_detail']`, which it does not declare today.

### The gallery

**Over the images that exist, which is fewer than the phrase suggests.**
The artwork job stores one poster, one background and one logo per media
item, and one picture per person: `bestImage` picks a single winner per
slot and `ARTWORK_QUERY` serves it with `LIMIT 1`. So a media item's
gallery holds at most three images and a person's holds exactly one.

That is a deliberate acceptance, not an oversight. Storing every image a
provider returns is issue #79 — TheTVDB answered 747 artworks for one
series on the sample read — and it needs a keep-N cap, a disk budget, a
list route and a job change. Building the modal now against three images
means #79 widens a component that already exists, rather than shipping
both at once.

The modal takes a list of urls and a caption. **A 404 is the normal
case**, so each image is dropped on `error` the way `MediaItemCard`
already drops its poster, and a subject with nothing left renders no
modal rather than an empty one.

### Accessibility

The poster and each person's picture are `<button>`s; the modal is a
real dialog with a focus trap and Escape to close, returning focus to
the control that opened it.

**Asserting the roles is not enough, and this repo has the scar.**
`IdentityChangeConfirm` shipped with `role="dialog"` and an
`aria-label`, passed eight unit tests and two Playwright specs, and
rendered as an unstyled block of text because no stylesheet rule
matched it. The gallery therefore gets a visible heading wired through
`aria-labelledby` rather than a duplicated `aria-label`, and its tests
assert rendered geometry — that the backdrop covers the viewport and the
image is inside it — not only that the accessibility tree is satisfied.

### Icons

The repo has no icons at all today; this introduces the first. Inline
SVG components in `plugin-ui`, coloured by `currentColor` so both themes
work with no second asset, and no build-pipeline change.

Provider marks are **lettermark badges** (`TMDb`, `TVDb`, `IMDb`,
`TPDb`), not the companies' logos: the real marks are trademarks with
usage rules, and a badge is recognisable enough for a row of link
affordances. TMDB's attribution requirement is met by the footer line
this feature already adds.

The file-type icon leads the row, one per **distinct** `downloadType`
across the item's releases — one in the common case, two for an item
holding both an nzb and a torrent. `download_type` is an `rss_item`
column, so an item genuinely can carry both and a single icon would
have to lie about one of them.

### Two things the request assumed that the data does not hold

1. **`mediaItem.provider.name` is not a thing.** `media_item.provider`
   is the bare lowercase string the lookup service answered with —
   `tmdb`, `tvdb`, `tpdb`. The footer's display name comes from a map in
   the link module, beside the url patterns it already keys on the same
   value.
2. **A person can hold several roles on one item**, so "up to five
   people" is five distinct `personId`s, not five `role` rows. Ordered
   by `billingOrder` ascending with nulls last, then by `person.name` so
   the order is total and two runs agree. `GatheredRole.person` is
   `undefined` for a role whose person has not yet replicated — those
   are skipped, because a nameless face is worse than a shorter cast.

## Components

| File | Responsibility |
|---|---|
| `packages/web/src/store/gather.ts` | widen `GatheredItem` → the view; person artwork urls |
| `packages/plugin-ui/src/types.ts` | `GatheredItemView` gains `roles` and `artwork` |
| `packages/plugin-ui/src/MediaDetails.tsx` | the section: poster, icon row, description, people, footer |
| `packages/plugin-ui/src/Gallery.tsx` | the modal: image list, caption, focus trap, Escape |
| `packages/plugin-ui/src/links.ts` | `providerLinks`, `personLink`, provider display names |
| `packages/plugin-ui/src/icons.tsx` | inline SVGs: nzb, torrent, provider lettermarks, image placeholder |
| `packages/plugin-movie/src/sync.ts` | `imdb_id` joins the projection |
| `packages/plugin-movie/src/browser.tsx` | `tables: ['movie_detail']`, supplies the IMDb link |
| `packages/plugin-tv/src/browser.tsx`, `packages/plugin-xxx/src/browser.tsx` | render `MediaDetails` |
| `packages/web/src/styles/library.css` | the section, the people strip, the modal |

## Testing

- **Links:** every pattern asserted as a literal string, never rebuilt by
  calling the builder — `CLAUDE.md` records `groupAnchor` passing 70
  tests while returning a constant. A composite TMDB ref, a bare TheTVDB
  id and a uuid each get a case, plus a ref that will not parse
  rendering no icon.
- **People:** de-duplication across two roles for one person; the
  `billingOrder` null-last ordering; the sixth person absent; a role
  whose person has not replicated skipped.
- **Gallery:** an image that 404s leaves the gallery; a subject whose
  images all 404 opens nothing; Escape and the focus trap; focus returns
  to the opener.
- **Browser:** one spec that the section *renders as a section* —
  geometry, not roles, per the `IdentityChangeConfirm` lesson.
- **Sync:** `movie_detail`'s projection guards extend to `imdb_id`.

## Out of scope

- **Issue #79, storing more than one image per slot.** Named above; the
  gallery is built so that widening storage needs no new component.
- **xxx site logos in the title bar.** A site is an `xxx_site` row, not a
  `media_item`, and every artwork table is keyed on `media_item_id` or
  `person_id` — so a site cannot own artwork today. It needs a new owner,
  a fetch path and a route kind. Worth recording for that slice: ThePornDB's
  scene payload carries a `site` object with a `logo` field, so the
  source data exists. Until then xxx titles keep the site name.
- **An IMDb link for television.** `tv_series` has no `imdb_id` column;
  adding one is a plugin migration and a lookup-service field that is
  not read today.
- **The rss feed name in the section.** Asked for, then withdrawn: a feed
  belongs to an `rss_item`, and a media item's releases can come from
  several feeds, so there is no one feed name to show.
