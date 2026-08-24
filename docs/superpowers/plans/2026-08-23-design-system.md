# Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Pickarr SPA a designed visual identity — a token layer, two real palettes, a bundled typeface pair, and a user-controlled theme — without changing any layout.

**Architecture:** `packages/web/src/styles.css` is replaced by a `packages/web/src/styles/` directory behind one entry point, organised into three cascade layers (`tokens`, `base`, `components`). All colour, size, spacing and radius values move into custom properties declared twice — once per theme — keyed on `<html data-theme>`. A small pure module (`src/theme.ts`) owns preference storage and resolution; an inline script in `index.html` applies the resolved theme before first paint; a `ThemeToggle` radio group in the nav lets the user override the OS.

**Tech Stack:** React 19, react-router 7, Vite 6, plain CSS with custom properties and `@layer`. Tests: `node:test` + `@testing-library/react` + happy-dom. No new runtime dependencies; the only new assets are three `woff2` files.

**Spec:** `docs/superpowers/specs/2026-08-23-design-system-design.md`

## Global Constraints

- **No new npm dependencies.** Runtime deps stay `react`, `react-dom`, `react-router`. Fonts are committed binaries, not a package.
- **No `any`.** `typescript/no-explicit-any` is `error` in `.oxlintrc.json`. Also avoid `as unknown as` casts — see Task 4, which uses a typed fake instead.
- **TypeScript is strict** with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`. Imports carry file extensions (`./theme.ts`, `./ThemeToggle.tsx`).
- **2-space indent, semicolons always.**
- **No layout changes.** Poster stays a 6rem/8rem-bounded right-hand thumb; Browse stays one column; `.app` stays `max-width: 60rem`. The nav growing to fit the theme control (Task 5) is the single permitted exception.
- **Preserve every existing CSS comment verbatim** when moving rules. They record why rules exist and are the house convention; losing them is a regression.
- **Token discipline:** after Task 3, no rule in `styles/` may declare a raw colour, font size, or radius. Use the custom properties.
- **`--color-text-faint` is barred from essential text.** It is ≈3.8:1 (dark) / ≈3.3:1 (light), below the 4.5:1 floor. Labels and placeholders only — never nav links.
- **Verification gate for every task:** `npm run lint && npm run typecheck && npm test && npm run build` from the repo root. Run from `/Users/chad/Projects/pickarr/worktrees/design-system`.
- **Commit after every task.** Never push.

### Deviation from the spec, recorded

Spec §6 says each `@font-face` carries a `unicode-range`. This plan omits it. The three files
*are* the latin subset and there is no second subset to fall back to, so a `unicode-range`
would only suppress the download for a page containing no latin text — which never happens
here. Per-glyph fallback for non-latin performer names and scene titles works identically
without it. Spec §6's ~120 KB estimate is also high: the actual files total 61.5 KB.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/web/src/styles/index.css` | Layer order and the only import list. The one file `main.tsx` knows. |
| `packages/web/src/styles/fonts.css` | `@font-face` only. Unlayered. |
| `packages/web/src/styles/tokens.css` | Custom properties; both palettes; `color-scheme`. |
| `packages/web/src/styles/base.css` | Element-level rules: `body`, `.app`, `main`, headings, `a`, controls, `:focus-visible`, `.error`, `.notice`, `.loading`, `.visually-hidden`. |
| `packages/web/src/styles/nav.css` | `nav`, `nav a`, `.nav-separator`, `.theme-toggle`. |
| `packages/web/src/styles/card.css` | `.media-card` and everything inside it, including `.metadata*`. |
| `packages/web/src/styles/rows.css` | `.release-row`, `.download-row`, `.failed-row` and their parts. |
| `packages/web/src/styles/forms.css` | `.manual-*`, `.config-form`, `.settings-*`, `fieldset`, `legend`, `input.search`, `.secret-set`. |
| `packages/web/src/styles/dialog.css` | `.image-modal*`, `.confirm*`. |
| `packages/web/src/fonts/*.woff2` (3) | Committed font binaries. |
| `packages/web/src/fonts/OFL.txt` | Licence text, as OFL 1.1 requires. |
| `packages/web/src/theme.ts` | Pure preference storage + resolution. No React. |
| `packages/web/src/components/ThemeToggle.tsx` | The radio group; owns its own state. |
| `packages/web/test/theme.test.ts` | Tests for `theme.ts`. |
| `packages/web/test/ThemeToggle.test.tsx` | Tests for the control. |

**Modified:** `packages/web/src/main.tsx` (one import line), `packages/web/index.html` (inline script), `packages/web/src/App.tsx` (render the toggle).

**Deleted:** `packages/web/src/styles.css`.

---

### Task 1: Split `styles.css` into `styles/` behind cascade layers

Pure refactor. No declaration changes, so any visual difference after this task is a bug in
the move. Doing it first means every later task edits one small focused file.

**Files:**
- Create: `packages/web/src/styles/index.css`, `base.css`, `nav.css`, `card.css`, `rows.css`, `forms.css`, `dialog.css`
- Delete: `packages/web/src/styles.css`
- Modify: `packages/web/src/main.tsx:5`

**Interfaces:**
- Consumes: nothing.
- Produces: `packages/web/src/styles/index.css` as the single stylesheet entry point, and the layer names `tokens`, `base`, `components` that every later task's rules live in.

- [ ] **Step 1: Capture a baseline of the built CSS**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system
npm run build -w @pickarr/web
cp packages/web/dist/assets/index-*.css /tmp/css-before.css
wc -c /tmp/css-before.css
```

- [ ] **Step 2: Create the seven files, moving rules verbatim**

Move each rule from `styles.css` into the file below, **including its comments, unchanged**.
Do not reformat, reorder within a file, or "tidy" anything.

`base.css` — `:root` (`color-scheme`, `font-family`), `body`, `.app`, `main`, `.notice`, and
the `.error` half of the shared colour rule.

`nav.css` — `nav`, `nav a`, `nav a.active`, `.nav-separator`.

`card.css` — `.media-card`, `.media-card h2`, `.card-head`, `.card-head-main`,
`.card-head-main .fields`, `.card-actions`, `.subtitle, .date`, `.badge`, `.fields`,
`.fields li`, `.poster-thumb, button.avatar-thumb`, `.poster-thumb`, `.poster-thumb img`,
`.metadata-performers`, `.metadata-performers li`, `.avatar-thumb img, img.avatar-thumb`,
`.metadata-pending`.

`rows.css` — `.releases, .downloads`, `.release-row, .download-row`, `.release-name`,
`.release-current`, `.download-row.untracked`, `.download-absent`, `.failed`, `.failed-row`,
`.failed-row h2`, `.failed-reason, .failed-feed`, `.failed-actions`, and the
`.download-error, .release-failed` half of the shared colour rule.

`forms.css` — `input.search`, `.manual-field`, `.manual-field label`, `.manual-help`,
`.manual-preview`, `.manual-actions`, `.secret-set`, `.settings-row`,
`.settings-row-actions`, `fieldset`, `.settings-row fieldset`, `legend`,
`.settings-actions`.

`dialog.css` — `.image-modal`, `.image-modal::backdrop`, `.image-modal-close`,
`.image-modal img`, `.confirm`, `.confirm::backdrop`, `.confirm h2`, `.confirm h3`,
`.confirm ul`, `.confirm li`, `.confirm button`, `.confirm .warning`.

One rule needs splitting. `.download-error, .error, .release-failed { color: #b91c1c; }`
becomes two rules, because its selectors belong to two files:

```css
/* base.css */
.error { color: #b91c1c; }
```

```css
/* rows.css */
.download-error, .release-failed { color: #b91c1c; }
```

`index.css`, with the layer statement before the imports (CSS permits `@layer` statements
ahead of `@import`; nothing else may precede them):

```css
/*
 * The only stylesheet `main.tsx` imports. Everything else arrives through here,
 * in a declared layer.
 *
 * The layer order is what lets component rules stop being written defensively.
 * Before layers, `.card-head-main .fields { margin-bottom: 0 }` had to out-specify
 * `.fields { margin: 0.5rem 0 }` with a second class, and every such rule was a bet
 * that no future selector outranked it. A rule in `components` now beats a rule in
 * `base` whatever its specificity, so the bet is off the table.
 */
@layer tokens, base, components;

@import './base.css' layer(base);
@import './nav.css' layer(components);
@import './card.css' layer(components);
@import './rows.css' layer(components);
@import './forms.css' layer(components);
@import './dialog.css' layer(components);
```

Then delete `packages/web/src/styles.css`.

- [ ] **Step 3: Repoint the entry import**

In `packages/web/src/main.tsx`, change line 5:

```tsx
import './styles/index.css';
```

- [ ] **Step 4: Verify the built CSS carries the same declarations**

```bash
npm run build -w @pickarr/web
cp packages/web/dist/assets/index-*.css /tmp/css-after.css

norm() { tr -d '\n' < "$1" | sed 's/}/}\n/g' | sed 's/^ *//' | grep -v '^$' | sort; }
diff <(norm /tmp/css-before.css) <(norm /tmp/css-after.css)
```

Expected: the only differences are the `@layer` statement and the `@layer …{` wrappers.
No selector and no declaration may appear on one side and not the other. If a selector is
missing, it was dropped in the move — find it and restore it.

**If the bundler emits the `layer()` imports unresolved** (Vite inlines `@import` through
postcss-import, which does support `layer()`, but confirm rather than assume): check that
`/tmp/css-after.css` contains no literal `@import` string:

```bash
grep -c '@import' /tmp/css-after.css
```

Expected: `0`. If it is not 0, fall back to wrapping each file's own contents in an explicit
block — `@layer components { … }` inside `card.css` and friends — and reduce `index.css` to
plain `@import` lines with no `layer()`.

- [ ] **Step 5: Run the full gate**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Expected: all pass. The four class-based test queries (`hr.nav-separator` and
`[role="separator"], hr` in `Settings.test.tsx`, `ul.downloads > li` in
`Downloads.test.tsx`, `.card-actions` and `.metadata-performers` in `MediaCard.test.tsx`)
must still pass — no class is renamed in this task.

- [ ] **Step 6: Commit**

```bash
git add -A packages/web/src
git commit -m "Split the stylesheet into layered files, so a component rule stops having to out-specify a base rule

No declaration changed; the built CSS carries the same selector and declaration
set, verified by normalising and sorting both builds. What changed is that
\`@layer tokens, base, components\` now decides precedence, which is what
\`.card-head-main .fields\` was using a second class to buy."
```

---

### Task 2: Bundle IBM Plex Sans and IBM Plex Mono

**Files:**
- Create: `packages/web/src/fonts/ibm-plex-sans-latin-400-normal.woff2`, `ibm-plex-sans-latin-600-normal.woff2`, `ibm-plex-mono-latin-400-normal.woff2`, `packages/web/src/fonts/OFL.txt`, `packages/web/src/styles/fonts.css`
- Modify: `packages/web/src/styles/index.css`, `packages/web/src/styles/base.css`

**Interfaces:**
- Consumes: `styles/index.css` from Task 1.
- Produces: the font families `'IBM Plex Sans'` and `'IBM Plex Mono'`, referenced by later tasks as `font-family: 'IBM Plex Sans', system-ui, sans-serif` and `font-family: 'IBM Plex Mono', ui-monospace, monospace`.

- [ ] **Step 1: Fetch the three font files and the licence**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system/packages/web/src
mkdir -p fonts
curl -sSL -o fonts/ibm-plex-sans-latin-400-normal.woff2 \
  https://unpkg.com/@fontsource/ibm-plex-sans@5/files/ibm-plex-sans-latin-400-normal.woff2
curl -sSL -o fonts/ibm-plex-sans-latin-600-normal.woff2 \
  https://unpkg.com/@fontsource/ibm-plex-sans@5/files/ibm-plex-sans-latin-600-normal.woff2
curl -sSL -o fonts/ibm-plex-mono-latin-400-normal.woff2 \
  https://unpkg.com/@fontsource/ibm-plex-mono@5/files/ibm-plex-mono-latin-400-normal.woff2
curl -sSL -o fonts/OFL.txt \
  https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt
file fonts/*.woff2 && ls -l fonts/
```

Expected: three files reporting `Web Open Font Format (Version 2)`, sizes 22588, 24252 and
14708 bytes, and a non-empty `OFL.txt`. If a size differs materially the upstream package
changed — check the file is still a woff2 and proceed; if a download produced HTML instead
of a font, `file` will say so and the URL needs revisiting.

- [ ] **Step 2: Write `fonts.css`**

```css
/*
 * Self-hosted, not a CDN. Pickarr runs on home networks with no guarantee of
 * egress, and a webfont that fails to fetch is a layout that shifts on every
 * page load.
 *
 * Static weights rather than a variable face: 400 and 600 are every weight the
 * stylesheet uses, and static sidesteps having to confirm which axes a given
 * release of the family ships. Adding a weight later is one file and one block.
 *
 * No `unicode-range`. These files *are* the latin subset and there is no second
 * subset to fall back to, so a range would only suppress the download for a page
 * with no latin text on it — which never happens here. Per-glyph fallback for a
 * non-latin performer name works the same either way.
 *
 * The `url()`s are relative, so Vite fingerprints these into `dist/assets/` and
 * the `@fastify/static` registration already serving `webRoot` (`server.ts:1396`)
 * serves them with no server change.
 */
@font-face {
  font-family: 'IBM Plex Sans';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('../fonts/ibm-plex-sans-latin-400-normal.woff2') format('woff2');
}

@font-face {
  font-family: 'IBM Plex Sans';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('../fonts/ibm-plex-sans-latin-600-normal.woff2') format('woff2');
}

@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('../fonts/ibm-plex-mono-latin-400-normal.woff2') format('woff2');
}
```

- [ ] **Step 3: Import it, unlayered, first**

In `index.css`, add above the other imports:

```css
/* Unlayered: `@font-face` is not affected by cascade layers, and putting it in
   one would only invite the question of which. */
@import './fonts.css';
```

- [ ] **Step 4: Apply the faces**

In `base.css`, replace the `font-family` in the `:root` rule:

```css
:root { color-scheme: light dark; font-family: 'IBM Plex Sans', system-ui, sans-serif; }
```

In `rows.css`, add `'IBM Plex Mono'` to `.release-name`'s existing rule — it has no
`font-family` today, so add one:

```css
/* Mono here is functional, not decorative. A column of
   `Vixen.26.08.14.Deep.Focus.XXX.2160p.MP4-KTR` against the same name at 1080p is
   only scannable when the characters that differ line up vertically, and that is
   the entire task this screen exists for. */
.release-name { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
```

Add it as a separate rule after the existing `.release-name` rule rather than editing that
rule, so the existing comment stays attached to what it describes.

- [ ] **Step 5: Verify the fonts are emitted and referenced**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system
npm run build -w @pickarr/web
ls packages/web/dist/assets/*.woff2
grep -o 'IBM Plex [A-Za-z]*' packages/web/dist/assets/index-*.css | sort -u
```

Expected: three fingerprinted `.woff2` files in `dist/assets/`, and both
`IBM Plex Sans` and `IBM Plex Mono` present in the built CSS.

- [ ] **Step 6: Run the full gate**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 7: Commit**

`dist/` is gitignored (`.gitignore:2`), so `-A` under `src` picks up only the fonts and the
stylesheet changes.

```bash
git add -A packages/web/src
git commit -m "Bundle IBM Plex Sans and Mono, so release names align and the interface stops being whatever system-ui resolves to

Three latin-subset woff2 files, 61.5 KB total, committed rather than fetched:
the app runs on home networks with no guaranteed egress. Mono on
\`.release-name\` is the functional half — two release names differing only at
2160p/1080p are only comparable when the differing characters line up."
```

---

### Task 3: The token layer, and the palettes

**Files:**
- Create: `packages/web/src/styles/tokens.css`
- Modify: `packages/web/src/styles/index.css`, `packages/web/src/styles/base.css`

**Interfaces:**
- Consumes: `styles/index.css`, `fonts.css` from Tasks 1–2.
- Produces: every custom property later tasks use — `--space-1..6`, `--text-label|meta|body|title|page`, `--radius-sm|md|lg`, `--shadow-dialog`, `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-line`, `--color-line-strong`, `--color-text`, `--color-text-dim`, `--color-text-faint`, `--color-accent`, `--color-accent-text`, `--color-on-accent`, `--color-error`, `--color-success`. Also the `[data-theme="dark"|"light"]` contract on `<html>` that Tasks 4–5 drive.

**Expected intermediate appearance:** after this task the page background, text and headings
are on tokens, but card borders, badges and status colours are still the old `currentColor`
and hardcoded hexes. Cards will look wrong — bright `currentColor` hairlines against a dark
ground. That is expected until Tasks 7–13; do not "fix" it here.

- [ ] **Step 1: Write `tokens.css`**

```css
/*
 * Every colour, size, space and radius in the app. Past this file, no rule in
 * `styles/` declares a raw value.
 *
 * Both palettes are keyed on `[data-theme]` and nothing resolves in CSS. The
 * alternative — `@media (prefers-color-scheme: light)` for the automatic case and
 * `:root[data-theme="light"]` for the manual one — needs the whole light palette
 * written twice, which is two places to edit every colour and a defect waiting for
 * whoever edits one of them. `theme.ts` and the inline script in `index.html`
 * resolve instead, and this file only ever sees a concrete answer.
 */
:root {
  /* 4px base. Every margin and gap already in the stylesheet lands on one of
     these, so this codifies practice rather than changing it. */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;

  /* Named by role, not by size, so a rule says what a thing is. The root stays
     16px: changing it would silently rescale every rem already written. */
  --text-label: 0.6875rem;
  --text-meta: 0.75rem;
  --text-body: 0.8125rem;
  --text-title: 1rem;
  --text-page: 1.5rem;

  --radius-sm: 3px;
  --radius-md: 6px;
  --radius-lg: 10px;

  /* One elevation, for dialogs. Cards are separated by surface and hairline, so a
     second shadow token would be speculative. */
  --shadow-dialog: 0 0.5rem 1.5rem rgb(0 0 0 / 30%);
}

/*
 * The dark palette on `:root` as well as on the attribute. This is the fallback
 * for a document whose `data-theme` never got set — the inline script is wrapped
 * in try/catch and the app is a React SPA that renders nothing without JS, but a
 * stylesheet that paints unstyled black-on-black when the attribute is missing is
 * a trap for whoever is debugging that.
 */
:root,
:root[data-theme='dark'] {
  color-scheme: dark;

  --color-bg: #121110;
  --color-surface: #1b1a18;
  --color-surface-2: #232120;
  --color-line: #322f2c;
  --color-line-strong: #6b665e;
  --color-text: #ece8e1;
  --color-text-dim: #a09a90;
  --color-text-faint: #756f66;
  --color-accent: #e0a02a;
  --color-accent-text: #e0a02a;
  --color-on-accent: #241a00;
  --color-error: #ef6a5c;
  --color-success: #5cbf7a;
}

:root[data-theme='light'] {
  color-scheme: light;

  --color-bg: #faf8f4;
  --color-surface: #ffffff;
  --color-surface-2: #f2efe9;
  --color-line: #ddd8cf;
  --color-line-strong: #9a917f;
  --color-text: #1f1d1a;
  --color-text-dim: #6b6459;
  --color-text-faint: #8f887c;
  --color-accent: #e0a02a;
  /*
   * The accent is two tokens because one cannot do both jobs. `#e0a02a` as a fill
   * with `--color-on-accent` on top is ~7.6:1 in either theme; as text on this
   * theme's `#faf8f4` it is ~2:1, which is unreadable and not fixable by moving
   * the background. So `--color-accent` is a fill only and this is the foreground.
   */
  --color-accent-text: #8a5d0a;
  --color-on-accent: #241a00;
  --color-error: #b3271a;
  --color-success: #1d7a3c;
}
```

Note on `color-scheme`: it moves here, per theme, and it is load-bearing rather than
tidiness. It is what native scrollbars, native form controls and the UA's `<dialog>`
rendering follow. Left as `light dark`, the moment the app's theme and the OS's preference
can disagree — the entire point of Tasks 4 and 5 — the scrollbars follow the OS while
everything around them follows the app.

- [ ] **Step 2: Import it into the `tokens` layer**

In `index.css`, between the fonts import and `base.css`:

```css
@import './tokens.css' layer(tokens);
```

- [ ] **Step 3: Move `base.css` onto the tokens**

Replace the `:root` and `body` rules, and add the page-level rules. `color-scheme` is gone
from here — `tokens.css` owns it now.

```css
:root { font-family: 'IBM Plex Sans', system-ui, sans-serif; }

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
}

/* Unstyled until now, so it rendered at the UA's 2em. */
h1 { font-size: var(--text-page); font-weight: 600; letter-spacing: -0.015em; margin: 0 0 var(--space-4); }

/*
 * One decision for every link in the app. Nav links are the exception and are
 * coloured by `nav.css`: five accent-coloured links stacked in a column read as
 * five calls to action.
 */
a { color: var(--color-accent-text); }

.error { color: var(--color-error); }
.notice { color: var(--color-success); }
/* Told apart from silence by italics as well as by colour — a lookup in flight is
   the one metadata state that resolves into something else on its own. */
.loading { color: var(--color-text-dim); font-size: var(--text-meta); font-style: italic; }
```

Delete the now-superseded `.notice { color: #15803d; }` and `.error { color: #b91c1c; }`
rules.

- [ ] **Step 4: Verify no raw colour survives outside `tokens.css`**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system/packages/web/src/styles
grep -n '#[0-9a-fA-F]\{3,6\}' base.css tokens.css nav.css card.css rows.css forms.css dialog.css
```

Expected at this point: hits only in `tokens.css`, plus the not-yet-converted hexes in
`card.css` (`#b45309`), `rows.css` (`#b91c1c`, `#b45309`) and `dialog.css` (`#b45309`).
Tasks 8, 10, 11 and 13 remove those. Nothing new may be added.

- [ ] **Step 5: Check both palettes actually apply**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system
npm run build -w @pickarr/web
grep -c 'data-theme' packages/web/dist/assets/index-*.css
```

Expected: at least 2 (one dark selector, one light). Then start the dev server and confirm
by hand, since nothing sets the attribute yet:

```bash
npm run dev -w @pickarr/web
```

In devtools, set `<html data-theme="dark">` — background goes `#121110`, text `#ece8e1`.
Set `light` — background `#faf8f4`, text `#1f1d1a`. With the attribute absent, dark.

- [ ] **Step 6: Run the full gate**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add -A packages/web/src
git commit -m "Add the token layer and both palettes, so colour stops being currentColor at some opacity

Two amber tokens rather than one, because one cannot do both jobs: #e0a02a as a
fill with dark text on it is ~7.6:1 either way, and as text on the light theme's
#faf8f4 it is ~2:1. Two line tokens for the same reason in reverse — the hairline
that looks right between rows is ~1.3:1, nowhere near the 3:1 WCAG 1.4.11 asks for
the boundary of a control, and raising it makes every card edge read as a grid.

color-scheme moves here per theme. Left as 'light dark' it would send native
scrollbars and form controls after the OS while everything around them followed
the app, the moment those two can disagree."
```

---

### Task 4: `theme.ts` — preference storage and resolution

Pure module, no React, no rendering. TDD.

**Files:**
- Create: `packages/web/src/theme.ts`, `packages/web/test/theme.test.ts`

**Interfaces:**
- Consumes: the `[data-theme]` contract from Task 3.
- Produces, for Task 5:
  - `type ThemePreference = 'system' | 'light' | 'dark'`
  - `type ResolvedTheme = 'light' | 'dark'`
  - `const LIGHT_QUERY = '(prefers-color-scheme: light)'`
  - `readPreference(): ThemePreference`
  - `writePreference(preference: ThemePreference): void`
  - `systemPrefersLight(): boolean`
  - `resolve(preference: ThemePreference, systemLight: boolean): ResolvedTheme`
  - `applyTheme(theme: ResolvedTheme): void`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/theme.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_QUERY,
  applyTheme,
  readPreference,
  resolve,
  systemPrefersLight,
  writePreference,
} from '../src/theme.ts';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

test('resolution is pure over the preference and what the OS says', () => {
  // An explicit preference ignores the OS in both directions.
  assert.equal(resolve('dark', true), 'dark');
  assert.equal(resolve('light', false), 'light');
  // Only `system` consults it.
  assert.equal(resolve('system', true), 'light');
  assert.equal(resolve('system', false), 'dark');
});

test('nothing stored reads as system', () => {
  assert.equal(readPreference(), 'system');
});

test('a stored preference is read back, and anything else is system', () => {
  localStorage.setItem('pickarr.theme', 'light');
  assert.equal(readPreference(), 'light');
  localStorage.setItem('pickarr.theme', 'dark');
  assert.equal(readPreference(), 'dark');
  // A value from a future version, or a hand-edited one, must not be trusted
  // into `data-theme` — it would select neither palette block.
  localStorage.setItem('pickarr.theme', 'sepia');
  assert.equal(readPreference(), 'system');
});

test('choosing system removes the key rather than storing a sentinel', () => {
  writePreference('dark');
  assert.equal(localStorage.getItem('pickarr.theme'), 'dark');
  writePreference('system');
  // A browser with nothing stored and one explicitly set to Auto are the same
  // state, so there is one code path for "no preference" rather than two.
  assert.equal(localStorage.getItem('pickarr.theme'), null);
});

test('a storage that throws degrades to system instead of propagating', () => {
  const original = Storage.prototype.getItem;
  const originalSet = Storage.prototype.setItem;
  Storage.prototype.getItem = () => {
    throw new Error('storage disabled');
  };
  Storage.prototype.setItem = () => {
    throw new Error('storage disabled');
  };
  try {
    assert.equal(readPreference(), 'system');
    // The write must not throw either: a browser refusing storage still gets a
    // themed session, it just forgets the choice.
    assert.doesNotThrow(() => writePreference('dark'));
  } finally {
    Storage.prototype.getItem = original;
    Storage.prototype.setItem = originalSet;
  }
});

test('applying a theme sets the attribute the palettes are keyed on', () => {
  applyTheme('light');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  applyTheme('dark');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});

test('the OS reading comes from the media query the palettes name', () => {
  assert.equal(LIGHT_QUERY, '(prefers-color-scheme: light)');
  // happy-dom answers this; the assertion is that we ask, and get a boolean,
  // not which way its default falls.
  assert.equal(typeof systemPrefersLight(), 'boolean');
  assert.equal(systemPrefersLight(), window.matchMedia(LIGHT_QUERY).matches);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/theme.test.ts
```

Expected: FAIL — `Cannot find module '../src/theme.ts'`.

- [ ] **Step 3: Write `packages/web/src/theme.ts`**

```ts
/**
 * The theme, as two separate pieces of state.
 *
 * The *preference* is what the user chose and is one of three values, persisted
 * per browser. The *resolved theme* is what gets painted and is one of two, held
 * in `<html data-theme>` where `tokens.css` keys the palettes on it.
 *
 * Resolution lives here rather than in CSS on purpose. Doing it with
 * `@media (prefers-color-scheme: light)` for the automatic case and
 * `:root[data-theme="light"]` for the manual one needs the light palette written
 * out twice, and two places to edit every colour is a defect waiting for whoever
 * edits one of them.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'pickarr.theme';

/** Exported so the tests, the toggle and `index.html` all ask the same question. */
export const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * Anything other than the two explicit values reads as `system`, which covers a
 * missing key, a value written by a future version, and a hand-edited one. The
 * alternative is putting an unrecognised string into `data-theme`, where it
 * selects neither palette block.
 */
export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // `localStorage` does not merely return null in some privacy
    // configurations, it throws on access. The degradation is a themed session
    // that forgets, not an unstyled one.
    return 'system';
  }
}

/**
 * `system` removes the key rather than storing the string. A browser with
 * nothing stored and one explicitly set to Auto are then the same state, and
 * "no preference" has one code path instead of two.
 */
export function writePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // As above: a browser that refuses storage still themes this session.
    return;
  }
}

export function systemPrefersLight(): boolean {
  return window.matchMedia(LIGHT_QUERY).matches;
}

/**
 * Pure, and it takes the OS reading as an argument rather than fetching it, so
 * the interesting half is testable without a DOM and the caller decides when to
 * re-read.
 */
export function resolve(preference: ThemePreference, systemLight: boolean): ResolvedTheme {
  if (preference !== 'system') return preference;
  return systemLight ? 'light' : 'dark';
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', theme);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/theme.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Run the full gate**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/theme.ts packages/web/test/theme.test.ts
git commit -m "Add the theme module, resolving a three-value preference into the two-value attribute the palettes key on

\`resolve\` takes the OS reading as an argument rather than fetching it, so the
half worth testing needs no DOM and the caller decides when to re-read. Choosing
Auto removes the stored key instead of writing a sentinel, so a browser with
nothing stored and one explicitly set to Auto are one state. Every storage access
is wrapped: localStorage throws outright rather than returning null in some
privacy configurations, and the degradation there has to be a themed session that
forgets rather than an unstyled one."
```

---

### Task 5: The pre-paint script, the toggle, and the nav wiring

**Files:**
- Create: `packages/web/src/components/ThemeToggle.tsx`, `packages/web/test/ThemeToggle.test.tsx`
- Modify: `packages/web/index.html`, `packages/web/src/App.tsx`, `packages/web/src/styles/base.css`, `packages/web/src/styles/nav.css`

**Interfaces:**
- Consumes: everything Task 4 produced.
- Produces: `<ThemeToggle />` from `./components/ThemeToggle.tsx`, and the classes `.theme-toggle` and `.visually-hidden`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/ThemeToggle.test.tsx`. The fake media query list is a real
`EventTarget` subclass implementing `MediaQueryList`, so it needs no cast — note that
`as unknown as` casts are what issue #58 is about, and this avoids adding another.

```tsx
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ThemeToggle } from '../src/components/ThemeToggle.tsx';

/**
 * A fully typed stand-in, built on EventTarget so `addEventListener`,
 * `removeEventListener` and `dispatchEvent` come from the platform with their
 * real signatures. `implements MediaQueryList` then needs only the four members
 * EventTarget does not supply, and no cast is required anywhere.
 */
class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  matches: boolean;
  readonly media = '(prefers-color-scheme: light)';
  onchange = null;

  constructor(matches: boolean) {
    super();
    this.matches = matches;
  }

  addListener(): void {}
  removeListener(): void {}
}

let fake: FakeMediaQueryList;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  fake = new FakeMediaQueryList(false);
  originalMatchMedia = window.matchMedia;
  window.matchMedia = () => fake;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  cleanup();
});

test('the control is a named group of three radios', () => {
  render(<ThemeToggle />);
  assert.ok(screen.getByRole('group', { name: /theme/i }));
  assert.ok(screen.getByRole('radio', { name: 'Auto' }));
  assert.ok(screen.getByRole('radio', { name: 'Light' }));
  assert.ok(screen.getByRole('radio', { name: 'Dark' }));
});

test('with nothing stored, Auto is checked and the OS decides the paint', () => {
  render(<ThemeToggle />);
  assert.equal(screen.getByRole<HTMLInputElement>('radio', { name: 'Auto' }).checked, true);
  // The fake says the OS is not light.
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});

test('a stored preference is what is checked, and it beats the OS', () => {
  localStorage.setItem('pickarr.theme', 'light');
  render(<ThemeToggle />);
  assert.equal(screen.getByRole<HTMLInputElement>('radio', { name: 'Light' }).checked, true);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
});

test('choosing a theme repaints and persists it', () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(localStorage.getItem('pickarr.theme'), 'light');
});

test('choosing Auto hands the decision back to the OS', () => {
  localStorage.setItem('pickarr.theme', 'light');
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole('radio', { name: 'Auto' }));
  assert.equal(localStorage.getItem('pickarr.theme'), null);
  // The fake still says not-light, so handing the decision back means dark.
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});

test('an OS change is followed while the preference is Auto', () => {
  render(<ThemeToggle />);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  fake.matches = true;
  fake.dispatchEvent(new Event('change'));
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
});

test('an OS change is ignored once the preference is explicit', () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
  fake.matches = true;
  fake.dispatchEvent(new Event('change'));
  // Explicitly dark means dark, whatever the operating system starts saying.
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/ThemeToggle.test.tsx
```

Expected: FAIL — `Cannot find module '../src/components/ThemeToggle.tsx'`.

- [ ] **Step 3: Write `ThemeToggle.tsx`**

```tsx
import { useEffect, useState } from 'react';
import {
  LIGHT_QUERY,
  applyTheme,
  readPreference,
  resolve,
  systemPrefersLight,
  writePreference,
  type ThemePreference,
} from '../theme.ts';

/**
 * Radios rather than a two-state switch, because "follow the OS" is what the app
 * did before there was any control at all, and a switch that can only say light
 * or dark removes a behaviour instead of adding one. Radios rather than three
 * buttons because a radio group inside a fieldset gives one accessible group
 * name and arrow-key movement without any JavaScript of ours.
 */
const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    applyTheme(resolve(preference, systemPrefersLight()));

    // The listener is only meaningful while the OS is what decides. An explicit
    // preference is an answer, and an operating system that switches on a
    // schedule must not overrule it.
    if (preference !== 'system') return;

    const query = window.matchMedia(LIGHT_QUERY);
    const onChange = (): void => {
      applyTheme(resolve('system', query.matches));
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  function choose(next: ThemePreference): void {
    writePreference(next);
    setPreference(next);
  }

  return (
    <fieldset className="theme-toggle">
      {/* The group's accessible name. Hidden visually because the three labels
          already say what this is to anyone who can see it. */}
      <legend className="visually-hidden">Theme</legend>
      {OPTIONS.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={preference === option.value}
            onChange={() => choose(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/ThemeToggle.test.tsx
```

Expected: 7 passing. If the OS-change tests fail because `@testing-library`'s `render` did
not flush the effect, wrap the `dispatchEvent` in `act` from `@testing-library/react` —
that is the only expected adjustment here.

- [ ] **Step 5: Add the pre-paint script to `index.html`**

Insert immediately before `</head>`:

```html
    <!--
      Inline and synchronous because it has to beat first paint. The module
      script below is deferred by definition, so leaving this to React means
      painting the wrong theme and then correcting it, in view.

      It duplicates three lines of `src/theme.ts` deliberately: importing the
      module here would make this a second module graph fetched before paint,
      which is the very thing it exists to avoid. `pickarr.theme` and
      `(prefers-color-scheme: light)` are the contract, and `theme.ts` exports
      both so they are stated in one place and copied here knowingly.
    -->
    <script>
      try {
        var stored = localStorage.getItem('pickarr.theme');
        document.documentElement.setAttribute(
          'data-theme',
          stored === 'light' || stored === 'dark'
            ? stored
            : matchMedia('(prefers-color-scheme: light)').matches
              ? 'light'
              : 'dark',
        );
      } catch (cause) {
        // localStorage throws on access outright in some privacy
        // configurations. Dark is the default identity, so fall to it.
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    </script>
```

- [ ] **Step 6: Render the control in the nav**

In `packages/web/src/App.tsx`, add the import and place the control after the Settings link,
inside `<nav>`:

```tsx
import { ThemeToggle } from './components/ThemeToggle.tsx';
```

```tsx
        <NavLink to="/settings">Settings</NavLink>
        {/*
          Below the rule that separates the library from the installation,
          because it is neither: it is a per-browser preference, and the foot of
          the chrome is where a reader looks for one.
        */}
        <ThemeToggle />
```

- [ ] **Step 7: Style the control and add the utility**

In `base.css`:

```css
/* The standard clip, so a legend can name a group for a screen reader without
   taking space in a nav that is already only as wide as its longest label. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
```

In `nav.css`:

```css
/*
 * The nav is content-width — about as wide as "Downloads" — and three labelled
 * segments roughly doubles that. This is the one layout change this phase makes,
 * and it is accepted rather than worked around: a Settings section would be the
 * only control on that page with no Save button, and an icon-only control needs
 * an icon set this phase does not add.
 *
 * The `fieldset` reset is not tidiness. The UA gives it a border, padding and
 * margin that would draw a second box inside a nav that already has none.
 */
.theme-toggle {
  display: flex;
  gap: var(--space-1);
  margin: var(--space-3) 0 0;
  padding: 0;
  border: 0;
  font-size: var(--text-label);
}

.theme-toggle label {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  color: var(--color-text-dim);
  white-space: nowrap;
}

.theme-toggle input { margin: 0; accent-color: var(--color-accent); }
```

- [ ] **Step 8: Verify by hand in the browser**

```bash
npm run dev -w @pickarr/web
```

Check, in order:
1. Load with nothing in `localStorage` — the page paints in the OS's scheme with **no flash** of the other one. Reload several times.
2. Click Light — the app goes light immediately, `localStorage` holds `light`, and a reload paints light with no flash even if the OS is dark.
3. Click Auto — the key disappears from `localStorage` and the app follows the OS again.
4. With Auto selected, change the OS appearance setting — the app follows live, without a reload.
5. With Dark selected, change the OS appearance setting — the app does not budge.
6. Confirm the scrollbar and any `<select>` match the app's theme rather than the OS's when the two disagree. This is `color-scheme` from Task 3 doing its job.

- [ ] **Step 9: Run the full gate**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 10: Commit**

```bash
git add -A packages/web
git commit -m "Let the user override the operating system's theme, and paint the choice before first paint

The control is three radios in a fieldset rather than a switch: 'follow the OS' is
what the app did before there was a control, and a two-state switch would remove
that rather than add to it. The fieldset's hidden legend is what names the group
to a screen reader.

The resolving script is inline in index.html and duplicates three lines of
theme.ts knowingly — importing the module before paint would create the second
pre-paint module graph the script exists to avoid. STORAGE_KEY and LIGHT_QUERY are
exported so the contract is stated once and copied deliberately.

The nav grows by roughly 70px to fit three labelled segments. That is the single
layout change this phase permits, and phase 2's card is what has to live with it."
```

---

### Task 6: Controls and focus in the base layer

**Files:**
- Modify: `packages/web/src/styles/base.css`

**Interfaces:**
- Consumes: tokens from Task 3.
- Produces: the button convention later tasks rely on — a bare `button` is secondary, and `button.primary` does not exist because no markup sets it. Primary treatment is applied by context in `rows.css` and `card.css`.

- [ ] **Step 1: Add the control and focus rules**

```css
/*
 * Native controls on a #121110 ground do not read as unstyled, they read as
 * broken, and `color-scheme: dark` alone only gets them to a grey slab.
 *
 * A bare `button` is the secondary treatment because that is what almost every
 * button in the app is — Edit, Cancel, Retry, Load more. The two that are
 * genuinely primary (Pick, and the confirm dialog's own confirm) get their fill
 * from their own files, by context, since no markup distinguishes them.
 */
button {
  font: inherit;
  font-size: var(--text-body);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
}

button:hover:not(:disabled) { background: var(--color-surface-2); }
button:disabled { color: var(--color-text-faint); border-color: var(--color-line); cursor: default; }

input, select, textarea {
  font: inherit;
  font-size: var(--text-body);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
}

/* `--color-line-strong` rather than `--color-line` on every control above: WCAG
   1.4.11 wants 3:1 against the adjacent background for the visual boundary of
   something the user operates, and the decorative hairline is ~1.3:1. */
::placeholder { color: var(--color-text-faint); }

/*
 * The app defined no focus style at all and relied on the UA default, which
 * against custom dark surfaces is frequently invisible. This is a correctness
 * fix rather than polish, and it is `:focus-visible` rather than `:focus` so a
 * mouse click on a button does not leave a ring behind.
 */
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
```

- [ ] **Step 2: Verify every control by hand**

```bash
npm run dev -w @pickarr/web
```

In both themes: the Browse search box, a card's Edit and Requery buttons, a release row's
Pick and Edit quality, Downloads' Retry, the Settings form's text inputs and selects, and
Load more in its disabled state. Then tab through Browse from the top and confirm every
stop shows a visible amber ring — nav links, search box, buttons, poster thumbnails.

- [ ] **Step 3: Run the full gate**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/styles/base.css
git commit -m "Style the native controls and give the app a focus indicator it never had

Controls take --color-line-strong rather than the decorative hairline because
WCAG 1.4.11 asks 3:1 of the boundary of anything the user operates, and the
hairline that looks right between two rows is ~1.3:1. The :focus-visible ring is
the correctness half: the app defined no focus style and relied on a UA default
that is frequently invisible against a custom dark surface."
```

---

### Task 7: The nav

**Files:**
- Modify: `packages/web/src/styles/nav.css`

- [ ] **Step 1: Move the nav onto tokens**

Replace `nav a`, `nav a.active` and `.nav-separator`'s colour handling. Keep `nav`'s
existing layout rule and its long comment untouched — `align-self`, `position: sticky`,
`top` and `max-height` are load-bearing and documented.

```css
nav a {
  text-decoration: none;
  /* `dim`, not `faint`. An inactive tab is essential text and `--color-text-faint`
     is ~3.8:1, below the 4.5:1 floor — it is for labels and placeholders. */
  color: var(--color-text-dim);
  font-size: var(--text-body);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
}

nav a:hover { color: var(--color-text); background: var(--color-surface-2); }

/*
 * The underline goes. It was carrying the whole burden of "you are here" on its
 * own; a filled surface plus an accent rule on the leading edge says it without
 * competing with the link text.
 */
nav a.active {
  font-weight: 600;
  text-decoration: none;
  color: var(--color-text);
  background: var(--color-surface-2);
  box-shadow: inset 2px 0 0 var(--color-accent);
}
```

And on `.nav-separator`, replace the `currentColor` border and its `opacity` with the token,
keeping the existing comment:

```css
.nav-separator {
  width: 100%;
  margin: var(--space-1) 0;
  border: 0;
  border-top: 1px solid var(--color-line);
}
```

- [ ] **Step 2: Confirm the separator test still passes**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/Settings.test.tsx
```

Expected: PASS. Both assertions look for `hr.nav-separator` and
`[role="separator"], hr` — the element and class are unchanged, only its paint.

- [ ] **Step 3: Verify by hand**

In both themes: the active tab reads as active without the underline; inactive tabs are
legible, not greyed to the point of looking disabled; the rule above Settings reads as a
division rather than a seam; the theme control below it does not crowd it.

- [ ] **Step 4: Run the full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add packages/web/src/styles/nav.css
git commit -m "Give the nav an active state that is not an underline, and colour inactive tabs legibly

Inactive tabs take --color-text-dim rather than --color-text-faint: faint is
~3.8:1, under the 4.5:1 floor, and a tab label is essential text rather than
decoration. The active tab trades its underline for a filled surface and an
accent rule on the leading edge, which says 'you are here' without competing with
the link text for the same pixels."
```

---

### Task 8: The card shell, header, badge and chips

**Files:**
- Modify: `packages/web/src/styles/card.css`

- [ ] **Step 1: Rewrite the card's paint**

Keep every existing comment and every layout declaration (`.card-head`'s flex,
`.card-head-main`'s `min-width: 0`, `.poster-thumb`'s `flex: none` and the image bounds).
Change only paint, and delete `opacity: 0.95`.

```css
/*
 * `opacity: 0.95` came off this rule. It dimmed the poster along with the text,
 * which is exactly backwards for a card whose job is judging artwork.
 */
.media-card {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.media-card h2 { margin: 0; font-size: var(--text-title); font-weight: 600; letter-spacing: -0.012em; }

.subtitle, .date { margin: 0.1rem 0; color: var(--color-text-dim); font-size: var(--text-meta); }

/* The accent as a fill, with `--color-on-accent` on it — ~7.6:1, and the same
   pair in both themes. Amber is also the warning colour (`.download-absent`,
   `.confirm .warning`); actions and warnings are told apart by form, a filled
   pill against plain text, rather than by hue. */
.badge {
  display: inline-block;
  margin-top: var(--space-1);
  padding: 0.1rem var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: var(--text-label);
  font-weight: 600;
}

/*
 * The display fields become chips. No markup changed: the `<li>` already exists,
 * and it already holds label and value in a single text node (see `MediaCard`
 * on why). A chip is what turns four floating "Label: Value" strings into four
 * things you can count at a glance.
 */
.fields { display: flex; gap: var(--space-2); flex-wrap: wrap; margin: var(--space-2) 0; padding: 0; list-style: none; }

.fields li {
  padding: 0.05rem var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface-2);
  color: var(--color-text-dim);
  font-size: var(--text-label);
}

/* The poster reads as a framed image rather than a floating one, and the frame is
   what keeps a letterboxed or very dark image from bleeding into the card. */
.poster-thumb img { display: block; max-width: 6rem; max-height: 8rem; border: 1px solid var(--color-line); border-radius: var(--radius-sm); }

.metadata-pending { color: var(--color-text-dim); font-size: var(--text-meta); font-style: italic; }
```

Note that `.fields`'s `gap` drops from `1rem` to `var(--space-2)` because the chips now
have their own padding and border to separate them; and `.fields li`'s `opacity: 0.8`
is replaced by an explicit colour, since opacity on a bordered chip washes out the border
too.

- [ ] **Step 2: Confirm the card tests still pass**

```bash
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/MediaCard.test.tsx
```

Expected: PASS, including the `.card-actions` and `.metadata-performers` queries.

- [ ] **Step 3: Verify by hand**

In both themes, on Browse and Picks: a card with a poster and one without; a card with an
"Upgrade available" badge; a card whose title is a long unbroken release name (it must still
wrap rather than push the poster out); the chips row with one field and with five.

- [ ] **Step 4: Run the full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add packages/web/src/styles/card.css
git commit -m "Give the card a real surface, turn the display fields into chips, and stop dimming the poster

opacity: 0.95 on .media-card dimmed the artwork along with the text, which is
backwards for a card that exists to help judge artwork. The fields list becomes
chips with no markup change — the <li> and its single label-and-value text node
were already there — because four bordered chips can be counted at a glance where
four floating strings cannot. The badge moves off #b45309 onto the accent."
```

---

### Task 9: The metadata panel

The panel and four of its five children have no rule at all today; this writes them.

**Files:**
- Modify: `packages/web/src/styles/card.css`

- [ ] **Step 1: Add the panel's rules**

```css
/*
 * The scene panel had no rules at all — `.metadata`, `.metadata-title`,
 * `.metadata-release-date`, `.metadata-duration` and `.metadata-synopsis` were
 * rendered by `MediaCard` and inherited browser defaults. This is the first time
 * any of them is styled.
 *
 * A top rule rather than a nested box: the panel is a second opinion about the
 * card it sits in, not a separate object, and a border would make it read as one.
 */
.metadata {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-line);
}

/* Dim when it is plain text, accent when it is a link — `MediaCard` wraps this in
   an `<a>` only when the provider gave a scene URL, and `base.css` colours the
   anchor. An unlinked second opinion is not interactive and must not look it. */
.metadata-title { margin: 0; color: var(--color-text-dim); font-size: var(--text-body); }

.metadata-release-date,
.metadata-duration {
  display: inline;
  margin: 0;
  color: var(--color-text-dim);
  font-size: var(--text-meta);
}

/* They are two `<p>`s in the markup and read as one line, so the second gets a
   separator rather than a line of its own. */
.metadata-duration::before { content: ' · '; color: var(--color-text-faint); }

/*
 * The measure is the point. An unbounded synopsis across a 60rem card is the
 * hardest thing on the screen to read, and 68ch is inside the 45–75 the
 * typographic advice settles on.
 */
.metadata-synopsis {
  max-width: 68ch;
  margin: var(--space-2) 0 0;
  color: var(--color-text-dim);
  font-size: var(--text-meta);
  line-height: 1.55;
}
```

- [ ] **Step 2: Verify by hand**

In both themes, on Browse: a card whose metadata is `confirmed` with a synopsis, a release
date and a duration; one with a synopsis but no duration (the `·` separator must not appear
orphaned); one where the title is a link and one where it is not; a `pending` card, which
must still show only the italic "pending" note and no empty panel.

Note the separator caveat: `.metadata-duration::before` only renders when the duration
element renders, which `MediaCard` gates on `durationSeconds !== null`, so a missing
duration cannot leave a stray `·`. A missing *release date* with a present duration will
show a leading `·` — check that case, and if it looks wrong, move the separator to
`.metadata-release-date + .metadata-duration::before` so it needs both siblings.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add packages/web/src/styles/card.css
git commit -m "Style the scene metadata panel, which had no rules at all

.metadata and four of its five children were rendered by MediaCard and inheriting
browser defaults. The synopsis gets a 68ch measure, which is the whole point:
unbounded across a 60rem card it was the hardest thing on the screen to read. The
panel is separated by a top rule rather than boxed, because it is a second opinion
about the card it sits in rather than a separate object."
```

---

### Task 10: Release rows

**Files:**
- Modify: `packages/web/src/styles/rows.css`

- [ ] **Step 1: Rewrite the release row's paint**

`.release-quality` and `.release-size` get their first rules ever. `ReleaseRow` already
renders them *before* the name, so a `min-width` on each puts the two numbers being
compared into a column instead of letting them drift with the length of the title beside
them.

```css
.release-row {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-1) 0;
  border-top: 1px solid var(--color-line);
  font-size: var(--text-body);
}

/*
 * First rules for these two. They are rendered ahead of the name by `ReleaseRow`,
 * and the fixed widths are what make the comparison possible: the numbers you are
 * choosing between line up in a column rather than starting wherever the title
 * beside them happens to end.
 */
.release-quality {
  flex: none;
  min-width: 3.5rem;
  padding: 0 var(--space-1);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface-2);
  color: var(--color-text-dim);
  font-size: var(--text-label);
  text-align: center;
}

.release-size {
  flex: none;
  min-width: 4.5rem;
  color: var(--color-text-dim);
  font-size: var(--text-meta);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.release-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-dim);
}

.release-current { font-weight: 600; color: var(--color-text); }
.release-failed { color: var(--color-error); }

/* The one genuinely primary button in the app, and it gets its fill by context
   because no markup distinguishes it. Pick is the whole purpose of the screen. */
.release-row button { background: var(--color-accent); color: var(--color-on-accent); border-color: transparent; font-weight: 600; }
.release-row button:hover:not(:disabled) { background: var(--color-accent); filter: brightness(1.08); }
```

Note: `.release-row button` also matches the row's "Edit quality" button. That is accepted —
both are actions on the row and the row has at most one of each; if the two filled buttons
side by side read as competing during Step 2's check, narrow the selector to
`.release-row > button:first-of-type`.

Delete the old shared `.download-error, .release-failed { color: #b91c1c; }` rule's
`.release-failed` selector, leaving `.download-error` for Task 11.

- [ ] **Step 2: Verify by hand**

In both themes, on Browse and Picks: a card with two releases at different qualities (the
quality chips and sizes must form two columns); a release with no size (`sizeBytes`
undefined — the row must not collapse); the current release; a failed current release
(reads "Failed", no Pick button); a failed alternative (reads "Failed" *and* keeps its Pick
button); a row with the quality-edit form open.

- [ ] **Step 3: Run the full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add packages/web/src/styles/rows.css
git commit -m "Put the numbers a release is judged on into columns, and give Pick the accent

.release-quality and .release-size had no rules at all. Fixed min-widths on both
are what make a card comparable: the quality and size you are choosing between now
line up vertically instead of starting wherever the title beside them ends. Pick
takes the accent fill by context, since no markup distinguishes the one primary
button on the screen from the secondary ones beside it."
```

---

### Task 11: Download rows, and the failed rows

**Files:**
- Modify: `packages/web/src/styles/rows.css`

- [ ] **Step 1: Add the status ladder and the row paint**

```css
.download-row {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-1) 0;
  border-top: 1px solid var(--color-line);
  font-size: var(--text-body);
}

.download-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.download-kind { flex: none; color: var(--color-text-faint); font-size: var(--text-label); text-transform: uppercase; letter-spacing: 0.06em; }

/*
 * Six additive rules over a neutral base, not a `switch`. `DownloadView.status`
 * is typed `string` on the wire — the closed union lives in core's
 * `db/downloads.ts` and does not travel — so a status this list has not heard of
 * has to render plainly rather than disappear.
 *
 * The ladder says how far along a job is, and it colours text that already names
 * the status, so nothing here is conveyed by colour alone.
 */
.download-status { flex: none; min-width: 5.5rem; color: var(--color-text-dim); font-size: var(--text-meta); }

.status-queued .download-status { color: var(--color-text-dim); }
.status-downloading .download-status { color: var(--color-text); }
.status-completed .download-status { color: var(--color-text-dim); }
.status-importing .download-status { color: var(--color-accent-text); }
.status-imported .download-status { color: var(--color-success); }
.status-failed .download-status { color: var(--color-error); }

.download-error { color: var(--color-error); font-size: var(--text-meta); }

/* Amber, not red: absence is not yet a failure, only a client that has gone
   quiet. It shares the accent hue — see the badge in `card.css` on why that is
   accepted, and how form rather than hue separates a warning from an action. */
.download-absent { color: var(--color-accent-text); font-size: var(--text-meta); }

.download-row.untracked { color: var(--color-text-faint); font-style: italic; }

.failed-row {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.failed-row h2 { margin: 0; font-size: var(--text-body); font-weight: 600; overflow-wrap: anywhere; font-family: 'IBM Plex Mono', ui-monospace, monospace; }

.failed-reason, .failed-feed { margin: 0.1rem 0; color: var(--color-text-dim); font-size: var(--text-meta); }
```

`.failed-row h2` takes mono because it is a raw release name that failed to parse — the same
reason `.release-name` does, and the whole point of that screen is reading the name closely
enough to fix it.

`.download-row.untracked` replaces `opacity: 0.5` with an explicit colour, for the same
reason the chips did: opacity on a row washes out its hairline too.

- [ ] **Step 2: Confirm the Downloads and Failed tests still pass**

```bash
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/Downloads.test.tsx packages/web/test/Failed.test.tsx
```

Expected: PASS, including `ul.downloads > li`.

- [ ] **Step 3: Verify by hand**

In both themes, on Downloads: rows in as many of the six statuses as the running instance
has; a failed row with an error string; an absent row showing "missing from client for …";
an untracked row. On Failed: a row with a reason and a feed, and the fix form open.

If the instance has no row in some status, temporarily edit one in the SQLite database to
see it, and put it back:

```bash
sqlite3 /Users/chad/Projects/pickarr/pickarr-2026-08-17.db \
  "select id, status from downloads order by id desc limit 10;"
```

- [ ] **Step 4: Run the full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add packages/web/src/styles/rows.css
git commit -m "Colour download status by how far along a job is, and style the four classes that had no rules

.download-title, .download-kind and .download-status had none, and neither did any
of the six status-* modifiers DownloadRow composes from a template literal. The
ladder is six additive rules over a neutral base rather than an exhaustive switch,
because DownloadView.status is typed string on the wire — core's closed union does
not travel — so an unrecognised status has to render plainly rather than vanish.
Every rule colours text that already names the status, so nothing is conveyed by
colour alone."
```

---

### Task 12: Forms

**Files:**
- Modify: `packages/web/src/styles/forms.css`

- [ ] **Step 1: Move the forms onto tokens**

Keep `.settings-row fieldset`'s reset and its comment — the nested-fieldset reasoning is
unchanged.

```css
input.search { margin-bottom: var(--space-4); width: 100%; max-width: 24rem; }

/* First rules for these two. Neither had any: both were containers whose children
   happened to be styled. A little separation is all they need. */
.manual-form { margin: var(--space-2) 0; }
.config-form { margin: 0; }

.manual-field { display: flex; gap: var(--space-2); align-items: baseline; margin-top: var(--space-2); }
.manual-field label { min-width: 8rem; color: var(--color-text-dim); font-size: var(--text-meta); }

.manual-help { color: var(--color-text-faint); font-size: var(--text-label); }
.manual-preview { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: var(--text-meta); color: var(--color-text-dim); }
.manual-actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); }

.secret-set { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: var(--text-meta); color: var(--color-text-faint); }

.settings-row {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  padding: var(--space-3);
  margin-bottom: var(--space-3);
}

.settings-row-actions { display: flex; gap: var(--space-2); margin-top: var(--space-2); }

fieldset {
  /* The decorative token, not the strong one: a fieldset groups controls but is
     not itself one, so 1.4.11 does not apply to its border. */
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  margin: 0 0 var(--space-4);
  padding: var(--space-3);
}

legend { font-weight: 600; font-size: var(--text-meta); color: var(--color-text-dim); }

.settings-actions { display: flex; gap: var(--space-2); margin: var(--space-3) 0 var(--space-5); }
```

- [ ] **Step 2: Confirm the settings tests still pass**

```bash
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/Settings.test.tsx packages/web/test/ConfigForm.test.tsx \
         packages/web/test/FeedFields.test.tsx packages/web/test/DownloadClientFields.test.tsx \
         packages/web/test/PluginFields.test.tsx packages/web/test/SecretField.test.tsx \
         packages/web/test/ManualForm.test.tsx
```

Expected: all PASS.

- [ ] **Step 3: Verify by hand**

In both themes, on Settings: the whole form top to bottom, a download client's nested
path-mappings fieldset (it must have no border of its own), a secret field in both its
`set` and `replace` states, and the Save/Restart action row. Then on Failed, open a fix
form; on Browse, open a card's Edit form and a row's Edit quality form and confirm the
identity preview is legible in mono.

- [ ] **Step 4: Run the full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add packages/web/src/styles/forms.css
git commit -m "Move the forms onto tokens, and give .manual-form and .config-form their first rules

fieldset takes the decorative line token rather than the strong one: it groups
controls but is not one, so WCAG 1.4.11 does not reach its border. The identity
preview and the stored-secret marker take Plex Mono, since both are strings the
reader is checking character by character."
```

---

### Task 13: Dialogs, and getting `.confirm` off the system colours

This repairs the defect the theme control would otherwise introduce.

**Files:**
- Modify: `packages/web/src/styles/dialog.css`

- [ ] **Step 1: Move `.confirm` onto tokens**

Keep every existing comment on `.image-modal`, `.image-modal-close` and `.image-modal img` —
the reasoning about the UA's `<dialog>` box and the out-of-flow close button is unchanged
and hard-won.

```css
/*
 * `background: Canvas; color: CanvasText` came off this rule, and that is a
 * repair rather than a restyle. Those keywords were chosen precisely *because*
 * `color-scheme: light dark` on the root made them track the app. Now that the
 * app's theme is the user's to set and can disagree with the operating system,
 * the same keywords track the OS instead — so a dark app would raise a light
 * confirmation dialog. Tokens follow `data-theme`, which is the app.
 */
.confirm {
  max-width: 40rem;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  padding: var(--space-4) var(--space-5);
  background: var(--color-surface);
  color: var(--color-text);
  box-shadow: var(--shadow-dialog);
}

.confirm::backdrop { background: rgb(0 0 0 / 60%); }
.confirm h2 { margin: 0 0 var(--space-3); font-size: var(--text-title); font-weight: 600; }
.confirm h3 { margin: var(--space-3) 0 var(--space-1); font-size: var(--text-body); color: var(--color-text-dim); }
.confirm ul { margin: 0; padding-left: var(--space-5); font-size: var(--text-meta); }
/* Mono and wrapping: these are destination paths, and the end of one is the part
   that says where the file is actually going. */
.confirm li { overflow-wrap: anywhere; font-family: 'IBM Plex Mono', ui-monospace, monospace; color: var(--color-text-dim); }
.confirm button { margin: var(--space-4) var(--space-2) 0 0; }
/* Amber, and distinct from the error red: something to read before confirming,
   not something that has already gone wrong. */
.confirm .warning { color: var(--color-accent-text); }
```

The `rgb(0 0 0 / 60%)` and `rgb(0 0 0 / 70%)` backdrops stay literal. A backdrop is a
scrim over arbitrary page content in both themes, not a surface, so it has no token.

- [ ] **Step 2: Confirm the dialog tests still pass**

```bash
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx \
  --import ./packages/web/test/setup.ts --conditions development \
  --test packages/web/test/ImageModal.test.tsx packages/web/test/IdentityChangeConfirm.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Verify the repair specifically**

This is the check that matters, and it needs the two schemes to disagree:

1. Set the OS to light. Set the app to Dark with the toggle.
2. On Browse, edit a group's identity so the confirmation dialog opens.
3. The dialog must be dark. Before this task it would be light-on-dark.
4. Repeat inverted: OS dark, app Light — the dialog must be light.
5. Open a poster in `ImageModal` in both themes and confirm a tall image still fits the
   window and the close button is still legible on it.

- [ ] **Step 4: Run the full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add packages/web/src/styles/dialog.css
git commit -m "Take the confirmation dialog off the system colours, so it follows the app rather than the OS

.confirm was painted in Canvas and CanvasText, chosen because color-scheme:
light dark on the root made those track the app. Once the theme is the user's to
set, the same keywords track the operating system instead — a dark app would
raise a light confirmation dialog the moment the two disagreed. Tokens follow
data-theme, which is the app. Verified with the OS and the app set opposite ways
round in both directions."
```

---

### Task 14: Final sweep

No new code. This is the gate the whole phase is judged at.

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Confirm the token discipline held**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system/packages/web/src/styles
grep -n '#[0-9a-fA-F]\{3,6\}' *.css
```

Expected: hits **only** in `tokens.css`. Any other file still holding a hex is a rule a
task missed.

```bash
grep -n 'currentColor\|opacity:' *.css
```

Expected: no `currentColor` anywhere, and `opacity` only where it is genuinely an opacity
rather than a stand-in for a colour. Every remaining hit needs a reason.

```bash
grep -n 'font-size: [0-9]' *.css
```

Expected: no hits — every size comes from a `--text-*` token.

- [ ] **Step 2: Confirm nothing was dropped**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system
git diff --stat main...HEAD -- packages/web/src/styles.css packages/web/src/styles/
```

Then re-run the class-coverage check that motivated the phase, confirming the thirteen
formerly ruleless classes now have rules:

```bash
cd packages/web/src
grep -rho 'className="[^"]*"' . | sed 's/className="//;s/"//' | tr ' ' '\n' \
  | grep -v '^$' | grep -v '{' | sort -u > /tmp/used.txt
grep -ho '\.[a-z][a-z0-9-]*' styles/*.css | sed 's/^\.//' | sort -u > /tmp/styled.txt
comm -23 /tmp/used.txt /tmp/styled.txt
```

Expected: empty, or only classes deliberately left unstyled with a stated reason.

- [ ] **Step 3: Walk all five routes in both themes**

```bash
cd /Users/chad/Projects/pickarr/worktrees/design-system
npm run dev -w @pickarr/web
```

For each of Auto, Light and Dark, visit Browse, Picks, Downloads, Failed and Settings. On
each, check: text legibility at every level, the hairlines reading as separators rather
than a grid, no element inheriting a browser default, and no element invisible against its
background. Specifically hunt the awkward cases:

- A card with no poster, no metadata and one release.
- A card mid-`pending`.
- A long unbroken release name in a card title, a release row and a `.failed-row h2`.
- Downloads with zero rows, and the untracked section.
- Settings with a validation error showing.
- Tab from the top of each page to the bottom and confirm every stop rings visibly.

- [ ] **Step 4: Confirm the contrast table**

Check each pair in spec §5.3 with a contrast checker against the built palette, in both
themes. The spec's figures are computed rather than measured; anything that comes in under
its stated threshold is a token to adjust here, not a rounding difference to accept.

- [ ] **Step 5: Run the full gate one last time**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 6: Commit anything the sweep fixed**

```bash
git status --short
# commit only if the sweep found and fixed something
```

---

## Self-Review

**Spec coverage.** §3 file structure → Task 1. §4 tokens → Task 3. §5.1 two accent tokens,
§5.2 two line tokens, §5.3 palettes → Task 3; §5.3's contrast table → Task 14 Step 4;
§5.4's recorded consequence → the comments in Tasks 8 and 11. §6 typography → Task 2, with
the `unicode-range` deviation recorded at the top of this plan. §7.1 state model and §7.3
`color-scheme` → Tasks 3 and 4; §7.2 no-flash → Task 5 Step 5; §7.4 the control → Task 5.
§8.1's thirteen classes → Tasks 3 (`loading`), 9 (five `metadata*`), 10 (two `release-*`),
11 (three `download-*`), 12 (`manual-form`, `config-form`); re-verified in Task 14 Step 2.
§8.2 card → Task 8. §8.3 release rows → Task 10. §8.4 downloads → Task 11. §8.5 metadata →
Task 9. §8.6 base layer → Tasks 3 and 6. §9 accessibility → Tasks 6, 7 and 14. §10 testing
→ Tasks 4 and 5. §11 verification → every task's gate, plus Task 14.

Two spec items land in tasks the spec did not itself separate: `.failed-row` and its
children are §8's implicit remainder and are covered in Task 11, and `input.search` in
Task 12.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code
step carries the actual content. Three steps carry conditional fallbacks rather than
placeholders — Task 1 Step 4 if the bundler leaves `@import` unresolved, Task 5 Step 4 if
the effect needs `act`, Task 9 Step 2 if the `·` separator orphans, Task 10 Step 1 if the
two filled buttons compete — and each names the exact alternative rather than deferring the
decision.

**Type consistency.** `ThemePreference` and `ResolvedTheme` are declared in Task 4 and used
under those names in Task 5. `readPreference`, `writePreference`, `systemPrefersLight`,
`resolve`, `applyTheme` and `LIGHT_QUERY` are exported in Task 4 and imported by exactly
those names in Task 5's component and both test files. The storage key `pickarr.theme` and
the query `(prefers-color-scheme: light)` appear in Task 4's module, Task 4's tests, Task
5's tests and Task 5's inline script, spelled identically in all four. Token names in Tasks
6–13 are all drawn from the list Task 3 declares; `--color-line-strong` and
`--color-accent-text` in particular are used only where §5.1 and §5.2 allow.
