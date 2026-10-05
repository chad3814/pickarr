import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { BrowseControls } from '../../src/library/BrowseControls.tsx';
import type { BrowseView } from '../../src/library/useBrowseQuery.ts';
import type { PickedFilter } from '../../src/store/catalog.ts';

afterEach(cleanup);

function setup(filter: PickedFilter, input = '', view: BrowseView = 'list') {
  const filters: PickedFilter[] = [];
  const inputs: string[] = [];
  const views: BrowseView[] = [];
  const rendered = render(
    <BrowseControls
      filter={filter}
      input={input}
      onFilter={(f) => { filters.push(f); }}
      onInput={(v) => { inputs.push(v); }}
      view={view}
      onView={(v) => { views.push(v); }}
    />,
  );
  return { filters, inputs, views, container: rendered.container };
}

test('three radios, checked by the filter, each firing onFilter', () => {
  const { filters } = setup('picked');
  const all = screen.getByRole('radio', { name: 'All' });
  const picked = screen.getByRole('radio', { name: 'Picked' });
  const unpicked = screen.getByRole('radio', { name: 'Unpicked' });
  assert.equal(within(screen.getByRole('group', { name: 'Show' })).getAllByRole('radio').length, 3);
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

test('a View group with List and Grid radios, checked by the view, each firing onView', () => {
  const { views } = setup('all', '', 'grid');
  const group = screen.getByRole('group', { name: 'View' });
  const list = within(group).getByRole('radio', { name: 'List' });
  const grid = within(group).getByRole('radio', { name: 'Grid' });
  assert.equal(grid instanceof HTMLInputElement && grid.checked, true);
  assert.equal(list.getAttribute('name'), 'view', 'its own radio group, so it cannot steal the Show group\'s selection');
  fireEvent.click(list);
  assert.deepEqual(views, ['list']);
});

test('held arrivals show as an "N new" button in a status region, and none renders at zero', () => {
  let revealed = 0;
  const { rerender } = render(
    <BrowseControls filter="all" input="" onFilter={() => {}} onInput={() => {}} view="list" onView={() => {}} pending={{ count: 3, reveal: () => { revealed += 1; } }} />,
  );
  const button = screen.getByRole('button', { name: '3 new' });
  assert.ok(screen.getByRole('status').contains(button), 'announced when it appears');
  fireEvent.click(button);
  assert.equal(revealed, 1);
  rerender(<BrowseControls filter="all" input="" onFilter={() => {}} onInput={() => {}} view="list" onView={() => {}} pending={{ count: 0, reveal: () => {} }} />);
  assert.ok(!screen.queryByRole('button', { name: /new/ }), 'nothing to reveal, nothing shown');
});
