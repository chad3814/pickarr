import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ImageModal } from '../src/components/ImageModal.tsx';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of the modal, turning one real failure into a cascade of fake ones.
afterEach(cleanup);

test('the close button closes', () => {
  let closed = false;
  render(<ImageModal src="/a.png" alt="A" onClose={() => { closed = true; }} />);
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  assert.equal(closed, true);
});

test('a click on the backdrop closes, and one on the image does not', () => {
  let closes = 0;
  render(<ImageModal src="/a.png" alt="A" onClose={() => { closes += 1; }} />);
  fireEvent.click(screen.getByRole('img'));
  assert.equal(closes, 0, 'clicking the image must not dismiss it');
  fireEvent.click(screen.getByRole('dialog'));
  assert.equal(closes, 1, 'a native modal reports a backdrop click as a click on the dialog');
});

test('the image is labelled and scaled to fit rather than cropped', () => {
  render(<ImageModal src="/a.png" alt="Poster for Alpha" onClose={() => {}} />);
  assert.ok(screen.getByRole('img', { name: 'Poster for Alpha' }));
});

// No Escape test here. happy-dom implements `showModal()` but not
// Escape-to-close: an open dialog given a bubbling, cancelable Escape keydown
// stays open and fires neither `cancel` nor `close`. A test asserting the
// modal closes would fail against correct code; one asserting it stays open
// would pass against broken code. Escape is covered in
// `packages/e2e/src/metadata-modal.spec.ts`, in a real browser.
