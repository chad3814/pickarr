import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Gallery } from '../src/Gallery.tsx';

afterEach(cleanup);

function noop(): void {}

test('the gallery shows its images under a caption that is a real heading', () => {
  // A real `<h2>`, with the dialog named through `aria-labelledby` rather
  // than a duplicated `aria-label`. `CLAUDE.md` records a dialog that
  // passed eight unit tests and two Playwright specs on an `aria-label`
  // while rendering as unstyled text nobody could use.
  render(<Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={noop} />);

  const dialog = screen.getByRole('dialog', { name: 'Blockers' });
  assert.ok(dialog, 'the dialog is named by its heading');
  assert.ok(screen.getByRole('heading', { name: 'Blockers' }), 'the caption is a visible heading');
  assert.equal(screen.getAllByRole('img').length, 1);
});

test('an image that fails to load leaves the gallery', () => {
  // A 404 is the normal case here, not an error: most items have a poster
  // and nothing else. `MediaItemCard` already drops its browse poster this
  // way.
  render(
    <Gallery urls={['/api/artwork/poster/1', '/api/artwork/logo/1']} caption="Blockers" onClose={noop} />,
  );
  assert.equal(screen.getAllByRole('img').length, 2);

  fireEvent.error(screen.getAllByRole('img')[1]!);

  assert.equal(screen.getAllByRole('img').length, 1);
});

test('a subject whose every image fails closes rather than showing an empty frame', async () => {
  // Review Focus 4. An empty modal with a caption and no picture reads as
  // a bug; there is nothing to look at, so there is nothing to open.
  let closed = false;
  render(
    <Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={() => { closed = true; }} />,
  );

  fireEvent.error(screen.getAllByRole('img')[0]!);

  await waitFor(() => {
    assert.ok(closed, 'the gallery asked to be closed');
  });
});

test('Escape closes the gallery', () => {
  let closed = false;
  render(<Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={() => { closed = true; }} />);

  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

  assert.ok(closed, 'Escape asked to close');
});

test('focus moves into the gallery when it opens', () => {
  render(<Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={noop} />);

  // Compared as a boolean, never `assert.equal(document.activeElement,
  // element)` -- handing two live nodes to `node:assert` formats both and
  // kills the run. `scripts/check-test-hygiene.ts` fails the build on it.
  assert.ok(
    screen.getByRole('dialog').contains(document.activeElement),
    'focus is inside the dialog',
  );
});

test('an empty url list renders nothing at all', () => {
  const { container } = render(<Gallery urls={[]} caption="Blockers" onClose={noop} />);
  assert.equal(container.innerHTML, '');
});

test('Tab wraps within the dialog, and Shift+Tab wraps the other way', () => {
  // The dialog's only focusable element is the Close button, so a correct
  // trap wraps in either direction back onto itself -- jsdom performs no
  // native Tab traversal at all, so an untrapped Tab keydown would *also*
  // leave focus on Close, and a bare `activeElement` assertion cannot tell
  // the two apart. The trap's actual, observable behaviour is that it
  // intercepts the key: `fireEvent` returns the boolean DOM
  // `dispatchEvent` produces, which is `false` exactly when something
  // called `preventDefault()`. Comparing that boolean is not a comparison
  // of live nodes.
  render(<Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={noop} />);

  const closeButton = screen.getByRole('button', { name: 'Close' });
  closeButton.focus();

  const tabNotCancelled = fireEvent.keyDown(closeButton, { key: 'Tab' });
  assert.equal(tabNotCancelled, false, 'Tab from the last (and only) element was intercepted, not left to default traversal');
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus is still inside the dialog after Tab');

  const shiftTabNotCancelled = fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
  assert.equal(shiftTabNotCancelled, false, 'Shift+Tab from the first (and only) element was intercepted, not left to default traversal');
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus is still inside the dialog after Shift+Tab');
});

test('closing the gallery returns focus to the control that opened it', () => {
  function Harness({ showGallery }: { showGallery: boolean }): ReactElement {
    return (
      <div>
        <button type="button">Open</button>
        {showGallery && (
          <Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={noop} />
        )}
      </div>
    );
  }

  const { rerender } = render(<Harness showGallery={false} />);
  const openButton = screen.getByRole('button', { name: 'Open' });
  openButton.focus();
  assert.ok(openButton.contains(document.activeElement), 'focus starts on the opener');

  rerender(<Harness showGallery={true} />);
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus moved into the dialog');

  rerender(<Harness showGallery={false} />);
  // Unmounting the gallery removes whatever held focus from the document,
  // and jsdom then falls `document.activeElement` back to `<body>`. With
  // only "<div><button>Open</button></div>" left in the document at this
  // point, `document.body.textContent` is coincidentally also `'Open'`, so
  // asserting on textContent alone cannot tell "focus was restored to the
  // button" apart from "focus was lost to the body" -- it passed even with
  // `opener.focus()` deleted from Gallery.tsx entirely. `contains()` does
  // not have that ambiguity: the button contains itself, but does not
  // contain `<body>`.
  assert.ok(openButton.contains(document.activeElement), 'focus returned to the opener, not lost to <body>');
});
