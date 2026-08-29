import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ViewToggle } from '../src/components/ViewToggle.tsx';

afterEach(cleanup);

test('it is one named group of two radios, with the current view checked', () => {
  render(<ViewToggle view="split" onChange={() => {}} />);
  assert.ok(screen.getByRole('group', { name: 'View' }));
  const split = screen.getByRole('radio', { name: 'Split' });
  assert.equal((split as HTMLInputElement).checked, true);
  assert.equal((screen.getByRole('radio', { name: 'List' }) as HTMLInputElement).checked, false);
});

test('choosing the other view reports it', () => {
  const chosen: string[] = [];
  render(<ViewToggle view="list" onChange={(next) => chosen.push(next)} />);
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  assert.deepEqual(chosen, ['split']);
});
