import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { IdentifySubmit } from '@pickarr/plugin-ui';
import type { CatalogRecord } from '../../src/store/catalog.ts';
import { ItemGrid, type GridSource } from '../../src/library/ItemGrid.tsx';
import type { CatalogItemsResult } from '../../src/library/useCatalogItems.ts';
import type { PickSubmit } from '../../src/library/postPick.ts';

afterEach(cleanup);

function mediaItem(id: number, pluginId: string, title: string): MediaItemSyncRead {
  return { id, pluginId, createdAt: id, updatedAt: id, provider: null, providerRef: null, title, releaseDate: null, description: null };
}
function recordOf(id: number, pluginId: string, title: string, poster: number | null, background: number | null): CatalogRecord {
  return { id, pluginId, updatedAt: id, picked: 0, haystack: title.toLowerCase(), poster, background };
}
function resultOf(items: readonly MediaItemSyncRead[], records: readonly CatalogRecord[], done = true): CatalogItemsResult {
  return { items, records: new Map(records.map((r) => [r.id, r])), loadMore: () => {}, done, empty: items.length === 0 && done };
}
const source: GridSource = {
  gatherMediaItem: () => Promise.resolve(undefined),
  subscribe: () => () => {},
  getRows: () => Promise.resolve(new Map()),
  pluginRowsByMediaItems: () => Promise.resolve({ rows: new Map(), heldIds: new Map() }),
  subscribeInserts: () => () => {},
  subscribeTouched: () => () => {},
};
const acceptsPick: PickSubmit = () => Promise.resolve({ accepted: true });
const neverIdentify: IdentifySubmit = { identify: () => Promise.reject(new Error('unused')), suggest: () => Promise.reject(new Error('unused')) };
const NO_TABLES: readonly string[] = [];

function renderGrid(pluginId: string, result: CatalogItemsResult): void {
  render(<ItemGrid store={source} pluginId={pluginId} tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={result} emptyMessage="Nothing here yet." />);
}

test('a film grid shows each item\'s poster; a television grid shows backgrounds; both name the tile by the title', () => {
  renderGrid('movie', resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 41, 91)]));
  const list = screen.getByRole('list');
  assert.equal(list.getAttribute('data-tile'), 'poster');
  const tile = within(list).getByRole('button', { name: 'Arrival' });
  const img = tile.querySelector('img');
  assert.equal(img?.getAttribute('src'), '/api/artwork/poster/41');
  assert.equal(img?.getAttribute('alt'), '', 'the caption is the name; the image says nothing twice');
  cleanup();
  renderGrid('tv', resultOf([mediaItem(2, 'tv', 'Severance')], [recordOf(2, 'tv', 'Severance', 42, 92)]));
  assert.equal(screen.getByRole('list').getAttribute('data-tile'), 'background');
  assert.equal(screen.getByRole('button', { name: 'Severance' }).querySelector('img')?.getAttribute('src'), '/api/artwork/background/92');
});

test('a record with no image of the plugin\'s kind shows the placeholder under the title, even when it has the other kind', () => {
  renderGrid('movie', resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', null, 91)]));
  const tile = screen.getByRole('button', { name: 'Arrival' });
  assert.ok(!tile.querySelector('img[src]'), 'no image is requested');
  assert.ok(within(tile).getByRole('img', { name: 'No poster for Arrival' }), 'the placeholder names what is missing');
});

test('an image that fails latches to the placeholder, and a new id for the tile is tried afresh', async () => {
  const first = resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 41, null)]);
  const { rerender } = render(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={first} emptyMessage="x" />);
  const img = screen.getByRole('button', { name: 'Arrival' }).querySelector('img');
  assert.ok(img);
  fireEvent.error(img);
  await waitFor(() => { assert.ok(screen.getByRole('img', { name: 'No poster for Arrival' })); });
  // The same record again: still the placeholder, no retry.
  rerender(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={first} emptyMessage="x" />);
  assert.ok(!screen.getByRole('button', { name: 'Arrival' }).querySelector('img[src]'));
  // A re-rank changes the id: the tile tries the new image.
  const reranked = resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 43, null)]);
  rerender(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={reranked} emptyMessage="x" />);
  assert.equal(screen.getByRole('button', { name: 'Arrival' }).querySelector('img')?.getAttribute('src'), '/api/artwork/poster/43');
});

test('activating a tile opens one dialog named for the item with the card expanded; a second tile replaces it', async () => {
  renderGrid('movie', resultOf(
    [mediaItem(1, 'movie', 'Arrival'), mediaItem(2, 'movie', 'Dune')],
    [recordOf(1, 'movie', 'Arrival', 41, null), recordOf(2, 'movie', 'Dune', 42, null)],
  ));
  fireEvent.click(screen.getByRole('button', { name: 'Arrival' }));
  const dialog = screen.getByRole('dialog', { name: 'Arrival' });
  assert.ok(within(dialog).getByRole('heading', { name: /Arrival/ }), 'the card is inside');
  assert.equal(within(dialog).getByRole('button', { name: /Arrival/ }).getAttribute('aria-expanded'), 'true', 'opened expanded');
  fireEvent.click(screen.getAllByRole('button', { name: 'Dune' })[0] as HTMLElement);
  await waitFor(() => { assert.equal(screen.getAllByRole('dialog').length, 1); });
  assert.ok(screen.getByRole('dialog', { name: 'Dune' }));
});

test('Escape, the backdrop and Close each close the dialog and return focus to the tile', () => {
  renderGrid('movie', resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 41, null)]));
  const tile = screen.getByRole('button', { name: 'Arrival' });
  const focusIsOnTile = (): boolean => tile.contains(document.activeElement) || document.activeElement === tile;
  tile.focus();
  fireEvent.click(tile);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  assert.ok(!screen.queryByRole('dialog'), 'Escape closed it');
  assert.ok(focusIsOnTile(), 'focus is back on the tile after Escape');
  fireEvent.click(tile);
  const backdrop = screen.getByRole('dialog').closest('.dialog-backdrop');
  assert.ok(backdrop instanceof HTMLElement, 'the dialog sits in a backdrop');
  fireEvent.click(backdrop);
  assert.ok(!screen.queryByRole('dialog'), 'the backdrop closed it');
  assert.ok(focusIsOnTile(), 'focus is back on the tile after the backdrop');
  fireEvent.click(tile);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
  assert.ok(!screen.queryByRole('dialog'), 'Close closed it');
  assert.ok(focusIsOnTile(), 'focus is back on the tile after Close');
});

test('a dialog whose item leaves the page closes, and focus lands on the grid', async () => {
  const two = resultOf([mediaItem(1, 'movie', 'Arrival'), mediaItem(2, 'movie', 'Dune')], [recordOf(1, 'movie', 'Arrival', 41, null), recordOf(2, 'movie', 'Dune', 42, null)]);
  const { rerender } = render(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={two} emptyMessage="x" />);
  fireEvent.click(screen.getByRole('button', { name: 'Arrival' }));
  assert.ok(screen.getByRole('dialog', { name: 'Arrival' }));
  const one = resultOf([mediaItem(2, 'movie', 'Dune')], [recordOf(2, 'movie', 'Dune', 42, null)]);
  rerender(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={one} emptyMessage="x" />);
  await waitFor(() => { assert.ok(!screen.queryByRole('dialog')); });
  assert.ok(screen.getByRole('list').contains(document.activeElement) || document.activeElement === screen.getByRole('list'), 'focus went to the grid, since the tile is gone');
});

test('an empty result says so, and a page that is not done shows the sentinel and Load more', () => {
  renderGrid('movie', resultOf([], []));
  assert.ok(screen.getByText('Nothing here yet.'));
  cleanup();
  renderGrid('movie', resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 41, null)], false));
  assert.ok(screen.getByTestId('load-more-sentinel'));
  assert.ok(screen.getByRole('button', { name: 'Load more' }));
});

test('a tile is captioned by its plugin from the page\'s rows, and carries the caption as its title for when the column truncates it', async () => {
  // A television item whose tv_release row is on the page: the caption is
  // the series, the number and the title, not the bare title.
  const withRows: GridSource = {
    ...source,
    pluginRowsByMediaItems: () => Promise.resolve({
      rows: new Map([[2, { tv_release: [{ mediaItemId: 2, kind: 'episode', seriesTitle: 'Severance', seriesRef: '1', seasonNumber: 1, episodeNumber: 2 }] }]]),
      heldIds: new Map(),
    }),
  };
  render(<ItemGrid store={withRows} pluginId="tv" tables={['tv_release']} submit={acceptsPick} identify={neverIdentify} result={resultOf([mediaItem(2, 'tv', 'Good News About Hell')], [recordOf(2, 'tv', 'Good News About Hell', null, null)])} emptyMessage="x" />);
  const tile = await screen.findByRole('button', { name: 'Severance S01E02 Good News About Hell' });
  assert.equal(tile.getAttribute('title'), 'Severance S01E02 Good News About Hell');
  assert.equal(tile.querySelector('span')?.textContent, 'Severance S01E02 Good News About Hell');
  assert.ok(within(tile).getByRole('img', { name: 'No background for Severance S01E02 Good News About Hell' }), 'the placeholder names the caption too');
});

test('a film tile carries the year, from the item alone', () => {
  const item: MediaItemSyncRead = { ...mediaItem(1, 'movie', 'Arrival'), releaseDate: '2016-11-11' };
  renderGrid('movie', resultOf([item], [recordOf(1, 'movie', 'Arrival', 41, null)]));
  const tile = screen.getByRole('button', { name: 'Arrival (2016)' });
  assert.equal(tile.getAttribute('title'), 'Arrival (2016)');
});
