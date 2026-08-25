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

test('the dialog can take focus, which the disabled-button focus fix depends on', () => {
  render(<ImageModal images={THREE} startIndex={0} onClose={() => {}} />);
  // Not a behavioural test: happy-dom does not blur a focused element when it
  // becomes `disabled` (confirmed directly, see `ImageModal.tsx`'s own
  // comment on the effect this guards), so the failure this fixes cannot be
  // reproduced here at all — only in `metadata-modal.spec.ts`, in a real
  // browser. What this pins is the one precondition the fix depends on:
  // `element.focus()` in the dialog's own effect only does anything because
  // the dialog is `tabIndex={-1}`. A refactor that dropped the attribute
  // while leaving the effect in place would silently reopen the bug with
  // nothing here to catch it.
  assert.equal(screen.getByRole('dialog').getAttribute('tabindex'), '-1');
});

// No Escape test here. happy-dom implements `showModal()` but not
// Escape-to-close: an open dialog given a bubbling, cancelable Escape keydown
// stays open and fires neither `cancel` nor `close`. A test asserting the
// modal closes would fail against correct code; one asserting it stays open
// would pass against broken code. Escape is covered in
// `packages/e2e/tests/metadata-modal.spec.ts`, in a real browser.
