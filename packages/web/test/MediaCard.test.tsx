import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MediaCard } from '../src/components/MediaCard.tsx';
import { groupAnchor } from '../src/api/anchors.ts';
import type { GroupView, ManualField, MetadataView } from '../src/api/client.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its card behind, and every later query sees two.
afterEach(cleanup);

/**
 * Absence, as a boolean.
 *
 * `assert.equal(screen.queryByText(x), null)` is the obvious spelling and it
 * kills the run: node:assert deep-inspects a live DOM element to build the
 * failure message, which burns ~75s and takes the whole file down without
 * naming a test. See the same helper in `Browse.test.tsx`.
 */
function gone(text: string | RegExp): boolean {
  return screen.queryByText(text) === null;
}

/** The card element itself, which is where the anchor id lives. */
function card(title: string): HTMLElement {
  const element = screen.getByText(title).closest('article');
  assert.ok(element !== null, `no card for ${title}`);
  return element;
}

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
  metadata: { state: 'absent' },
};

const CONFIRMED: MetadataView = {
  state: 'confirmed',
  title: 'A Different Title',
  performers: ['Alex Coal', 'Jane Doe'],
  releaseDate: '2023-04-15',
  durationSeconds: 1800,
  synopsis: 'A synopsis from the provider.',
  hasPoster: true,
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
  // No `downloadFailed` on any release, so nothing claims a failure. The server
  // omits the field for a healthy release rather than sending `false`.
  assert.equal(gone(/failed/i), true);
});

test('a card carries the anchor a Downloads row links to', () => {
  // The id is what makes `/picks#…` land somewhere.
  //
  // Asserted as a *literal*, not as `groupAnchor(GROUP.id)`. Computing the
  // expectation by calling the code under test is how `groupAnchor` came to be
  // pinned by nothing: made to return a constant `group-x` it passed every test
  // in this suite, including the end-to-end one — both ends agreed, on the
  // wrong string, and every card on the page claimed the same DOM id, so a
  // Downloads link scrolled to whichever rendered first. Two different ids are
  // spelled out here and in `Downloads.test.tsx`, which no constant and no
  // non-identity mapping can satisfy.
  const { rerender } = render(<MediaCard group={GROUP} onPick={() => {}} />);
  assert.equal(card('Alex Coal').id, 'group-1');

  // Stable across renders: a link followed after the list refreshes has to
  // find the same element, so the id cannot be per-mount or generated.
  rerender(<MediaCard group={{ ...GROUP, listRankAt: 200 }} onPick={() => {}} />);
  assert.equal(card('Alex Coal').id, 'group-1');

  // Derived from the group, so two cards never collide. `groupAnchor` here
  // rather than a literal on purpose: this assertion is about the card
  // agreeing with the shared function, which the literals above have already
  // pinned to a value.
  cleanup();
  render(<MediaCard group={{ ...GROUP, id: 7 }} onPick={() => {}} />);
  assert.equal(card('Alex Coal').id, groupAnchor(7));
  assert.notEqual(groupAnchor(7), groupAnchor(1));
});

/** `GROUP`'s releases with `downloadFailed` set on the ids named. */
function failing(...ids: number[]): GroupView['releases'] {
  return GROUP.releases.map((release) =>
    ids.includes(release.id) ? { ...release, downloadFailed: true } : release,
  );
}

test('a pick whose download failed reads Failed, not Current', () => {
  // `Current` is exactly the wrong word for a file the user does not have.
  // The colour is the stylesheet's business; what is asserted here is the word
  // a human reads.
  render(
    <MediaCard
      group={{ ...GROUP, state: 'picked', pickedReleaseId: 1, releases: failing(1) }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText('Failed'));
  assert.equal(gone(/current/i), true);
  // The pick is not released — the user still wants the content — so the
  // failed release keeps its slot and the untried versions keep their Pick
  // buttons. That is the whole reason for linking here.
  assert.equal(screen.getAllByRole('button', { name: /pick/i }).length, 1);
});

test('a failed release that is not the pick reads Failed and keeps its Pick button', () => {
  // The case that widened the rule: the user owns release 1, asked to upgrade
  // to release 2, and that failed. `pickedReleaseId` never moved — an upgrade
  // defers it until the replacement imports — so the failure is on a row that
  // is not the current one, and the card has to be able to say so.
  render(
    <MediaCard
      group={{ ...GROUP, state: 'picked', pickedReleaseId: 1, releases: failing(2) }}
      onPick={() => {}}
    />,
  );

  assert.ok(screen.getByText('Failed'));
  // Release 1 still imported fine, so it is still the current file.
  assert.ok(screen.getByText('Current'));
  // Beside the label, not instead of it: picking it again is how a user retries
  // from this screen, and it is why they were sent here.
  assert.equal(screen.getAllByRole('button', { name: /pick/i }).length, 1);
});

test('only the release that failed is marked', () => {
  // One `Failed`, not one per row: the flag is per release, and a card that
  // marked every row would tell the user nothing about which version to avoid.
  render(
    <MediaCard
      group={{ ...GROUP, state: 'picked', pickedReleaseId: 1, releases: failing(2) }}
      onPick={() => {}}
    />,
  );
  assert.equal(screen.getAllByText('Failed').length, 1);
});

test('the metadata panel renders only once the answer is confirmed', () => {
  const unconfirmed: MetadataView[] = [{ state: 'absent' }, { state: 'pending' }, { state: 'none' }];
  for (const metadata of unconfirmed) {
    const { unmount } = render(<MediaCard group={{ ...GROUP, metadata }} onPick={() => {}} />);
    // #40: never `assert.equal(screen.queryByText(x), null)` — it OOM-kills
    // the web test run inside `waitFor`, and the same failure mode applies to
    // any assertion node:assert would have to deep-inspect a live element to
    // report on.
    assert.ok(!screen.queryByText('A synopsis from the provider.'));
    assert.ok(!screen.queryByRole('img'));
    unmount();
  }

  render(<MediaCard group={{ ...GROUP, metadata: CONFIRMED }} onPick={() => {}} />);
  assert.ok(screen.getByText('A synopsis from the provider.'));
});

test('a pending lookup says so; none and absent stay silent', () => {
  const { unmount } = render(
    <MediaCard group={{ ...GROUP, metadata: { state: 'pending' } }} onPick={() => {}} />,
  );
  assert.ok(screen.getByText('pending'));
  unmount();

  render(<MediaCard group={{ ...GROUP, metadata: { state: 'none' } }} onPick={() => {}} />);
  // #40: never `assert.equal(screen.queryByText(x), null)`.
  assert.equal(gone('pending'), true);
  cleanup();

  render(<MediaCard group={{ ...GROUP, metadata: { state: 'absent' } }} onPick={() => {}} />);
  assert.equal(gone('pending'), true);
});

test('the parsed title stays the card title when metadata disagrees', () => {
  // Phase 1 is deliberately non-destructive: the panel is a second opinion,
  // never a replacement. `display.title` is what the parser produced, and
  // `CONFIRMED.title` is a deliberately different string from the provider.
  render(<MediaCard group={{ ...GROUP, metadata: CONFIRMED }} onPick={() => {}} />);

  assert.equal(screen.getByRole('heading', { level: 2 }).textContent, 'Alex Coal');
  // The provider's disagreeing title is still shown — just not as *the* title.
  assert.ok(screen.getByText('A Different Title'));
});

test('the panel renders the provider release date and a human-formatted running time', () => {
  render(
    <MediaCard
      group={{
        ...GROUP,
        metadata: { ...CONFIRMED, releaseDate: '2023-05-01', durationSeconds: 5400 },
      }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText('2023-05-01'));
  assert.ok(screen.getByText('1h 30m'));
});

test('a missing release date or running time is independently absent from the panel', () => {
  render(
    <MediaCard
      group={{ ...GROUP, metadata: { ...CONFIRMED, releaseDate: null, durationSeconds: null } }}
      onPick={() => {}}
    />,
  );
  // #40: never `assert.equal(screen.queryByText(x), null)`.
  assert.ok(!screen.queryByText('1h 30m'));
  assert.ok(!screen.queryByText('30m'));
  // The rest of the panel still rendered — proof neither absence took the
  // whole panel down with it.
  assert.ok(screen.getByText('A Different Title'));

  const { unmount } = render(
    <MediaCard
      group={{ ...GROUP, metadata: { ...CONFIRMED, releaseDate: null, durationSeconds: 1800 } }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText('30m'));
  unmount();

  render(
    <MediaCard
      group={{ ...GROUP, metadata: { ...CONFIRMED, releaseDate: '2023-05-01', durationSeconds: null } }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText('2023-05-01'));
});

test('no duration renders nothing; a duration of zero still renders 0m', () => {
  // formatDuration maps both "no duration" and "a duration of zero" to
  // rendering-adjacent outcomes — the latter literally formats to `0m` — so
  // asserting `0m` is absent for `null` only pins the guard if a duration of
  // zero is also proven to render. Without that second case, removing the
  // `!== null` check and letting `formatDuration(null)` produce `0m` for the
  // null case too would slip past unnoticed.
  const { unmount } = render(
    <MediaCard
      group={{ ...GROUP, metadata: { ...CONFIRMED, durationSeconds: null } }}
      onPick={() => {}}
    />,
  );
  // #40: never `assert.equal(screen.queryByText(x), null)`.
  assert.equal(gone('0m'), true);
  unmount();

  render(
    <MediaCard
      group={{ ...GROUP, metadata: { ...CONFIRMED, durationSeconds: 0 } }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText('0m'));
});

test('the panel tolerates a missing poster, synopsis and empty performers independently', () => {
  render(
    <MediaCard
      group={{
        ...GROUP,
        metadata: { ...CONFIRMED, hasPoster: false, synopsis: null, performers: [] },
      }}
      onPick={() => {}}
    />,
  );
  assert.ok(!screen.queryByRole('img'));
  assert.ok(!screen.queryByText('A synopsis from the provider.'));
  // The title, which the same record still carries, proves the panel itself
  // rendered — the three tolerances above are independent absences, not one
  // that took the whole panel down with it.
  assert.ok(screen.getByText('A Different Title'));

  const { unmount } = render(
    <MediaCard group={{ ...GROUP, metadata: { ...CONFIRMED, synopsis: null } }} onPick={() => {}} />,
  );
  assert.ok(screen.getByRole('img'));
  assert.ok(!screen.queryByText('A synopsis from the provider.'));
  assert.ok(screen.getByText('Alex Coal', { selector: 'li' }));
  unmount();

  render(
    <MediaCard group={{ ...GROUP, metadata: { ...CONFIRMED, performers: [] } }} onPick={() => {}} />,
  );
  assert.ok(screen.getByRole('img'));
  assert.ok(screen.getByText('A synopsis from the provider.'));
});
