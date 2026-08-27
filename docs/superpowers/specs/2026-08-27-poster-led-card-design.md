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
- `groupSearchText` gains the provider's title and date, so search keeps matching what is on
  screen (§5).

Explicitly out of scope:

- **Any change to the poster's size or aspect.** The 2:3 6rem frame from 1.8 is unchanged.
- **Master/detail Browse and the view switcher.** Phase 3, as phase 1 said.
- **The image gallery.** Still later; the browsable modal from 1.8 is what exists.
- **Measuring performer artwork.** Unchanged since 1.8's §9 recorded it.
- **Adopting any provider value other than title and date.** Synopsis, duration, cast and
  performers are already displayed from the provider; nothing else changes hands.
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

## 5. Search follows what is displayed

`groupSearchText` builds its haystack from `display.title`, `display.subtitle`, `display.date`
and the display fields. It does not read the metadata view at all. Left alone, this phase
would make the visible title unsearchable and keep a hidden one matching.

The provider's title and date join the haystack. The plugin's stay in it: a date that is no
longer displayed is still a reasonable thing to search for, and dropping it would lose matches
for no gain.

This is the only reason this phase touches anything outside `MediaCard` and the stylesheet.

## 6. Testing

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

`packages/web/test/search.test.ts`: a term matching only the provider's title finds the group;
a term matching only the plugin's still does.

`packages/e2e/tests/card-layout.spec.ts` asserts the artwork's position, and two of its
assertions are directional: one requires the artwork to start right of the heading's right
edge, the other requires the fields to start left of the artwork. Both **invert** — the
artwork now starts left of the heading, and the fields start right of it. They are inverted,
not relaxed: an assertion that stops constraining the axis it was written for is worse than
one pointing the wrong way, and this file has been weakened by accident before.

## 7. Risks

- **Almost every card in the current library will lead with a performer portrait**, because
  the scenes plugin's artwork is 1,494 backgrounds to 14 posters and the slot refuses a
  landscape image. That is a property of adult content, not of Pickarr: future content types
  carry posters for the majority, and the card is deliberately content-agnostic. Designing
  around the scenes ratio would optimise for the one plugin that is atypical. Recorded because
  it is what the screen will actually look like today.
- **The synopsis has never been rendered at this width.** It moves from the card's full width
  into a column narrowed by the poster and by phase 1's nav change. §1 states why that is not
  assumable; the mitigation is looking at a real synopsis in the built app early, not at the
  end.
- **Adoption is hard to undo cheaply.** Once the card shows provider titles, a reader's mental
  index of their library is the provider's naming. Reverting means re-teaching it.
- **A group with a background, no poster and no cast portrait draws no slot at all**, so a
  poster-led card leads with nothing for it. Filed as #75; unchanged by this phase, more
  visible in it.
