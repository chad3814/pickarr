import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BrowseControls } from '../../src/library/BrowseControls.tsx';
import type { PickedFilter } from '../../src/store/catalog.ts';

afterEach(cleanup);

function setup(filter: PickedFilter, input = '') {
  const filters: PickedFilter[] = [];
  const inputs: string[] = [];
  const view = render(
    <BrowseControls
      filter={filter}
      input={input}
      onFilter={(f) => { filters.push(f); }}
      onInput={(v) => { inputs.push(v); }}
    />,
  );
  return { filters, inputs, container: view.container };
}

test('three radios, checked by the filter, each firing onFilter', () => {
  const { filters } = setup('picked');
  const all = screen.getByRole('radio', { name: 'All' });
  const picked = screen.getByRole('radio', { name: 'Picked' });
  const unpicked = screen.getByRole('radio', { name: 'Unpicked' });
  assert.equal(screen.getAllByRole('radio').length, 3);
  assert.equal(picked.getAttribute('name'), 'filter');
  assert.equal(all instanceof HTMLInputElement && all.checked, false);
  assert.equal(picked instanceof HTMLInputElement && picked.checked, true);
  fireEvent.click(unpicked);
  fireEvent.click(all);
  assert.deepEqual(filters, ['unpicked', 'all']);
});

test('a searchbox named Search shows the input and reports typing', () => {
  const { inputs } = setup('all', 'dune');
  const box = screen.getByRole('searchbox', { name: 'Search' });
  assert.equal(box instanceof HTMLInputElement && box.value, 'dune');
  fireEvent.change(box, { target: { value: 'dunes' } });
  assert.deepEqual(inputs, ['dunes']);
});

test('the form is a search landmark named Filter and search, with no classes', () => {
  const { container } = setup('all');
  assert.ok(screen.getByRole('search', { name: 'Filter and search' }));
  assert.ok(container.querySelector('[class]') === null, 'no element carries a class');
});
