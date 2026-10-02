import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router';
import { SEARCH_DEBOUNCE_MS, parseFilter, useBrowseQuery } from '../../src/library/useBrowseQuery.ts';

const realSetTimeout = globalThis.setTimeout;

afterEach(() => {
  cleanup();
  globalThis.setTimeout = realSetTimeout;
});

function Probe(): ReactElement {
  const { query, controls } = useBrowseQuery();
  const location = useLocation();
  const navType = useNavigationType();
  return (
    <div>
      <output data-testid="filter">{query.filter}</output>
      <output data-testid="q">{query.q}</output>
      <output data-testid="term">{query.term}</output>
      <output data-testid="input">{controls.input}</output>
      <output data-testid="search">{location.search}</output>
      <output data-testid="nav">{navType}</output>
      <button type="button" onClick={() => { controls.setFilter('picked'); }}>set-picked</button>
      <button type="button" onClick={() => { controls.setFilter('all'); }}>set-all</button>
      <button type="button" onClick={() => { controls.setInput('dune'); }}>type-dune</button>
      <button type="button" onClick={() => { controls.setInput(''); }}>clear</button>
    </div>
  );
}

function text(id: string): string {
  return screen.getByTestId(id).textContent;
}

function renderAt(entry: string): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
    </MemoryRouter>,
  );
}

test('the filter and the search are read from the URL', () => {
  renderAt('/tv?filter=unpicked&q=Dune%20');
  assert.equal(text('filter'), 'unpicked');
  assert.equal(text('q'), 'Dune ');
  assert.equal(text('term'), 'dune');
  assert.equal(text('input'), 'Dune ');
});

test('an unknown filter reads as all, and a whitespace-only q has an empty term', () => {
  assert.equal(parseFilter('bogus'), 'all');
  assert.equal(parseFilter(null), 'all');
  renderAt('/tv?filter=bogus&q=%20%20');
  assert.equal(text('filter'), 'all');
  assert.equal(text('term'), '');
});

test('setFilter writes the URL immediately, as a replace', () => {
  renderAt('/tv');
  fireEvent.click(screen.getByText('set-picked'));
  assert.equal(text('search'), '?filter=picked');
  assert.equal(text('nav'), 'REPLACE');
});

test('typing is debounced before it reaches the URL', async () => {
  const delays: unknown[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    delays.push(delay);
    return realSetTimeout(handler, delay, ...args);
  }) as typeof globalThis.setTimeout;
  renderAt('/tv');
  fireEvent.click(screen.getByText('type-dune'));
  assert.equal(text('search'), '');
  assert.equal(text('input'), 'dune');
  assert.ok(delays.includes(SEARCH_DEBOUNCE_MS), 'asked setTimeout for the debounce');
  await waitFor(() => {
    assert.equal(text('search'), '?q=dune');
  });
});

test('clearing the input writes immediately', async () => {
  renderAt('/tv?q=dune');
  fireEvent.click(screen.getByText('clear'));
  assert.equal(text('search'), '');
  assert.equal(text('input'), '');
});

test('all with an empty input leaves no params', () => {
  renderAt('/tv?filter=picked');
  fireEvent.click(screen.getByText('set-all'));
  assert.equal(text('search'), '');
});

test('changing the filter while a keystroke is pending keeps both, now and after the debounce', async () => {
  renderAt('/tv');
  fireEvent.click(screen.getByText('type-dune'));
  fireEvent.click(screen.getByText('set-picked'));
  assert.equal(text('search'), '?filter=picked&q=dune');
  await new Promise((resolve) => { realSetTimeout(resolve, 200); });
  assert.equal(text('search'), '?filter=picked&q=dune');
  assert.equal(text('input'), 'dune');
});
