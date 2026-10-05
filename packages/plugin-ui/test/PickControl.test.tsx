import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PickControl, PICK_LABELS } from '../src/PickControl.tsx';
import type { PickSubmit } from '../src/types.ts';

afterEach(cleanup);

function Harness({ submit }: { submit: PickSubmit }): ReactElement {
  return (
    <div>
      <span id="name">release-1.mkv</span>
      <PickControl id="pick-1" labelledBy="name" rssItemId={1} submit={submit} />
    </div>
  );
}
// By the release half of the name: the verb half reads `Picking…` while a pick is in flight.
const button = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /release-1\.mkv$/ });

test('the button is named by its own label and the release, reads Pick, and is enabled until clicked', () => {
  render(<Harness submit={() => Promise.resolve({ accepted: true })} />);
  assert.ok(screen.getByRole('button', { name: 'Pick release-1.mkv' }), 'named by its own label and the release');
  assert.equal(button().textContent, 'Pick');
  assert.ok(!button().disabled);
  assert.deepEqual(PICK_LABELS, { idle: 'Pick', pending: 'Picking…' }, 'the two labels the stylesheet\'s --size-pick-button was measured against');
});

test('an accepted pick stays Picking… and disabled: the status that replaces it is the caller\'s to render', async () => {
  const seen: number[] = [];
  render(<Harness submit={(id) => { seen.push(id); return Promise.resolve({ accepted: true }); }} />);
  fireEvent.click(button());
  await act(async () => { await Promise.resolve(); });
  assert.equal(button().textContent, 'Picking…');
  assert.ok(button().disabled);
  assert.deepEqual(seen, [1]);
  assert.equal(screen.queryAllByRole('alert').length, 0, 'an acceptance is not something to report');
});

test('a refusal is one readable sentence and hands the button back', async () => {
  render(<Harness submit={() => Promise.resolve({ refusal: 'already-submitted' })} />);
  fireEvent.click(button());
  const alert = await screen.findByRole('alert');
  assert.equal(alert.textContent, 'This release has already been sent to a download client.');
  assert.ok(!button().disabled);
  assert.equal(button().textContent, 'Pick');
});

test('a submit that rejects outright shows the offline sentence and hands the button back', async () => {
  render(<Harness submit={() => Promise.reject(new Error('network down'))} />);
  fireEvent.click(button());
  await waitFor(() => { assert.ok(screen.getByRole('alert')); });
  assert.equal(screen.getByRole('alert').textContent, 'Could not reach Pickarr. Check your connection and try again.');
  assert.ok(!button().disabled);
});
