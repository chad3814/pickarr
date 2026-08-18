import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SearchBox } from '../src/components/SearchBox.tsx';

afterEach(cleanup);

test('the label is the accessible name, so three boxes are three controls', () => {
  // Browse, Picks and Downloads each render one of these, and all three carry
  // the same "Search" placeholder for a consistent look. The placeholder is
  // therefore no way to say which one a test — or a screen reader — is on, and
  // "Search" alone never said what was being searched.
  render(<SearchBox label="Search picks" value="" onChange={() => {}} />);
  assert.ok(screen.getByRole('searchbox', { name: 'Search picks' }));
});

test('it is a search input, not a bare text field', () => {
  // `type="search"` is what gives the browser's own clear affordance, which is
  // how most readers will empty the box.
  render(<SearchBox label="Search picks" value="alex" onChange={() => {}} />);
  assert.equal(screen.getByRole('searchbox').getAttribute('type'), 'search');
});

test('it is controlled: it shows what it is given and reports what was typed', () => {
  // The term lives in the route, not in here — Picks filters cards with it and
  // Downloads survives a poll with it — so this reports and never remembers.
  const typed: string[] = [];
  const { rerender } = render(<SearchBox label="Search" value="" onChange={(next) => typed.push(next)} />);

  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'coal' } });
  assert.deepEqual(typed, ['coal']);
  assert.equal(
    (screen.getByRole('searchbox') as HTMLInputElement).value,
    '',
    'still empty: nothing changed the value it was given',
  );

  rerender(<SearchBox label="Search" value="coal" onChange={(next) => typed.push(next)} />);
  assert.equal((screen.getByRole('searchbox') as HTMLInputElement).value, 'coal');
});
