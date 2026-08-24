# Design system — Design

Date: 2026-08-23
Status: approved for planning
Branch: `design-system`

## 1. What this adds

A visual identity for the SPA: a token layer, two real palettes, a bundled typeface pair,
and a theme control that lets the user override the operating system's preference.

Today `packages/web/src/styles.css` is 210 lines of hand-written CSS with no shared
vocabulary. Colour is either `currentColor` at some opacity, one of three hardcoded hexes
(`#b45309`, `#b91c1c`, `#15803d`), or a literal `rgb(0 0 0 / …)`. Type is `system-ui` at
seven sizes chosen a rule at a time — `0.8`, `0.85`, `0.9`, `0.95`, `1`, `1.1` and
`1.5rem` — with no scale behind them. `:root` declares `color-scheme: light dark`, so the app
follows the OS into a light theme that was never designed.

Thirteen classes that components already render have no rule in the stylesheet at all
(§8.1). The result is not an app that needs restyling so much as one whose styling was
never finished.

This is phase 1 of three. Phase 2 is the poster-led card layout; phase 3 is a
master/detail view of Browse with a switcher between the two. Both get their own design.
Phase 1 deliberately changes no layout, so that phases 2 and 3 build on a finished token
layer rather than restyling a layout they are about to replace.

## 2. Scope

In scope:

- A token layer: colour, type size, space, radius, elevation.
- Two palettes — warm charcoal dark, warm off-white light — from one set of tokens.
- IBM Plex Sans and IBM Plex Mono, self-hosted, latin subset, static weights.
- A three-state theme control (Auto / Light / Dark) persisted in `localStorage`.
- Rules for the thirteen classes that have none, and the six `status-*` modifiers.
- A `:focus-visible` treatment, which the app has none of today.
- Splitting `styles.css` into a `styles/` directory behind one entry point.

Explicitly out of scope:

- **Any layout change.** The poster stays a 6rem right-hand thumb; Browse stays one
  column of full-width cards; `.app` stays a 60rem centred column. The one exception is
  the nav, which grows to fit the theme control (§7.4).
- **The poster-led card.** Phase 2.
- **Master/detail Browse and the view switcher.** Phase 3.
- **Server-side theme storage.** The preference is per-browser, in `localStorage`. It is
  not part of `config.json` and does not survive to another device. Making it an
  installation setting would mean a config field, a migration, and a round trip before
  first paint — which is exactly what §7.2 exists to avoid.
- **Responsive and mobile layout.** The app assumes a desktop window today and still
  will. Tokens make it cheaper later; they do not do it.
- **Icons.** No icon set is added. The nav stays textual.
- **Component extraction.** No shared `<Button>`/`<Chip>` React components. Element
  selectors and existing class names carry the styling, so this phase touches almost no
  JSX (§8).

## 3. File structure

`styles.css` becomes a directory. `main.tsx` changes one import line and knows nothing
else:

```
packages/web/src/styles/
  index.css      layer order, then @import of everything below
  fonts.css      @font-face
  tokens.css     custom properties; both palettes
  base.css       body, headings, links, button, input, select, textarea, :focus-visible
  nav.css        nav, .nav-separator, the theme control
  card.css       .media-card and everything inside it, including .metadata
  rows.css       .release-row, .download-row, .failed-row
  forms.css      .manual-form, .config-form, .settings-row, fieldset, legend
  dialog.css     .image-modal, .confirm
```

`index.css` opens with the layer order and nothing else declares a layer:

```css
@layer tokens, base, components;
```

The reason is the problem the current file solves by ordering and hoping. `.card-head-main
.fields { margin-bottom: 0 }` exists to beat `.fields { margin: 0.5rem 0 }`, and it wins
on specificity — a two-class selector over one. Every such rule is a small bet that no
future selector outranks it. With layers, a rule in `components` beats a rule in `base`
regardless of specificity, so component rules stop needing to be written defensively.

Nine files rather than one is not decomposition for its own sake: the current file is
already at the limit of what can be read in one pass, and phases 2 and 3 add
substantially to the card and to the nav. Splitting now means those phases edit one
focused file each.

## 4. Tokens

Past this phase, no rule declares a raw colour, size, or radius. Four scales:

**Space** — a 4px base, six steps. Every existing margin and gap in the stylesheet
already lands on one of these values, so this codifies practice rather than changing it:

```css
--space-1: 0.25rem;  --space-2: 0.5rem;   --space-3: 0.75rem;
--space-4: 1rem;     --space-5: 1.5rem;   --space-6: 2rem;
```

> **Correction (post-implementation, whole-branch review):** not every existing value
> landed on the scale exactly. Five did not and were snapped to the nearest step during
> implementation, each plan-specified, reviewed and visually approved: `.release-row` and
> `.download-row` padding `0.35rem` → `--space-1`, `.badge` margin-top `0.4rem` →
> `--space-1`, `.confirm` padding `1rem 1.25rem` → `--space-4 --space-5`, and `.confirm ul`
> padding-left `1.25rem` → `--space-5`. The scale mostly codifies practice, as above, but it
> also snapped a handful of sub-8px values that practice had left off-grid.

**Type size** — named by role, not by size, so a rule says what a thing *is*:

```css
--text-label: 0.6875rem;  /* 11px — uppercase tracked labels, chips */
--text-meta:  0.75rem;    /* 12px — subtitle, date, field values */
--text-body:  0.8125rem;  /* 13px — release rows, download rows, form fields */
--text-title: 1rem;       /* 16px — card title */
--text-page:  1.5rem;     /* 24px — route h1 */
```

The root font size stays 16px. Changing it would silently rescale every `rem` in the
existing stylesheet, which is a large uncontrolled diff in exchange for nothing.

**Radius** — `--radius-sm: 3px` (chips, quality tags), `--radius-md: 6px` (buttons,
inputs), `--radius-lg: 10px` (cards, dialogs, the nav's active item).

**Elevation** — one token, `--shadow-dialog`, replacing the literal
`0 0.5rem 1.5rem rgb(0 0 0 / 30%)` on `.confirm`. Cards are separated by surface and
hairline, not by shadow; a second elevation token would be speculative.

## 5. Colour

### 5.1 Two amber tokens, not one

The accent is `#e0a02a`. Used as a *fill* with dark text on it, it reaches ≈7.6:1 in
either theme. Used as *text* on the light theme's `#faf8f4` background it reaches ≈2:1,
which is unreadable and not fixable by adjusting the background.

So the accent is two tokens with different jobs:

- `--color-accent` — a fill only. Backgrounds of primary buttons, the upgrade badge, the
  nav's active indicator. Always paired with `--color-on-accent` for text on top.
- `--color-accent-text` — foreground only. Links, the scene-title link, the `importing`
  status. Identical to `--color-accent` in dark, and darkened to `#8a5d0a` in light.

A single accent token would force whoever writes the next rule to discover this by
shipping an unreadable link.

### 5.2 Two line tokens, not one

WCAG 1.4.11 asks for 3:1 against the adjacent background for the visual boundary of a
user-interface component. A decorative hairline between two table rows is not that; the
border of a text input is.

The hairline that looks right for row separators is nowhere near 3:1 — `#322f2c` on
`#1b1a18` is ≈1.3:1, and the light theme's `#ddd8cf` on `#ffffff` is ≈1.4:1. Raising it
to pass would make every card and row edge heavy enough to read as a grid.

So:

- `--color-line` — decorative. Card edges, row separators, chip borders, the nav rule, and
  `fieldset`, which groups controls but is not itself one.
- `--color-line-strong` — the boundary of anything the user operates: `input`,
  `select`, `textarea`, and secondary/ghost buttons. Meets 3:1.

### 5.3 The palettes

```css
:root[data-theme="dark"] {              :root[data-theme="light"] {
  --color-bg:            #121110;         --color-bg:            #faf8f4;
  --color-surface:       #1b1a18;         --color-surface:       #ffffff;
  --color-surface-2:     #232120;         --color-surface-2:     #f2efe9;
  --color-line:          #322f2c;         --color-line:          #ddd8cf;
  --color-line-strong:   #6b665e;         --color-line-strong:   #9a917f;
  --color-text:          #ece8e1;         --color-text:          #1f1d1a;
  --color-text-dim:      #a09a90;         --color-text-dim:      #6b6459;
  --color-text-faint:    #756f66;         --color-text-faint:    #8f887c;
  --color-accent:        #e0a02a;         --color-accent:        #e0a02a;
  --color-accent-text:   #e0a02a;         --color-accent-text:   #8a5d0a;
  --color-on-accent:     #241a00;         --color-on-accent:     #241a00;
  --color-error:         #ef6a5c;         --color-error:         #b3271a;
  --color-success:       #5cbf7a;         --color-success:       #1d7a3c;
}                                       }
```

Contrast against each theme's `--color-bg`, computed from WCAG relative luminance:

| Token | Dark | Light | Required |
|---|---|---|---|
| `--color-text` | ≈15:1 | ≈16:1 | 4.5:1 |
| `--color-text-dim` | ≈6.8:1 | ≈5.5:1 | 4.5:1 |
| `--color-text-faint` | ≈3.8:1 | ≈3.3:1 | decorative only |
| `--color-accent-text` | ≈8.3:1 | ≈5.4:1 | 4.5:1 |
| `--color-on-accent` on `--color-accent` | ≈7.6:1 | ≈7.6:1 | 4.5:1 |
| `--color-error` | ≈6.2:1 | ≈6.2:1 | 4.5:1 |
| `--color-success` | ≈8.3:1 | ≈5.1:1 | 4.5:1 |
| `--color-line-strong` on `--color-surface` | ≈3.05:1 | ≈3.1:1 | 3:1 (1.4.11) |

`--color-text-faint` is below the 4.5:1 floor deliberately and is therefore restricted to
text that carries no information a reader needs: the `--text-label` captions, and
placeholder text. It is specifically **not** for inactive nav links, which are essential
text — those take `--color-text-dim`. Implementation re-verifies every row above with a
contrast checker rather than trusting this table.

> **Correction (post-implementation, whole-branch review):** the table above checks every
> pair only against `--color-bg`. Implementation went further and verified each pair
> against the surface it actually sits on — `--color-surface` and `--color-surface-2` as
> well as `--color-bg` — which is stricter, since a token used on a card or a chip is
> never actually painted against the bare page background. That stricter check is what
> caught the three real defects the whole-branch review found and this fix wave corrected:
> `--color-accent` used as focus-ring and active-tab foreground (§8.6, `nav.css`), and
> `--color-text-faint` on `.manual-help` and `.secret-set` in `forms.css`. The per-surface
> figures live as comments next to the rules they justify (`base.css`'s `:focus-visible`,
> `nav.css`'s `nav a.active`) rather than in a second table here.

### 5.4 One consequence, recorded

Amber is both the primary action and the warning colour — `.download-absent` and
`.confirm .warning` are amber today and stay amber, because amber is what "look at this,
nothing has broken yet" means. Actions and warnings are told apart by *form*: an action
is a filled pill of `--color-accent`, a warning is plain `--color-accent-text` text.

If that ever reads as ambiguous in use, the fix is a distinct `--color-warning` token and
two rule changes, not a rework. Recorded here so that the next person to notice it knows
it was a decision.

## 6. Typography

IBM Plex Sans for the interface, IBM Plex Mono for release names and paths. A matched
pair, warm enough to sit with the palette, and technical without being a novelty.

**Static weights, not variable.** Sans 400 and 600; Mono 400. Three `woff2` files, latin
subset, on the order of 120 KB total. Static sidesteps having to confirm at build time
which axes a given release of the family ships, and 400/600 is every weight the current
stylesheet uses (`font-weight: 600` appears three times; nothing else is set).

> **Correction (recorded as a deviation at implementation, folded in here):** the actual
> total is 61.5 KB, not ~120 KB — this estimate ran high.

Both faces are OFL 1.1. The licence text ships in the repo beside the fonts, as the
licence requires.

The files live in `packages/web/src/fonts/` and are referenced by relative `url()` from
`fonts.css`, so Vite fingerprints them into `dist/assets/`. `@fastify/static` already
serves that directory (`server.ts:1396`) and resolves `woff2` content types itself, so
no server change is needed. `font-display: swap`, and each `@font-face` carries a
`unicode-range` for the latin subset.

> **Correction (recorded as a deviation at implementation, folded in here):** the
> implementation deliberately omits `unicode-range`. The three files *are* the latin
> subset and there is no second subset to fall back to, so a `unicode-range` would only
> suppress the download for a page containing no latin text — which never happens here.
> Per-glyph fallback for non-latin performer names and scene titles works identically
> without it.

Nothing loads from a CDN. Pickarr runs on home networks with no guarantee of egress, and
a webfont that fails to load is a layout that shifts on every page load.

**Mono becomes functional, not decorative.** `.release-name` is proportional today. A
column of `Vixen.26.08.14.Deep.Focus.XXX.2160p.MP4-KTR` against
`Vixen.26.08.14.Deep.Focus.XXX.1080p.MP4-KTR` is only scannable when the differing
characters align vertically, which is the whole task the Browse screen exists for.

## 7. Theme resolution and the control

### 7.1 Two pieces of state

- **Preference** — `'system' | 'light' | 'dark'`, persisted in `localStorage` under
  `pickarr.theme`. What the user chose.
- **Resolved theme** — `'light' | 'dark'`, written to `document.documentElement`'s
  `data-theme`. What is painted.

Resolution happens in JavaScript, and `tokens.css` therefore contains exactly two palette
blocks — the two in §5.3 — keyed on `[data-theme]`.

The alternative is to resolve in CSS, with `@media (prefers-color-scheme: light)` for the
automatic case and `:root[data-theme="light"]` for the manual one. That works, and it
requires the entire light palette to be written twice. Two places to edit every colour is
a defect waiting for the first person who edits one of them.

`:root` itself carries the dark palette unconditionally, as the fallback for a browser
with JavaScript disabled — the app is a React SPA and shows nothing at all in that case,
but a stylesheet that renders unstyled black-on-black if the attribute is missing is a
trap for anyone debugging.

### 7.2 First paint

An inline `<script>` in `index.html`'s `<head>`, before the module script, reads the
preference, resolves it, and sets the attribute:

```html
<script>
  try {
    var stored = localStorage.getItem('pickarr.theme');
    var resolved = stored === 'light' || stored === 'dark' ? stored
      : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolved;
  } catch { document.documentElement.dataset.theme = 'dark'; }
</script>
```

Inline and synchronous because it has to run before first paint; the module script is
deferred by definition and would paint the wrong theme and then correct it. The `catch`
is not defensive habit — `localStorage` throws on access outright in some privacy
configurations, and the degradation there has to be a themed app rather than an unstyled
one.

This script duplicates three lines of `src/theme.ts` (the `pickarr.theme` key and the
`(prefers-color-scheme: light)` query) deliberately, rather than importing the module,
because importing it here would make this a second module graph fetched before paint —
the very thing the inline script exists to avoid. `packages/e2e/tests/theme.spec.ts` is
that duplication's only coverage: its `setTheme` helper reloads the page, which is the one
thing that actually exercises this script rather than `theme.ts`'s own logic.

### 7.3 `color-scheme` moves per theme

```css
:root[data-theme="dark"]  { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }
```

This replaces today's `color-scheme: light dark` on `:root`, and it is load-bearing.
`color-scheme` is what native scrollbars, native form controls, and the UA's `<dialog>`
rendering follow. Leaving it as `light dark` means that the moment the app's theme and the
OS's preference can disagree — which is the entire point of this section — the scrollbars
and the date pickers follow the OS while everything around them follows the app.

It also repairs a related defect. `.confirm` is painted with the `Canvas` and `CanvasText`
system colours, chosen precisely *because* `color-scheme: light dark` made them track the
app. Once the app's theme is independent, those keywords track the OS instead, and the
identity-change dialog renders light on a dark app. `.confirm` moves onto
`--color-surface` / `--color-text`.

### 7.4 The control

At the foot of the nav, below the existing `<hr>`: a `<fieldset>` with a visually hidden
`<legend>Theme</legend>` and three radios — Auto, Light, Dark.

Radios rather than a two-state switch because "follow the OS" is what the app does today,
and a switch that can only say light or dark removes a behaviour rather than adding one.
Radios rather than three buttons because a radio group gives a single accessible group
name and arrow-key movement without any JavaScript.

Selecting Auto removes the stored preference rather than storing the string `'system'`, so
that a browser with nothing stored and a browser explicitly set to Auto are the same
state, and there is only one code path for "no preference".

While the preference is `'system'`, a `change` listener on the media query re-resolves the
attribute, so an OS that switches theme on a schedule is followed live. The listener is
inert for an explicit preference.

**The nav grows.** It is currently content-width — about as wide as "Downloads". Three
labelled segments roughly doubles that. This is the one layout change §2 permits, and it
is accepted rather than worked around: the alternative placements are a Settings section
(where it would be the only control on a server-config page with no Save button) or an
icon-only control (which needs an icon set this phase does not add).

## 8. Component treatments

### 8.1 The thirteen classes with no rule

Verified by diffing every `className` in `packages/web/src` against every selector in
`styles.css`:

```
config-form  download-kind  download-status  download-title  loading  manual-form
metadata  metadata-duration  metadata-release-date  metadata-synopsis  metadata-title
release-quality  release-size
```

Plus the six modifiers `DownloadRow` composes as `` `download-row status-${status}` ``:
`status-queued`, `status-downloading`, `status-completed`, `status-importing`,
`status-imported`, `status-failed`.

Every one of these is a styling hook the markup already provides. This phase writes their
rules. That is why it touches almost no JSX: the only component work is the theme control
(§7.4) and the inline script (§7.2).

### 8.2 Card

`--color-surface` on `--color-line` at `--radius-lg`. `opacity: 0.95` comes off
`.media-card` — it currently dims the poster along with the text, which is precisely
backwards for a screen whose job is judging artwork.

`.fields li` becomes a chip: `--color-surface-2`, `--color-line`, `--radius-sm`,
`--text-label`. No markup change; the `<li>` already exists and carries a single text node
by design (see `MediaCard`'s comment on why label and value share one node).

`.badge` moves from `#b45309` to `--color-accent` with `--color-on-accent`.

### 8.3 Release rows

`.release-name` takes IBM Plex Mono at `--text-body`, and keeps its existing ellipsis.

`.release-quality` and `.release-size` get their first rules. `ReleaseRow` already renders
them *before* the name, so a fixed `min-width` on each puts the two numbers being compared
into a column, rather than letting them drift with the length of the title beside them.
Quality reads as a chip; size as `--color-text-dim` with `font-variant-numeric:
tabular-nums`.

`.release-current` keeps its weight and takes `--color-text`. `.release-failed` takes
`--color-error`.

### 8.4 Downloads

The six `status-*` modifiers become a ladder that says how far along a job is:

| Status | Treatment |
|---|---|
| `queued` | `--color-text-dim` — accepted, nothing happening |
| `downloading` | `--color-text` — live |
| `completed` | `--color-text-dim` — downloaded, awaiting import |
| `importing` | `--color-accent-text` — working |
| `imported` | `--color-success` — done |
| `failed` | `--color-error` — needs the user |

`DownloadView.status` is typed `string` on the wire, not the closed union
`DownloadStatus` is in `packages/core/src/db/downloads.ts`. So the ladder is written as
six additive rules over a neutral `.download-status` base: a status this list has not
heard of renders plainly rather than disappearing.

`.download-title` is a `<Link>` and takes `--color-accent-text`. `.download-kind` takes
`--text-label` and `--color-text-faint`. `.download-absent` keeps amber
(`--color-accent-text`), per §5.4.

### 8.5 The metadata panel

Currently raw markup on browser defaults. `.metadata` takes a top rule and `--space-3` of
separation from the release list. `.metadata-synopsis` takes `max-width: 68ch` — an
unbounded measure across a 60rem card is the single worst thing on the screen to read.
`.metadata-release-date` and `.metadata-duration` become one `--text-meta` line in
`--color-text-dim`. `.metadata-title` takes `--color-accent-text` when it is a link, and
`--color-text-dim` when it is not, since an unlinked second opinion is not interactive and
should not look it.

### 8.6 Base layer

`button`, `input`, `select` and `textarea` get real rules. Native controls on a `#121110`
surface do not merely look unstyled, they look broken — and `color-scheme: dark` alone
gives a grey slab, not a designed control. Primary buttons are `--color-accent` on
`--color-on-accent`; secondary are transparent on `--color-line-strong`.

`a` takes `--color-accent-text`, so that the scene-title link (§8.5), the download title
(§8.4) and any future link are one decision rather than three. Nav links are the exception
and are coloured by `nav.css`: `--color-text` for the active tab, `--color-text-dim` for
the rest (§5.3), because a column of five accent-coloured links reads as five calls to
action.

`:focus-visible` gets a 2px `--color-accent` outline with a 2px offset, applied once in
`base.css` to every focusable element. The app defines no focus style at all today and
relies on the UA default, which against custom dark surfaces is frequently invisible.
This is a correctness fix.

> **Correction (post-implementation, whole-branch review):** the ring uses
> `--color-accent-text`, not `--color-accent`. `--color-accent` is 2.14:1 / 2.27:1 /
> 1.98:1 against the light theme's three backgrounds — under the 3:1 floor a focus
> indicator needs — while `--color-accent-text` reaches 5.42 / 5.75 / 5.01:1 in light and
> the identical value in dark. This is exactly the mistake §5.1 warns against — using the
> fill-only `--color-accent` as a foreground — and the same correction applies to the nav's
> active-tab inset rule (`nav a.active`'s `box-shadow` in `nav.css`), which also moved to
> `--color-accent-text` for the same reason and carries its own contrast note.

Route `h1` takes `--text-page`; it is unstyled today and renders at the UA's `2em`.

## 9. Accessibility

- Every colour pair in §5.3 meets its stated threshold, re-verified at implementation.
- `--color-text-faint` is barred from essential text (§5.3).
- `--color-line-strong` exists so operable components meet 1.4.11 (§5.2).
- A visible focus indicator exists for the first time (§8.6).
- The theme control is a named radio group with keyboard movement (§7.4).
- `color-scheme` tracks the app so native controls stay legible (§7.3).
- The existing `<hr className="nav-separator">` and its implicit `role="separator"` are
  untouched; §3's `nav.css` keeps the `border-top`-only treatment and its rationale.
- Nothing in this phase conveys information by colour alone. The download status ladder
  (§8.4) colours text that already names the status.

## 10. Testing

The new behaviour is the theme; the rest is CSS, which has no unit tests worth writing.

A theme module (`src/theme.ts`) owns preference storage and resolution, tested directly:

- No stored preference resolves from `matchMedia`.
- A stored `'light'` wins over an OS preference of dark, and vice versa.
- Setting an explicit preference writes `localStorage` and updates `data-theme`.
- Setting Auto *removes* the stored key rather than writing a sentinel (§7.4).
- A `localStorage` that throws on read and on write degrades to the system preference
  without propagating (§7.2).
- An OS change re-resolves while the preference is `'system'` and is ignored once it is
  explicit.

The control (`src/components/ThemeToggle.tsx`), via `@testing-library/react`:

- Renders three radios with the stored preference checked.
- Selecting one updates `data-theme` on the document element.
- The group carries an accessible name.

happy-dom supports both halves this needs: `matchMedia` is implemented, and
`prefers-color-scheme` is driven by its `device.prefersColorScheme` browser setting. If
driving a *change event* through that setting proves unsupported, the OS-change test stubs
`matchMedia` directly rather than being dropped.

The four existing tests that query by class name — `hr.nav-separator` and
`[role="separator"], hr` in `Settings.test.tsx`, `ul.downloads > li` in
`Downloads.test.tsx`, `.card-actions` and `.metadata-performers` in `MediaCard.test.tsx` —
all continue to pass. No class in that set is removed or renamed by this phase.

## 11. Verification

`npm run lint`, `npm run typecheck`, `npm test` (server and web suites), `npm run build`.

Styling has no automated assertions, so the last gate is manual: run the app and view all
five routes in both themes, plus the two dialogs (`ImageModal`, `IdentityChangeConfirm`),
a card with no poster and no metadata, a card with a long unbroken release name, and the
Downloads tab with a failed row and an absent row.

## 12. Risks

- **The palette is a taste commitment.** Warm charcoal and amber is one direction of
  several that were considered. It is cheap to revise — the values live in one block of
  `tokens.css` — and expensive to revise *after* phases 2 and 3 add rules that assume it.
  Reviewing the built app in both themes before starting phase 2 is the mitigation.
- **Font weight coverage.** Shipping only 400 and 600 means any future rule wanting 500
  or 700 gets a synthesised face. Adding a weight is one file and one `@font-face`.
- **The nav widening** (§7.4) reduces the content column by roughly 70px on a 60rem
  layout. Phase 2's poster-led card is the design that has to live with it, and it should
  be checked there rather than assumed here.
- **`prefers-color-scheme` change events in happy-dom** are the one test above that may
  need a stub instead of the real facility (§10).
