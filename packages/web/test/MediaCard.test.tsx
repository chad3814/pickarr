import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MediaCard } from '../src/components/MediaCard.tsx';
import type { GroupView, ManualField } from '../src/api/client.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its card behind, and every later query sees two.
afterEach(cleanup);

const GROUP: GroupView = {
  id: 1,
  plugin: 'scenes',
  display: {
    title: 'Alex Coal',
    subtitle: 'Brazzers',
    date: '2023-04-15',
    fields: [{ label: 'Site', value: 'Brazzers' }],
  },
  state: 'new',
  pickedReleaseId: null,
  upgradeReleaseId: null,
  listRankAt: 100,
  releases: [
    { id: 2, score: 2160, quality: { resolution: 2160 }, releaseName: 'R2', publishedAt: null },
    { id: 1, score: 1080, quality: { resolution: 1080 }, releaseName: 'R1', publishedAt: null },
  ],
};

test('renders the display fields', () => {
  render(<MediaCard group={GROUP} onPick={() => {}} />);
  assert.ok(screen.getByText('Alex Coal'));
  assert.ok(screen.getByText('Brazzers'));
  assert.ok(screen.getByText('2023-04-15'));
});

test('shows one pick control per release, best first', () => {
  render(<MediaCard group={GROUP} onPick={() => {}} />);
  const buttons = screen.getAllByRole('button', { name: /pick/i });
  assert.equal(buttons.length, 2);
  assert.ok(screen.getByText(/2160p/));
});

test('picking a release reports its id', () => {
  const picked: number[] = [];
  render(<MediaCard group={GROUP} onPick={(releaseId) => picked.push(releaseId)} />);
  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);
  assert.deepEqual(picked, [2]);
});

test('an upgrade-flagged group is badged', () => {
  render(
    <MediaCard
      group={{ ...GROUP, state: 'picked', pickedReleaseId: 1, upgradeReleaseId: 2 }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText(/upgrade available/i));
});

const FIELDS: ManualField[] = [
  { name: 'site', label: 'Site', type: 'text', scope: 'identity', required: true },
  { name: 'resolution', label: 'Resolution', type: 'text', scope: 'quality' },
];

/** Everything an edit needs except somewhere to send it. */
const EDITABLE: GroupView = {
  ...GROUP,
  manualValues: { site: 'Brazzers', resolution: '' },
  releases: GROUP.releases.map((release) => ({
    ...release,
    manualValues: { site: 'Brazzers', resolution: '2160p' },
  })),
};

test('a card given no edit handlers offers no edit controls', () => {
  // The handlers are optional so that a screen with nowhere to send an edit —
  // and any caller written before there was one — gets a card with no controls
  // rather than controls that do nothing. The prefills and the schema are both
  // present here, so their absence is not what is being tested.
  render(<MediaCard group={EDITABLE} onPick={() => {}} fields={FIELDS} />);
  assert.equal(screen.queryAllByRole('button', { name: /edit/i }).length, 0);
});

test('an empty prefill is still a prefill', () => {
  // The control keys off the *absence* of `manualValues`, which is how a plugin
  // with no manual hooks reaches the UI. A plugin whose fields are all optional
  // can legitimately read a record back as no values at all, and that record is
  // still editable.
  render(
    <MediaCard
      group={{ ...EDITABLE, manualValues: {} }}
      onPick={() => {}}
      fields={FIELDS}
      onEditGroup={async () => true}
      onEditRelease={async () => true}
    />,
  );
  assert.ok(screen.getByRole('button', { name: 'Edit' }));
});

test('the release you already own is marked and not offered again', () => {
  render(
    <MediaCard
      group={{ ...GROUP, state: 'picked', pickedReleaseId: 1, upgradeReleaseId: 2 }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText(/current/i));
  assert.equal(screen.getAllByRole('button', { name: /pick/i }).length, 1);
});
