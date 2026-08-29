# Master/detail Browse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Browse a second view — a dense scannable list on the left, the selected group's card on the right — and a switcher between it and today's column of cards.

**Architecture:** Four tasks, each with its own deliverable. One pure function so the list and the pane agree on a group's title; one self-contained listbox component tested through its props; one integration in `Browse` that adds the switcher and wires both views; one layout pass that widens the shell, makes the pane sticky, and proves it in a browser. No server change, no URL state, no new endpoint.

**Tech Stack:** React 19, TypeScript, react-router 7, `node:test` + happy-dom for the web suite, Playwright for e2e. No new dependency.

**Spec:** `docs/superpowers/specs/2026-08-28-master-detail-browse-design.md`

## Global Constraints

- The TypeScript `any` type is banned. Never introduce it, not even in tests.
- Comments are documentation in this codebase. A comment false about the code beside it is a defect equal to a wrong line of code. This plan falsifies at least one existing comment by design (Task 1); correcting it is part of the work.
- An assertion message must not claim more than its assertion establishes.
- **Never** write `assert.equal(screen.queryBy*(...), null)`, and never hand a live DOM element to `node:assert` as a value it might print. `scripts/check-test-hygiene.ts` fails the build on it; the rule and both hazard shapes are on `gone()` in `packages/web/test/dom.ts`.
- Test-suite split: `test:web` globs `packages/web/test/**/*.test.tsx`; `test:server` globs `packages/*/test/**/*.test.ts` **and** `scripts/**/*.test.ts`. A `.test.ts` inside `packages/web/test/` runs in the **server** suite.
- **Do not run `npx playwright test` from the repo root.** A root `playwright.config.ts` refuses on purpose: the root has no `globalSetup`, so the SPA bundle is never rebuilt and CSS or markup changes appear to pass while the browser never sees them. Use `npm run e2e`.
- **Gate by redirecting the whole run to a file and grepping the file** — `npm test >/tmp/gate.log 2>&1; grep … /tmp/gate.log`. Never pipe the run through `grep`: a failure's name and output are exactly what gets filtered out, and you only discover the loss after the failure has evaporated.
- `docs/superpowers/` is a historical record. Do not edit anything under it.
- Commit messages: one full declarative sentence saying what changed and why it is better. No `feat:`/`fix:`/`chore:` prefix, no attribution or `Co-Authored-By` trailer, **no trailing period**. `git log -5 --format=%s` shows the shape.
- Gate every task: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`. The e2e script is `e2e`, **not** `test:e2e`.
- **The branch must add no lint warnings.** Baseline is 125, counted as `grep -c ': warning ' <lint output>`. Check before and after; the previous phase shipped one and needed a follow-up commit.
- Baseline at the start of this plan: server 1417 pass, web 308 pass, e2e 23 passed, lint/typecheck/build clean, 125 lint warnings.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/web/src/api/format.ts` | **Modify, Task 1.** Gains `text()`, moved out of `MediaCard` so two callers share one normaliser. |
| `packages/web/src/api/groupTitle.ts` | **Create, Task 1.** `groupTitle(group)` — the provider-led title rule, so the master row and the card agree. |
| `packages/web/src/components/MediaCard.tsx` | **Modify, Task 1 only.** Imports `text` and `groupTitle` instead of deriving them. Its composition is otherwise untouched — spec §2. |
| `packages/web/src/components/GroupList.tsx` | **Create, Task 2.** The master list: a listbox of dense rows, selection and keyboard through props. Renders no card and knows nothing about Browse. |
| `packages/web/src/browseView.ts` | **Create, Task 3.** The `list \| split` preference, persisted per browser. Mirrors `theme.ts`. |
| `packages/web/src/components/ViewToggle.tsx` | **Create, Task 3.** The switcher. Mirrors `ThemeToggle`'s radio-group shape. |
| `packages/web/src/routes/Browse.tsx` | **Modify, Task 3.** Holds the view mode and the selected id, renders one view or the other. |
| `packages/web/src/styles/browse.css` | **Create, Task 4.** The split layout, the sticky pane, and the list's own rules. |
| `packages/web/src/styles/base.css` | **Modify, Task 4.** `.app`'s cap rises in split view. |
| `packages/web/src/styles/index.css` | **Modify, Task 4.** Imports `browse.css`. |
| `packages/e2e/tests/browse-split.spec.ts` | **Create, Task 4.** Switching, clicking a row, and keyboard movement in a real browser. |

Tests live beside their subjects: `packages/web/test/groupTitle.test.ts` (server suite — pure), and `GroupList.test.tsx`, `ViewToggle.test.tsx`, `browseView.test.tsx`, `Browse.test.tsx` in the web suite.

---

## Task 1: One title rule, shared

**Files:**
- Create: `packages/web/src/api/groupTitle.ts`
- Modify: `packages/web/src/api/format.ts` (gains `text`)
- Modify: `packages/web/src/components/MediaCard.tsx` (imports both; drops its private `text`)
- Test: `packages/web/test/groupTitle.test.ts` — **server suite**, it is pure and needs no DOM

**Interfaces:**
- Consumes: `GroupView`, `MetadataView` from `packages/web/src/api/client.ts` (type-only).
- Produces:
  - `export function text(value: string | null | undefined): string | null` in `format.ts`
  - `export function groupTitle(group: GroupView): string` in `groupTitle.ts`

**Why this is a task and not an inline helper.** Spec §5: the master row must show the same title the pane does, or the two disagree about what a group is called. Phase 2 spent a fix round on exactly that defect when the artwork button's `aria-label` kept `display.title` while the heading had adopted the provider's, so a screen-reader user heard a name appearing nowhere on screen. A second consumer now exists, so the rule moves to a function. It moves *now*, before either consumer is written, so neither is written against a copy.

**A comment this task falsifies.** `MediaCard`'s `text()` doc ends: "`commit.ts`'s `isText` guards the same class of value for `display`'s own optional strings, though only against `undefined` — **there is no shared helper to reuse here.**" After this task there is one, and it is this. Rewrite that clause where the helper now lives; do not leave it behind in `MediaCard`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/groupTitle.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTitle } from '../src/api/groupTitle.ts';
import type { GroupView, MetadataView } from '../src/api/client.ts';

const BASE: GroupView = {
  id: 7,
  plugin: 'scenes',
  display: { title: 'Parsed Title', subtitle: 'Brazzers', fields: [] },
  state: 'new',
  pickedReleaseId: null,
  upgradeReleaseId: null,
  listRankAt: 0,
  releases: [],
  metadata: { state: 'absent' },
};

function withMetadata(metadata: MetadataView): GroupView {
  return { ...BASE, metadata };
}

const CONFIRMED = {
  state: 'confirmed',
  title: 'Provider Title',
  releaseDate: null,
  durationSeconds: null,
  synopsis: null,
  hasPoster: false,
  hasBackground: false,
} satisfies Extract<MetadataView, { state: 'confirmed' }>;

test('the provider title wins when there is one', () => {
  assert.equal(groupTitle(withMetadata(CONFIRMED)), 'Provider Title');
});

test('a confirmed answer with no title falls back to the parsed one', () => {
  // Not only unanswered groups: `title` is `string | null` inside the
  // confirmed variant, so a confirmed answer can carry nothing to show.
  assert.equal(groupTitle(withMetadata({ ...CONFIRMED, title: null })), 'Parsed Title');
});

test('an empty provider title falls back too', () => {
  // `maybeStr` in `db/row.ts` folds only NULL and undefined, so an empty
  // column reaches the view as `''` and would render a heading with no text.
  assert.equal(groupTitle(withMetadata({ ...CONFIRMED, title: '' })), 'Parsed Title');
});

test('every unconfirmed state falls back, since the provider fields are not reachable', () => {
  for (const metadata of [{ state: 'absent' }, { state: 'none' }, { state: 'pending' }] satisfies MetadataView[]) {
    assert.equal(groupTitle(withMetadata(metadata)), 'Parsed Title', `state ${metadata.state}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:server >/tmp/t.log 2>&1; grep -E "^ℹ (tests|pass|fail)|Cannot find" /tmp/t.log`
Expected: FAIL — `Cannot find module '../src/api/groupTitle.ts'`.

- [ ] **Step 3: Move `text` into `format.ts`**

Cut the `text` function and its doc comment out of `MediaCard.tsx` and add it to `packages/web/src/api/format.ts`, exported. Rewrite the clause that said no shared helper exists:

```ts
/**
 * A string with something in it, or `null`.
 *
 * `maybeStr` in `db/row.ts` folds only `NULL` and `undefined` into `null`, so an
 * empty column reaches the view as an empty string and nothing upstream
 * normalises it. Every consumer that would render such a value has to decide
 * what an empty one means, and for all of them so far the answer is "the same
 * as absent": an empty provider title renders a heading with no text, an empty
 * context part renders a span the sibling separator then decorates so the line
 * reads ` · 2023-04-15`, and an empty synopsis renders a paragraph whose margin
 * is blank space with nothing in it.
 *
 * Here rather than private to a component because `groupTitle` needs the same
 * question answered the same way. `commit.ts`'s `isText` guards the same class
 * of value for `display`'s own optional strings, but only against `undefined`,
 * so it is not this.
 */
export function text(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
```

- [ ] **Step 4: Write `groupTitle`**

Create `packages/web/src/api/groupTitle.ts`:

```ts
import { text } from './format.ts';
import type { GroupView } from './client.ts';

/**
 * What a group is called, wherever it is shown.
 *
 * The provider's title when there is one, the plugin's parsed title otherwise.
 * Phase 2 adopted the provider's on the card — the parsed title is
 * performer-name-led where the provider returns the scene's actual title — and
 * this is that rule, moved out of the card now that the master list shows a
 * title too.
 *
 * It is a function rather than a copy in each place because the two disagreeing
 * is a defect that has already happened once: the card's artwork button kept
 * `display.title` after the heading had adopted the provider's, so a
 * screen-reader user heard a name that appeared nowhere on screen. One rule,
 * one call.
 *
 * `title` lives inside the `'confirmed'` member of the `MetadataView` union, so
 * the narrowing is what makes every other state fall back — there is no
 * provider title to read on a group nobody has asked about yet.
 */
export function groupTitle(group: GroupView): string {
  const answered = group.metadata.state === 'confirmed' ? group.metadata : null;
  return text(answered?.title) ?? group.display.title;
}
```

- [ ] **Step 5: Have `MediaCard` use both**

Replace `MediaCard.tsx`'s local derivation. It currently reads:

```tsx
  const answered = metadata.state === 'confirmed' ? metadata : null;
  // `text`, not `??`: an empty provider title is a title the card cannot show,
  // so it falls back the same way a null one does.
  const title = text(answered?.title) ?? display.title;
```

Keep `answered` — the runtime, release date and synopsis all still narrow through it — and take the title from the shared rule:

```tsx
  const answered = metadata.state === 'confirmed' ? metadata : null;
  // The same rule the master list uses, so a group is called one thing
  // wherever it is shown. See `groupTitle`'s doc for why it is not derived here.
  const title = groupTitle(group);
```

Import `groupTitle` from `../api/groupTitle.ts` and `text` from `../api/format.ts` (that file is already imported for `formatDuration` — extend the existing import rather than adding a second).

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e` (redirected, grep the file).
Expected: PASS. Server rises by 4. Web unchanged at 308 — this task changes no rendering, and if a web test fails you have changed behaviour this task was meant to hold still.

- [ ] **Step 7: Mutation-test the two assertions that carry the rule**

Break, run, note which test failed, revert:

1. `groupTitle` returns `answered?.title ?? group.display.title` (drops `text`) → the empty-title test fails.
2. `groupTitle` returns `group.display.title` unconditionally → the provider-title test fails.
3. In `MediaCard`, revert `title` to its own local derivation → **no test fails**, because the two produce the same value today. Report that: it is why the rule is shared as a function rather than pinned by a test, and it is the reason a future edit to one copy would go unnoticed.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/api/groupTitle.ts packages/web/src/api/format.ts \
        packages/web/src/components/MediaCard.tsx packages/web/test/groupTitle.test.ts
git commit -m "Derive a group's title in one place, so the card and the list about to join it cannot disagree about what a group is called"
```

---

## Task 2: The master list

**Files:**
- Create: `packages/web/src/components/GroupList.tsx`
- Test: `packages/web/test/GroupList.test.tsx`

**Interfaces:**
- Consumes: `groupTitle` from Task 1; `GroupView` from `client.ts`.
- Produces:

```tsx
interface GroupListProps {
  groups: readonly GroupView[];
  /** The selected group's id, or `null` for nothing selected. */
  selectedId: number | null;
  onSelect: (groupId: number) => void;
}
export function GroupList(props: GroupListProps): JSX.Element
```

Nothing about paging, the sentinel, or the card is in here. `Browse` renders the sentinel after this component, as it does after the card list today.

**Why a component and not JSX inside `Browse`.** `Browse.tsx` is 259 lines and already holds paging, metadata polling, search, identity changes, picks, edits and the schema fetch. The listbox has its own keyboard behaviour and its own ARIA contract, and it is testable through three props without any of that. Spec §3.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/GroupList.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { GroupList } from '../src/components/GroupList.tsx';
import type { GroupView, MetadataView, ReleaseView } from '../src/api/client.ts';

afterEach(cleanup);

function release(id: number): ReleaseView {
  return { id, score: 1080, quality: { resolution: 1080 }, releaseName: `R${id}`, publishedAt: null };
}

function group(over: Partial<GroupView> & { id: number }): GroupView {
  return {
    plugin: 'scenes',
    display: { title: `Group ${over.id}`, subtitle: 'Brazzers', fields: [] },
    state: 'new',
    pickedReleaseId: null,
    upgradeReleaseId: null,
    listRankAt: 0,
    releases: [release(1)],
    metadata: { state: 'absent' } satisfies MetadataView,
    ...over,
  };
}

const THREE = [group({ id: 1 }), group({ id: 2 }), group({ id: 3 })];

test('a row shows the title, the studio and the release count', () => {
  render(<GroupList groups={[group({ id: 1, releases: [release(1), release(2)] })]}
                    selectedId={null} onSelect={() => {}} />);
  const row = screen.getByRole('option');
  assert.match(row.textContent ?? '', /Group 1/);
  assert.match(row.textContent ?? '', /Brazzers/);
  assert.match(row.textContent ?? '', /2 releases/);
});

test('one release is singular', () => {
  render(<GroupList groups={[group({ id: 1 })]} selectedId={null} onSelect={() => {}} />);
  assert.match(screen.getByRole('option').textContent ?? '', /1 release(?!s)/);
});

test('the title is the provider\'s when there is one, the same as the card shows', () => {
  render(<GroupList groups={[group({ id: 1, metadata: {
    state: 'confirmed', title: 'Provider Title', releaseDate: null, durationSeconds: null,
    synopsis: null, hasPoster: false, hasBackground: false,
  } })]} selectedId={null} onSelect={() => {}} />);
  assert.match(screen.getByRole('option').textContent ?? '', /Provider Title/);
  assert.ok(!screen.queryByText(/Group 1/));
});

test('an absent studio leaves no orphan separator', () => {
  render(<GroupList groups={[group({ id: 1, display: { title: 'Group 1', fields: [] } })]}
                    selectedId={null} onSelect={() => {}} />);
  const row = screen.getByRole('option');
  assert.ok(!(row.textContent ?? '').includes('·'), 'the separator is drawn by CSS between siblings');
  assert.equal(row.querySelectorAll('.group-row-meta > span').length, 1, 'one part, one span');
});

test('the upgrade marker renders only for a group that has one, and is named', () => {
  render(<GroupList groups={[group({ id: 1, upgradeReleaseId: 9 }), group({ id: 2 })]}
                    selectedId={null} onSelect={() => {}} />);
  const marked = screen.getAllByRole('option');
  assert.ok(marked[0]?.querySelector('.group-row-upgrade'), 'the flagged group is marked');
  assert.ok(!marked[1]?.querySelector('.group-row-upgrade'), 'the other is not');
  assert.ok(screen.getByLabelText('Upgrade available'), 'the marker is not glyph-only');
});

test('clicking a row reports its id', () => {
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={null} onSelect={(id) => picked.push(id)} />);
  fireEvent.click(screen.getAllByRole('option')[1]!);
  assert.deepEqual(picked, [2]);
});

test('it is a listbox with exactly one selected option', () => {
  render(<GroupList groups={THREE} selectedId={2} onSelect={() => {}} />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  const selected = screen.getAllByRole('option').filter((row) => row.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1);
  assert.match(selected[0]?.textContent ?? '', /Group 2/);
});

test('exactly one row is in the tab order', () => {
  // A roving tabindex: the listbox is one stop, not one stop per group, so a
  // reader tabbing past a paged list does not tab through hundreds of rows.
  render(<GroupList groups={THREE} selectedId={2} onSelect={() => {}} />);
  const reachable = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(reachable.length, 1);
  assert.match(reachable[0]?.textContent ?? '', /Group 2/, 'the selected row is the reachable one');
});

test('with nothing selected the first row is the tab stop', () => {
  render(<GroupList groups={THREE} selectedId={null} onSelect={() => {}} />);
  const reachable = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(reachable.length, 1);
  assert.match(reachable[0]?.textContent ?? '', /Group 1/);
});

test('ArrowDown from nothing selected takes the first row', () => {
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={null} onSelect={(id) => picked.push(id)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
  assert.deepEqual(picked, [1]);
});

test('the arrows move one row at a time', () => {
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={2} onSelect={(id) => picked.push(id)} />);
  const list = screen.getByRole('listbox');
  fireEvent.keyDown(list, { key: 'ArrowDown' });
  fireEvent.keyDown(list, { key: 'ArrowUp' });
  // Both are reported against the same `selectedId={2}`, because this component
  // does not hold the selection — the caller does, and a real caller re-renders
  // between the two.
  assert.deepEqual(picked, [3, 1]);
});

test('neither arrow walks off an end', () => {
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={1} onSelect={(id) => picked.push(id)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' });
  assert.deepEqual(picked, [], 'nothing above the first row');
  cleanup();

  render(<GroupList groups={THREE} selectedId={3} onSelect={(id) => picked.push(id)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
  assert.deepEqual(picked, [], 'nothing below the last');
});

test('an empty list renders a listbox with no options and no crash', () => {
  render(<GroupList groups={[]} selectedId={null} onSelect={() => {}} />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  // #40: never `assert.equal(screen.queryBy*(...), null)`.
  assert.ok(!screen.queryByRole('option'));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:web >/tmp/t.log 2>&1; grep -E "^ℹ (tests|pass|fail)|Cannot find" /tmp/t.log`
Expected: FAIL — `Cannot find module '../src/components/GroupList.tsx'`.

- [ ] **Step 3: Write the component**

Create `packages/web/src/components/GroupList.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { groupTitle } from '../api/groupTitle.ts';
import type { GroupView } from '../api/client.ts';

interface Props {
  groups: readonly GroupView[];
  /** The selected group's id, or `null` for nothing selected. */
  selectedId: number | null;
  onSelect: (groupId: number) => void;
}

/**
 * The dense half of Browse's split view: one row per group, selection and
 * keyboard movement, and nothing else. No card, no paging, no metadata — the
 * route renders the sentinel after this list exactly as it does after the card
 * list, and the pane beside it is the route's business.
 *
 * A listbox rather than a list of buttons. Single selection out of many options
 * is what `role="listbox"` describes, and it brings the contract with it: the
 * selected option is announced as selected rather than merely styled, and the
 * arrows are the expected way to move. A column of buttons would announce
 * nothing about selection and would put every row in the tab order — hundreds
 * of stops on a paged list, between the search box and whatever follows.
 *
 * The roving `tabIndex` is what keeps the whole list one tab stop. With nothing
 * selected the first row carries it, so a reader arriving by keyboard reaches
 * the list rather than skipping it.
 */
export function GroupList({ groups, selectedId, onSelect }: Props) {
  const selectedRow = useRef<HTMLLIElement | null>(null);

  // The selected row is scrolled into view when selection changes, which is
  // what makes arrow movement usable on a list longer than the window. Not on
  // every render: the route re-renders this list whenever a metadata answer
  // lands for any group on screen, and scrolling then would yank the page
  // under a reader who had not moved.
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  function step(by: number): void {
    if (groups.length === 0) return;
    const current = groups.findIndex((group) => group.id === selectedId);
    // Nothing selected yet: ArrowDown takes the first row, ArrowUp does
    // nothing. Starting at the last row for ArrowUp would move the reader to
    // the far end of a paged list on one keypress.
    if (current === -1) {
      if (by > 0) onSelect(groups[0]!.id);
      return;
    }
    const next = current + by;
    // Clamped rather than wrapped: a list that grows by paging has no
    // meaningful end to wrap to, and arriving at the top from the bottom reads
    // as a jump rather than a move.
    if (next < 0 || next >= groups.length) return;
    onSelect(groups[next]!.id);
  }

  const tabStopId = selectedId ?? groups[0]?.id ?? null;

  return (
    <ul
      className="group-list"
      role="listbox"
      aria-label="Groups"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
        if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
      }}
    >
      {groups.map((group) => {
        const selected = group.id === selectedId;
        const studio = group.display.subtitle;
        const count = `${group.releases.length} release${group.releases.length === 1 ? '' : 's'}`;
        return (
          <li
            key={group.id}
            ref={selected ? selectedRow : null}
            className={selected ? 'group-row group-row-selected' : 'group-row'}
            role="option"
            aria-selected={selected}
            tabIndex={group.id === tabStopId ? 0 : -1}
            onClick={() => onSelect(group.id)}
          >
            <span className="group-row-title">{groupTitle(group)}</span>
            {/*
              * One span per part, with the ` · ` drawn by CSS between adjacent
              * siblings rather than joined here — the same treatment the card's
              * context line uses, and for the same reason: a group with no
              * studio must not render a leading separator.
              */}
            <span className="group-row-meta">
              {studio !== undefined && <span>{studio}</span>}
              <span>{count}</span>
            </span>
            {group.upgradeReleaseId !== null && (
              <span className="group-row-upgrade" aria-label="Upgrade available">↑</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npm run test:web >/tmp/t.log 2>&1; grep -E "^ℹ (tests|pass|fail)" /tmp/t.log`
Expected: PASS. Web rises by 13.

- [ ] **Step 5: Mutation-test the keyboard and the ARIA**

Break, run `npm run test:web`, note the failure, revert:

1. Drop the clamp (`onSelect(groups[next]!.id)` unguarded) → the walk-off-an-end test fails, on both ends.
2. `ArrowUp` from nothing selected takes the last row → the ArrowDown-from-nothing test still passes; add nothing, but report that the ArrowUp-from-nothing behaviour is asserted only by the `deepEqual([])` in the end test. If it is not, say so.
3. `tabIndex={0}` on every row → the one-tab-stop test fails.
4. `aria-selected={false}` always → the one-selected-option test fails.
5. Remove `role="option"` → every `getAllByRole('option')` fails, which is most of the file.
6. Join the meta parts with `' · '` in JSX instead of two spans → the orphan-separator test fails on the span count.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/GroupList.tsx packages/web/test/GroupList.test.tsx
git commit -m "Add a listbox of dense group rows, so a long library can be scanned without rendering a full card for every entry"
```

---

## Task 3: The switcher, and Browse holding both views

**Files:**
- Create: `packages/web/src/browseView.ts`
- Create: `packages/web/src/components/ViewToggle.tsx`
- Modify: `packages/web/src/routes/Browse.tsx`
- Test: `packages/web/test/browseView.test.tsx`, `packages/web/test/ViewToggle.test.tsx`, `packages/web/test/Browse.test.tsx`

**Interfaces:**
- Consumes: `GroupList` from Task 2; `groupTitle` from Task 1.
- Produces:
  - `export type BrowseView = 'list' | 'split'`
  - `export function readView(): BrowseView` — `'list'` when nothing is stored **or when `localStorage` throws**
  - `export function writeView(view: BrowseView): void`
  - `export function ViewToggle({ view, onChange }: { view: BrowseView; onChange: (view: BrowseView) => void }): JSX.Element`

**Follow `theme.ts` and `ThemeToggle.tsx` exactly.** Two things in them are easy to miss and both are load-bearing. `readPreference` wraps the read in `try`/`catch` because, as that file records, "`localStorage` does not merely return null in some privacy configurations, **it throws on access**" — an unguarded read takes the whole route down. And `ThemeToggle` uses radios in a `<fieldset>` with a visually-hidden `<legend>`, for the reason it states: "a radio group inside a fieldset gives one accessible group name and arrow-key movement without any JavaScript of ours."

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/browseView.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readView, writeView } from '../src/browseView.ts';

const KEY = 'pickarr.browseView';

afterEach(() => {
  localStorage.removeItem(KEY);
});

test('nothing stored reads as the card list', () => {
  assert.equal(readView(), 'list');
});

test('a stored view reads back', () => {
  writeView('split');
  assert.equal(readView(), 'split');
  writeView('list');
  assert.equal(readView(), 'list');
});

test('an unrecognised stored value reads as the card list', () => {
  // Covers a hand-edited key and one written by a future version. The
  // alternative is rendering a view name nothing matches.
  localStorage.setItem(KEY, 'masterdetail');
  assert.equal(readView(), 'list');
});

test('a localStorage that throws on read still gives a view', () => {
  // Not hypothetical: `theme.ts` documents that some privacy configurations
  // throw on access rather than returning null. An unguarded read would take
  // the route down.
  const original = localStorage.getItem;
  localStorage.getItem = () => { throw new Error('SecurityError'); };
  try {
    assert.equal(readView(), 'list');
  } finally {
    localStorage.getItem = original;
  }
});

test('a localStorage that throws on write does not throw at the caller', () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('SecurityError'); };
  try {
    writeView('split');
  } finally {
    localStorage.setItem = original;
  }
});
```

Create `packages/web/test/ViewToggle.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ViewToggle } from '../src/components/ViewToggle.tsx';

afterEach(cleanup);

test('it is one named group of two radios, with the current view checked', () => {
  render(<ViewToggle view="split" onChange={() => {}} />);
  assert.ok(screen.getByRole('group', { name: 'View' }));
  const split = screen.getByRole('radio', { name: 'Split' });
  assert.equal((split as HTMLInputElement).checked, true);
  assert.equal((screen.getByRole('radio', { name: 'List' }) as HTMLInputElement).checked, false);
});

test('choosing the other view reports it', () => {
  const chosen: string[] = [];
  render(<ViewToggle view="list" onChange={(next) => chosen.push(next)} />);
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  assert.deepEqual(chosen, ['split']);
});
```

And in `packages/web/test/Browse.test.tsx`, add these. That file already has everything they need: `serve(pick, options)` installs the fetch stub with two pages, `group(id, title)` builds a `GroupView`, `options.firstPage` replaces page one, and `render(<Browse />)` plus a `waitFor` on the first title is how every test there starts. `localStorage` is cleared between tests by the additions below, because the view preference persists and a leaked `split` would change the next test's starting view.

```tsx
/**
 * The view preference outlives a `cleanup()`, so a test that switches views
 * would otherwise change the view every later test starts in. Cleared here
 * rather than in each test, so a test added later cannot forget.
 */
afterEach(() => {
  localStorage.removeItem('pickarr.browseView');
});

/** A confirmed answer whose title disagrees with the parsed one, as most real ones do. */
function answered(title: string): MetadataView {
  return {
    state: 'confirmed',
    title,
    releaseDate: null,
    durationSeconds: null,
    synopsis: null,
    hasPoster: false,
    hasBackground: false,
  };
}

test('a fresh browser gets the card list', () => {
  // Spec §7: nobody's Browse changes shape without them asking.
  serve(null);
  render(<Browse />);
  // #40: never `assert.equal(screen.queryBy*(...), null)`.
  assert.ok(!screen.queryByRole('listbox', { name: 'Groups' }));
});

test('choosing the split view shows the list, and no card until a row is picked', async () => {
  serve(null);
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Alpha')));

  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));

  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  assert.ok(!document.querySelector('article.media-card'), 'nothing selected, so no card');
  assert.ok(screen.getByText(/select a group/i), 'the pane says what to do instead');
});

test('clicking a row fills the pane with that group', async () => {
  serve(null, { firstPage: [group(1, 'Alpha'), group(2, 'Beta')] });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));

  fireEvent.click(screen.getAllByRole('option')[1]!);

  // The pane is a `MediaCard`, so the group's title is its heading.
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Beta' }));
  assert.equal(document.querySelectorAll('article.media-card').length, 1, 'one card, not one per group');
});

test('the row and the pane show the same title, not the row the parsed one', async () => {
  // The whole reason `groupTitle` is a shared function: a provider title that
  // disagrees with the parsed one must reach both surfaces.
  const alpha = group(1, 'Alpha');
  alpha.metadata = answered('Provider Alpha');
  serve(null, { firstPage: [alpha] });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Provider Alpha')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));

  const row = screen.getByRole('option');
  assert.match(row.textContent ?? '', /Provider Alpha/);
  assert.ok(!(row.textContent ?? '').includes('Alpha,'), 'the row does not also carry the parsed title');

  fireEvent.click(row);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Provider Alpha' }));
});

test('the selection clears when a term filters the selected group out', async () => {
  // Spec §4: an id pointing at nothing leaves a pane showing a group the list
  // beside it denies. `serve` answers every `?q=` with the same two pages, so
  // the term is applied by replacing the page — which is what a real
  // server-side search does, and what rebuilds `items`.
  serve(null, { firstPage: [group(1, 'Alpha'), group(2, 'Beta')] });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  fireEvent.click(screen.getAllByRole('option')[1]!);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Beta' }));

  // A term whose page omits Beta. Reinstall the stub so the next fetch answers
  // with one group, then change the term, which rebuilds the list.
  serve(null, { firstPage: [group(1, 'Alpha')] });
  fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'alpha' } });

  await waitFor(() => assert.ok(!document.querySelector('article.media-card')));
  assert.ok(screen.getByText(/select a group/i), 'the pane returned to its empty state');
});

test('the chosen view survives a remount', async () => {
  serve(null);
  const first = render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  first.unmount();

  serve(null);
  render(<Browse />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }), 'the preference was read back');
});
```

**Check the `Search groups` label matches** `SearchBox`'s actual `label` prop before relying on `getByLabelText` — `Browse` passes `label="Search groups"` today, and if that is not what the DOM exposes, use the query that file's other tests use.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:web >/tmp/t.log 2>&1; grep -E "^ℹ (tests|pass|fail)|Cannot find" /tmp/t.log`
Expected: FAIL on the missing modules, then on the missing listbox.

- [ ] **Step 3: Write the preference module**

Create `packages/web/src/browseView.ts`:

```ts
/**
 * Which of Browse's two views the reader chose, persisted per browser.
 *
 * The same shape as `theme.ts`, and for the same reason that file gives: this is
 * a per-browser preference, not an installation setting. Making it one would
 * mean a config field, a migration, and a round trip before first paint.
 */

export type BrowseView = 'list' | 'split';

const STORAGE_KEY = 'pickarr.browseView';

/**
 * Anything other than `'split'` reads as `'list'`, which covers a missing key, a
 * value written by a future version, and a hand-edited one — and makes the card
 * list what a fresh browser gets, so nobody's Browse changes shape without them
 * asking.
 */
export function readView(): BrowseView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'split' ? 'split' : 'list';
  } catch {
    // `localStorage` does not merely return null in some privacy
    // configurations, it throws on access — see `theme.ts`, which found this
    // first. The degradation is a Browse that forgets, not one that fails.
    return 'list';
  }
}

/** `'list'` removes the key, so "nothing stored" and "chose the default" are one state. */
export function writeView(view: BrowseView): void {
  try {
    if (view === 'list') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, view);
  } catch {
    return;
  }
}
```

- [ ] **Step 4: Write the toggle**

Create `packages/web/src/components/ViewToggle.tsx`:

```tsx
import type { BrowseView } from '../browseView.ts';

const OPTIONS: ReadonlyArray<{ value: BrowseView; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'split', label: 'Split' },
];

/**
 * Radios in a fieldset, the same shape `ThemeToggle` uses and for the reason it
 * states: a radio group gives one accessible group name and arrow-key movement
 * without any JavaScript of ours.
 *
 * Controlled, unlike `ThemeToggle`, which owns its own preference because it
 * also has to apply a theme to `<html>`. Here the route holds the view — it
 * decides what to render from it — so this component only reports a choice.
 */
export function ViewToggle({ view, onChange }: { view: BrowseView; onChange: (view: BrowseView) => void }) {
  return (
    <fieldset className="view-toggle">
      {/* The group's accessible name. Hidden visually because two labels
          reading List and Split already say what this is. */}
      <legend className="visually-hidden">View</legend>
      {OPTIONS.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name="browse-view"
            value={option.value}
            checked={view === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
```

- [ ] **Step 5: Wire `Browse`**

Add state beside the existing four `useState` calls:

```tsx
  const [view, setView] = useState<BrowseView>(readView);
  const [selectedId, setSelectedId] = useState<number | null>(null);
```

Persist on change:

```tsx
  function chooseView(next: BrowseView): void {
    writeView(next);
    setView(next);
  }
```

**Extract the card's prop set once, and use it from both views.** The existing `groups.map(...)` call site passes seven props; a second copy for the pane is seven chances to drift. Add, after `requeryMetadata`:

```tsx
  /**
   * One group's card, however it is being shown. Both views render this rather
   * than each composing the card's seven props, because two copies of a prop
   * list are two things to keep in step — and the pane and the list are meant
   * to show the same card, not similar ones.
   */
  function cardFor(group: GroupView) {
    return (
      <MediaCard
        key={group.id}
        group={{ ...group, metadata: liveMetadata.get(group.id) ?? group.metadata }}
        onPick={(releaseId) => void pick(group.id, releaseId)}
        fields={fields[group.plugin]}
        onEditGroup={(values) => identityChange.begin(group.id, values)}
        onEditRelease={(releaseId, values) => editRelease(group.id, releaseId, values)}
        onRequeryMetadata={requeryMetadata}
      />
    );
  }
```

Move the existing comments about `liveMetadata` and `fields` onto it — they explain those two props and are still true.

Derive the pane's group, and clear a selection the list no longer holds:

```tsx
  // The pane derives its group from `groups` rather than holding a copy, so a
  // metadata answer, a pick or an edit reaches it the same way it reaches a
  // card: the route merges the update into `groups` and this re-derives.
  const selected = selectedId === null ? null : groups.find((group) => group.id === selectedId) ?? null;

  // A term that filters the selected group out — or a new term, which rebuilds
  // the list from page one — leaves an id pointing at nothing. Clearing is the
  // honest outcome: the alternative is a pane showing a group the list beside
  // it says is not there. Guarded on `groups.length` so the gap between a term
  // changing and its first page arriving does not clear a still-valid
  // selection.
  useEffect(() => {
    if (selectedId !== null && groups.length > 0 && selected === null) setSelectedId(null);
  }, [selectedId, groups, selected]);
```

Render the toggle beside the search box, and one view or the other:

```tsx
      <div className="browse-controls">
        <SearchBox label="Search groups" value={search} onChange={setSearch} />
        <ViewToggle view={view} onChange={chooseView} />
      </div>
```

```tsx
      {view === 'list' ? (
        groups.map((group) => cardFor(group))
      ) : (
        <div className="browse-split">
          <GroupList groups={groups} selectedId={selectedId} onSelect={setSelectedId} />
          <div className="browse-detail">
            {selected === null ? (
              <p className="browse-detail-empty">Select a group to see its releases.</p>
            ) : (
              cardFor(selected)
            )}
          </div>
        </div>
      )}
```

The sentinel block stays exactly where it is, after both branches — spec §1.1: paging does not change.

- [ ] **Step 6: Run the gate**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e` (redirected; grep the file).
Expected: PASS. Report all counts. If an existing `Browse.test.tsx` test fails, read it — a test asserting cards render is still correct, because list is the default.

- [ ] **Step 7: Mutation-test the wiring**

1. `readView` returns `'split'` when nothing is stored → the fresh-browser test fails.
2. Drop the `writeView` call from `chooseView` → the persistence test fails.
3. Remove the clearing effect → the filtered-out test fails.
4. Have the pane hold its own copy of the group (`useState` on select) instead of deriving → report whether any test catches it. If none does, say so rather than adding one speculatively; the derivation's value is staleness that only shows when an answer lands mid-selection.
5. Render `<GroupList>` in both branches → the fresh-browser test fails.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/browseView.ts packages/web/src/components/ViewToggle.tsx \
        packages/web/src/routes/Browse.tsx packages/web/test/browseView.test.tsx \
        packages/web/test/ViewToggle.test.tsx packages/web/test/Browse.test.tsx
git commit -m "Let Browse hold two views and remember which one, so a reader can scan a long library or read one group in full"
```

---

## Task 4: The layout, and a browser to prove it

**Files:**
- Create: `packages/web/src/styles/browse.css`
- Modify: `packages/web/src/styles/base.css` (`.app`'s cap in split view)
- Modify: `packages/web/src/styles/index.css` (import)
- Create: `packages/e2e/tests/browse-split.spec.ts`

**Interfaces:** consumes Task 3's class names — `.browse-controls`, `.browse-split`, `.browse-detail`, `.browse-detail-empty`, `.group-list`, `.group-row`, `.group-row-selected`, `.group-row-title`, `.group-row-meta`, `.group-row-upgrade`, `.view-toggle`. Produces nothing.

**Read `packages/web/src/styles/index.css` first** to see how the existing files are imported and in what order, and follow it. The cascade layers matter: phase 1 put `@layer tokens, base, components` in a specific position and a previous phase broke the cascade by moving it.

**The two constraints this task exists to honour**, both from spec §6:

`.app` is `display: flex; gap: var(--space-5); max-width: 60rem` — the row holding `<nav>` and `<main>`. Its cap rises to `90rem` in split view; the nav's width is intrinsic, so the extra space lands in `<main>`. Drive it off an attribute or class the route sets, not off a media query — the view is a preference, not a viewport.

**Neither pane gets its own scrollbar, and that is a constraint, not a preference.** `usePagedList` observes its sentinel with an `IntersectionObserver` whose root is the viewport (`ROOT_MARGIN = '200px'`, no `root` option). Give the master list `overflow-y: auto` and the sentinel stops entering the viewport as that container scrolls, so **paging silently stops**. The page scrolls, as today, and `.browse-detail` is `position: sticky` so it stays in view while the list scrolls past. If you find yourself adding `overflow` to either pane, stop — you are about to break paging in a way no unit test will catch.

- [ ] **Step 1: Write the styles**

Create `packages/web/src/styles/browse.css`:

```css
/* The switcher sits in the row that already holds the search box, because both
   are controls over the same list. */
.browse-controls { display: flex; align-items: center; gap: var(--space-4); margin-bottom: var(--space-4); }
.browse-controls .search { flex: 1; }

.view-toggle { display: flex; gap: var(--space-3); border: none; margin: 0; padding: 0; }
.view-toggle label { display: flex; align-items: center; gap: var(--space-1); color: var(--color-text-dim); font-size: var(--text-meta); }

/* A fixed list pane and an elastic detail pane. 22rem holds a title over two
   lines before it wraps, and leaves the detail pane wider than the 60rem column
   the card renders in today. */
.browse-split { display: flex; align-items: flex-start; gap: var(--space-5); }
.group-list { flex: none; width: 22rem; margin: 0; padding: 0; list-style: none; }

/* Sticky rather than scrollable, and the reason is load-bearing:
   `usePagedList` observes its sentinel against the viewport, so a pane with its
   own `overflow` would stop the sentinel ever entering it and paging would
   silently stop. The page scrolls; this stays put while it does. `--space-4`
   matches `.app`'s own padding, so the pane's top aligns with the window edge
   rather than floating below it. */
.browse-detail { flex: 1; min-width: 0; position: sticky; top: var(--space-4); }
.browse-detail-empty { color: var(--color-text-dim); font-size: var(--text-meta); font-style: italic; }

.group-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.group-row:hover { background: var(--color-surface-2); }
.group-row-selected { background: var(--color-surface-2); box-shadow: inset 2px 0 0 var(--color-accent); }
.group-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-row-meta { flex: none; color: var(--color-text-dim); font-size: var(--text-meta); }
/* The separator between the parts that are present, drawn between adjacent
   siblings so a group with no studio renders no leading ` · `. Same treatment
   as the card's context line. */
.group-row-meta > span + span::before { content: ' · '; color: var(--color-text-faint); }
.group-row-upgrade { flex: none; color: var(--color-accent-text); }
```

- [ ] **Step 2: Widen the shell in split view**

In `Browse.tsx`, set an attribute on the section so CSS can key off the view:

```tsx
    <section data-browse-view={view}>
```

In `base.css`, beside the existing `.app` rule:

```css
/* Split view divides `<main>` between two panes, and 60rem is not enough for
   both: the detail pane would land near 600px, and after the card's 98px
   artwork and its gap that is a text column near 490px — the width at which
   `card.css` records the synopsis's `68ch` cap stopping binding, and the regime
   its `card-layout` guard does not cover. Keyed off the view rather than a media
   query because the view is a preference: a reader in the card list gets the
   60rem column at any window size. */
.app:has([data-browse-view='split']) { max-width: 90rem; }
```

Add the import to `index.css` in the position that file's own ordering dictates.

- [ ] **Step 3: Verify the layout in a browser, and look at it**

Run: `npm run e2e` once to confirm nothing existing broke, then write the spec below. Before you do, actually look at the rendered split view — take a screenshot in a scratch Playwright call and **open it** — and report: does a real synopsis read at the detail pane's width, does the sticky pane behave when the list scrolls, and does the selected row read as selected. If any needs a rule, add it and say why. Delete the scratch script.

- [ ] **Step 4: Write the e2e spec**

Create `packages/e2e/tests/browse-split.spec.ts`, following the fixture and harness pattern in `packages/e2e/tests/card-layout.spec.ts` — read it first; do not invent a second way to seed groups. Assert:

```ts
// The card list is what a fresh browser gets.
await expect(page.locator('article.media-card')).toHaveCount(2);
await expect(page.getByRole('listbox', { name: 'Groups' })).toHaveCount(0);

// Switching shows the list and an empty pane.
await page.getByRole('radio', { name: 'Split' }).click();
await expect(page.getByRole('listbox', { name: 'Groups' })).toBeVisible();
await expect(page.locator('article.media-card')).toHaveCount(0);

// A row fills the pane, and the pane's heading matches the row.
await page.getByRole('option').first().click();
await expect(page.locator('article.media-card')).toHaveCount(1);

// The keyboard moves the selection — the part happy-dom is least trustworthy
// for, and phase 1.8 found a real focus bug here that only a browser saw.
await page.keyboard.press('ArrowDown');
// ...assert the second row is now selected and the pane followed.

// The choice survives a reload.
await page.reload();
await expect(page.getByRole('listbox', { name: 'Groups' })).toBeVisible();

// The shell widened, and only in split view.
```

Write each assertion out fully against the real harness. For the widening, compare `.app`'s bounding box between the two views rather than reading the CSS.

- [ ] **Step 5: Run the gate, and check the warning count**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e` (redirected; grep the file).
Then: `npm run lint >/tmp/l.log 2>&1; grep -c ': warning ' /tmp/l.log` — **must be 125**. Count it with `': warning '`, not a bare `warning`: a server test's name contains the word and inflates a naive count.

- [ ] **Step 6: Mutation-test the layout constraints**

1. Give `.group-list` `overflow-y: auto` → report what happens to paging in the browser. This is the constraint the task exists to protect and it may fail nothing automatically; if so, say that plainly rather than claiming coverage.
2. Remove `position: sticky` from `.browse-detail` → report whether any assertion catches it.
3. Remove the `.app:has(...)` rule → the widening assertion fails.
4. Remove `.group-row-meta > span + span::before` → the row reads run-together; report whether an assertion catches it, and add one if not.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/styles/browse.css packages/web/src/styles/base.css \
        packages/web/src/styles/index.css packages/e2e/tests/browse-split.spec.ts
git commit -m "Lay the split view out as a fixed list beside a sticky pane, so scrolling for more groups does not carry the card off screen"
```

---

## Self-review against the spec

**Spec coverage.** §1's detail-pane-is-`MediaCard`: Task 3's `cardFor`, used by both views. §1.1's four exclusions: nothing in any task adds URL state, an endpoint, a paging change or a Picks abstraction, and Task 4 step 6 mutation 1 exists to protect the paging one. §3's row contents: Task 2, every part tested. §3's listbox and keyboard: Task 2, six mutations. §3's sentinel placement: Task 3 step 5. §4's selection-as-id and derivation: Task 3 step 5, with the clearing effect. §4's nothing-selected-on-arrival: Task 3's empty-state test. §5's extraction: Task 1. §6's widening and the sticky pane: Task 4 steps 1-2, with the `IntersectionObserver` reason stated at both the spec and the CSS. §7's preference and its `try`/`catch`: Task 3, including a test that stubs a throwing `localStorage`. §8's test list: distributed. §9's risks: the narrow-window and tall-pane ones are recorded, not actioned — they are judgements use will settle.

**One deliberate non-code step.** Task 4's step 3 is look-at-it-and-report, because the detail pane's width is the one thing in this phase that cannot be settled on paper — the same class of item phase 2 handled the same way, and the same one whose measurement phase 2 recorded in a comment rather than a test. Everything else in every task is executable code.

**One thing to verify rather than trust.** Task 3's `Browse.test.tsx` additions call `getByLabelText('Search groups')`, which assumes `SearchBox` exposes its `label` prop as an accessible label. `Browse` passes that string today; the step says to check it against the DOM before relying on it.

**Type consistency.** `BrowseView`, `readView`, `writeView`, `ViewToggle`, `GroupList`, `groupTitle` and `text` keep their names across every task that uses them. `GroupList`'s props are `groups`/`selectedId`/`onSelect` in Task 2's definition, Task 2's tests and Task 3's call site. `cardFor` is introduced and used only in Task 3.
