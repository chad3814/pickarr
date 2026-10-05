import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import { useHeldItems, useScrolledToTop } from '../../src/library/useHeldItems.ts';
import type { MediaItemsResult } from '../../src/library/useMediaItems.ts';

afterEach(cleanup);

function item(id: number, title: string, updatedAt = id): MediaItemSyncRead {
  return { id, pluginId: 'tv', createdAt: 1, updatedAt, provider: null, providerRef: null, title, releaseDate: null, description: null };
}
function resultOf(items: readonly MediaItemSyncRead[], done = true): MediaItemsResult {
  return { items, loadMore: () => {}, done, empty: done && items.length === 0 };
}

function Probe({ result, atTop }: { result: MediaItemsResult; atTop: boolean }): ReactElement {
  const { shown, held } = useHeldItems(result, atTop);
  return (
    <div>
      <output data-testid="shown">{shown.items.map((i) => `${String(i.id)}:${i.title}`).join(',')}</output>
      <output data-testid="held">{held}</output>
    </div>
  );
}
const text = (id: string): string => screen.getByTestId(id).textContent;

test('at the top the result passes straight through, held is zero', () => {
  const { rerender } = render(<Probe result={resultOf([item(3, 'c'), item(2, 'b')])} atTop />);
  assert.equal(text('shown'), '3:c,2:b');
  assert.equal(text('held'), '0');
  rerender(<Probe result={resultOf([item(4, 'd'), item(3, 'c'), item(2, 'b')])} atTop />);
  assert.equal(text('shown'), '4:d,3:c,2:b', 'live: a new head item shows at once');
});

test('scrolled down, a new head item is held and counted while the shown order stays put', () => {
  const { rerender } = render(<Probe result={resultOf([item(3, 'c'), item(2, 'b')])} atTop />);
  rerender(<Probe result={resultOf([item(3, 'c'), item(2, 'b')])} atTop={false} />);
  rerender(<Probe result={resultOf([item(4, 'd'), item(3, 'c'), item(2, 'b')])} atTop={false} />);
  assert.equal(text('shown'), '3:c,2:b', 'the new item is not inserted above what is on screen');
  assert.equal(text('held'), '1');
  rerender(<Probe result={resultOf([item(5, 'e'), item(4, 'd'), item(3, 'c'), item(2, 'b')])} atTop={false} />);
  assert.equal(text('held'), '2', 'the count follows every arrival');
});

test('while held, a shown item still updates in place and a vanished one is removed', () => {
  const { rerender } = render(<Probe result={resultOf([item(3, 'c'), item(2, 'b'), item(1, 'a')])} atTop />);
  rerender(<Probe result={resultOf([item(3, 'c'), item(2, 'b'), item(1, 'a')])} atTop={false} />);
  rerender(<Probe result={resultOf([item(3, 'c'), item(2, 'B!'), item(1, 'a')])} atTop={false} />);
  assert.equal(text('shown'), '3:c,2:B!,1:a', 'a retitle shows where the item already is');
  rerender(<Probe result={resultOf([item(3, 'c'), item(1, 'a')])} atTop={false} />);
  assert.equal(text('shown'), '3:c,1:a', 'a tombstoned item leaves');
  assert.equal(text('held'), '0');
});

test('an existing item bumped to the head counts as new, since showing it there would move everything below', () => {
  const { rerender } = render(<Probe result={resultOf([item(3, 'c'), item(2, 'b'), item(1, 'a')])} atTop />);
  rerender(<Probe result={resultOf([item(3, 'c'), item(2, 'b'), item(1, 'a')])} atTop={false} />);
  rerender(<Probe result={resultOf([item(1, 'a', 99), item(3, 'c'), item(2, 'b')])} atTop={false} />);
  assert.equal(text('shown'), '3:c,2:b,1:a', 'kept in the order it was shown');
  assert.equal(text('held'), '0', 'it is a shown item, so nothing is hidden -- but nothing moved either');
});

test('pages the operator loads append at the tail and join the frozen order', () => {
  const { rerender } = render(<Probe result={resultOf([item(3, 'c'), item(2, 'b')], false)} atTop />);
  rerender(<Probe result={resultOf([item(3, 'c'), item(2, 'b')], false)} atTop={false} />);
  rerender(<Probe result={resultOf([item(3, 'c'), item(2, 'b'), item(1, 'a')], false)} atTop={false} />);
  assert.equal(text('shown'), '3:c,2:b,1:a', 'the loaded page shows below what was there');
  assert.equal(text('held'), '0');
  // An arrival older than the loaded page but newer than nothing shown: held, not slotted between.
  rerender(<Probe result={resultOf([item(4, 'd'), item(3, 'c'), item(2, 'b'), item(1, 'a')], false)} atTop={false} />);
  assert.equal(text('shown'), '3:c,2:b,1:a');
  assert.equal(text('held'), '1');
});

test('returning to the top releases the hold and the held items appear', () => {
  const { rerender } = render(<Probe result={resultOf([item(3, 'c')])} atTop />);
  rerender(<Probe result={resultOf([item(3, 'c')])} atTop={false} />);
  rerender(<Probe result={resultOf([item(4, 'd'), item(3, 'c')])} atTop={false} />);
  assert.equal(text('held'), '1');
  rerender(<Probe result={resultOf([item(4, 'd'), item(3, 'c')])} atTop />);
  assert.equal(text('shown'), '4:d,3:c');
  assert.equal(text('held'), '0');
});

test('useScrolledToTop tracks the window through the scroll event', () => {
  let y = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  function ScrollProbe(): ReactElement {
    return <output>{String(useScrolledToTop())}</output>;
  }
  render(<ScrollProbe />);
  assert.equal(screen.getByRole('status').textContent, 'true');
  act(() => { y = 480; window.dispatchEvent(new Event('scroll')); });
  assert.equal(screen.getByRole('status').textContent, 'false');
  act(() => { y = 0; window.dispatchEvent(new Event('scroll')); });
  assert.equal(screen.getByRole('status').textContent, 'true');
});
