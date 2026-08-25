# The card's image slot, and a browsable modal — Design

**Phase 2b.** Follows `2026-08-24-poster-background-split-design.md`, which made poster and
background two separate images. This is the phase that spends that correction: the card stops
showing a landscape image in a portrait slot, and every image a group has becomes reachable.

## 1. What this delivers

Phase 2a left a placeholder in `MediaCard.tsx`, labelled `TEMPORARY, and phase 2b deletes it
deliberately`. It renders whichever group image exists, preferring the poster, and exists only
so that 1,494 cards did not go blank the moment `hasPoster` started telling the truth. It is
not a design and was never presented as one.

This phase replaces it with two things:

- **A 2:3 slot** holding the poster, or the first performer's portrait when there is no poster.
- **A browsable modal** over the group's whole image list: poster, background, then each
  performer's portrait.

The second is not decoration on the first. Without it, phase 2a's own migration table says
what happens: 1,494 groups hold a background and no poster, against 14 that hold a poster. A
slot that skips the background and falls through to a performer would leave the scene's only
image invisible for 99% of the library. The modal is what keeps it reachable, and it is the
browse the user described when the slot rule was set.

## 2. Scope

In scope:

- The card's image slot: source order, geometry, and the absence case.
- One ordered image list per group, composed client-side.
- `ImageModal` gaining an index, prev/next, keyboard, and a caption.
- The two renames the change forces, per §3.
- Deleting the temporary fallback.

Explicitly out of scope:

- **Measuring performer artwork.** `cachePerformerArtwork` calls `cacheImage` with no
  measurement, so no performer image's shape is known to the system. §9 records what that
  costs. Measuring them would be a second phase-2a-shaped piece of work — a migration, new
  columns, a backfill over every cached performer image — and §3 chooses to crop instead.
- **A `group_images` table.** Phase 2a's §7 named this as the eventual right shape, "when the
  gallery lands and the list becomes ordered and open-ended". That trigger has not fired. The
  list here spans two tables — group artwork in `group_metadata`, performer artwork in
  `performers` — so a `group_images` table would not hold the performer portraits and the join
  would remain. It fires when a group's own images become open-ended in number, which is
  uploads or multiple provider images, not this.
- **A server endpoint for the list.** The client already holds every input. §4.
- **Adopting provider titles, or any other metadata behaviour.** Untouched.

## 3. The card slot

A fixed 2:3 frame, `width: 6rem`, so 9rem tall, with `object-fit: cover`.

Cropped rather than letterboxed, and that is the whole point of the geometry: today
`.poster-thumb img` bounds the image with `max-width: 6rem; max-height: 8rem`, which means a
landscape background renders 6rem wide and about 3.4rem tall — a wide, short band in a column
sized for a portrait. Cropping is what makes every card's slot the same shape.

It is 1rem taller than today's bound. The alternative — holding 8rem and narrowing to 5.33rem
— was rejected: this is the card's only image, and 6rem is already modest.

Source order:

| the group has | the slot shows |
|---|---|
| a poster | the poster |
| no poster, a performer with a full image | that performer's image, first by cast order |
| neither | nothing: no slot, no placeholder |

"First by cast order" needs no new work. `performersForGroups` already ends
`ORDER BY gp.group_id, gp.position`, so the cast arrives in the provider's own order and the
first entry with `hasImage` is well defined.

The absence case draws nothing rather than a placeholder frame. A placeholder would hold the
column's width and keep every card's text block starting at the same place, which is a real
benefit — but it would also draw the eye to an absence the user cannot act on, since there is
no "add artwork" action to offer. Cards already vary in whether they have a slot; this changes
nothing about that.

The slot is **not** gated on `metadata.state`. It follows the images, so a group whose scene
lookup returned nothing still shows a portrait when the performer search found one. This
follows the cast list, which already renders at any state on the same reasoning: a cast is a
fact about the group rather than part of the scene answer. Gating the slot while showing the
cast below it produced cards that named a performer they would not show.

### 3.1 Two renames, because the old names became false

- `.poster-thumb` becomes **`.card-artwork`**. The element can now hold a performer portrait.
  A class called "poster" would be the same kind of falsehood phase 2a spent a commit
  correcting, in the same codebase, about the same image.
- `alt="Poster for {title}"` becomes **per-image alt text**. A performer portrait announced as
  "Poster for {title}" tells a screen-reader user something untrue about what they are looking
  at. Each image carries its own: `Poster for {title}`, `Background for {title}`, and the
  performer's name.

Nothing in either test suite selects `.poster-thumb`, and `ImageModal.test.tsx` passes `alt` as
a literal of its own, so neither rename has a consumer to update.

## 4. The image list

One pure function beside the card:

```ts
function groupImages(group: GroupView): GroupImage[]
```

returning `{ src, alt, caption }` in order — poster, background, then each performer's full
image — including each only when its boolean says the file exists. A pure function of the view
rather than a hook or a method, so it is tested without rendering anything.

Composed client-side, from data the card already holds. This is what phase 2a's §7 planned
for: "those are four addressable routes — two group images and the two existing performer ones
— with a boolean each saying whether they exist. That is enough to build the list client-side
without another schema change." A server endpoint would ship the same facts twice, define the
order in a second place, and cost either a round trip on open or an eager fetch per card.

**The slot's image is not `images[0]`.** The list starts with the background when there is no
poster; the slot skips the background entirely. Those are two different rules on purpose — the
slot must not crop a landscape image, the modal must not hide one — so the slot performs its
own selection per §3 rather than reading the head of the list. Stated here because the two
rules look close enough to be collapsed by a later reader, and collapsing them reintroduces
exactly the cropping this phase exists to remove.

Clicking the slot opens the modal at index 0. For the 1,494 background-only groups that means
the modal opens on the background, not on the performer portrait that was clicked. This is
deliberate: the browse is ordered from the scene's own images outward, and the scene image is
the more informative thing to land on. It is also the one place where what opens is not what
was clicked, and worth knowing before it is reported as a bug.

## 5. The modal

`ImageModal`'s props become `{ images, startIndex, onClose }`, and it owns the browse index
itself.

The card keeps exactly one piece of modal state. Its existing comment — "so the poster and a
performer's full image can never both be open at once" — becomes more true rather than less:
both call sites now open the *same list*, differing only in where they start. The card slot
opens at index 0; a performer's avatar opens at that performer's own entry.

Escape, focus trapping, the backdrop and focus restoration stay the browser's, through the
native `<dialog>` and `showModal()` already in place. Unchanged.

Added: prev/next buttons, ArrowLeft/ArrowRight, and a caption reading `Background · 2 of 3`.

Bounds **clamp rather than wrap**, with each button `disabled` at its end. A three-item list
that loops silently gives the user no way to tell where it begins. Disabled buttons show the
shape of the list instead of hiding it.

A single-image list renders **no prev/next chrome at all**. This is the judgement the card
already makes one component away, for a performer with a face but no full image: "Opening a
modal onto a 404 is worse than not offering." A control that cannot act is worse than no
control.

## 6. When a boolean lies

All four booleans read a path column — `metadata.posterPath !== null`,
`performer.imagePath !== null`, and their two siblings, at `http/views.ts:214-238`. So a true
boolean means "a row names a file", not "a file is there". The two differ whenever a cached
file goes missing, which is a state this project has just spent a phase handling.

Today it cannot bite: the card only ever opens an image it has already rendered. A list built
from booleans is different — an entry whose file has vanished is a frame the user can page
onto.

On the image's `onError`, the frame shows **"This image could not be loaded"** in place of the
image, keeping its caption and its controls.

Deliberately not dropping the entry from the list. Removing an item mid-browse renumbers every
item after it and moves the ground under the user's feet, turning one missing file into a list
that disagrees with the one they started reading. A visible gap that can be paged past is the
honest failure.

## 7. What gets deleted

The `thumbnail` expression in `MediaCard.tsx` and the comment above it. That comment names its
own replacement and asks not to be mistaken for the intended design; this is the phase that
honours it.

This also discharges the last bullet of phase 2a's §11: "Phase 2b must delete §6's fallback.
If it does not, the card keeps showing landscape backgrounds cropped into a 2:3 slot, which is
the outcome this whole phase exists to make impossible."

## 8. Testing

Web suite (`.test.tsx`, happy-dom):

- `groupImages`: ordering; each boolean's effect on inclusion; the empty list.
- The slot's own selection: a poster wins; a performer portrait when there is no poster; **no
  slot rendered** when there is neither; a slot on a group whose state is not `confirmed`.
- Per-image alt text, including that a performer portrait is not announced as a poster.
- The modal: opens at `startIndex`; clamps at both ends with the buttons disabled; renders no
  chrome for a one-image list; shows the failure text on `onError`.

Playwright: the browse flow end to end, and Escape — which stays e2e-only because happy-dom
does not implement the `cancel` event Escape arrives through, as `ImageModal`'s own doc already
records. The rest of the dialog is testable in happy-dom: the existing modal test renders
through `showModal()` today.

## 9. Risks

- **No performer image's shape is known.** `cachePerformerArtwork` measures nothing, so the
  2:3 slot may be fed a landscape performer image and will centre-crop it. Accepted rather
  than solved: a cropped photograph of a person still reads as that person, where a cropped
  scene background loses its composition entirely. That asymmetry is the whole reason the slot
  skips the background but crops a portrait.
- **No test can prove the crop is flattering.** Tests can pin that the slot crops rather than
  letterboxes. Whether the result looks right is a judgement that needs eyes on the real
  library, and the library is not on the machine this was designed on.
- **The list's order is defined in the client.** Two consumers exist today — the slot and the
  modal — and they deliberately disagree (§4). A third consumer would be the point to move the
  order somewhere both must obey.
- **The modal opens on something other than what was clicked** for background-only groups
  (§4). Intended, and the most likely part of this to be reported as a defect.
