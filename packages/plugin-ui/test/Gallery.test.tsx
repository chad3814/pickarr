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
  render(<Gallery images={[{ url: "/api/artwork/poster/1", caption: "Blockers" }]} startUrl={'/api/artwork/poster/1'} onClose={noop} />);

  const dialog = screen.getByRole('dialog', { name: 'Blockers' });
  assert.ok(dialog, 'the dialog is named by its heading');
  assert.ok(screen.getByRole('heading', { name: 'Blockers' }), 'the caption is a visible heading');
  assert.equal(screen.getAllByRole('img').length, 1);
});

const POSTER = { url: '/api/artwork/poster/1', caption: 'Blockers' };
const BACKDROP = { url: '/api/artwork/background/1', caption: 'Blockers' };
const ALICE = { url: '/api/artwork/person/7', caption: 'Alice' };

test('an image that fails to load leaves the set, and the count says so', () => {
  // A 404 is the normal case here, not an error: most items have a poster
  // and neither of the other two slots, and most people have no picture
  // at all. One image shows at a time now, so "it left the gallery" is
  // observable in the position indicator rather than in an element count.
  render(<Gallery images={[POSTER, BACKDROP]} startUrl={POSTER.url} onClose={noop} />);
  assert.ok(screen.getByText('1 of 2'), 'two images to begin with');

  fireEvent.error(screen.getByRole('img'));

  assert.ok(screen.getByText('1 of 1'), 'the failed one is gone from the set');
});

test('the arrows walk the images one at a time, wrapping at both ends', () => {
  render(<Gallery images={[POSTER, BACKDROP, ALICE]} startUrl={POSTER.url} onClose={noop} />);
  // Exactly one image on screen: the vertical stack this replaced showed
  // every image at once, which is the thing being changed.
  assert.equal(screen.getAllByRole('img').length, 1);
  assert.ok(screen.getByText('1 of 3'));

  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  assert.ok(screen.getByText('2 of 3'));

  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  assert.ok(screen.getByText('3 of 3'));

  // Wrapping, not disabling: a disabled control a keyboard user has
  // tabbed to is a dead end that announces nothing.
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  assert.ok(screen.getByText('1 of 3'), 'forward from the last wraps to the first');

  fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
  assert.ok(screen.getByText('3 of 3'), 'and back from the first wraps to the last');
});

test('an image that fails mid-walk advances past it, rather than snapping back to the first', () => {
  // **The reported bug.** Stepping onto a missing image renders it, which
  // fires `error`, which drops it from the set -- and the position was
  // derived by looking the current url up in the *surviving* list. Once
  // the current url was the one that just left, that lookup answered -1
  // and `Math.max(0, -1)` sent the gallery back to the first image. With
  // a logo missing and two performers, walking forward went poster,
  // background, poster, background, ... losing one image per lap and
  // never reaching the cast.
  const LOGO = { url: '/api/artwork/logo/1', caption: 'Blockers' };
  render(
    <Gallery images={[POSTER, BACKDROP, LOGO, ALICE]} startUrl={POSTER.url} onClose={noop} />,
  );
  assert.ok(screen.getByText('1 of 4'));

  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  assert.ok(screen.getByText('2 of 4'), 'on the background');

  // Forward onto the logo, which 404s the moment it renders.
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  fireEvent.error(screen.getByRole('img'));

  // It must land on the image *after* the failed one, with the set one
  // shorter -- not back at the start.
  assert.ok(screen.getByRole('heading', { name: 'Alice' }), 'it advanced to the next surviving image');
  assert.ok(screen.getByText('3 of 3'), 'and the set lost only the failed one');
});

test('two missing images in a row are both skipped, not landed on twice', () => {
  // **The reported case exactly: no logo and one performer with no
  // picture, among two performers.** Walking forward has to step over
  // both dead images and arrive at the performer who does have one.
  //
  // What this does NOT pin, said plainly because the first draft of this
  // comment claimed it did: `nextSurvivor`'s consultation of the
  // already-failed list. Dropping that check leaves all 17 tests green.
  // It cannot be observed from outside, because `step()` walks the
  // surviving set, so a wrap never offers a dead url -- the only way
  // `nextSurvivor` meets one is when every image fails, and that ends
  // with the gallery closed either way. The check stays because without
  // it that case churns through a render-and-error per corpse before
  // closing, but it is defensive, not behaviour.
  const LOGO = { url: '/api/artwork/logo/1', caption: 'Blockers' };
  const NO_PIC = { url: '/api/artwork/person/8', caption: 'Bob' };
  render(
    <Gallery images={[POSTER, LOGO, NO_PIC, ALICE]} startUrl={POSTER.url} onClose={noop} />,
  );

  // Onto the logo, which fails.
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  fireEvent.error(screen.getByRole('img'));
  // It advanced to Bob, who also has nothing.
  assert.ok(screen.getByRole('heading', { name: 'Bob' }), 'it moved to the next image');
  fireEvent.error(screen.getByRole('img'));

  // Alice is the only remaining image besides the poster, and the walk
  // must have reached her rather than going back to the logo it already
  // knows is dead.
  assert.ok(screen.getByRole('heading', { name: 'Alice' }), 'it skipped past both failures');
  assert.ok(screen.getByText('2 of 2'), 'and only the two live images are left');
});

test('a failure on the last image wraps forward to the first', () => {
  const LOGO = { url: '/api/artwork/logo/1', caption: 'Blockers' };
  render(<Gallery images={[POSTER, LOGO]} startUrl={POSTER.url} onClose={noop} />);

  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  fireEvent.error(screen.getByRole('img'));

  assert.ok(screen.getByText('1 of 1'), 'the only survivor is the one on screen');
  assert.ok(screen.getByRole('heading', { name: 'Blockers' }));
});

test('the attribution is the subject of the image on screen, not of the card', () => {
  // The whole reason media and people share one gallery: the caption has
  // to change as the arrows move, or a person's photo would be labelled
  // with the item's title.
  render(<Gallery images={[POSTER, ALICE]} startUrl={POSTER.url} onClose={noop} />);
  assert.ok(screen.getByRole('heading', { name: 'Blockers' }));
  assert.ok(screen.getByRole('dialog', { name: 'Blockers' }), 'and the dialog is named by it');

  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));

  assert.ok(screen.getByRole('heading', { name: 'Alice' }), 'the caption followed the image');
  assert.ok(screen.getByRole('img', { name: 'Alice' }), 'and so did the alt text');
});

test('it opens on the image that was clicked, not on the first one', () => {
  // Clicking a cast member opens the card's whole set at that person.
  render(<Gallery images={[POSTER, BACKDROP, ALICE]} startUrl={ALICE.url} onClose={noop} />);

  assert.ok(screen.getByRole('heading', { name: 'Alice' }));
  assert.ok(screen.getByText('3 of 3'));
});

test('a startUrl that is not in the set opens on the first image rather than nothing', () => {
  render(<Gallery images={[POSTER, BACKDROP]} startUrl="/api/artwork/logo/999" onClose={noop} />);

  assert.ok(screen.getByRole('heading', { name: 'Blockers' }));
  assert.ok(screen.getByText('1 of 2'));
});

test('the arrow keys walk the set too, so the mouse is not the only way through', () => {
  render(<Gallery images={[POSTER, BACKDROP, ALICE]} startUrl={POSTER.url} onClose={noop} />);
  const dialog = screen.getByRole('dialog');

  fireEvent.keyDown(dialog, { key: 'ArrowRight' });
  assert.ok(screen.getByText('2 of 3'));

  fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
  assert.ok(screen.getByText('1 of 3'));
});

test('a single image shows no arrows, because there is nowhere to go', () => {
  render(<Gallery images={[POSTER]} startUrl={POSTER.url} onClose={noop} />);

  assert.ok(!screen.queryByRole('button', { name: 'Next image' }), 'no next');
  assert.ok(!screen.queryByRole('button', { name: 'Previous image' }), 'no previous');
  assert.ok(screen.getByText('1 of 1'), 'but the position still reads');
});

test('a subject whose every image fails closes rather than showing an empty frame', async () => {
  // Review Focus 4. An empty modal with a caption and no picture reads as
  // a bug; there is nothing to look at, so there is nothing to open.
  let closed = false;
  render(
    <Gallery images={[{ url: "/api/artwork/poster/1", caption: "Blockers" }]} startUrl={'/api/artwork/poster/1'} onClose={() => { closed = true; }} />,
  );

  fireEvent.error(screen.getAllByRole('img')[0]!);

  await waitFor(() => {
    assert.ok(closed, 'the gallery asked to be closed');
  });
});

test('Escape closes the gallery', () => {
  let closed = false;
  render(<Gallery images={[{ url: "/api/artwork/poster/1", caption: "Blockers" }]} startUrl={'/api/artwork/poster/1'} onClose={() => { closed = true; }} />);

  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

  assert.ok(closed, 'Escape asked to close');
});

test('focus moves into the gallery when it opens', () => {
  render(<Gallery images={[{ url: "/api/artwork/poster/1", caption: "Blockers" }]} startUrl={'/api/artwork/poster/1'} onClose={noop} />);

  // Compared as a boolean, never `assert.equal(document.activeElement,
  // element)` -- handing two live nodes to `node:assert` formats both and
  // kills the run. `scripts/check-test-hygiene.ts` fails the build on it.
  assert.ok(
    screen.getByRole('dialog').contains(document.activeElement),
    'focus is inside the dialog',
  );
});

test('an empty url list renders nothing at all', () => {
  const { container } = render(<Gallery images={[]} startUrl={''} onClose={noop} />);
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
  render(<Gallery images={[{ url: "/api/artwork/poster/1", caption: "Blockers" }]} startUrl={'/api/artwork/poster/1'} onClose={noop} />);

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
          <Gallery images={[{ url: "/api/artwork/poster/1", caption: "Blockers" }]} startUrl={'/api/artwork/poster/1'} onClose={noop} />
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
