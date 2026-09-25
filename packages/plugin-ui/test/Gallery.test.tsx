import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
