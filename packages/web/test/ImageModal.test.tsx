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

// No test that the dialog carries `tabIndex={-1}`, because it does not carry
// one any more. The attribute existed to guarantee `element.focus()` a target
// when the reclaim effect fell back to the dialog; the fallback is now
// `.image-modal-close`, which is always rendered and focusable everywhere with
// no `tabindex` at all, so there is nothing left for the attribute to insure.

test('a one-image list hands reclaimed focus to the close button', () => {
  render(<ImageModal images={ONE} startIndex={0} onClose={() => {}} />);
  // The shape that actually reaches the reclaim effect's fallback, and the only
  // one that can (see `ImageModal.tsx`): no browse chrome means neither browse
  // ref is set. Observable here only because happy-dom's `showModal()` leaves
  // focus outside the dialog, which is what sends this render through the
  // fallback at all — in a real browser `showModal()` has already put focus on
  // this same button before the effect runs.
  //
  // This is what keeps the fallback from failing silently. The effect focuses
  // `closeButton.current` with optional chaining, so a refactor that dropped
  // `ref={closeButton}` from the button would reclaim nothing at all and throw
  // nothing either — and the e2e reclaim test walks a two-image list, where
  // `target` is a real browse button and the fallback never engages. Without
  // this test that regression has nowhere to show up.
  // A boolean with its own message, not `assert.equal` on the two nodes: see
  // `gone()` in `./dom.ts` for why, and `scripts/check-test-hygiene.ts` for
  // what now stops it coming back.
  assert.ok(
    document.activeElement === screen.getByRole('button', { name: /close/i }),
    'a one-image list must reclaim focus to the close button',
  );
});

test('the failure text carries a status role and describes the image whose alt still claims it loaded', () => {
  render(<ImageModal images={THREE} startIndex={1} onClose={() => {}} />);
  // Nothing to point at while the image is fine: a description referring to an
  // element that is not rendered describes nothing.
  assert.ok(!screen.getByRole('img').hasAttribute('aria-describedby'));

  fireEvent.error(screen.getByRole('img'));
  const failure = screen.getByText(/could not be loaded/i);
  // `role="status"` because this text appears on `onError`, with no user action
  // to prompt a re-read.
  //
  // Titled for what this pins rather than for the outcome, because the two are
  // not the same here. The `<p>` enters the DOM *with* its text already in it,
  // and a live region created and populated in one go is the case NVDA and
  // JAWS handle unreliably; the pattern they honour is a region already in the
  // tree whose contents then change, which is what `.image-modal-caption` is
  // and this is not. Rendering this `<p>` unconditionally — present and empty
  // until `failed` — would make the announcement reliable, and is deliberately
  // not done in this wave. `aria-describedby` below is the half that works
  // regardless.
  assert.equal(failure.getAttribute('role'), 'status');
  // And attached to the image, because the image's `alt` cannot be emptied to
  // tell the truth on its own: an empty alt drops the element out of the
  // accessibility tree as an `img`, which is the role `shown()` above and
  // `metadata-modal.spec.ts` both find it by.
  assert.ok(failure.id !== '', 'the failure text needs an id to be referenced by');
  assert.equal(screen.getByRole('img').getAttribute('aria-describedby'), failure.id);
});

test('the caption is announced, not merely rendered, when the browse moves', () => {
  render(<ImageModal images={THREE} startIndex={0} onClose={() => {}} />);
  // A step that lands on an end reclaims focus to the opposite button, so a
  // screen-reader user can be nowhere near this text when it changes — and it
  // is the only thing that says which image is now shown.
  assert.equal(screen.getByText('Poster · 1 of 3').getAttribute('role'), 'status');
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  assert.equal(screen.getByText('Background · 2 of 3').getAttribute('role'), 'status');
});

// No Escape test here. happy-dom implements `showModal()` but not
// Escape-to-close: an open dialog given a bubbling, cancelable Escape keydown
// stays open and fires neither `cancel` nor `close`. A test asserting the
// modal closes would fail against correct code; one asserting it stays open
// would pass against broken code. Escape is covered in
// `packages/e2e/tests/metadata-modal.spec.ts`, in a real browser.
