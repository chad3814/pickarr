# The poster-led card — Design

**Phase 2 of the UI redesign**, and the first phase of it to change layout.
`2026-08-23-design-system-design.md` §1 set the sequence: "This is phase 1 of three. Phase 2
is the poster-led card layout; phase 3 is a master/detail view of Browse with a switcher
between the two."

The two specs dated 2026-08-24 and 2026-08-25 label themselves phase 2a and 2b. They were
not this phase. Both were prerequisites found while starting it — the data model had to stop
calling landscape images posters (1.5), and the image slot had to stop cropping them (1.8) —
and the record reads better with those numbers. Phase 2 begins here.

## 1. What this delivers

Mockup **B**, "poster-led band", from the phase 1 brainstorm: the artwork leads on the left,
the scene's own metadata sits beside it rather than below the release rows, and the header
collapses to a title and one line of context.

Two things it deliberately does **not** change. The poster stays **6rem** wide — the mockup's
caption said "artwork gets real size" and that is not wanted; the current width reads well. And
the release table stays where it is: it already sits under the whole card, so "the release
table sits under the whole card" is satisfied today.

Phase 1's §12 left a note for this phase — the nav widening "reduces the content column by
roughly 70px on a 60rem layout. Phase 2's poster-led card is the design that has to live with
it, and it should be checked there rather than assumed here." Keeping the poster at 6rem does
not discharge it. The synopsis is what makes it bite: today it spans the card's full width
below the release rows, and here it moves into the column beside the poster, losing 6rem plus
a gap on top of the nav's 70px. Whether the synopsis still reads at that width is the one
thing about this layout that cannot be settled on paper.

## 2. Scope

In scope:

- The artwork moves from the right of the identity column to the left of it.
- The scene metadata panel moves from below the release rows into the card head.
- The header collapses to a title plus one `·`-joined line of context.
- The card becomes **provider-led**: the provider's title and date are what it shows, with the
  plugin's display title as the fallback (§4).

Explicitly out of scope:

- **Any change to the poster's size or aspect.** The 2:3 6rem frame from 1.8 is unchanged.
- **Master/detail Browse and the view switcher.** Phase 3, as phase 1 said.
- **The image gallery.** Still later; the browsable modal from 1.8 is what exists.
- **Measuring performer artwork.** Unchanged since 1.8's §9 recorded it.
- **Adopting any provider value other than title and date.** Synopsis, duration, cast and
  performers are already displayed from the provider; nothing else changes hands.
- **Search.** `groupSearchText` mirrors `searchTextFor` in `packages/core/src/ingest/commit.ts`,
  which fills the stored `search_text` column `/api/browse?q=` matches against, and
  `search_text` is derived from `display` alone — `recordMetadataAnswer` never touches it.
  Making the provider's title searchable is therefore a data change (a derivation that also
  reads the answer, a rewrite when one lands or is cleared, a backfill, and the client mirror
  in step), not a change to one pure function. Out of scope, and not filed as a gap: the parsed
  title is performer-name-led, and a performer's name stays searchable through `display.title`
  and the performer fields regardless.
- **Responsive layout.** The app assumes a desktop window, as it did in phase 1.

## 3. The layout

`.card-head` keeps its flex row and swaps the order: `.card-artwork` first, `.card-head-main`
second. The artwork keeps `flex: none` and its 6rem 2:3 cropped frame; the identity column
keeps `flex: 1; min-width: 0`.

Everything the scene panel holds moves into `.card-head-main`, in this order:

1. `<h2>` — the title (§4)
2. the context line — `·`-joined (§4)
3. `.badge` — "Upgrade available", unchanged
4. the pending note, when the metadata lookup is in flight
5. the identity form, when open — unchanged
6. `.card-actions` — Edit and Requery, unchanged
7. `.fields` chips — plugin display fields, unchanged
8. `.metadata-synopsis`
9. the cast list

The pending note moves with the panel. Left below the release rows it would be the only
metadata-derived thing still down there, describing a lookup whose result now renders above.

`ul.releases` stays exactly where it is, after `.card-head`. `.metadata` as a *section* stops
existing: its children are now part of the identity column, so a wrapper whose only job was
to group them below the releases has nothing left to group. `.metadata-performers`,
`.metadata-synopsis` and `.metadata-pending` keep their class names and their phase 1 rules.

### 3.1 The cast renders once, not twice

`MediaCard` renders the cast from two places today: inside the scene panel for a confirmed
group, and standalone for one the provider had nothing for. That existed because the cast
belongs *inside* the panel when there is one and has to stand alone when there is not. With
the panel's children moved into the identity column, there is no longer an enclosing section
to be inside or outside of, so the two call sites collapse to one. The exclusivity the
existing code protects — one list or the other, never both — becomes structural rather than
maintained.

## 4. Provider-led title and date

This is the substantive behaviour change, and it reverses a rule the earlier phases held.

Today the header shows `display.title` and `display.date` — the plugin's parse of the release
name — and the scene panel shows `metadata.title` and `metadata.releaseDate` beside them. The
current comment states the rule being reversed: "A second opinion, never a replacement:
`display.title` above stays the card's title even when the provider disagrees with it —
adopting a provider value is later work (this phase is deliberately non-destructive)."

Collapsing the header into one title makes that position untenable: two titles and two dates,
usually identical, would sit adjacent. The decision is to adopt.

| what shows | source | fallback |
|---|---|---|
| title | `metadata.title` when non-null | `display.title` |
| date | `metadata.releaseDate` when non-null | **nothing** — the parsed date is not shown |
| studio | `display.subtitle` | omitted from the line |
| runtime | `formatDuration(metadata.durationSeconds)` | omitted from the line |

The context line is those three joined with ` · `, with absent parts omitted rather than
leaving separators — a group with a studio and nothing else reads `Brazzers`, not
`Brazzers · ·`.

`sceneUrl` links whichever title renders, so the scene stays one click away whether the title
came from the provider or the plugin.

Two consequences to state rather than discover:

**A confirmed answer can carry `title: null`.** The fallback is not only for groups the
provider never answered about, and a card can show a parsed title while displaying a provider
synopsis beside it.

**A card's title can now change when an answer lands.** That is what adopting means. It was
refused twice before on the grounds that this phase should be non-destructive; it is taken
here because the collapsed header has no room to hold both opinions.

### 4.1 Why the fallback is `display.title` and not a release name

The fallback stays the plugin's display title rather than reaching into
`group.releases[].releaseName`, and the reason is the contract `MediaCard` states in its own
first line: "One card renders every media type. Plugins supply display fields, never UI."

Filename parsing is on its way out of Pickarr entirely. When it goes, the scenes plugin will
set `display.title` to the release name for a release the metadata service returned no match
for — a release with no match is its own group by definition, so there is exactly one name to
use, and the result reads like the Failed tab's raw rows. A card that falls back to
`display.title` needs **no change at all** on that day. A card that reached for a release name
itself would have to pick one, and would be deciding presentation the plugin owns.

## 5. Testing

`packages/web/test/MediaCard.test.tsx`:

- the title is the provider's when it has one, and the plugin's when the provider's is null —
  including for a **confirmed** answer whose title is null
- the context line joins studio, provider date and runtime with ` · `, and omits absent parts
  without leaving separators
- the parsed date does not appear when the provider has no date
- `sceneUrl` links the rendered title in both the provider and fallback cases
- the cast renders exactly once for a confirmed group and once for an unconfirmed one with a
  cast — the same exclusivity, now structural
- the pending note renders in the head

`packages/e2e/tests/card-layout.spec.ts` asserts the artwork's position, and two of its
assertions are directional: one requires the artwork to start right of the heading's right
edge, the other requires the fields to start left of the artwork. Both **invert** — the
artwork now starts left of the heading, and the fields start right of it. They are inverted,
not relaxed: an assertion that stops constraining the axis it was written for is worse than
one pointing the wrong way, and this file has been weakened by accident before.

## 6. Risks

- **Measured against `pickarr-2026-08-27.db`, 4,313 groups, this is what leads each card:** an
  actual poster on **18** (0.4%), a performer portrait on **3,046** (71%), and **nothing at all
  on 1,249** (29%). Of those 1,249, **131** hold a background nothing in the UI can reach
  (#75). A poster-led layout therefore leads with a poster on one card in 240, and with an
  empty column on nearly a third. That is a property of adult content, not of Pickarr — future
  content types carry posters for the majority and the card is deliberately content-agnostic,
  so designing around the scenes ratio would optimise for the one plugin that is atypical. The
  empty-column decision stands as taken in 1.8: no slot, no placeholder.
- **The title changes on most confirmed cards.** 1,957 groups (45%) have a provider title and
  all of them have a provider date; 2,356 (55%) fall back to `display.title` and show no date.
  Of the 1,957, **1,715 differ from the parsed title and 1,677 differ substantively.** That is
  expected rather than alarming: the parsed title is performer-name-led — scene release names
  usually open with a performer and only sometimes carry the scene title — while the provider
  returns the scene's actual title. Adoption is what puts the real title on the card. Recorded
  because it means this phase visibly renames most of the library.
- **The title on the card is not searchable.** `searchTextFor` in
  `packages/core/src/ingest/commit.ts` fills the stored `search_text` column from `display`
  alone, and `groupSearchText` in `packages/web/src/api/search.ts` mirrors it, so for the
  1,957 groups now showing a provider title the string on the card matches nothing typed
  into the search box — on Browse through `search_text`, on Picks through
  `groupSearchText`. Before this phase every displayed title was searchable, and that
  stops being true here. §2 scopes the fix out and gives the reason (it is a data change,
  not a change to one pure function); the consequence is recorded because it is not
  discoverable from that scope note, only by typing a title off a card and getting nothing
  back.
- **Every other surface still names a group by its parsed title.**
  `IdentityChangeConfirm` renders `plan.mergeInto.title`, which `titleOf` in
  `manual/identity-plan.ts` reads from `display`, so it says "This will merge into Alex
  Coal" while the heading of the card being merged into reads "A Different Title". So does
  the Downloads row label (`views.ts` sends `title: display.title`), and so do the
  post-merge notices in `Browse.tsx` ("Releases moved into …") and `Failed.tsx` ("… joined
  an existing group"). Each is arguably correct: these are identity operations, and a
  group's identity is the parsed title the merge actually keys on, not the provider's
  opinion of the scene. But nobody decided that — it is what falls out of adopting in one
  component — and one consequence is concrete rather than philosophical: a Downloads row's
  link now carries a label that disagrees with the heading of the card it scrolls to.
- **The synopsis has never been rendered at this width.** It moves from the card's full width
  into a column narrowed by the poster and by phase 1's nav change. §1 states why that is not
  assumable; the mitigation is looking at a real synopsis in the built app early, not at the
  end.
- **Adoption is hard to undo cheaply.** Once the card shows provider titles, a reader's mental
  index of their library is the provider's naming. Reverting means re-teaching it.
- **A group with a background, no poster and no cast portrait draws no slot at all**, so a
  poster-led card leads with nothing for it. Filed as #75; unchanged by this phase, more
  visible in it.
