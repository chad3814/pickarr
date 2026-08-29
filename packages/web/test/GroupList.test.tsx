import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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

test('an empty list renders a listbox with no options and no crash', () => {
  render(<GroupList groups={[]} selectedId={null} onSelect={() => {}} />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  // #40: never `assert.equal(screen.queryBy*(...), null)`.
  assert.ok(!screen.queryByRole('option'));
});
