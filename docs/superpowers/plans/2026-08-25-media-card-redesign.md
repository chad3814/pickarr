# Media Card Image Slot and Browsable Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the card a 2:3 image slot holding the poster or a performer portrait, and make every image a group has reachable through a browsable modal.

**Architecture:** One pure function derives a group's ordered image list from booleans the SPA already holds; a second derives the slot's own image by a deliberately different rule. `ImageModal` grows an index and controls so both the card slot and a performer avatar open the same list at different points. No server change, no schema change.

**Tech Stack:** React 19, TypeScript, `node:test` + happy-dom for the web suite, Playwright for e2e. No new dependency.

**Spec:** `docs/superpowers/specs/2026-08-25-media-card-redesign-design.md`

## Global Constraints

- The TypeScript `any` type is banned. Never introduce it, not even in tests.
- Prefer async APIs over sync twins. Nothing in this plan does I/O, so this bites only if you reach for one.
- `docs/superpowers/` is a historical record of specs and plans. Never edit a file under it, even when the code diverges from what it says.
- Comments are documentation in this codebase. A comment that is false about the code beside it is a defect equal to a wrong line of code. Do not leave a comment describing a consumer, a caller, or a behaviour that your change removed.
- An assertion message must not claim more than its assertion establishes.
- **Test-suite split, and it is not what the file extension suggests.** `test:server` globs `packages/*/test/**/*.test.ts` and `test:web` globs `packages/web/test/**/*.test.tsx`. A `.test.ts` file placed in `packages/web/test/` therefore runs in the **server** suite — no happy-dom, no DOM globals, and not under the web tsconfig. `packages/web/test/format.test.ts` and `search.test.ts` already work this way. Put DOM tests in `.test.tsx`, pure-function tests in `.test.ts`.
- **Never `assert.equal(screen.queryBy*(...), null)`.** `node:assert` deep-inspects a live DOM element to build its failure message, which burns ~75 seconds and takes the whole file down without naming a test. Write `assert.ok(!screen.queryBy*(...))`. The existing files mark this rule `#40`; obey it in every line you add.
- Commit messages: one full declarative sentence saying what changed and why it is better. No `feat:`/`fix:`/`chore:` prefix, no attribution or `Co-Authored-By` trailer. Run `git log -5 --format=%B` to see the house style before writing one.
- Gate every task with `npm run lint && npm run typecheck && npm test && npm run build`. Tasks 2, 3 and 4 additionally run `npm run e2e` — the script is `e2e`, **not** `test:e2e`.
- Baseline at the start of this plan: server 1397 pass, web 278 pass, e2e 21 passed, lint/typecheck/build clean.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/web/src/api/groupImages.ts` | **Create.** The `GroupImage` type, `groupImages()` (the modal's ordered list) and `slotImage()` (the card slot's own choice). Pure; no React import. Lives beside `anchors.ts` and `format.ts`, which are the same kind of thing: derivations from an API view. |
| `packages/web/test/groupImages.test.ts` | **Create.** Server suite (see Global Constraints). Pure-function coverage. |
| `packages/web/src/components/ImageModal.tsx` | **Modify.** Props become `{ images, startIndex, onClose }`; owns the browse index, the controls, the caption and the load-failure frame. |
| `packages/web/src/components/MediaCard.tsx` | **Modify.** Delete the temporary `thumbnail` block; render the slot from `slotImage`; open the modal on `groupImages` from both call sites. |
| `packages/web/src/styles/card.css` | **Modify.** `.poster-thumb` → `.card-artwork`, and the bounded box becomes a cropped 2:3 frame. |
| `packages/web/src/styles/dialog.css` | **Modify.** Prev/next and caption chrome, out of flow. |
| `packages/web/test/ImageModal.test.tsx` | **Modify.** New props; browse, bounds, chrome suppression, failure frame. |
| `packages/web/test/MediaCard.test.tsx` | **Modify.** Rewrite the four image tests; fix the one `#40` violation at :438. |
| `packages/e2e/tests/metadata-modal.spec.ts` | **Modify.** Add the browse flow beside the existing Escape coverage. |

### One deliberate departure from the spec's wording

Spec §4 names the list item's third field `caption`. This plan calls it **`label`**. The caption the user reads is `Background · 2 of 3` — the kind comes from the image, the position comes from the modal's index, and only the modal knows the latter. Naming the image's field `caption` would invite an implementer to put the whole rendered string in it, which cannot be done from `groupImages` because it does not know where in the list the item will be shown. Same data, honest name.

---

## Task 1: The image list and the slot's choice

**Files:**
- Create: `packages/web/src/api/groupImages.ts`
- Test: `packages/web/test/groupImages.test.ts`

**Interfaces:**
- Consumes: `GroupView`, `MetadataView`, `PerformerView` from `packages/web/src/api/client.ts` (type-only imports).
- Produces:
  - `interface GroupImage { src: string; alt: string; label: string }`
  - `function groupImages(group: GroupView): GroupImage[]`
  - `function slotImage(group: GroupView): GroupImage | null`

**Why both functions live in one file:** spec §4 warns that the two rules look similar enough to be collapsed, and that collapsing them reintroduces the cropping this phase removes. Side by side in one small file, the difference is visible to anyone editing either.

**A type fact you need before writing this.** In `client.ts`, `hasPoster` and `hasBackground` are members of the `state: 'confirmed'` variant of the `MetadataView` union, while `performers` sits on `CastView`, outside the union. So the poster and background require narrowing on `metadata.state === 'confirmed'`, and the cast does not. This is not an inconvenience to work around — it is the type system stating that a group with no scene answer has no scene artwork, while it may well have a cast.

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/groupImages.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupImages, slotImage } from '../src/api/groupImages.ts';
import type { GroupView, MetadataView, PerformerView } from '../src/api/client.ts';

const BASE: GroupView = {
  id: 7,
  plugin: 'scenes',
  display: { title: 'Alpha Scene', fields: [] },
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
  title: null,
  releaseDate: null,
  durationSeconds: null,
  synopsis: null,
  hasPoster: false,
  hasBackground: false,
} satisfies Extract<MetadataView, { state: 'confirmed' }>;

function performer(over: Partial<PerformerView>): PerformerView {
  return { id: 1, name: 'Alice Maze', url: 'https://example/alice', hasAvatar: true, hasImage: true, ...over };
}

test('the list runs poster, background, then each performer with a full image', () => {
  const images = groupImages(
    withMetadata({
      ...CONFIRMED,
      hasPoster: true,
      hasBackground: true,
      performers: [performer({ id: 4, name: 'Alice Maze' }), performer({ id: 5, name: 'Bea Vale' })],
    }),
  );
  assert.deepEqual(
    images.map((image) => image.src),
    [
      '/api/groups/7/poster',
      '/api/groups/7/background',
      '/api/performers/4/image',
      '/api/performers/5/image',
    ],
  );
});

test('a performer with no full image is not in the list', () => {
  const images = groupImages(
    withMetadata({ ...CONFIRMED, performers: [performer({ id: 4, hasImage: false })] }),
  );
  assert.deepEqual(images, []);
});

test('each image carries its own alt text, so a portrait is never announced as a poster', () => {
  const images = groupImages(
    withMetadata({
      ...CONFIRMED,
      hasPoster: true,
      hasBackground: true,
      performers: [performer({ id: 4, name: 'Alice Maze' })],
    }),
  );
  // Literals, not values read back from the fixture: both ends agreeing on a
  // wrong string is the failure this style of assertion exists to catch.
  assert.deepEqual(
    images.map((image) => image.alt),
    ['Poster for Alpha Scene', 'Background for Alpha Scene', 'Alice Maze'],
  );
  assert.deepEqual(images.map((image) => image.label), ['Poster', 'Background', 'Alice Maze']);
});

test('a group with no scene answer still lists its performers', () => {
  // `performers` sits outside the state union on purpose: the performer search
  // exists for groups whose scene lookup settled without a cast.
  const images = groupImages(withMetadata({ state: 'none', performers: [performer({ id: 9 })] }));
  assert.deepEqual(images.map((image) => image.src), ['/api/performers/9/image']);
});

test('a group with nothing has an empty list and no slot image', () => {
  assert.deepEqual(groupImages(withMetadata({ state: 'absent' })), []);
  assert.equal(slotImage(withMetadata({ state: 'absent' })), null);
});

test('the slot takes the poster when there is one', () => {
  const image = slotImage(withMetadata({ ...CONFIRMED, hasPoster: true, hasBackground: true }));
  assert.equal(image?.src, '/api/groups/7/poster');
});

test('the slot skips the background entirely and falls to the first performer', () => {
  // The asymmetry this whole file exists to keep visible: the modal's list
  // includes the background second, the slot never shows it at all.
  const group = withMetadata({
    ...CONFIRMED,
    hasBackground: true,
    performers: [performer({ id: 4, name: 'Alice Maze' }), performer({ id: 5, name: 'Bea Vale' })],
  });
  assert.equal(slotImage(group)?.src, '/api/performers/4/image');
  assert.equal(groupImages(group)[0]?.src, '/api/groups/7/background');
});

test('the slot takes the first performer in cast order who has a full image', () => {
  const image = slotImage(
    withMetadata({
      ...CONFIRMED,
      performers: [performer({ id: 4, hasImage: false }), performer({ id: 5, name: 'Bea Vale' })],
    }),
  );
  assert.equal(image?.src, '/api/performers/5/image');
});

test('a background with no performer leaves the slot empty rather than cropping it', () => {
  assert.equal(slotImage(withMetadata({ ...CONFIRMED, hasBackground: true })), null);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test:server`
Expected: FAIL — `Cannot find module '../src/api/groupImages.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/api/groupImages.ts`. `GroupImage` is declared in this file, not
imported — `client.ts` mirrors the server's view types and knows nothing about how the SPA
composes them:

```ts
import type { GroupView } from './client.ts';

/**
 * One image a group has, addressed and described.
 *
 * `label` is the image's kind, not the caption the user reads. The modal
 * renders `${label} · ${n} of ${total}`, and the position half is the modal's
 * to know — nothing here can say where in a list an item will be shown.
 */
export interface GroupImage {
  src: string;
  /**
   * What a screen reader announces, per image. A performer portrait must never
   * be announced as the scene's poster: before this existed the card labelled
   * every image `Poster for {title}`, which told a screen-reader user something
   * untrue about what they were looking at.
   */
  alt: string;
  label: string;
}

/**
 * Every image the group has, in browse order: poster, background, then each
 * performer's full image.
 *
 * Composed here rather than fetched, because the SPA already holds every input.
 * The four `has*` booleans and the cast arrive with the group view, so an
 * endpoint would ship the same facts twice and put the order in a second place
 * (spec §4).
 *
 * Poster and background are read only under `state === 'confirmed'`, and that
 * is the type system rather than a precaution: both live inside that variant of
 * `MetadataView`, while `performers` sits outside it. A group with no scene
 * answer has no scene artwork and may still have a cast.
 */
export function groupImages(group: GroupView): GroupImage[] {
  const images: GroupImage[] = [];
  const { metadata } = group;
  const title = group.display.title;

  if (metadata.state === 'confirmed') {
    if (metadata.hasPoster) {
      images.push({
        src: `/api/groups/${group.id}/poster`,
        alt: `Poster for ${title}`,
        label: 'Poster',
      });
    }
    if (metadata.hasBackground) {
      images.push({
        src: `/api/groups/${group.id}/background`,
        alt: `Background for ${title}`,
        label: 'Background',
      });
    }
  }

  for (const performer of metadata.performers ?? []) {
    if (!performer.hasImage) continue;
    images.push({
      src: `/api/performers/${performer.id}/image`,
      alt: performer.name,
      label: performer.name,
    });
  }

  return images;
}

/**
 * The one image the card's slot shows, or `null` for no slot at all.
 *
 * Deliberately **not** `groupImages(group)[0]`, and the difference is the point
 * of this phase. The slot is a fixed 2:3 frame that crops what it is given, so a
 * landscape background in it is the exact outcome the poster/background split
 * was made to end. The modal has no such constraint and lists the background
 * second, so an image the slot refuses is still one click away.
 *
 * A group with a background and no performer therefore draws no slot even though
 * `groupImages` returns one image. That is not an oversight to tidy up later.
 */
export function slotImage(group: GroupView): GroupImage | null {
  const { metadata } = group;

  if (metadata.state === 'confirmed' && metadata.hasPoster) {
    return {
      src: `/api/groups/${group.id}/poster`,
      alt: `Poster for ${group.display.title}`,
      label: 'Poster',
    };
  }

  // Cast order, which is the provider's: `performersForGroups` ends
  // `ORDER BY gp.group_id, gp.position`, so "first" needs no sort here.
  for (const performer of metadata.performers ?? []) {
    if (performer.hasImage) {
      return {
        src: `/api/performers/${performer.id}/image`,
        alt: performer.name,
        label: performer.name,
      };
    }
  }

  return null;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test:server`
Expected: PASS, server count 1397 → 1406 (nine new tests).

- [ ] **Step 5: Mutation-test the two assertions that carry the design**

The asymmetry test and the alt-text test are the two that would let the design regress silently. Prove each fails against broken code:

1. In `slotImage`, add a `hasBackground` branch returning the background before the performer loop. Run `npm run test:server`. Expected: `the slot skips the background entirely…` and `a background with no performer leaves the slot empty…` both FAIL. Revert.
2. In `groupImages`, change the performer `alt` to `` `Poster for ${title}` ``. Run `npm run test:server`. Expected: `each image carries its own alt text…` FAILS. Revert.

Record which test failed for which mutation. A test you did not watch fail is not yet a test.

- [ ] **Step 6: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add packages/web/src/api/groupImages.ts packages/web/test/groupImages.test.ts
git commit -m "Derive a group's image list and its card slot as two separate rules, so the slot can refuse a landscape image the modal still offers"
```

---

## Task 2: ImageModal becomes a browser

**Files:**
- Modify: `packages/web/src/components/ImageModal.tsx`
- Modify: `packages/web/src/components/MediaCard.tsx:84`, `:183`, `:325`, `:426` (call sites only — the slot's own rule is Task 3)
- Modify: `packages/web/src/styles/dialog.css`
- Test: `packages/web/test/ImageModal.test.tsx`

**Interfaces:**
- Consumes: `GroupImage`, `groupImages` from Task 1.
- Produces: `ImageModal` with props `{ images: readonly GroupImage[]; startIndex: number; onClose: () => void }`.

**Scope discipline for this task.** The card's *source order* does not change here. Both of `MediaCard`'s existing modal call sites keep opening the image they open today; they are edited only enough to pass the new prop shape, by wrapping their single image in a one-element list. The user sees no behaviour change from this task, which is what makes it reviewable on its own. Task 3 changes what the card shows.

**A CSS trap, documented in the file you are about to edit.** `.image-modal-close` is `position: absolute` and the comment above it says why: as an in-flow sibling above the image it "spent its own height out of the 100vh the image is trying to fit inside, so the bottom of a tall image landed just past the viewport — the box was right and the image still did not fit." Prev/next buttons and the caption have the identical hazard. **Put all new chrome out of flow.** If you instead make the image shorter to leave room, say so and why in a comment, because you will have reversed a decision that file argues for.

- [ ] **Step 1: Write the failing tests**

Replace the body of `packages/web/test/ImageModal.test.tsx` below the `afterEach(cleanup)` line. Keep the file's existing header comment and the trailing Escape comment — the latter is still true and still load-bearing.

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ImageModal } from '../src/components/ImageModal.tsx';
import type { GroupImage } from '../src/api/groupImages.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of the modal, turning one real failure into a cascade of fake ones.
afterEach(cleanup);

const THREE: GroupImage[] = [
  { src: '/api/groups/7/poster', alt: 'Poster for Alpha', label: 'Poster' },
  { src: '/api/groups/7/background', alt: 'Background for Alpha', label: 'Background' },
  { src: '/api/performers/4/image', alt: 'Alice Maze', label: 'Alice Maze' },
];

const ONE: GroupImage[] = [THREE[0]!];

function shown(): string {
  const src = screen.getByRole('img').getAttribute('src');
  assert.ok(src !== null, 'the modal always shows one image');
  return src;
}

test('the close button closes', () => {
  let closed = false;
  render(<ImageModal images={ONE} startIndex={0} onClose={() => { closed = true; }} />);
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  assert.equal(closed, true);
});

test('a click on the backdrop closes, and one on the image does not', () => {
  let closes = 0;
  render(<ImageModal images={ONE} startIndex={0} onClose={() => { closes += 1; }} />);
  fireEvent.click(screen.getByRole('img'));
  assert.equal(closes, 0, 'clicking the image must not dismiss it');
  fireEvent.click(screen.getByRole('dialog'));
  assert.equal(closes, 1, 'a native modal reports a backdrop click as a click on the dialog');
});

test('it opens on the image the caller asked for, not on the first', () => {
  render(<ImageModal images={THREE} startIndex={2} onClose={() => {}} />);
  assert.equal(shown(), '/api/performers/4/image');
  assert.ok(screen.getByRole('img', { name: 'Alice Maze' }));
});

test('next and previous walk the list', () => {
  render(<ImageModal images={THREE} startIndex={0} onClose={() => {}} />);
  assert.equal(shown(), '/api/groups/7/poster');
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  assert.equal(shown(), '/api/groups/7/background');
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  assert.equal(shown(), '/api/performers/4/image');
  fireEvent.click(screen.getByRole('button', { name: /previous/i }));
  assert.equal(shown(), '/api/groups/7/background');
});

test('the arrow keys walk the list too', () => {
  render(<ImageModal images={THREE} startIndex={0} onClose={() => {}} />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  assert.equal(shown(), '/api/groups/7/background');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
  assert.equal(shown(), '/api/groups/7/poster');
});

test('the list clamps at both ends rather than wrapping', () => {
  render(<ImageModal images={THREE} startIndex={0} onClose={() => {}} />);
  const previous = screen.getByRole('button', { name: /previous/i });
  // Disabled rather than looping: a three-item list that wraps silently gives
  // the user no way to tell where it begins.
  assert.equal(previous.hasAttribute('disabled'), true, 'no previous image at the start');
  fireEvent.click(previous);
  assert.equal(shown(), '/api/groups/7/poster', 'a clamped click moves nothing');

  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  assert.equal(shown(), '/api/performers/4/image');
  assert.equal(screen.getByRole('button', { name: /next/i }).hasAttribute('disabled'), true);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  assert.equal(shown(), '/api/performers/4/image', 'the end does not wrap to the start');
});

test('the caption names the image and its place in the list', () => {
  render(<ImageModal images={THREE} startIndex={1} onClose={() => {}} />);
  assert.ok(screen.getByText('Background · 2 of 3'));
});

test('a one-image list offers no controls that cannot act', () => {
  render(<ImageModal images={ONE} startIndex={0} onClose={() => {}} />);
  // The judgement the card already makes for a performer with no full image:
  // a control that cannot do anything is worse than no control.
  // #40: never `assert.equal(screen.queryByRole(x), null)`.
  assert.ok(!screen.queryByRole('button', { name: /next/i }));
  assert.ok(!screen.queryByRole('button', { name: /previous/i }));
  assert.ok(!screen.queryByText(/1 of 1/));
});

test('an image that will not load says so, keeping its place in the list', () => {
  render(<ImageModal images={THREE} startIndex={1} onClose={() => {}} />);
  fireEvent.error(screen.getByRole('img'));
  assert.ok(screen.getByText(/could not be loaded/i));
  // Kept, not dropped: removing an item mid-browse renumbers everything after
  // it and moves the ground under the user's feet.
  assert.ok(screen.getByText('Background · 2 of 3'));
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  assert.equal(shown(), '/api/performers/4/image', 'the browse continues past a broken image');
});

test('paging away from a broken image and back shows the failure again, not a stale frame', () => {
  render(<ImageModal images={THREE} startIndex={0} onClose={() => {}} />);
  fireEvent.error(screen.getByRole('img'));
  assert.ok(screen.getByText(/could not be loaded/i));
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  assert.equal(shown(), '/api/groups/7/background');
  assert.ok(!screen.queryByText(/could not be loaded/i), 'a new image starts unbroken');
});

// No Escape test here. happy-dom implements `showModal()` but not
// Escape-to-close: an open dialog given a bubbling, cancelable Escape keydown
// stays open and fires neither `cancel` nor `close`. A test asserting the
// modal closes would fail against correct code; one asserting it stays open
// would pass against broken code. Escape is covered in
// `packages/e2e/tests/metadata-modal.spec.ts`, in a real browser.
```

Note the last comment's path: the existing file says `packages/e2e/src/metadata-modal.spec.ts`, and the spec actually lives in `packages/e2e/tests/`. Correct it while you are here.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run test:web`
Expected: FAIL — `ImageModal` does not accept `images`; several tests error on missing controls.

- [ ] **Step 3: Rewrite ImageModal**

Replace `packages/web/src/components/ImageModal.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { GroupImage } from '../api/groupImages.ts';

interface Props {
  images: readonly GroupImage[];
  /** Which image opens. The card slot passes 0; a performer avatar passes its own entry. */
  startIndex: number;
  onClose: () => void;
}

/**
 * A full-size image over the page, browsable when the group has more than one,
 * closed by the X, a click outside, or Escape.
 *
 * Built on a native `<dialog>` opened with `showModal()` rather than a
 * positioned div: that is what makes the rest of the page inert, traps focus
 * inside, restores it on close, and paints a backdrop — four things worth
 * having and none worth hand-rolling.
 *
 * Escape is the browser's, surfaced through `cancel` so the React state that
 * owns "which image is open" is updated rather than left describing a dialog
 * the DOM has already closed. Note that happy-dom does not implement it, so
 * this path is covered by a Playwright spec and not by the unit tests beside
 * this file.
 *
 * The browse index lives here rather than in the card. The card owns *which
 * list* is open and where it starts; how far through it the user has walked is
 * this component's own business, and putting it in the card would make every
 * arrow press a state update on an element that renders a whole article.
 */
export function ImageModal({ images, startIndex, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(startIndex);
  // Reset per image, not per modal: a frame that failed must not keep saying so
  // once the user has paged to a different image that loads perfectly well.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
  }, []);

  const image = images[index];
  const hasPrevious = index > 0;
  const hasNext = index < images.length - 1;

  function step(by: number): void {
    // Clamped rather than wrapped, and clamped here rather than only in the
    // buttons' `disabled`: the arrow keys reach this too, and a keyboard user
    // must not be able to walk off an end a mouse user cannot.
    const next = Math.min(Math.max(index + by, 0), images.length - 1);
    if (next === index) return;
    setIndex(next);
    setFailed(false);
  }

  return (
    <dialog
      ref={dialog}
      className="image-modal"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      // A click on the backdrop of a native modal targets the dialog itself;
      // a click on anything inside targets that child. Comparing the target
      // to the element is the whole of "clicked outside".
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') step(1);
        if (event.key === 'ArrowLeft') step(-1);
      }}
    >
      <button type="button" className="image-modal-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      {/*
        * An image is always rendered, even when it failed, so that the dialog
        * keeps exactly one `img` for a caller to find and the failure is a
        * caption over it rather than a different tree. `alt` still describes
        * what was meant to be there, which is what a screen reader needs when
        * the bytes never arrived.
        */}
      {image !== undefined && (
        <img src={image.src} alt={image.alt} onError={() => setFailed(true)} />
      )}
      {failed && <p className="image-modal-failed">This image could not be loaded</p>}

      {/*
        * Chrome renders only for a list worth walking. One image means no
        * controls and no `1 of 1` — the same judgement the card makes for a
        * performer with a face but no full image: opening a control onto
        * nothing is worse than not offering it.
        */}
      {images.length > 1 && image !== undefined && (
        <div className="image-modal-browse">
          <button type="button" onClick={() => step(-1)} disabled={!hasPrevious} aria-label="Previous image">
            ‹
          </button>
          <p className="image-modal-caption">
            {image.label} · {index + 1} of {images.length}
          </p>
          <button type="button" onClick={() => step(1)} disabled={!hasNext} aria-label="Next image">
            ›
          </button>
        </div>
      )}
    </dialog>
  );
}
```

- [ ] **Step 4: Style the new chrome, out of flow**

Append to `packages/web/src/styles/dialog.css`, after the `.image-modal img` rule:

```css
/* Out of flow for the reason `.image-modal-close` above documents at length:
   in-flow chrome spends its own height out of the 100vh the image is trying to
   fit inside, so a tall image ends up just past the viewport with a box that
   measures correctly. Absolute positioning is what keeps the image's box the
   window. Raw alpha-black and `white`, the same exception `::backdrop` claims:
   these are controls drawn over an image of unknown colour, not over a themed
   surface. */
.image-modal-browse {
  position: absolute;
  bottom: var(--space-3);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-lg);
  background: rgb(0 0 0 / 60%);
  color: white;
}
.image-modal-browse button {
  padding: 0 var(--space-2);
  border: none;
  background: none;
  color: white;
  /* A control dimension, not a type role — same call as `.image-modal-close`. */
  font-size: 1.5rem;
  line-height: 1.5;
  cursor: pointer;
}
.image-modal-browse button:disabled { color: rgb(255 255 255 / 40%); cursor: default; }
.image-modal-caption { margin: 0; white-space: nowrap; }
.image-modal-failed {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  background: rgb(0 0 0 / 70%);
  color: white;
}
```

- [ ] **Step 5: Update MediaCard's call sites, without changing what it shows**

`MediaCard.tsx` holds the modal in one piece of state. Widen that state from `{ src, alt }` to a list plus a start index:

```tsx
  // One piece of state, so the card slot's image and a performer's full image
  // can never both be open at once. Both now open the *same* list, differing
  // only in where they start.
  const [modal, setModal] = useState<{ images: GroupImage[]; startIndex: number } | null>(null);
```

Import the type: `import type { GroupImage } from '../api/groupImages.ts';`

At the slot's `onClick` (currently `setModal({ src: thumbnail, alt: ... })`), and at the performer avatar's `onClick` (currently `setModal({ src: /api/performers/.../image, alt: performer.name })`), wrap the existing single image in a one-element list so behaviour is unchanged:

```tsx
            onClick={() => setModal({
              images: [{ src: thumbnail, alt: `Poster for ${display.title}`, label: 'Poster' }],
              startIndex: 0,
            })}
```

```tsx
                  onClick={() => setModal({
                    images: [{
                      src: `/api/performers/${performer.id}/image`,
                      alt: performer.name,
                      label: performer.name,
                    }],
                    startIndex: 0,
                  })}
```

The render stays `{modal !== null && <ImageModal {...modal} onClose={() => setModal(null)} />}`.

Leave the `TEMPORARY` block and its comment alone — Task 3 deletes them.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`
Expected: PASS throughout. Web count 278 → 285 (ImageModal.test.tsx goes from 3 tests to 10). `MediaCard.test.tsx` must still pass unchanged — if a card test fails here, you changed behaviour this task was supposed to hold still.

- [ ] **Step 7: Mutation-test the browse assertions**

Each of these is a real regression the tests must catch. Break, run `npm run test:web`, note which test failed, revert:

1. `step` wraps instead of clamping (`(index + by + n) % n`). Expected: the clamp test fails on the end-does-not-wrap assertion.
2. Remove `disabled` from both buttons. Expected: the clamp test fails on the `hasAttribute('disabled')` assertions.
3. Render the browse chrome unconditionally (drop `images.length > 1`). Expected: the one-image test fails.
4. Drop `setFailed(false)` from `step`. Expected: `paging away from a broken image and back…` fails.
5. Ignore `startIndex` (`useState(0)`). Expected: `it opens on the image the caller asked for…` fails.
6. Drop the `onError` handler. Expected: `an image that will not load says so…` fails.

If any mutation passes, the assertion is decoration — fix the assertion, not the mutation.

- [ ] **Step 8: Commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
git add packages/web/src/components/ImageModal.tsx packages/web/src/components/MediaCard.tsx \
        packages/web/src/styles/dialog.css packages/web/test/ImageModal.test.tsx
git commit -m "Let the image modal walk a list rather than hold one image, so a group's other images become reachable without leaving the dialog"
```

---

## Task 3: The card slot

**Files:**
- Modify: `packages/web/src/components/MediaCard.tsx` (delete the `TEMPORARY` block; render from `slotImage`; open `groupImages`)
- Modify: `packages/web/src/styles/card.css:77`, `:82`, `:92`
- Test: `packages/web/test/MediaCard.test.tsx`

**Interfaces:**
- Consumes: `groupImages`, `slotImage`, `GroupImage` from Task 1; `ImageModal`'s `{ images, startIndex, onClose }` from Task 2.
- Produces: nothing further tasks import. This is the phase's user-visible deliverable.

- [ ] **Step 1: Write the failing tests**

In `packages/web/test/MediaCard.test.tsx`, replace the four image tests (currently at :397, :408, :419, :432) and the performer-avatar test at :467 with these. Add `import type { PerformerView } from '../src/api/client.ts';` if it is not already imported, and a helper beside the existing ones:

```tsx
function performer(over: Partial<PerformerView>): PerformerView {
  return { id: 4, name: 'Alice Maze', url: 'https://example/alice', hasAvatar: true, hasImage: true, ...over };
}
```

```tsx
test('the slot is a button that opens the modal, and the modal closes', () => {
  render(<MediaCard group={withMetadata({ hasPoster: true })} onPick={() => {}} />);
  // #40: never `assert.equal(screen.queryByRole(x), null)` — same deep-inspect
  // hazard as `queryByText`, on a live element instead of text.
  assert.ok(!screen.queryByRole('dialog'));
  fireEvent.click(screen.getByRole('button', { name: /poster for/i }));
  assert.ok(screen.getByRole('dialog'));
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  assert.ok(!screen.queryByRole('dialog'));
});

test('the slot shows the poster when there is one', () => {
  render(
    <MediaCard group={withMetadata({ hasPoster: true, hasBackground: true })} onPick={() => {}} />,
  );
  assert.equal(
    screen.getByRole('img', { name: 'Poster for Alex Coal' }).getAttribute('src'),
    '/api/groups/1/poster',
  );
});

test('a background alone draws no slot, because a 2:3 frame would crop it', () => {
  render(
    <MediaCard group={withMetadata({ hasPoster: false, hasBackground: true, performers: [] })}
               onPick={() => {}} />,
  );
  // The background is not gone — it is in the modal's list (see
  // groupImages.test.ts). It is only refused *this* frame.
  // #40: never `assert.equal(screen.queryByRole(x), null)`.
  assert.ok(!screen.queryByRole('img', { name: /for Alex Coal/i }));
});

test('with no poster the slot falls to the first performer portrait', () => {
  render(
    <MediaCard
      group={withMetadata({
        hasPoster: false,
        hasBackground: true,
        performers: [performer({ id: 4, name: 'Alice Maze' }), performer({ id: 5, name: 'Bea Vale' })],
      })}
      onPick={() => {}}
    />,
  );
  const slot = card('Alex Coal').querySelector('.card-artwork img');
  assert.equal(slot?.getAttribute('src'), '/api/performers/4/image');
  // Announced as the performer, never as the scene's poster.
  assert.equal(slot?.getAttribute('alt'), 'Alice Maze');
});

test('neither image means no slot at all, as before', () => {
  // `performerNames: []` is load-bearing, not tidying. `CONFIRMED` carries
  // `performerNames: ['Alex Coal', 'Jane Doe']`, and 'Alex Coal' is also the
  // group's title — so with an empty `performers` the legacy names list renders
  // an `<li>Alex Coal</li>`, and `card()`'s `getByText` then matches both it and
  // the `<h2>` and throws on the ambiguity. Emptying both lists renders no cast
  // at all, which is what this test is about anyway.
  render(
    <MediaCard
      group={withMetadata({ hasPoster: false, hasBackground: false, performers: [], performerNames: [] })}
      onPick={() => {}}
    />,
  );
  // #40 again: this assertion used to be `assert.equal(screen.queryByRole(...), null)`,
  // which is the exact deep-inspect hazard the comments in this file forbid.
  assert.ok(!card('Alex Coal').querySelector('.card-artwork'));
});

test('the slot renders for a group whose scene lookup returned nothing', () => {
  // The slot follows the images, not the scene answer. The cast list already
  // renders at any state; gating the slot produced cards that named a
  // performer they would not show.
  render(
    <MediaCard
      group={{ ...GROUP, metadata: { state: 'none', performers: [performer({ id: 4 })] } }}
      onPick={() => {}}
    />,
  );
  assert.equal(
    card('Alex Coal').querySelector('.card-artwork img')?.getAttribute('src'),
    '/api/performers/4/image',
  );
});

test('the slot opens the modal on the whole list, starting at the scene image', () => {
  render(
    <MediaCard
      group={withMetadata({
        hasPoster: false,
        hasBackground: true,
        performers: [performer({ id: 4, name: 'Alice Maze' })],
      })}
      onPick={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Alice Maze' }));
  const dialog = screen.getByRole('dialog');
  // Index 0 is the background, which is not what was clicked. Deliberate: the
  // browse runs from the scene's own images outward.
  assert.equal(dialog.querySelector('img')?.getAttribute('src'), '/api/groups/1/background');
  assert.ok(screen.getByText('Background · 1 of 2'));
});

test('a performer avatar opens the same list at that performer', () => {
  render(
    <MediaCard
      group={withMetadata({
        hasPoster: true,
        performers: [performer({ id: 4, name: 'Alice Maze' }), performer({ id: 5, name: 'Bea Vale' })],
      })}
      onPick={() => {}}
    />,
  );
  // Two sizes exist for a reason: the avatar is a face crop, the modal wants
  // the full image.
  fireEvent.click(screen.getAllByRole('button', { name: 'Bea Vale' })[0]!);
  assert.equal(
    screen.getByRole('dialog').querySelector('img')?.getAttribute('src'),
    '/api/performers/5/image',
  );
  assert.ok(screen.getByText('Bea Vale · 3 of 3'));
});
```

Note: the slot and the avatar can both be a button named for the same performer, which is why the avatar test uses `getAllByRole(...)[0]`. If that ambiguity makes a test brittle, scope the query with `within(...)` rather than renaming a control to dodge it.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run test:web`
Expected: FAIL — no `.card-artwork` element exists; the slot still labels everything `Poster for …`; the modal opens one image rather than a list.

- [ ] **Step 3: Replace the TEMPORARY block with the slot**

In `MediaCard.tsx`, delete the whole `thumbnail` const and the `TEMPORARY, and phase 2b deletes it deliberately` comment above it (currently :97-117). Put in their place:

```tsx
  // Two rules, deliberately different, and both stated in `groupImages.ts`:
  // the slot is a fixed 2:3 frame that crops, so it refuses a landscape
  // background; the modal has no such constraint and lists it. An image the
  // slot will not show is one click away rather than gone.
  const slot = slotImage(group);
  const images = groupImages(group);
```

Import them: `import { groupImages, slotImage } from '../api/groupImages.ts';`

Replace the slot's JSX (currently :321-329):

```tsx
        {slot !== null && (
          <button
            type="button"
            className="card-artwork"
            onClick={() => setModal({ images, startIndex: 0 })}
          >
            <img src={slot.src} alt={slot.alt} />
          </button>
        )}
```

Change the performer avatar's `onClick` to open the same list at that performer:

```tsx
                  onClick={() => setModal({
                    images,
                    startIndex: images.findIndex(
                      (image) => image.src === `/api/performers/${performer.id}/image`,
                    ),
                  })}
```

That `findIndex` cannot return `-1` here: the button only renders under `performer.hasImage`, which is the same condition `groupImages` includes the entry under. Say so in a comment rather than adding a guard that can never fire — but if you find a path where it can, guard it and report that instead.

- [ ] **Step 4: Make the slot a cropped 2:3 frame**

In `packages/web/src/styles/card.css`, rename the class and change the box:

```css
/* Only the interactive thumbnails get the pointer cursor: `button.avatar-thumb`
   (has a full image behind it) rather than `.avatar-thumb` by class alone,
   which would also match the plain `<img class="avatar-thumb">` shown for a
   performer with a face and no full image. */
.card-artwork, button.avatar-thumb { padding: 0; border: none; background: none; cursor: pointer; }
```

```css
.card-artwork { flex: none; }
```

```css
/* A fixed 2:3 frame that crops, not a box that bounds. Bounded by
   `max-width`/`max-height`, a landscape image rendered 6rem wide and about
   3.4rem tall — a wide, short band in a column sized for a portrait. The slot
   only ever receives a poster or a performer portrait now (see
   `groupImages.ts`), so cropping is what makes every card's frame the same
   shape. 9rem is 1rem taller than the old bound; this is the card's only
   image. */
.card-artwork img {
  display: block;
  width: 6rem;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
}
```

Grep for any other `poster-thumb` occurrence before you finish: `grep -rn "poster-thumb" packages/ --include='*.ts' --include='*.tsx' --include='*.css'`. Expected after this step: no matches.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`
Expected: PASS. Web count 285 → 288 (four image tests become seven, plus the avatar test stays one). If `card-layout.spec.ts` fails, read it — it may assert the old geometry, and if so its assertion needs updating to the new frame rather than the frame changing to suit it.

- [ ] **Step 6: Mutation-test the slot's rules**

Break, run `npm run test:web`, note the failure, revert:

1. `const slot = images[0] ?? null;` — the collapse spec §4 warns about. Expected: `a background alone draws no slot…` and `with no poster the slot falls to the first performer portrait` both fail.
2. Gate the slot on `metadata.state === 'confirmed'`. Expected: `the slot renders for a group whose scene lookup returned nothing` fails.
3. Slot `alt` back to `` `Poster for ${display.title}` ``. Expected: `with no poster the slot falls to…` fails on the alt assertion.
4. `startIndex: 0` for the performer avatar. Expected: `a performer avatar opens the same list at that performer` fails.
5. `object-fit: contain` in the CSS. Expected: **no test fails** — and that is the honest result to report, not a gap to paper over. The crop is a visual property no unit test reaches; spec §9 already records that only eyes on the real library can judge it.

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
git add packages/web/src/components/MediaCard.tsx packages/web/src/styles/card.css \
        packages/web/test/MediaCard.test.tsx
git commit -m "Fill the card's slot with a poster or a performer portrait, so a landscape image stops being cropped into a frame built for a portrait"
```

---

## Task 4: The browse flow in a real browser

**Files:**
- Modify: `packages/e2e/tests/metadata-modal.spec.ts`

**Interfaces:**
- Consumes: the finished UI from Task 3. Produces nothing.

**Why this task exists separately.** happy-dom implements `showModal()` but not Escape-to-close, which is why `ImageModal.test.tsx` has no Escape test and says so. The browse is the same shape of risk one level up: focus behaviour, key handling on a real `<dialog>`, and whether the chrome is actually clickable over the image are all things only a browser answers.

- [ ] **Step 1: Read the existing spec and its harness**

```bash
cat packages/e2e/tests/metadata-modal.spec.ts
cat packages/e2e/src/harness.ts
```

Follow whatever fixture pattern that file already uses to seed a group with metadata — do not invent a second way to set up an e2e database. The group you need has **no poster, a background, and one performer with a full image**, which is the shape 1,494 of the real library's groups have.

- [ ] **Step 2: Write the failing spec**

Add to `packages/e2e/tests/metadata-modal.spec.ts`, using that file's own fixture helpers:

```ts
test('the modal walks a group\'s images and clamps at the ends', async ({ page }) => {
  // Seeded with no poster, a background, and one performer portrait — the
  // shape almost every real group has, and the reason the browse exists.
  await page.goto('/');
  await page.getByRole('button', { name: /alice maze/i }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Opens on the scene's own image, not on the portrait that was clicked.
  await expect(dialog.getByText('Background · 1 of 2')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /previous/i })).toBeDisabled();

  await dialog.getByRole('button', { name: /next/i }).click();
  await expect(dialog.getByText('Alice Maze · 2 of 2')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /next/i })).toBeDisabled();

  // The keyboard reaches the same clamp a mouse does.
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByText('Alice Maze · 2 of 2')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByText('Background · 1 of 2')).toBeVisible();

  // Escape still closes, which is the thing the unit suite cannot check.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
```

- [ ] **Step 3: Run it and watch it fail, then pass**

Run: `npm run e2e`
Run the spec before the seed exists to confirm it fails for the right reason (no such group / no such control), then once seeded confirm it passes. A spec that has never failed proves nothing.

- [ ] **Step 4: Commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
git add packages/e2e/tests/metadata-modal.spec.ts
git commit -m "Drive the image browse in a real browser, so the key handling and the clamp are checked where happy-dom cannot reach"
```

---

## Self-review against the spec

**Spec coverage.** §3 the slot: Task 3 (geometry step 4, source order step 3, absence and state in step 1's tests). §3.1 both renames: Task 3 step 4 (`.card-artwork`) and Task 1 plus Task 3 (per-image alt). §4 the list, and the slot-is-not-`images[0]` warning: Task 1, pinned by a test and by mutation 1 in Task 3 step 6. §5 the modal: Task 2 in full — props, index ownership, clamping, single-image chrome suppression, caption. §6 the lying boolean: Task 2 step 1's two failure tests and step 3's `failed` state. §7 deletion of the temporary block: Task 3 step 3. §8 testing: distributed, with the suite split stated in Global Constraints. §9 risks: mutation 5 in Task 3 step 6 deliberately records that no test reaches the crop, rather than pretending otherwise.

**Type consistency.** `GroupImage { src, alt, label }` is defined in Task 1 and used with those three fields in Tasks 2 and 3. `groupImages(group)` and `slotImage(group)` keep those names throughout. `ImageModal`'s props are `{ images, startIndex, onClose }` in Task 2's implementation, Task 2's tests, and Task 3's call sites. The card's modal state is `{ images, startIndex }` in both tasks that touch it.

**Known gap, stated rather than hidden.** Task 4's spec code is written against fixture helpers this plan has not read, because the seeding pattern lives in `packages/e2e/src/harness.ts` and belongs to that file rather than to a guess made here. Step 1 is a read step for exactly that reason: the assertions are the deliverable, the seeding must follow the house pattern.
