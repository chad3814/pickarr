import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Dialog } from '../src/Dialog.tsx';

afterEach(cleanup);

function noop(): void {}

test('a dialog is labelled by its label, is modal, and moves focus in when it opens', () => {
  render(<Dialog label="Severance" className="item-dialog" onClose={noop}><button type="button">Close</button></Dialog>);
  const dialog = screen.getByRole('dialog', { name: 'Severance' });
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(dialog.contains(document.activeElement), 'focus is inside the dialog');
});

test('Escape and a backdrop click close it; a click inside does not', () => {
  let closed = 0;
  const { container } = render(<Dialog label="x" className="item-dialog" onClose={() => { closed += 1; }}><button type="button">Inside</button></Dialog>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  assert.equal(closed, 1, 'Escape asked to close');
  fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
  assert.equal(closed, 1, 'a click inside stays inside');
  const backdrop = container.querySelector('.dialog-backdrop');
  assert.ok(backdrop instanceof HTMLElement, 'the backdrop is a real element with the class the stylesheet keys on');
  fireEvent.click(backdrop);
  assert.equal(closed, 2, 'the backdrop closes');
});

test('Tab wraps within the dialog, and Shift+Tab wraps the other way', () => {
  render(<Dialog label="x" className="item-dialog" onClose={noop}><button type="button">Close</button></Dialog>);
  const closeButton = screen.getByRole('button', { name: 'Close' });
  closeButton.focus();
  const tabNotCancelled = fireEvent.keyDown(closeButton, { key: 'Tab' });
  assert.equal(tabNotCancelled, false, 'Tab from the last (and only) element was intercepted, not left to default traversal');
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus is still inside the dialog after Tab');
  const shiftTabNotCancelled = fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
  assert.equal(shiftTabNotCancelled, false, 'Shift+Tab from the first (and only) element was intercepted, not left to default traversal');
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus is still inside the dialog after Shift+Tab');
});

test('closing returns focus to the control that opened it', () => {
  function Harness({ open }: { open: boolean }): ReactElement {
    return (
      <div>
        <button type="button">Open</button>
        {open && <Dialog label="x" className="item-dialog" onClose={noop}><button type="button">Close</button></Dialog>}
      </div>
    );
  }
  const { rerender } = render(<Harness open={false} />);
  const openButton = screen.getByRole('button', { name: 'Open' });
  openButton.focus();
  rerender(<Harness open />);
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus moved in');
  rerender(<Harness open={false} />);
  assert.ok(openButton.contains(document.activeElement) || document.activeElement === openButton, 'focus is back on the opener');
});

test('other keys reach the caller, so a gallery can walk with the arrows', () => {
  const keys: string[] = [];
  render(<Dialog label="x" className="gallery" onClose={noop} onKeyDown={(event) => { keys.push(event.key); }}><button type="button">Close</button></Dialog>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  assert.deepEqual(keys, ['ArrowRight'], 'Escape is the dialog\'s own and is not forwarded');
});

test('when the focused control removes itself, the dialog reclaims focus so Escape still closes it', async () => {
  let closed = 0;
  function Harness(): ReactElement {
    const [present, setPresent] = useState(true);
    return (
      <Dialog label="x" className="item-dialog" onClose={() => { closed += 1; }}>
        {present && <button type="button" onClick={() => { setPresent(false); }}>Pick</button>}
      </Dialog>
    );
  }
  render(<Harness />);
  const pick = screen.getByRole('button', { name: 'Pick' });
  pick.focus();
  fireEvent.click(pick);
  assert.ok(!screen.queryByRole('button', { name: 'Pick' }), 'the focused button is gone');
  await waitFor(() => {
    assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus came back inside the dialog');
  });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  assert.equal(closed, 1, 'Escape closes it');
});

test('with dialogs nested, the innermost one reclaims focus, not the outer', async () => {
  // The inner dialog opens after the outer one, as a gallery does inside the
  // item dialog, so the outer panel's observer is created first and runs first.
  function Harness(): ReactElement {
    const [innerOpen, setInnerOpen] = useState(false);
    const [present, setPresent] = useState(true);
    return (
      <Dialog label="outer" className="item-dialog" onClose={noop}>
        <button type="button" onClick={() => { setInnerOpen(true); }}>Open gallery</button>
        {innerOpen && (
          <Dialog label="inner" className="gallery" onClose={noop}>
            {present && <button type="button" onClick={() => { setPresent(false); }}>Next</button>}
          </Dialog>
        )}
      </Dialog>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Open gallery' }));
  const next = screen.getByRole('button', { name: 'Next' });
  next.focus();
  fireEvent.click(next);
  await waitFor(() => {
    assert.ok(document.activeElement === screen.getByRole('dialog', { name: 'inner' }), 'the inner panel holds focus');
  });
});

test('Escape on a nested dialog closes only that dialog, not the one beneath it', () => {
  let outerClosed = 0;
  let innerClosed = 0;
  function Harness(): ReactElement {
    const [innerOpen, setInnerOpen] = useState(false);
    return (
      <Dialog label="outer" className="item-dialog" onClose={() => { outerClosed += 1; }}>
        <button type="button" onClick={() => { setInnerOpen(true); }}>Open gallery</button>
        {innerOpen && <Dialog label="inner" className="gallery" onClose={() => { innerClosed += 1; }}><button type="button">Next</button></Dialog>}
      </Dialog>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Open gallery' }));
  const innerDialog = screen.getByRole('dialog', { name: 'inner' });
  fireEvent.keyDown(innerDialog, { key: 'Escape' });
  assert.equal(innerClosed, 1, 'the inner dialog asked to close');
  assert.equal(outerClosed, 0, 'the outer dialog did not');
});

test('a disabled control is not the last stop, so Tab from the control before it is still trapped', () => {
  render(
    <Dialog label="x" className="item-dialog" onClose={noop}>
      <button type="button">Close</button>
      <button type="button" disabled>Picking…</button>
    </Dialog>,
  );
  const closeButton = screen.getByRole('button', { name: 'Close' });
  closeButton.focus();
  const tabNotCancelled = fireEvent.keyDown(closeButton, { key: 'Tab' });
  assert.equal(tabNotCancelled, false, 'Tab from the last enabled control was intercepted');
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus is still inside the dialog');
});
