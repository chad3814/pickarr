# Master/detail Browse, with a view switcher — Design

**Phase 3 of the UI redesign, and the last of the three phase 1 laid out.**
`2026-08-23-design-system-design.md` §1: "This is phase 1 of three. Phase 2 is the poster-led
card layout; phase 3 is a master/detail view of Browse with a switcher between the two."

The two specs dated 2026-08-24 and 2026-08-25 label themselves 2a and 2b. They were
prerequisites found while starting phase 2 — the data model had to stop calling landscape
images posters, and the slot had to stop cropping them — and the record reads better as 1.5
and 1.8.

## 1. What this delivers

A second way to read Browse: a dense scannable list on the left, the selected group's full
card on the right, and a control to switch between that and today's column of cards.

Mockup **C** from the phase 1 brainstorm, which described itself as "a dense scannable list on
the left; the selected group's artwork, synopsis and full release table on the right."

**The detail pane is `MediaCard`, unchanged.** Mockup C's right-hand pane — poster, title,
studio · date · runtime, upgrade badge, synopsis, then the release table — is what phase 2
built. So the master list is the only new rendering here, and phase 2's card is reused rather
than reimplemented.

### 1.1 What this phase is not, and why

The mockup's caption listed option C's costs as "selection state, deep links, keyboard
movement, and a rethink of how infinite scroll and search behave." Three of those five turned
out not to apply, and saying so is most of what keeps this phase small:

- **No deep links, and no endpoint to serve them.** Nothing in the app links to a Browse
  group. `DownloadRow` is the only component that links to a group at all and it targets
  `/picks#group-N`; every other navigation is a top-level `NavLink`, and Browse is `/`. A
  cold-load link to an arbitrary group would need `GET /api/groups/:id`, which does not exist.
  Since every selectable group is one the reader just clicked, and is therefore already in the
  loaded list, the endpoint has no caller. It is not built.
- **No URL state.** With no inbound links, URL selection would buy reload-preserves-your-place
  and the back button. Browse does not preserve scroll position today, so that is not a
  standard this app currently holds itself to, and adding it for selection alone would be the
  only URL state in the application.
- **No rethink of infinite scroll.** `usePagedList` already returns `sentinelRef`; the split
  view renders it at the foot of the master list instead of the card list. Nothing about
  paging changes.
- **No shared abstraction for Picks.** Picks has the same too-long-list problem and will get
  its own treatment, with ideas that are not this design's to guess at. Building a component
  parameterised over a Picks that has not been designed would be inventing an interface for
  requirements nobody has.

## 2. Scope

In scope:

- A `list | split` switcher above Browse's list, persisted per browser.
- A master list: one dense row per group, selection, keyboard movement.
- The detail pane, rendering `MediaCard` for the selected group.
- Widening the app shell in split view only.
- Extracting phase 2's title rule so the row and the pane agree.

Explicitly out of scope:

- **Picks.** Unchanged. §1.1.
- **Deep links, URL state, and `GET /api/groups/:id`.** §1.1.
- **Any change to `MediaCard`'s own composition.** The pane renders it as phase 2 left it.
- **Any change to paging, or to Browse's server-side search.** `?q=` is untouched.
- **Responsive layout.** The app assumes a desktop window, as it has since phase 1.
- **Thumbnails in the master list.** §3.

## 3. The master list

One row per group, text only. No thumbnail: the poster is in the pane a few hundred pixels
away, and a per-row image would cost width and one request per row across a library measured at
4,313 groups.

Each row carries:

| part | source |
|---|---|
| title | `groupTitle(group)` — §5 |
| studio | `display.subtitle`, omitted when absent |
| release count | `group.releases.length`, as `N releases` (`1 release` singular) |
| upgrade marker | `↑`, with an accessible name, when `group.upgradeReleaseId !== null` |

Studio and count join with ` · ` on the same rule the card's context line uses: one span per
part, separator drawn between adjacent siblings, so an absent part leaves no orphan.

**The list is a listbox.** `role="listbox"` on the container, `role="option"` with
`aria-selected` on each row, and a roving `tabIndex` so exactly one row sits in the tab order.
ArrowUp and ArrowDown move the selection and scroll the newly selected row into view. No
Home/End, no type-ahead — neither was asked for, and a listbox that grows by paging is a poor
place to promise "End".

`usePagedList`'s `sentinelRef` renders at the foot of the list, so scrolling the master list
loads the next page exactly as scrolling the card list does.

## 4. Selection

**Selection is a group id in component state.** The pane derives its group by looking that id
up in `items`.

One source of truth, and that is the point. `Browse` already merges live metadata into `items`
(and a pick, and an edit), so a pane that re-derives on every render is never stale. A pane
holding its own copy of the group would rot the moment an answer landed.

**When the selected id leaves `items`, the selection clears and the pane shows its empty
state.** That happens when a search term filters the group out, or when a new term replaces the
page — `usePagedList` bumps a generation and rebuilds. Clearing is the honest outcome: the
alternative is a pane showing a group the list beside it says is not there.

Nothing is selected on arrival. The pane's empty state says so, rather than auto-selecting the
first row: an auto-selection would fire a metadata lookup for a group the reader never asked
about, and on a library this size the first row is not a meaningful default.

## 5. One extraction: the title rule

Phase 2 made the card provider-led, inline in `MediaCard`:

```ts
const answered = metadata.state === 'confirmed' ? metadata : null;
const title = text(answered?.title) ?? display.title;
```

The master row must show **the same** title, or the list and the pane disagree about what a
group is called. That is not hypothetical: phase 2 spent a fix round on exactly this defect,
when the artwork button's `aria-label` kept `display.title` while the heading had adopted the
provider's, so a screen-reader user heard a name appearing nowhere on screen.

So the rule moves to a pure function beside `groupImages` and `slotImage`, which is where this
codebase already keeps derivations of a view:

```ts
export function groupTitle(group: GroupView): string
```

`MediaCard` calls it too. This is the only shared code the phase adds, and it exists because a
second consumer exists — not in anticipation of one.

## 6. The shell widens in split view

`.app` is `display: flex; gap: var(--space-5); max-width: 60rem` — the row holding `<nav>` and
`<main>`. In split view its cap rises to `90rem`. The nav's width is intrinsic, so the extra
space lands in `<main>`, which is what the two panes divide.

Phase 1 pinned 60rem and phase 2 kept it; this phase is where changing it was always going to
happen. Splitting inside 60rem would leave the detail pane around 600px, and after the card's
98px artwork and its gap that is a text column near 490px — the exact width at which phase 2's
measured note says the synopsis's `68ch` cap stops binding, and the regime its `card-layout`
guard does not cover, because that guard measures the widest card shape. Widening avoids
walking into the one measurement phase 2 flagged as unverified.

The list pane takes `22rem` and the detail pane the rest — enough for a title to run two lines
before wrapping at the narrowest supported window, and it leaves the pane wider than the 60rem
column the card renders in today.

**Neither pane gets its own scrollbar, and that is a constraint rather than a preference.**
`usePagedList` observes its sentinel with an `IntersectionObserver` whose root is the viewport
(`ROOT_MARGIN = '200px'`, no `root` option), and `Browse` renders that sentinel after the whole
split row, outside the master list entirely. That placement is why giving the master list its
own scroll container does not fail the way it first sounds like it would. Confirmed in a real
browser during task 4: `overflow-y: auto` on the list alone does nothing at all, because the
list's height already equals its content and no scroll container forms. Pair it with a height
bound — the realistic way anyone reaches for this — and the failure inverts instead of going
quiet: once the list stops growing taller as rows arrive, the split row's height (and so the
document's) stops tracking how many groups have loaded, the sentinel sits within the viewport
almost immediately, and `usePagedList`'s re-arm effect cascades through every remaining page in
one burst at mount, before the reader scrolls at all. Either way the observer would need its
root rethreaded to the container to behave, which §2 puts out of scope.

So the page scrolls, as it does today, and **the detail pane is `position: sticky`** so it stays
in view while the list scrolls past it. That keeps the observer untouched and avoids the wart
the alternative has: a page-scrolling split view whose pane slides off screen as soon as the
reader scrolls to load more.

## 7. The switcher, and where the preference lives

A two-state control in the row that already holds Browse's search box.

The choice goes in `localStorage`, beside the theme, for the reason phase 1 gave for the theme:
it is per-browser, not per-installation, and making it an installation setting would mean a
config field, a migration, and a round trip before first paint. It follows `theme.ts`'s shape
exactly, including the part that is easy to miss — `readPreference` wraps the read in a
`try`/`catch` because, as that file records, "`localStorage` does not merely return null in some
privacy configurations, it throws on access." A switcher that throws on read would take the
whole route down.

**First visit is the card list.** Nobody's Browse changes shape without asking for it.

## 8. Testing

Web suite (`.test.tsx`):

- `groupTitle` as a pure function: the provider's title when present, `display.title` when the
  provider's is null, empty or the answer is not confirmed.
- The master row: title, studio, `1 release` versus `N releases`, the upgrade marker present
  and absent, and no separator orphan when the studio is absent.
- Selection: clicking a row fills the pane; the pane renders the same title the row does; the
  pane's empty state on arrival.
- Selection clears when the selected id leaves `items`.
- Keyboard: ArrowDown from nothing selected takes the first row; ArrowUp/ArrowDown move;
  neither walks off either end.
- Listbox semantics: `role="listbox"`, one `aria-selected` row, exactly one row with a
  non-negative `tabIndex`.
- The switcher: renders both views, persists across a remount, and defaults to the card list
  with nothing stored.
- A `localStorage` that throws on read leaves the route rendering the card list.

Playwright: switching views and clicking a row, in a real browser, plus the keyboard movement —
which is the part happy-dom's focus handling is least trustworthy for, and phase 1.8 already
found one focus bug that only a browser could see.

## 9. Risks

- **The master list has no artwork, so it drops the one thing phase 2 spent a phase on.**
  Deliberate: the pane carries it. But a reader who lives in split view sees posters one at a
  time rather than as a column, and whether that reads as an improvement is a judgement only
  use will settle.
- **Two views mean two renderings of the same group, and they can drift.** §5 removes the
  known instance by sharing the title rule. Anything else the row shows — the studio, the
  release count — is read straight from the same `GroupView`, so there is no second derivation
  to drift, but a future addition to either surface could add one.
- **The widened shell is a view-conditional layout rule**, the first in the app. On a window
  narrower than about 1440px, 90rem stops binding and the panes divide whatever the window
  gives, which is untested below the desktop assumption §2 declares. With the list pane fixed
  at 22rem, the detail pane is what absorbs the loss, so a narrow window walks toward the same
  sub-490px text column §6 widened the shell to avoid.
- **A sticky pane taller than the viewport cannot be fully read** without scrolling the page,
  which also scrolls the list. A card with a long synopsis and many releases is the case; how
  often that exceeds a desktop viewport is unmeasured.
- **Nothing preserves the reader's place.** No URL state and no scroll restoration, so a reload
  returns to the top with nothing selected. Consistent with Browse today; more noticeable when
  a selection was on screen.
