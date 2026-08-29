import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { GroupList } from '../src/components/GroupList.tsx';
import type { GroupView, MetadataView, ReleaseView } from '../src/api/client.ts';

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

const THREE = [group({ id: 1 }), group({ id: 2 }), group({ id: 3 })];

test('a row shows the title, the studio and the release count', () => {
  render(<GroupList groups={[group({ id: 1, releases: [release(1), release(2)] })]}
                    selectedId={null} onSelect={() => {}} />);
  const row = screen.getByRole('option');
  assert.match(row.textContent ?? '', /Group 1/);
  assert.match(row.textContent ?? '', /Brazzers/);
  assert.match(row.textContent ?? '', /2 releases/);
});

test('one release is singular', () => {
  render(<GroupList groups={[group({ id: 1 })]} selectedId={null} onSelect={() => {}} />);
  assert.match(screen.getByRole('option').textContent ?? '', /1 release(?!s)/);
});

test('the title is the provider\'s when there is one, the same as the card shows', () => {
  render(<GroupList groups={[group({ id: 1, metadata: {
    state: 'confirmed', title: 'Provider Title', releaseDate: null, durationSeconds: null,
    synopsis: null, hasPoster: false, hasBackground: false,
  } })]} selectedId={null} onSelect={() => {}} />);
  assert.match(screen.getByRole('option').textContent ?? '', /Provider Title/);
  assert.ok(!screen.queryByText(/Group 1/));
});

test('an absent studio leaves no orphan separator', () => {
  render(<GroupList groups={[group({ id: 1, display: { title: 'Group 1', fields: [] } })]}
                    selectedId={null} onSelect={() => {}} />);
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
  render(<GroupList groups={[group({ id: 1, display: { title: 'Group 1', subtitle: '', fields: [] } })]}
                    selectedId={null} onSelect={() => {}} />);
  const row = screen.getByRole('option');
  assert.equal(row.querySelectorAll('.group-row-meta > span').length, 1, 'one part, one span');
});

test('the upgrade marker renders only for a group that has one, and is named', () => {
  render(<GroupList groups={[group({ id: 1, upgradeReleaseId: 9 }), group({ id: 2 })]}
                    selectedId={null} onSelect={() => {}} />);
  const marked = screen.getAllByRole('option');
  assert.ok(marked[0]?.querySelector('.group-row-upgrade'), 'the flagged group is marked');
  assert.ok(!marked[1]?.querySelector('.group-row-upgrade'), 'the other is not');
  assert.ok(screen.getByLabelText('Upgrade available'), 'the marker is not glyph-only');
});

test('clicking a row reports its id', () => {
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={null} onSelect={(id) => picked.push(id)} />);
  fireEvent.click(screen.getAllByRole('option')[1]!);
  assert.deepEqual(picked, [2]);
});

test('it is a listbox with exactly one selected option', () => {
  render(<GroupList groups={THREE} selectedId={2} onSelect={() => {}} />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  const selected = screen.getAllByRole('option').filter((row) => row.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1);
  assert.match(selected[0]?.textContent ?? '', /Group 2/);
});

test('exactly one row is in the tab order', () => {
  // A roving tabindex: the listbox is one stop, not one stop per group, so a
  // reader tabbing past a paged list does not tab through hundreds of rows.
  render(<GroupList groups={THREE} selectedId={2} onSelect={() => {}} />);
  const reachable = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(reachable.length, 1);
  assert.match(reachable[0]?.textContent ?? '', /Group 2/, 'the selected row is the reachable one');
});

test('with nothing selected the first row is the tab stop', () => {
  render(<GroupList groups={THREE} selectedId={null} onSelect={() => {}} />);
  const reachable = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(reachable.length, 1);
  assert.match(reachable[0]?.textContent ?? '', /Group 1/);
});

test('ArrowDown from nothing selected takes the first row', () => {
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={null} onSelect={(id) => picked.push(id)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
  assert.deepEqual(picked, [1]);
});

test('ArrowUp with nothing selected reports nothing', () => {
  // Deliberate: starting from the last row would move a reader to the far end
  // of a paged list on one keypress. ArrowDown taking the first row is the
  // asymmetry, and it is tested above.
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={null} onSelect={(id) => picked.push(id)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' });
  assert.deepEqual(picked, []);
});

test('the arrows move one row at a time', () => {
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={2} onSelect={(id) => picked.push(id)} />);
  const list = screen.getByRole('listbox');
  fireEvent.keyDown(list, { key: 'ArrowDown' });
  fireEvent.keyDown(list, { key: 'ArrowUp' });
  // Both are reported against the same `selectedId={2}`, because this component
  // does not hold the selection — the caller does, and a real caller re-renders
  // between the two.
  assert.deepEqual(picked, [3, 1]);
});

test('neither arrow walks off an end', () => {
  const picked: number[] = [];
  render(<GroupList groups={THREE} selectedId={1} onSelect={(id) => picked.push(id)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' });
  // `[] as number[]`, not `[]`: `assert/strict`'s `deepEqual` is `deepStrictEqual`,
  // typed `asserts actual is T`, and infers `T = never[]` from a bare `[]` —
  // narrowing `picked` to `never[]` for the rest of this test, so the `push`
  // below no longer typechecks. The cast makes `T` what it already is.
  assert.deepEqual(picked, [] as number[], 'nothing above the first row');
  cleanup();

  render(<GroupList groups={THREE} selectedId={3} onSelect={(id) => picked.push(id)} />);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
  assert.deepEqual(picked, [], 'nothing below the last');
});

/**
 * A caller that holds the selection, as the route does. Tests that pin
 * `selectedId` can only see what one render does; anything the selection
 * *change* causes — the effect that scrolls and focuses — needs the re-render
 * a real caller performs.
 */
function Controlled({ initialId }: { initialId: number | null }) {
  const [selectedId, setSelectedId] = useState(initialId);
  return <GroupList groups={THREE} selectedId={selectedId} onSelect={setSelectedId} />;
}

test('an arrow key moves focus onto the newly selected row', () => {
  // The other half of the roving `tabIndex`. Without it `aria-selected` moves
  // to a row that is neither focused nor pointed at by
  // `aria-activedescendant`, so there is no accessibility event at all and the
  // focus ring stays on the row the reader arrived at.
  render(<Controlled initialId={1} />);
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
  const [selectedId, setSelectedId] = useState<number | null>(1);
  return (
    <>
      <button type="button" onClick={() => setSelectedId(3)}>Select the third</button>
      <GroupList groups={THREE} selectedId={selectedId} onSelect={setSelectedId} />
    </>
  );
}

test('a selection changed from outside the list does not steal focus', () => {
  // The guard on the focus move. A row clicked with the pointer, or a caller
  // setting `selectedId` itself, must not yank focus out of whatever the reader
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
  render(<GroupList groups={[]} selectedId={null} onSelect={() => {}} />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  // #40: never `assert.equal(screen.queryBy*(...), null)`.
  assert.ok(!screen.queryByRole('option'));
});
