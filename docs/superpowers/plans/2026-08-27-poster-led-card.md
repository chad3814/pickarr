# The Poster-Led Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the card's artwork to the left of the identity column, bring the scene metadata up beside it, and make the provider's title and date what the card shows.

**Architecture:** Two independent changes to one component and its stylesheet. Task 1 is content — which title and which date the card renders, and collapsing three header elements into one context line. Task 2 is layout — the artwork's side, and the metadata panel's children moving into the identity column. Nothing outside `MediaCard`, `card.css` and their tests changes.

**Tech Stack:** React 19, TypeScript, `node:test` + happy-dom for the web suite, Playwright for e2e. No new dependency.

**Spec:** `docs/superpowers/specs/2026-08-27-poster-led-card-design.md`

## Global Constraints

- The TypeScript `any` type is banned. Never introduce it, not even in tests.
- Comments are documentation in this codebase. A comment that is false about the code beside it is a defect equal to a wrong line of code. This change falsifies several comments that describe the old layout and the old title rule; correcting them is part of the work, not tidying after it.
- An assertion message must not claim more than its assertion establishes.
- **Never** write `assert.equal(screen.queryBy*(...), null)`, and never hand a live DOM element to `node:assert` as a value it might print. `scripts/check-test-hygiene.ts` fails the build on it; the rule and both hazard shapes are documented on `gone()` in `packages/web/test/dom.ts`.
- Test-suite split: `test:web` globs `packages/web/test/**/*.test.tsx`; `test:server` globs `packages/*/test/**/*.test.ts` **and** `scripts/**/*.test.ts`.
- **Do not run `npx playwright test` from the repo root.** A root `playwright.config.ts` refuses for a reason: the root has no `globalSetup`, so the SPA bundle is never rebuilt and the suite runs against a stale `packages/web/dist` — CSS and markup changes appear to pass while the browser never sees them. Use `npm run e2e`.
- `docs/superpowers/` is a historical record. Do not edit anything under it.
- Commit messages: one full declarative sentence saying what changed and why it is better. No `feat:`/`fix:`/`chore:` prefix, no attribution or `Co-Authored-By` trailer, **no trailing period**. `git log -5 --format=%s` shows the shape.
- Gate every task: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`. The e2e script is `e2e`, not `test:e2e`.
- Baseline at the start of this plan: server 1417 pass, web 291 pass, e2e 22 passed, lint/typecheck/build clean, 125 lint warnings.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/web/src/components/MediaCard.tsx` | **Modify, both tasks.** Task 1 rewrites the `<header>` and strips three elements from the scene panel. Task 2 reorders `.card-head` and moves the panel's remaining children into the identity column. |
| `packages/web/src/styles/card.css` | **Modify, both tasks.** Task 1 adds `.card-context` and retires `.subtitle`/`.date`/`.metadata-title`/`.metadata-release-date`/`.metadata-duration`. Task 2 retires `.metadata` and its top rule. |
| `packages/web/test/MediaCard.test.tsx` | **Modify, both tasks.** |
| `packages/e2e/tests/card-layout.spec.ts` | **Modify, task 2.** Two directional assertions invert. |

Nothing else. `groupImages`/`slotImage`, `ImageModal`, the API views and the server are untouched.

---

## Task 1: Provider-led title and the collapsed context line

**Files:**
- Modify: `packages/web/src/components/MediaCard.tsx` — the `<header>` block, and the three elements removed from the scene panel
- Modify: `packages/web/src/styles/card.css`
- Test: `packages/web/test/MediaCard.test.tsx`

**Interfaces:**
- Consumes: `GroupView`, `MetadataView` from `packages/web/src/api/client.ts`; `formatDuration` from `packages/web/src/api/format.ts` (already imported by this component).
- Produces: nothing other tasks import. Task 2 assumes the header is already collapsed.

**The type fact that shapes this.** In `client.ts`, `MetadataView` is a union and `title`, `releaseDate`, `durationSeconds` and `sceneUrl` all live inside the `state: 'confirmed'` member. `performers` sits on `CastView`, outside it. So every provider field needs narrowing on `metadata.state === 'confirmed'`, and `display.*` needs none. `sceneUrl` is already narrowed for you near the top of the component:

```tsx
const sceneUrl = metadata.state === 'confirmed' ? metadata.sceneUrl ?? null : null;
```

**Measured, so you know what you are building for** (`pickarr-2026-08-27.db`, 4,313 groups): 1,957 groups have a provider title *and* a provider date; 2,356 have neither and fall back. Of the 1,957, 1,677 provider titles differ substantively from the parsed title — the parsed title is performer-name-led, the provider's is the scene's actual title. This task visibly renames most of the library, on purpose.

- [ ] **Step 1: Write the failing tests**

In `packages/web/test/MediaCard.test.tsx`, add these. The existing fixtures `GROUP`, `CONFIRMED` and `withMetadata` are already in the file; `CONFIRMED` has `title: 'A Different Title'`, `releaseDate: '2023-04-15'`, `durationSeconds: 1800`, and `GROUP.display` has `title: 'Alex Coal'`, `subtitle: 'Brazzers'`, `date: '2023-04-15'`.

```tsx
test('the card shows the provider title, not the parsed one', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'A Different Title' }));
  // The parsed title is performer-name-led; adopting the provider's is the point
  // of this phase, so the parsed one must not also be on screen as a heading.
  assert.ok(!screen.queryByRole('heading', { level: 2, name: 'Alex Coal' }));
});

test('the parsed title is the fallback when the provider has no title', () => {
  render(<MediaCard group={withMetadata({ title: null })} onPick={() => {}} />);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Alex Coal' }));
});

test('a group with no confirmed answer falls back too', () => {
  render(<MediaCard group={{ ...GROUP, metadata: { state: 'none' } }} onPick={() => {}} />);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Alex Coal' }));
});

test('the context line joins studio, provider date and runtime', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  const context = card('A Different Title').querySelector('.card-context');
  assert.ok(context !== null, 'no context line');
  // Asserted as one string because the separators are the thing under test:
  // they are drawn by CSS between adjacent spans, so what matters is which
  // parts are present and in what order.
  // `formatDuration(1800)` is '30m' — verified against packages/web/src/api/format.ts,
  // not assumed. The separators are CSS `::before` content, which `textContent`
  // does not include, so the parts run together here.
  assert.equal(context.textContent, 'Brazzers2023-04-1530m');
});

test('an absent part leaves no separator behind', () => {
  // The provider populates these unevenly — the existing panel comment says a
  // running time without a release date is ordinary, not rare — so each part
  // renders on its own condition and the separator is CSS between siblings.
  render(<MediaCard group={withMetadata({ releaseDate: null, durationSeconds: null })} onPick={() => {}} />);
  const context = card('A Different Title').querySelector('.card-context');
  assert.equal(context?.textContent, 'Brazzers', 'no orphan separator');
  assert.equal(context?.querySelectorAll('span').length, 1, 'one part means one span');
});

test('the parsed date is not shown when the provider has no date', () => {
  // Spec §4: the date falls back to nothing, not to display.date.
  render(<MediaCard group={withMetadata({ releaseDate: null })} onPick={() => {}} />);
  const context = card('A Different Title').querySelector('.card-context');
  assert.ok(context !== null, 'no context line');
  assert.ok(!context.textContent?.includes('2023-04-15'), 'display.date must not stand in');
});

test('a group with no studio, date or runtime renders no context line at all', () => {
  const bare: GroupView = {
    ...GROUP,
    display: { title: 'Alex Coal', fields: [] },
    metadata: { state: 'none' },
  };
  render(<MediaCard group={bare} onPick={() => {}} />);
  // #40: never `assert.equal(screen.queryBy*(...), null)`.
  assert.ok(!card('Alex Coal').querySelector('.card-context'));
});

test('the scene link wraps whichever title renders', () => {
  const url = 'https://theporndb.net/scenes/s';
  render(<MediaCard group={withMetadata({ sceneUrl: url })} onPick={() => {}} />);
  const link = screen.getByRole('link', { name: 'A Different Title' });
  // A literal, not the fixture value: both ends agreeing on a wrong string is
  // the failure this style of assertion exists to catch.
  assert.equal(link.getAttribute('href'), 'https://theporndb.net/scenes/s');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');

  cleanup();
  render(<MediaCard group={withMetadata({ title: null, sceneUrl: url })} onPick={() => {}} />);
  assert.ok(screen.getByRole('link', { name: 'Alex Coal' }), 'the fallback title links too');
});

test('the scene panel no longer carries a second title, date or duration', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  const cardEl = card('A Different Title');
  for (const cls of ['.metadata-title', '.metadata-release-date', '.metadata-duration']) {
    assert.ok(!cardEl.querySelector(cls), `${cls} moved into the header`);
  }
  // The synopsis and cast are untouched by this task.
  assert.ok(cardEl.querySelector('.metadata-synopsis'));
});
```

Existing tests in this file that will now fail and must be **updated, not deleted** — they assert the old header:

- `renders the display fields` asserts `getByText('Alex Coal')`, `getByText('Brazzers')` and `getByText('2023-04-15')` on a `GROUP` with `metadata: { state: 'absent' }`. That group has no provider answer, so the title stays `'Alex Coal'` and the studio stays; only the bare `'2023-04-15'` assertion changes, because `display.date` is no longer rendered. Keep the test, drop that one line, and say in a comment why.
- Any test using `card('Alex Coal')` on a group with a **confirmed** answer now needs `card('A Different Title')`, because `card()` looks the element up by its visible text. Grep for `card('Alex Coal')` and check each call site's fixture.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run test:web`
Expected: the new tests fail on the missing `.card-context` and on the heading still reading `'Alex Coal'`.

- [ ] **Step 3: Rewrite the header**

In `MediaCard.tsx`, add these near the existing `sceneUrl` line:

```tsx
  // The provider's answer is what the card shows, with the plugin's display as
  // the fallback — spec §4. This reverses the rule the old panel comment stated
  // ("a second opinion, never a replacement"): a collapsed header has room for
  // one title, and the provider's is the scene's actual title where the parsed
  // one is usually performer-name-led. All three are inside the `'confirmed'`
  // member of the union, so they narrow together.
  const answered = metadata.state === 'confirmed' ? metadata : null;
  const title = answered?.title ?? display.title;
  const runtime = answered?.durationSeconds ?? null;
  // The date has no fallback on purpose: `display.date` is the parse of a
  // release name, and this phase stops presenting that as the scene's date.
  const releaseDate = answered?.releaseDate ?? null;
  const context: string[] = [];
  if (display.subtitle !== undefined) context.push(display.subtitle);
  if (releaseDate !== null) context.push(releaseDate);
  if (runtime !== null) context.push(formatDuration(runtime));
```

Replace the `<header>` block:

```tsx
          <header>
            <h2>
              {sceneUrl === null ? (
                title
              ) : (
                <a href={sceneUrl} target="_blank" rel="noopener noreferrer">
                  {title}
                </a>
              )}
            </h2>
            {/*
              * One span per part, with the separator drawn by CSS between
              * adjacent siblings rather than joined here. The provider populates
              * these unevenly — the panel this replaces documented a running
              * time without a release date as ordinary — so a JS join would need
              * to know which parts are present, which is exactly what the
              * sibling selector already knows.
              */}
            {context.length > 0 && (
              <p className="card-context">
                {context.map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </p>
            )}
            {group.upgradeReleaseId !== null && <span className="badge">Upgrade available</span>}
          </header>
```

Then delete from the scene panel the three blocks that rendered `metadata.title` (with its `sceneUrl` ternary), `metadata.releaseDate` and `metadata.durationSeconds`. The panel keeps `metadata.synopsis` and `{cast}`.

Rewrite the panel's doc comment. Its first sentence — "A second opinion, never a replacement: `display.title` above stays the card's title even when the provider disagrees with it — adopting a provider value is later work (this phase is deliberately non-destructive)" — is now false in every clause. State what the panel holds now and why the title left it.

- [ ] **Step 4: Style the context line**

In `card.css`, replace the `.subtitle, .date` rule:

```css
/* One line of context under the title, from parts that render on independent
   conditions. The separator is drawn between adjacent spans rather than joined
   in the component, so an absent part leaves no orphan ` · ` — the same reason
   `.metadata-release-date + .metadata-duration::before` used to exist, applied
   once to any number of parts instead of once per pair. */
.card-context { margin: 0.1rem 0; color: var(--color-text-dim); font-size: var(--text-meta); }
.card-context > span + span::before { content: ' · '; color: var(--color-text-faint); }
```

Delete the now-unused `.metadata-title`, `.metadata-release-date`, `.metadata-duration` rules and the comment block explaining the pairwise separator — including the paragraph that argues for the adjacent-sibling selector, since the rule it argued for is gone and the argument now lives on `.card-context`.

**Before deleting `.subtitle` and `.date`, grep for them:** `grep -rn "className=\"subtitle\"\|className=\"date\"\|\.subtitle\|\.date\b" packages/web/src packages/e2e`. If another component renders either class, keep the rule and say so in your report rather than breaking that component's styling.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`
Expected: PASS. Report the web count — it rises by the number of tests you added, less any you merged into existing ones.

If an e2e spec fails here, read it before changing it. `metadata.spec.ts` and `metadata-modal.spec.ts` seed confirmed groups and may assert on a title; a spec asserting the *parsed* title on a confirmed group is now asserting the wrong thing and its expectation updates to the provider's. Report every e2e expectation you change and why.

- [ ] **Step 6: Mutation-test the rules that carry the decision**

Break, run `npm run test:web`, note which test failed, revert:

1. `const title = display.title;` (ignore the provider) → the provider-title test fails.
2. `const title = answered?.title ?? '';` (no fallback) → both fallback tests fail.
3. `context.push(releaseDate ?? display.date ?? '')` (reinstate the parsed date) → the parsed-date test fails.
4. Join the context in JS with `.join(' · ')` and render one span → the absent-part test fails on the span count, and the separator assertion on a single-part group.
5. Drop the `sceneUrl` ternary from the `h2` → the scene-link test fails.

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
git add packages/web/src/components/MediaCard.tsx packages/web/src/styles/card.css \
        packages/web/test/MediaCard.test.tsx
git commit -m "Show the provider's title and date in one collapsed header, so the card reads as the scene rather than as the release name it was parsed from"
```

---

## Task 2: The artwork leads, and the metadata comes up beside it

**Files:**
- Modify: `packages/web/src/components/MediaCard.tsx`
- Modify: `packages/web/src/styles/card.css`
- Modify: `packages/e2e/tests/card-layout.spec.ts`
- Test: `packages/web/test/MediaCard.test.tsx`

**Interfaces:**
- Consumes: the collapsed header from Task 1. Nothing else.
- Produces: nothing further tasks import — this is the last task.

- [ ] **Step 1: Write the failing tests**

```tsx
test('the artwork leads: it starts before the identity column in the DOM', () => {
  render(<MediaCard group={withMetadata({ hasPoster: true })} onPick={() => {}} />);
  const head = card('A Different Title').querySelector('.card-head');
  assert.ok(head !== null, 'no card head');
  const children = [...head.children];
  const artwork = head.querySelector('.card-artwork');
  const main = head.querySelector('.card-head-main');
  assert.ok(artwork !== null && main !== null, 'head is missing a column');
  // DOM order, not CSS order: `flex-direction: row-reverse` or an `order`
  // property would put the artwork on the left visually while leaving a screen
  // reader and the tab order reading the identity column first.
  assert.ok(children.indexOf(artwork) < children.indexOf(main), 'artwork precedes the identity column');
});

test('the synopsis and cast render inside the identity column, not below the releases', () => {
  render(<MediaCard group={withMetadata({ performers: [
    { id: 4, name: 'Alice Maze', url: 'https://example/alice', hasAvatar: true, hasImage: true },
  ] })} onPick={() => {}} />);
  const main = card('A Different Title').querySelector('.card-head-main');
  assert.ok(main !== null, 'no identity column');
  assert.ok(main.querySelector('.metadata-synopsis'), 'the synopsis moved up');
  assert.ok(main.querySelector('.metadata-performers'), 'the cast moved up');
});

test('the pending note moves up with the panel it describes', () => {
  render(<MediaCard group={{ ...GROUP, metadata: { state: 'pending' } }} onPick={() => {}} />);
  const main = card('Alex Coal').querySelector('.card-head-main');
  assert.ok(main?.querySelector('.metadata-pending'), 'the note describes a lookup rendering above');
});

test('the metadata section wrapper is gone', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  // Its children now live in the identity column, so a wrapper whose only job
  // was grouping them below the releases has nothing left to group.
  assert.ok(!card('A Different Title').querySelector('section.metadata'));
});

test('the cast renders once for a confirmed group and once for an unconfirmed one', () => {
  const performers = [
    { id: 4, name: 'Alice Maze', url: 'https://example/alice', hasAvatar: true, hasImage: true },
  ];
  render(<MediaCard group={withMetadata({ performers })} onPick={() => {}} />);
  assert.equal(card('A Different Title').querySelectorAll('.metadata-performers').length, 1);
  cleanup();

  // The old code had two call sites for exactly this pair of cases. With no
  // enclosing section to be inside or outside of, one site serves both — and
  // the exclusivity the old comment maintained by hand is now structural.
  render(<MediaCard group={{ ...GROUP, metadata: { state: 'none', performers } }} onPick={() => {}} />);
  assert.equal(card('Alex Coal').querySelectorAll('.metadata-performers').length, 1);
});

test('the release rows stay after the head, not inside it', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  const cardEl = card('A Different Title');
  const head = cardEl.querySelector('.card-head');
  const releases = cardEl.querySelector('ul.releases');
  assert.ok(head !== null && releases !== null, 'card is missing a part');
  assert.ok(!head.contains(releases), 'the releases are a sibling of the head, as before');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run test:web`
Expected: failures on DOM order and on the synopsis/cast still being outside `.card-head-main`.

- [ ] **Step 3: Move the artwork and the panel**

In `MediaCard.tsx`:

1. Inside `<div className="card-head">`, move the `{slot !== null && (<button className="card-artwork" …>)}` block so it appears **before** `<div className="card-head-main">`. Reorder the JSX rather than using CSS `order` or `row-reverse` — the tests above assert DOM order, and for the reason they state.

2. Move the pending note, the synopsis and the cast into `.card-head-main`, after the `.fields` list, in that order. The `{metadata.state === 'confirmed' && (<section className="metadata" …>)}` wrapper and the separate `{metadata.state !== 'confirmed' && cast !== null && (<section …>)}` block both go; what remains is:

```tsx
          {metadata.state === 'pending' && <p className="metadata-pending">pending</p>}
          {metadata.state === 'confirmed' && metadata.synopsis !== null && (
            <p className="metadata-synopsis">{metadata.synopsis}</p>
          )}
          {cast}
```

`cast` is already `null` when there is nobody to list, so it needs no guard — that is what the existing `cast` builder returns `null` for. The two old call sites existed because the cast belonged inside the panel when there was one; with no panel there is one place for it.

3. Rewrite the `.card-head` doc comment. It currently argues that the identity block gets a column "beside the whole identity block — title, Edit, fields — rather than beside the title alone" so the column stays tall enough. That reasoning survives the move but the sides in it do not; the comment names the artwork as the right-hand column. Correct it, and keep the argument about column height, which is still why the artwork sits beside the whole block rather than the title.

- [ ] **Step 4: Retire the panel's stylesheet rule**

In `card.css`, delete the `.metadata` rule and the comment above it. That comment reads "A top rule rather than a nested box: the panel is a second opinion about the card it sits in, not a separate object, and a border would make it read as one." Both the rule and its reasoning are gone with the section.

`.metadata-synopsis`, `.metadata-performers` and `.metadata-pending` keep their class names and their existing rules — check each still reads correctly inside a narrower column, and say in your report whether any needed a change.

**The one thing about this layout that cannot be settled on paper** (spec §1): the synopsis moves from the card's full width into the column beside the artwork, losing 6rem plus a gap on top of the ~70px phase 1's nav change already cost. Build it, look at a real synopsis, and report how it reads. If it needs a rule, add one and say why.

- [ ] **Step 5: Invert the two directional e2e assertions**

`packages/e2e/tests/card-layout.spec.ts` asserts the artwork's position relative to the heading and the fields. Two assertions are directional and both **invert** — they do not relax:

```ts
  expect(posterBox.x).toBeGreaterThan(headingBox.x + headingBox.width - 1);
```
becomes an assertion that the artwork ends left of where the heading starts:
```ts
  expect(posterBox.x + posterBox.width).toBeLessThan(headingBox.x + 1);
```

and

```ts
  expect(fieldsBox.x).toBeLessThan(posterBox.x);
```
becomes
```ts
  expect(fieldsBox.x).toBeGreaterThan(posterBox.x);
```

Leave `expect(posterBox.y).toBeLessThan(headingBox.y + headingBox.height)` and `expect(posterBox.y + posterBox.height).toBeGreaterThan(fieldsBox.y)` exactly as they are: they constrain the vertical relationship, which the move does not change, and they are what catches `flex-direction` reverting to a stacked column.

Update the comments above both. The second one explains that the fields row being the last thing in the column is what proves the artwork spans the whole identity block — that argument is unchanged; only the direction is.

**Do not weaken any assertion in this file.** It has been weakened by accident before: an earlier change left its title and its fixture describing a scenario the stylesheet had made unreachable, and a separate one left it passing against both a cropped and a letterboxed slot. If an assertion no longer constrains the thing it was written for, say so in your report rather than deleting it.

- [ ] **Step 6: Run the full gate**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`
Expected: PASS. Report all three counts.

- [ ] **Step 7: Mutation-test the layout**

1. Move the artwork block back after `.card-head-main` → the DOM-order test fails.
2. Achieve the visual move with `flex-direction: row-reverse` on `.card-head` and the artwork last in the DOM → the DOM-order test still fails, which is the point of asserting order rather than geometry.
3. Leave the synopsis and cast below the releases → the "render inside the identity column" test fails.
4. Restore the second cast call site → the render-once test fails on the confirmed case (two `.metadata-performers`).
5. Revert one inverted e2e assertion to its old direction → `npm run e2e` fails on it.

- [ ] **Step 8: Commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
git add packages/web/src/components/MediaCard.tsx packages/web/src/styles/card.css \
        packages/web/test/MediaCard.test.tsx packages/e2e/tests/card-layout.spec.ts
git commit -m "Lead the card with its artwork and bring the scene's own details up beside it, so the card reads as a scene rather than as a filename with a thumbnail"
```

---

## Self-review against the spec

**Spec coverage.** §3's layout: Task 2 steps 3-4, with DOM order asserted rather than geometry. §3's ordering of the identity column: Task 1 step 3 (header, context) and Task 2 step 3 (pending, synopsis, cast after the fields). §3.1's single cast site: Task 2 step 3, pinned by the render-once test and mutation 4. §4's title and date table: Task 1 steps 1 and 3, every row pinned by a test and by mutations 1-3. §4's context-line joining with absent parts omitted: Task 1's CSS sibling selector, pinned by the absent-part test and mutation 4. §4's `sceneUrl` on whichever title renders: Task 1, both cases tested. §4's "a confirmed answer can carry `title: null`": tested explicitly, since it is the non-obvious half of the fallback. §5's testing list: distributed across both tasks. §6's risks: the synopsis width is Task 2 step 4's explicit look-and-report; the rest are recorded rather than actionable.

**Not in scope and deliberately absent from every task:** search, the poster's size, the empty-slot placeholder, performer measurement, and the gallery. If a task tempts you toward any of them, it is out of scope — say so in your report rather than widening.

**Type consistency.** `answered`, `title`, `releaseDate`, `runtime` and `context` are introduced in Task 1 step 3 and used nowhere else. Task 2 adds no new names. `.card-context` is the only new class; `.metadata` is the only class removed.

**Known gap, stated rather than hidden.** Task 1 step 5 warns that an e2e spec may assert a parsed title on a confirmed group, but this plan does not name which — `metadata.spec.ts` and `metadata-modal.spec.ts` both seed confirmed groups and I have not read their assertions closely enough to promise which will fail. Step 5 is a read-and-report step for exactly that reason.
