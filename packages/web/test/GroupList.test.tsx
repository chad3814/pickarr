import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { GroupList, type BrowseSelection } from '../src/components/GroupList.tsx';
import type { BrowseItem, FailedItemView, GroupView, MetadataView, ReleaseView } from '../src/api/client.ts';

afterEach(cleanup);

function release(id: number): ReleaseView {
  return { id, score: 1080, quality: { resolution: 1080 }, releaseName: `R${id}`, publishedAt: null };
}

function group(over: Partial<GroupView> & { id: number }): GroupView {
  return {
    plugin: 'scenes',
    display: { title: `Group ${over.id}`, subtitle: 'Brazzers', fields: [] },
    state: 'new',
    pickedReleaseId: null,
    upgradeReleaseId: null,
    listRankAt: 0,
    releases: [release(1)],
    metadata: { state: 'absent' } satisfies MetadataView,
    ...over,
  };
}

/** A refused name, with just enough shape to render and to be selected. */
function failed(over: Partial<FailedItemView> & { id: number }): FailedItemView {
  return {
    feedId: 'scenes-daily',
    plugin: 'scenes',
    rawTitle: `Failed ${over.id}`,
    link: `http://feed.invalid/${over.id}`,
    parseError: 'no anchor',
    firstSeenAt: 0,
    publishedAt: null,
    suggestedValues: {},
    dismissedAt: null,
    ...over,
  };
}

function groupItem(g: GroupView): BrowseItem {
  return { kind: 'group', group: g };
}

function failedItem(item: FailedItemView): BrowseItem {
  return { kind: 'failed', item };
}

/** The selection a plain group row of this id carries. */
function sel(id: number): BrowseSelection {
  return { kind: 'group', id };
}

const THREE: BrowseItem[] = [group({ id: 1 }), group({ id: 2 }), group({ id: 3 })].map(groupItem);

test('a row shows the title, the studio and the release count', () => {
  render(<GroupList items={[groupItem(group({ id: 1, releases: [release(1), release(2)] }))]}
                    selected={null} onSelect={() => {}} />);
  const row = screen.getByRole('option');
  assert.match(row.textContent ?? '', /Group 1/);
  assert.match(row.textContent ?? '', /Brazzers/);
  assert.match(row.textContent ?? '', /2 releases/);
});

test('one release is singular', () => {
  render(<GroupList items={[groupItem(group({ id: 1 }))]} selected={null} onSelect={() => {}} />);
  assert.match(screen.getByRole('option').textContent ?? '', /1 release(?!s)/);
});

test('the title is the provider\'s when there is one, the same as the card shows', () => {
  render(<GroupList items={[groupItem(group({ id: 1, metadata: {
    state: 'confirmed', title: 'Provider Title', releaseDate: null, durationSeconds: null,
    synopsis: null, hasPoster: false, hasBackground: false,
  } }))]} selected={null} onSelect={() => {}} />);
  assert.match(screen.getByRole('option').textContent ?? '', /Provider Title/);
  assert.ok(!screen.queryByText(/Group 1/));
});

test('an absent studio leaves no orphan separator', () => {
  render(<GroupList items={[groupItem(group({ id: 1, display: { title: 'Group 1', fields: [] } }))]}
                    selected={null} onSelect={() => {}} />);
  const row = screen.getByRole('option');
  assert.ok(!(row.textContent ?? '').includes('·'), 'the separator is drawn by CSS between siblings');
  assert.equal(row.querySelectorAll('.group-row-meta > span').length, 1, 'one part, one span');
});

test('an empty studio leaves no orphan separator either', () => {
  // `''` is not the same case as absent, and `DisplayFields` allows it —
  // `subtitle?: string` with `isText` accepting any string. An empty span is
  // still a span, so `.group-row-meta > span + span::before` would draw the
  // ` · ` before the count and the row would read " · 1 release". `text()` is
  // what collapses the two cases into one, the same as on the card.
  render(<GroupList items={[groupItem(group({ id: 1, display: { title: 'Group 1', subtitle: '', fields: [] } }))]}
                    selected={null} onSelect={() => {}} />);
  const row = screen.getByRole('option');
  assert.equal(row.querySelectorAll('.group-row-meta > span').length, 1, 'one part, one span');
});

test('the upgrade marker renders only for a group that has one, and is named', () => {
  render(<GroupList items={[groupItem(group({ id: 1, upgradeReleaseId: 9 })), groupItem(group({ id: 2 }))]}
                    selected={null} onSelect={() => {}} />);
  const marked = screen.getAllByRole('option');
  assert.ok(marked[0]?.querySelector('.group-row-upgrade'), 'the flagged group is marked');
  assert.ok(!marked[1]?.querySelector('.group-row-upgrade'), 'the other is not');
  assert.ok(screen.getByLabelText('Upgrade available'), 'the marker is not glyph-only');
});

test('clicking a row reports its selection', () => {
  const picked: BrowseSelection[] = [];
  render(<GroupList items={THREE} selected={null} onSelect={(selection) => picked.push(selection)} />);
  fireEvent.click(screen.getAllByRole('option')[1]!);
  assert.deepEqual(picked, [sel(2)]);
});

test('it is a listbox with exactly one selected option', () => {
  render(<GroupList items={THREE} selected={sel(2)} onSelect={() => {}} />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  const selected = screen.getAllByRole('option').filter((row) => row.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1);
  assert.match(selected[0]?.textContent ?? '', /Group 2/);
});

test('exactly one row is in the tab order', () => {
  // A roving tabindex: the listbox is one stop, not one stop per group, so a
  // reader tabbing past a paged list does not tab through hundreds of rows.
  render(<GroupList items={THREE} selected={sel(2)} onSelect={() => {}} />);
  const reachable = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(reachable.length, 1);
  assert.match(reachable[0]?.textContent ?? '', /Group 2/, 'the selected row is the reachable one');
});

test('with nothing selected the first row is the tab stop', () => {
  render(<GroupList items={THREE} selected={null} onSelect={() => {}} />);
  const reachable = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(reachable.length, 1);
  assert.match(reachable[0]?.textContent ?? '', /Group 1/);
});

test('ArrowDown from nothing selected takes the first row', () => {
  const picked: BrowseSelection[] = [];
  render(<GroupList items={THREE} selected={null} onSelect={(selection) => picked.push(selection)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
  assert.deepEqual(picked, [sel(1)]);
});

test('ArrowUp with nothing selected reports nothing', () => {
  // Deliberate: starting from the last row would move a reader to the far end
  // of a paged list on one keypress. ArrowDown taking the first row is the
  // asymmetry, and it is tested above.
  const picked: BrowseSelection[] = [];
  render(<GroupList items={THREE} selected={null} onSelect={(selection) => picked.push(selection)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' });
  assert.deepEqual(picked, [] as BrowseSelection[]);
});

test('the arrows move one row at a time', () => {
  const picked: BrowseSelection[] = [];
  render(<GroupList items={THREE} selected={sel(2)} onSelect={(selection) => picked.push(selection)} />);
  const list = screen.getByRole('listbox');
  fireEvent.keyDown(list, { key: 'ArrowDown' });
  fireEvent.keyDown(list, { key: 'ArrowUp' });
  // Both are reported against the same `selected={sel(2)}`, because this
  // component does not hold the selection — the caller does, and a real
  // caller re-renders between the two.
  assert.deepEqual(picked, [sel(3), sel(1)]);
});

test('neither arrow walks off an end', () => {
  const picked: BrowseSelection[] = [];
  render(<GroupList items={THREE} selected={sel(1)} onSelect={(selection) => picked.push(selection)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' });
  assert.deepEqual(picked, [] as BrowseSelection[], 'nothing above the first row');
  cleanup();

  render(<GroupList items={THREE} selected={sel(3)} onSelect={(selection) => picked.push(selection)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
  assert.deepEqual(picked, [], 'nothing below the last');
});

/**
 * A caller that holds the selection, as the route does. Tests that pin
 * `selected` can only see what one render does; anything the selection
 * *change* causes — the effect that scrolls and focuses — needs the re-render
 * a real caller performs.
 */
function Controlled({ items, initial }: { items: BrowseItem[]; initial: BrowseSelection | null }) {
  const [selected, setSelected] = useState(initial);
  return <GroupList items={items} selected={selected} onSelect={setSelected} />;
}

test('an arrow key moves focus onto the newly selected row', () => {
  // The other half of the roving `tabIndex`. Without it `aria-selected` moves
  // to a row that is neither focused nor pointed at by
  // `aria-activedescendant`, so there is no accessibility event at all and the
  // focus ring stays on the row the reader arrived at.
  render(<Controlled items={THREE} initial={sel(1)} />);
  const rows = screen.getAllByRole('option');
  const first = rows[0];
  const second = rows[1];
  assert.ok(first !== undefined && second !== undefined, 'three rows rendered');
  first.focus();
  // dom.ts: element identity is `assert.ok(a === b, '…')`, never `assert.equal`.
  assert.ok(document.activeElement === first, 'the list holds focus to begin with');

  fireEvent.keyDown(first, { key: 'ArrowDown' });

  assert.ok(document.activeElement === second, 'focus followed the selection down a row');
});

/** A caller that can change the selection without the reader being in the list. */
function WithOutsideControl() {
  const [selected, setSelected] = useState<BrowseSelection | null>(sel(1));
  return (
    <>
      <button type="button" onClick={() => setSelected(sel(3))}>Select the third</button>
      <GroupList items={THREE} selected={selected} onSelect={setSelected} />
    </>
  );
}

test('a selection changed from outside the list does not steal focus', () => {
  // The guard on the focus move. A row clicked with the pointer, or a caller
  // setting `selected` itself, must not yank focus out of whatever the reader
  // is actually using.
  render(<WithOutsideControl />);
  const button = screen.getByRole('button', { name: 'Select the third' });
  button.focus();
  assert.ok(document.activeElement === button, 'focus starts outside the list');

  fireEvent.click(button);

  const selected = screen.getAllByRole('option').find((row) => row.getAttribute('aria-selected') === 'true');
  assert.match(selected?.textContent ?? '', /Group 3/, 'the selection did move');
  assert.ok(document.activeElement === button, 'focus stayed where the reader put it');
});

test('an empty list renders a listbox with no options and no crash', () => {
  render(<GroupList items={[]} selected={null} onSelect={() => {}} />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  // #40: never `assert.equal(screen.queryBy*(...), null)`.
  assert.ok(!screen.queryByRole('option'));
});

// The rest of this file is the second kind: a refused name interleaved among
// groups, addressed by `{ kind, id }` rather than a bare id — the reason is
// that `media_groups.id` and `feed_items.id` are unrelated namespaces, so a
// group and a failed item can carry the same number.

test('a failed row and a group row with the same id are different rows', () => {
  // The whole reason selection is composite. With a bare id these two collide.
  const items: BrowseItem[] = [
    groupItem(group({ id: 5 })),
    failedItem(failed({ id: 5, rawTitle: 'Same Id' })),
  ];
  const { rerender } = render(
    <GroupList items={items} selected={{ kind: 'failed', id: 5 }} onSelect={() => {}} />,
  );
  const options = screen.getAllByRole('option');
  assert.equal(options.length, 2, 'both rows rendered despite sharing a numeric id');
  const selectedAsFailed = options.filter((row) => row.getAttribute('aria-selected') === 'true');
  assert.equal(selectedAsFailed.length, 1, 'exactly one row is marked selected');
  assert.match(selectedAsFailed[0]?.textContent ?? '', /Same Id/, 'the failed row is the one selected');

  rerender(<GroupList items={items} selected={{ kind: 'group', id: 5 }} onSelect={() => {}} />);
  const selectedAsGroup = screen.getAllByRole('option').filter((row) => row.getAttribute('aria-selected') === 'true');
  assert.equal(selectedAsGroup.length, 1, 'still exactly one row is marked selected');
  assert.match(selectedAsGroup[0]?.textContent ?? '', /Group 5/, 'the group row is the one selected now');
});

test('a failed row is announced by its refused title', () => {
  render(
    <GroupList
      items={[failedItem(failed({ id: 9, rawTitle: 'Refused.RAW' }))]}
      selected={null}
      onSelect={() => {}}
    />,
  );
  assert.ok(screen.getByRole('option', { name: 'Refused.RAW' }));
});

test('exactly one row is in the tab order, whichever kind is selected', () => {
  const items: BrowseItem[] = [
    groupItem(group({ id: 1 })),
    failedItem(failed({ id: 2, rawTitle: 'Refused Two' })),
    groupItem(group({ id: 3 })),
  ];
  render(<GroupList items={items} selected={{ kind: 'failed', id: 2 }} onSelect={() => {}} />);
  const reachable = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(reachable.length, 1);
  assert.match(reachable[0]?.textContent ?? '', /Refused Two/, 'the selected failed row is the reachable one');
});

function ControlledMixed({ items, initial }: { items: BrowseItem[]; initial: BrowseSelection | null }) {
  const [selected, setSelected] = useState(initial);
  return <GroupList items={items} selected={selected} onSelect={setSelected} />;
}

test('arrow keys move across both kinds and move DOM focus with the selection', () => {
  const items: BrowseItem[] = [
    groupItem(group({ id: 1 })),
    failedItem(failed({ id: 2, rawTitle: 'Refused One' })),
    groupItem(group({ id: 3 })),
  ];
  render(<ControlledMixed items={items} initial={{ kind: 'group', id: 1 }} />);
  const first = screen.getAllByRole('option')[0];
  assert.ok(first !== undefined);
  first.focus();
  assert.ok(document.activeElement === first, 'the list holds focus to begin with');

  fireEvent.keyDown(first, { key: 'ArrowDown' });

  const second = screen.getAllByRole('option')[1];
  assert.ok(second !== undefined);
  assert.ok(document.activeElement === second, 'focus followed the selection onto the failed row');
  assert.equal(second.getAttribute('aria-selected'), 'true');
  assert.match(second.textContent ?? '', /Refused One/);

  fireEvent.keyDown(second, { key: 'ArrowDown' });

  const third = screen.getAllByRole('option')[2];
  assert.ok(third !== undefined);
  assert.ok(document.activeElement === third, 'focus continued onto the group row past it');
  assert.match(third.textContent ?? '', /Group 3/);
});
