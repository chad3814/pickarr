import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MediaCard } from '../src/components/MediaCard.tsx';
import { groupAnchor } from '../src/api/anchors.ts';
import type { GroupView, ManualField, MetadataView, PerformerView } from '../src/api/client.ts';
import { gone } from './dom.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its card behind, and every later query sees two.
afterEach(cleanup);

/** A stand-in `onRequeryMetadata` for tests that only need the button to render. */
async function noop(): Promise<void> {}

/** An `onRequeryMetadata` that always refuses, carrying a message a test can look for. */
async function refuseRequery(): Promise<void> {
  throw new Error('Metadata lookups are unavailable.');
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
  performerNames: ['Alex Coal', 'Jane Doe'],
  releaseDate: '2023-04-15',
  durationSeconds: 1800,
  synopsis: 'A synopsis from the provider.',
  hasPoster: true,
  hasBackground: false,
};

function withMetadata(over: Partial<Extract<MetadataView, { state: 'confirmed' }>>): GroupView {
  return {
    ...GROUP,
    metadata: { ...(CONFIRMED as Extract<MetadataView, { state: 'confirmed' }>), ...over },
  };
}

function performer(over: Partial<PerformerView>): PerformerView {
  return { id: 4, name: 'Alice Maze', url: 'https://example/alice', hasAvatar: true, hasImage: true, ...over };
}

test('renders the display fields', () => {
  render(<MediaCard group={GROUP} onPick={() => {}} />);
  assert.ok(screen.getByText('Alex Coal'));
  assert.ok(screen.getByText('Brazzers'));
  // `display.date` is no longer rendered: this group has no provider answer
  // (`metadata: { state: 'absent' }`), and the parsed date has no fallback
  // role left on the card now that the header shows only the provider's.
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

test('the provider synopsis renders only once the answer is confirmed', () => {
  // Only the synopsis. The `img` check below is not about the state at all —
  // this fixture is bare `GROUP`, with no poster and no performers, so there
  // is no image to draw whatever the answer says. The slot follows the images
  // rather than the scene answer, which the test named for that further down
  // this file is the one that pins.
  const unconfirmed: MetadataView[] = [{ state: 'absent' }, { state: 'pending' }, { state: 'none' }];
  for (const metadata of unconfirmed) {
    const { unmount } = render(<MediaCard group={{ ...GROUP, metadata }} onPick={() => {}} />);
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
  assert.equal(gone('pending'), true);
  cleanup();

  render(<MediaCard group={{ ...GROUP, metadata: { state: 'absent' } }} onPick={() => {}} />);
  assert.equal(gone('pending'), true);
});

test('the card shows the provider title, not the parsed one', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'A Different Title' }));
  // The parsed title is performer-name-led; adopting the provider's is the point
  // of this phase, so the parsed one must not also be on screen as a heading.
  assert.ok(!screen.queryByRole('heading', { level: 2, name: 'Alex Coal' }));
});

test('the parsed title is the fallback when the provider has no title', () => {
  render(<MediaCard group={withMetadata({ title: null })} onPick={() => {}} />);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Alex Coal' }));
});

test('an empty provider title falls back too, rather than rendering an empty heading', () => {
  // `''`, not `null`: `maybeStr` (`db/row.ts`) folds only `NULL` and `undefined`
  // into `null`, so an empty title column reaches the card as an empty string
  // and `??` would accept it — leaving a card with no heading at all and
  // nothing on it naming the group.
  render(<MediaCard group={withMetadata({ title: '' })} onPick={() => {}} />);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Alex Coal' }));
});

test('an empty studio leaves no orphan separator either', () => {
  // The same emptiness, one line down. An empty subtitle rendered as a span
  // is invisible, and the CSS separator between adjacent spans still draws
  // for it, so the line reads ` · 2023-04-15 · 30m` with nothing before the
  // first separator.
  render(
    <MediaCard
      group={{ ...withMetadata({}), display: { ...GROUP.display, subtitle: '' } }}
      onPick={() => {}}
    />,
  );
  const context = card('A Different Title').querySelector('.card-context');
  assert.ok(context !== null, 'no context line');
  assert.equal(context.querySelectorAll('span').length, 2, 'the empty studio drew no span');
  assert.equal(context.textContent, '2023-04-1530m');
});

test('an empty synopsis renders no paragraph at all', () => {
  // `''` reaches `!== null` intact, and an empty `.metadata-synopsis` is not
  // invisible: the rule carries `margin: var(--space-2) 0 0`, so it costs the
  // same 8px band the cast list returns `null` to avoid.
  render(<MediaCard group={withMetadata({ synopsis: '' })} onPick={() => {}} />);
  assert.ok(!card('A Different Title').querySelector('.metadata-synopsis'));
});

test('a group with no confirmed answer falls back too', () => {
  render(<MediaCard group={{ ...GROUP, metadata: { state: 'none' } }} onPick={() => {}} />);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Alex Coal' }));
});

test('the context line joins studio, provider date and runtime', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  const context = card('A Different Title').querySelector('.card-context');
  assert.ok(context !== null, 'no context line');
  // Asserted as one string because the parts and their order are all this test
  // can see. The separators are CSS `::before` content, which `textContent`
  // does not include, so the parts run together below — and this assertion
  // would read exactly the same with `card.css`'s separator rule deleted. The
  // separator itself is pinned where generated content exists, in
  // `packages/e2e/tests/card-layout.spec.ts`.
  // `formatDuration(1800)` is '30m' — verified against packages/web/src/api/format.ts,
  // not assumed.
  assert.equal(context.textContent, 'Brazzers2023-04-1530m');
});

test('an absent part leaves no separator behind', () => {
  // The provider populates these unevenly — a running time with no release
  // date was recorded as ordinary rather than rare by the scene panel this
  // branch deleted, and `MediaCard`'s context-line comment carries that
  // forward in the past tense — so each part renders on its own condition and
  // the separator is CSS between siblings.
  render(<MediaCard group={withMetadata({ releaseDate: null, durationSeconds: null })} onPick={() => {}} />);
  const context = card('A Different Title').querySelector('.card-context');
  assert.equal(context?.textContent, 'Brazzers', 'no orphan separator');
  assert.equal(context?.querySelectorAll('span').length, 1, 'one part means one span');
});

test('the parsed date is not shown when the provider has no date', () => {
  // Spec §4: the date falls back to nothing, not to display.date.
  render(<MediaCard group={withMetadata({ releaseDate: null })} onPick={() => {}} />);
  const context = card('A Different Title').querySelector('.card-context');
  assert.ok(context !== null, 'no context line');
  assert.ok(!context.textContent?.includes('2023-04-15'), 'display.date must not stand in');
});

test('a group with no studio, date or runtime renders no context line at all', () => {
  const bare: GroupView = {
    ...GROUP,
    display: { title: 'Alex Coal', fields: [] },
    metadata: { state: 'none' },
  };
  render(<MediaCard group={bare} onPick={() => {}} />);
  // #40: never `assert.equal(screen.queryBy*(...), null)`.
  assert.ok(!card('Alex Coal').querySelector('.card-context'));
});

test('the scene link wraps whichever title renders', () => {
  const url = 'https://theporndb.net/scenes/s';
  render(<MediaCard group={withMetadata({ sceneUrl: url })} onPick={() => {}} />);
  const link = screen.getByRole('link', { name: 'A Different Title' });
  // A literal, not the fixture value: both ends agreeing on a wrong string is
  // the failure this style of assertion exists to catch.
  assert.equal(link.getAttribute('href'), 'https://theporndb.net/scenes/s');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');

  cleanup();
  render(<MediaCard group={withMetadata({ title: null, sceneUrl: url })} onPick={() => {}} />);
  assert.ok(screen.getByRole('link', { name: 'Alex Coal' }), 'the fallback title links too');
});

test('the identity column no longer carries a second title, date or duration', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  const cardEl = card('A Different Title');
  for (const cls of ['.metadata-title', '.metadata-release-date', '.metadata-duration']) {
    assert.ok(!cardEl.querySelector(cls), `${cls} moved into the header`);
  }
  // The synopsis keeps its class name across this task's move into
  // `.card-head-main` — this only checks presence, not where.
  assert.ok(cardEl.querySelector('.metadata-synopsis'));
});

test('the artwork leads: it starts before the identity column in the DOM', () => {
  render(<MediaCard group={withMetadata({ hasPoster: true })} onPick={() => {}} />);
  const head = card('A Different Title').querySelector('.card-head');
  assert.ok(head !== null, 'no card head');
  const children = [...head.children];
  const artwork = head.querySelector('.card-artwork');
  const main = head.querySelector('.card-head-main');
  assert.ok(artwork !== null && main !== null, 'head is missing a column');
  // DOM order, not CSS order: `flex-direction: row-reverse` or an `order`
  // property would put the artwork on the left visually while leaving a screen
  // reader and the tab order reading the identity column first.
  const artworkIndex = children.indexOf(artwork);
  const mainIndex = children.indexOf(main);
  // `indexOf` returns -1 for a non-member, and -1 is less than every real
  // index — asserting the ordering alone would pass vacuously if `.card-artwork`
  // ever stopped being a direct child of `.card-head` (moved a level deeper,
  // say), rendered after the identity column but still "less than" it by
  // this comparison.
  assert.ok(artworkIndex !== -1 && mainIndex !== -1, 'artwork or identity column is not a direct child of .card-head');
  assert.ok(artworkIndex < mainIndex, 'artwork precedes the identity column');
});

test('the synopsis and cast render inside the identity column, not below the releases', () => {
  render(<MediaCard group={withMetadata({ performers: [
    { id: 4, name: 'Alice Maze', url: 'https://example/alice', hasAvatar: true, hasImage: true },
  ] })} onPick={() => {}} />);
  const main = card('A Different Title').querySelector('.card-head-main');
  assert.ok(main !== null, 'no identity column');
  assert.ok(main.querySelector('.metadata-synopsis'), 'the synopsis moved up');
  assert.ok(main.querySelector('.metadata-performers'), 'the cast moved up');
});

test('the pending note renders right after the header, ahead of the actions and the fields', () => {
  // Given an editable group and a handler, so `.card-actions` is on screen to
  // be ordered against: with `header < pending < fields` alone, moving the
  // actions row above the note passed.
  render(
    <MediaCard
      group={{ ...EDITABLE, metadata: { state: 'pending' } }}
      onPick={() => {}}
      fields={FIELDS}
      onEditGroup={async () => true}
    />,
  );
  const main = card('Alex Coal').querySelector('.card-head-main');
  assert.ok(main !== null, 'no identity column');
  const header = main.querySelector('header');
  const pending = main.querySelector('.metadata-pending');
  const actions = main.querySelector('.card-actions');
  const fields = main.querySelector('.fields');
  assert.ok(
    header !== null && pending !== null && actions !== null && fields !== null,
    'identity column is missing a part',
  );
  const children = [...main.children];
  const headerIndex = children.indexOf(header);
  const pendingIndex = children.indexOf(pending);
  const actionsIndex = children.indexOf(actions);
  const fieldsIndex = children.indexOf(fields);
  assert.ok(
    headerIndex !== -1 && pendingIndex !== -1 && actionsIndex !== -1 && fieldsIndex !== -1,
    'header, pending note, actions or fields is not a direct child of the identity column',
  );
  // Spec §3, position 4: right after the badge, before `.card-actions` and the
  // fields — the note describes the lookup that will change the title and
  // context line above it, not the chips below.
  //
  // Position 5, the identity form, is not pinned here and cannot be on this
  // card: the form renders only while `editing`, and `.card-actions` on a
  // pending group renders only while `canEdit && !editing` — `settled` is
  // false for `pending`, so there is no Requery button to keep the row alive
  // once the form opens. One render can hold the note and the form, or the
  // note and the actions row, never all three.
  assert.ok(
    headerIndex < pendingIndex && pendingIndex < actionsIndex && actionsIndex < fieldsIndex,
    'the pending note sits between the header and the actions row, which sits above the fields',
  );
});

test('the metadata section wrapper is gone', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  // Its children now live in the identity column, so a wrapper whose only job
  // was grouping them below the releases has nothing left to group.
  assert.ok(!card('A Different Title').querySelector('section.metadata'));
});

test('the cast renders once for a confirmed group and once for an unconfirmed one', () => {
  const performers = [
    { id: 4, name: 'Alice Maze', url: 'https://example/alice', hasAvatar: true, hasImage: true },
  ];
  render(<MediaCard group={withMetadata({ performers })} onPick={() => {}} />);
  assert.equal(card('A Different Title').querySelectorAll('.metadata-performers').length, 1);
  cleanup();

  // The old code had two call sites for exactly this pair of cases. With no
  // enclosing section to be inside or outside of, one site serves both — and
  // the exclusivity the old comment maintained by hand is now structural.
  render(<MediaCard group={{ ...GROUP, metadata: { state: 'none', performers } }} onPick={() => {}} />);
  assert.equal(card('Alex Coal').querySelectorAll('.metadata-performers').length, 1);
});

test('the release rows stay after the head, not inside it', () => {
  render(<MediaCard group={withMetadata({})} onPick={() => {}} />);
  const cardEl = card('A Different Title');
  const head = cardEl.querySelector('.card-head');
  const releases = cardEl.querySelector('ul.releases');
  assert.ok(head !== null && releases !== null, 'card is missing a part');
  assert.ok(!head.contains(releases), 'the releases render outside the head, not inside it');
});

test('the card shows the provider release date and a human-formatted running time', () => {
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

test('a missing release date or running time is independently absent from the context line', () => {
  render(
    <MediaCard
      group={{ ...GROUP, metadata: { ...CONFIRMED, releaseDate: null, durationSeconds: null } }}
      onPick={() => {}}
    />,
  );
  assert.ok(!screen.queryByText('1h 30m'));
  assert.ok(!screen.queryByText('30m'));
  // The title still renders regardless — proof neither absence took the
  // rest of the header down with it.
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

test('the identity column tolerates a missing poster, synopsis and empty performers independently', () => {
  render(
    <MediaCard
      group={{
        ...GROUP,
        metadata: { ...CONFIRMED, hasPoster: false, synopsis: null, performerNames: [] },
      }}
      onPick={() => {}}
      onRequeryMetadata={noop}
    />,
  );
  assert.ok(!screen.queryByRole('img'));
  assert.ok(!screen.queryByText('A synopsis from the provider.'));
  // `section.metadata` used to give a confirmed-but-empty group a labelled
  // region to check for even when poster, synopsis and cast were all absent.
  // With that wrapper gone the loss is narrower than "nothing identifies this
  // card": `settled` in `MediaCard.tsx` is `(confirmed || none) && a requery
  // handler`, and both routes pass one, so the Requery button below separates
  // this card from a group that was never asked. What is genuinely
  // indistinguishable now is `confirmed`-with-nothing from `none` — the two
  // states `settled` deliberately treats alike — and closing *that* would mean
  // re-adding the wrapper this task dissolves. Recorded in
  // `docs/known-issues.md` under "Test-suite blind spots".
  assert.ok(
    screen.getByRole('button', { name: /requery/i }),
    'a confirmed group with no poster, synopsis or cast still renders something identifiable',
  );

  // What this test's name promises — that the three absences are
  // independent, not one masking another — is only partly pinned below, by
  // the two renders that follow. Render 2 isolates the synopsis: poster and
  // cast both keep `CONFIRMED`'s present values, and only `synopsis` is set
  // to `null`, so its absence there cannot be explained by the other two
  // also being gone. Render 3 does the same for the cast: poster and
  // synopsis stay present, and only `performerNames` is emptied. Neither
  // isolates the poster — the only render above where the poster is absent
  // also empties the synopsis and the cast at the same time, so a
  // poster-only absence is untested here; a third render setting just
  // `hasPoster: false` would be needed to close that gap.

  const { unmount } = render(
    <MediaCard group={{ ...GROUP, metadata: { ...CONFIRMED, synopsis: null } }} onPick={() => {}} />,
  );
  assert.ok(screen.getByRole('img'));
  assert.ok(!screen.queryByText('A synopsis from the provider.'));
  assert.ok(screen.getByText('Alex Coal', { selector: 'li' }));
  unmount();

  render(
    <MediaCard group={{ ...GROUP, metadata: { ...CONFIRMED, performerNames: [] } }} onPick={() => {}} />,
  );
  assert.ok(screen.getByRole('img'));
  assert.ok(screen.getByText('A synopsis from the provider.'));
  assert.ok(
    !screen.queryByText('Alex Coal', { selector: 'li' }),
    'the cast is absent when performerNames is empty',
  );
});

test('the slot is a button that opens the modal, and the modal closes', () => {
  render(<MediaCard group={withMetadata({ hasPoster: true })} onPick={() => {}} />);
  assert.ok(!screen.queryByRole('dialog'));
  fireEvent.click(screen.getByRole('button', { name: /browse images for/i }));
  assert.ok(screen.getByRole('dialog'));
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  assert.ok(!screen.queryByRole('dialog'));
});

test('the slot shows the poster when there is one', () => {
  render(
    <MediaCard group={withMetadata({ hasPoster: true, hasBackground: true })} onPick={() => {}} />,
  );
  assert.equal(
    screen.getByRole('img', { name: 'Poster for Alex Coal' }).getAttribute('src'),
    '/api/groups/1/poster',
  );
});

test('a background alone draws no slot, because a 2:3 frame would crop it', () => {
  render(
    <MediaCard group={withMetadata({ hasPoster: false, hasBackground: true, performers: [] })}
               onPick={() => {}} />,
  );
  // The background is still in `groupImages`' list (see groupImages.test.ts)
  // — only this frame refuses it. With no cast portrait, though, this
  // fixture has no slot and no avatar either, so nothing on the card opens
  // the modal: here the background is unreachable, not one click away.
  assert.ok(!screen.queryByRole('img', { name: /for Alex Coal/i }));
});

test('with no poster the slot falls to the first performer portrait', () => {
  render(
    <MediaCard
      group={withMetadata({
        hasPoster: false,
        hasBackground: true,
        performers: [performer({ id: 4, name: 'Alice Maze' }), performer({ id: 5, name: 'Bea Vale' })],
      })}
      onPick={() => {}}
    />,
  );
  const slot = card('A Different Title').querySelector('.card-artwork img');
  assert.equal(slot?.getAttribute('src'), '/api/performers/4/image');
  // Announced as the performer, never as the scene's poster.
  assert.equal(slot?.getAttribute('alt'), 'Alice Maze');
});

test('neither image means no slot at all, as before', () => {
  // `performerNames: []` empties the cast, which is what this test is about
  // anyway — the header's h2 now reads 'A Different Title' (the provider's),
  // so 'Alex Coal' surviving only as a cast `<li>` (see `CONFIRMED`) is no
  // longer ambiguous with `card()`'s lookup the way it was before this task.
  render(
    <MediaCard
      group={withMetadata({ hasPoster: false, hasBackground: false, performers: [], performerNames: [] })}
      onPick={() => {}}
    />,
  );
  assert.ok(!card('A Different Title').querySelector('.card-artwork'));
});

test('the slot renders for a group whose scene lookup returned nothing', () => {
  // The slot follows the images, not the scene answer. The cast list already
  // renders at any state; gating the slot produced cards that named a
  // performer they would not show.
  render(
    <MediaCard
      group={{ ...GROUP, metadata: { state: 'none', performers: [performer({ id: 4 })] } }}
      onPick={() => {}}
    />,
  );
  assert.equal(
    card('Alex Coal').querySelector('.card-artwork img')?.getAttribute('src'),
    '/api/performers/4/image',
  );
});

test('the slot opens the modal on the whole list, starting at the scene image', () => {
  render(
    <MediaCard
      group={withMetadata({
        hasPoster: false,
        hasBackground: true,
        performers: [performer({ id: 4, name: 'Alice Maze' })],
      })}
      onPick={() => {}}
    />,
  );
  // Unscoped, and it has to stay that way: with no poster the slot shows this
  // performer's portrait, so the slot and her cast-list avatar below would
  // collide on one name if the slot took its own from the image's `alt`. It
  // does not — the button is named for what it does — so this query reaches
  // exactly one control, and it is the one whose whole point is that it opens
  // somewhere other than the image it is showing.
  //
  // The name is spelled out rather than matched loosely because it is the one
  // place the button's accessible name is pinned to a value: the group it
  // names is `A Different Title`, the provider title the `<h2>` renders, and
  // not the parsed `Alex Coal`, which appears nowhere on this card.
  fireEvent.click(screen.getByRole('button', { name: 'Browse images for A Different Title' }));
  const dialog = screen.getByRole('dialog');
  // Index 0 is the background, which is not what was clicked. Deliberate: the
  // browse runs from the scene's own images outward.
  assert.equal(dialog.querySelector('img')?.getAttribute('src'), '/api/groups/1/background');
  assert.ok(screen.getByText('Background · 1 of 2'));
});

test('a performer shows an avatar, and their name links to their page', () => {
  render(<MediaCard group={withMetadata({ performers: [
    { id: 4, name: 'Alice Maze', url: 'https://theporndb.net/performers/alice-maze',
      hasAvatar: true, hasImage: true },
  ] })} onPick={() => {}} />);

  const link = screen.getByRole('link', { name: 'Alice Maze' });
  // A literal, not the value from the fixture: both ends agreeing on a wrong
  // string is the failure this style of assertion exists to catch.
  assert.equal(link.getAttribute('href'), 'https://theporndb.net/performers/alice-maze');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(screen.getByRole('img', { name: /alice maze/i }).getAttribute('src'),
    '/api/performers/4/avatar');
});

test('a performer with no cached avatar renders a name and no image', () => {
  render(<MediaCard group={withMetadata({ performers: [
    { id: 4, name: 'Alice Maze', url: 'https://theporndb.net/performers/alice-maze',
      hasAvatar: false, hasImage: false },
  ] })} onPick={() => {}} />);
  assert.ok(screen.getByRole('link', { name: 'Alice Maze' }));
  assert.ok(!screen.queryByRole('img', { name: /alice maze/i }));
});

test('a performer avatar opens the same list at that performer', () => {
  render(
    <MediaCard
      group={withMetadata({
        hasPoster: true,
        performers: [performer({ id: 4, name: 'Alice Maze' }), performer({ id: 5, name: 'Bea Vale' })],
      })}
      onPick={() => {}}
    />,
  );
  // Two sizes exist for a reason: the avatar is a face crop, the modal wants
  // the full image.
  fireEvent.click(screen.getAllByRole('button', { name: 'Bea Vale' })[0]!);
  assert.equal(
    screen.getByRole('dialog').querySelector('img')?.getAttribute('src'),
    '/api/performers/5/image',
  );
  assert.ok(screen.getByText('Bea Vale · 3 of 3'));
});

test('a performer with an avatar but no full image is not clickable', () => {
  // Opening a modal onto a 404 is worse than not offering it. The avatar is
  // still shown — this asserts the button is absent, not the image.
  render(<MediaCard group={withMetadata({ performers: [
    { id: 4, name: 'Alice Maze', url: 'https://theporndb.net/performers/alice-maze',
      hasAvatar: true, hasImage: false },
  ] })} onPick={() => {}} />);

  assert.ok(screen.getByRole('img', { name: /alice maze/i }));
  assert.ok(!screen.queryByRole('button', { name: /alice maze/i }));
});

test('legacy metadata renders plain names with no links or avatars', () => {
  render(<MediaCard group={withMetadata({ performers: [], performerNames: ['Alice Maze'] })}
                    onPick={() => {}} />);
  assert.ok(screen.getByText('Alice Maze'));
  assert.ok(!screen.queryByRole('link', { name: 'Alice Maze' }));
});

test('a cast and legacy names together render only the cast', () => {
  // The server never sends both — `metadataViewOf` empties `performerNames`
  // the moment there is a structured cast — so this is a card built from a
  // response no current server produces. That is the point: as two
  // independent `&&` blocks the component rendered whichever the server
  // handed it, and would have rendered every performer twice the day that
  // guarantee moved or a rolled-back API stopped honouring it. Exclusivity is
  // now the component's own property.
  render(<MediaCard group={withMetadata({
    performers: [
      { id: 4, name: 'Alice Maze', url: 'https://theporndb.net/performers/alice-maze',
        hasAvatar: false, hasImage: false },
    ],
    performerNames: ['Alice Maze'],
  })} onPick={() => {}} />);

  // One node, not two: the linked one from the structured list.
  assert.equal(screen.getAllByText('Alice Maze').length, 1);
  assert.equal(screen.getByRole('link', { name: 'Alice Maze' }).getAttribute('href'),
    'https://theporndb.net/performers/alice-maze');
});

test('the metadata title links to the scene when a url is known', () => {
  render(<MediaCard group={withMetadata({ title: 'Scene', sceneUrl: 'https://theporndb.net/scenes/s' })}
                    onPick={() => {}} />);
  assert.equal(screen.getByRole('link', { name: 'Scene' }).getAttribute('href'),
    'https://theporndb.net/scenes/s');
});

test('the metadata title without a url is not a link', () => {
  render(<MediaCard group={withMetadata({ title: 'Scene', sceneUrl: null })} onPick={() => {}} />);
  assert.ok(screen.getByText('Scene'));
  assert.ok(!screen.queryByRole('link', { name: 'Scene' }));
});

test('the Requery button renders only once metadata is settled, and only with a handler to call', () => {
  // `absent` (never asked) and `pending` (already queued) are both the lazy
  // trigger's business, not this button's — a button that duplicated it
  // would be two paths to the one outcome.
  const { rerender } = render(
    <MediaCard group={{ ...GROUP, metadata: { state: 'absent' } }} onPick={() => {}} onRequeryMetadata={noop} />,
  );
  assert.ok(!screen.queryByRole('button', { name: /requery/i }));

  rerender(
    <MediaCard group={{ ...GROUP, metadata: { state: 'pending' } }} onPick={() => {}} onRequeryMetadata={noop} />,
  );
  assert.ok(!screen.queryByRole('button', { name: /requery/i }));

  // `none` (asked, nothing came back) and `confirmed` are both settled: an
  // answer is recorded either way, and either can be worth re-asking about.
  rerender(
    <MediaCard group={{ ...GROUP, metadata: { state: 'none' } }} onPick={() => {}} onRequeryMetadata={noop} />,
  );
  assert.ok(screen.getByRole('button', { name: 'Requery metadata' }));

  rerender(<MediaCard group={{ ...GROUP, metadata: CONFIRMED }} onPick={() => {}} onRequeryMetadata={noop} />);
  assert.ok(screen.getByRole('button', { name: 'Requery metadata' }));

  // A caller with nowhere to send a requery gets no button at all, the same
  // as `onEditGroup`'s absence takes the Edit button with it (see "a card
  // given no edit handlers offers no edit controls" above) — a settled
  // group is not enough on its own.
  rerender(<MediaCard group={{ ...GROUP, metadata: CONFIRMED }} onPick={() => {}} />);
  assert.ok(!screen.queryByRole('button', { name: /requery/i }));
});

test('clicking Requery calls the handler with this group\'s id', () => {
  const requeried: number[] = [];
  render(
    <MediaCard
      group={{ ...GROUP, metadata: CONFIRMED }}
      onPick={() => {}}
      onRequeryMetadata={async (groupId) => {
        requeried.push(groupId);
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Requery metadata' }));
  assert.deepEqual(requeried, [GROUP.id]);
});

test('clicking Requery disables it and shows in-flight text until the handler settles', async () => {
  let resolveRequery: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    resolveRequery = resolve;
  });

  render(
    <MediaCard
      group={{ ...GROUP, metadata: CONFIRMED }}
      onPick={() => {}}
      onRequeryMetadata={() => held}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Requery metadata' }));

  const inFlight = await waitFor(() => screen.getByRole('button', { name: /requerying/i }));
  assert.equal((inFlight as HTMLButtonElement).disabled, true);

  resolveRequery?.();
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Requery metadata' })));
});

test('the card keeps its title and cast on screen while a requery is in flight', async () => {
  let resolveRequery: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    resolveRequery = resolve;
  });

  render(
    <MediaCard
      group={{ ...GROUP, metadata: CONFIRMED }}
      onPick={() => {}}
      onRequeryMetadata={() => held}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Requery metadata' }));
  await waitFor(() => screen.getByRole('button', { name: /requerying/i }));

  // No blanking: the card keeps rendering the metadata it already has for as
  // long as the request is in flight. This card no longer holds any
  // metadata state of its own to blank in the first place — it only ever
  // reads `group.metadata` — but the behaviour this guards is exactly the
  // one the brief requires, so it stays asserted directly.
  assert.equal(screen.getByRole('heading', { level: 2 }).textContent, 'A Different Title');
  assert.ok(screen.getByText('Alex Coal', { selector: 'li' }));
  assert.ok(screen.getByText('A synopsis from the provider.'));

  resolveRequery?.();
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Requery metadata' })));
});

test('a rejected requery re-enables the button, shows the error, and keeps the existing metadata', async () => {
  render(
    <MediaCard
      group={{ ...GROUP, metadata: CONFIRMED }}
      onPick={() => {}}
      onRequeryMetadata={async () => {
        throw new Error('Invalid request');
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Requery metadata' }));

  await waitFor(() => assert.ok(screen.getByText('Invalid request')));

  // Re-enabled, not left disabled, so a retry is possible.
  const button = screen.getByRole('button', { name: 'Requery metadata' });
  assert.equal((button as HTMLButtonElement).disabled, false);

  // The existing metadata — untouched by the failure — is still on screen.
  assert.equal(screen.getByRole('heading', { level: 2 }).textContent, 'A Different Title');
  assert.ok(screen.getByText('A synopsis from the provider.'));
});

test('the card never overrides group.metadata itself — a fresher prop is what has to change what is shown', () => {
  // The first cut of this button kept a local override and refetched inside
  // the card; that was the architecture the button's "no blanking" bug came
  // from (a rearmed-but-not-yet-answered id has to be told apart from a
  // regression, and this card has no way to know the difference — only
  // `useGroupMetadata`, which owns the polling, does). This test pins the
  // fix: rendering a *fresher* `group` prop, with no requery ever clicked,
  // is enough on its own to update what the card shows — proof nothing here
  // is shadowing it with state of its own.
  const { rerender } = render(<MediaCard group={{ ...GROUP, metadata: CONFIRMED }} onPick={() => {}} />);
  assert.ok(screen.getByText('A synopsis from the provider.'));

  const fresher: MetadataView = { ...CONFIRMED, synopsis: 'A fresher synopsis.' };
  rerender(<MediaCard group={{ ...GROUP, metadata: fresher }} onPick={() => {}} />);

  assert.ok(screen.getByText('A fresher synopsis.'));
  assert.ok(!screen.queryByText('A synopsis from the provider.'));
});

test('an open identity form with no Requery button leaves no empty actions row behind', () => {
  // `.card-actions` carries vertical margin of its own, so an empty one is a
  // visible band of nothing rather than a harmless wrapper. It can only be
  // empty in one arrangement: a plugin that offers editing, on a group with no
  // settled metadata to requery, with the form already open — Edit is gone
  // because the form replaced it, and there is no second button to keep the
  // row occupied.
  render(
    <MediaCard
      group={EDITABLE}
      onPick={() => {}}
      fields={FIELDS}
      onEditGroup={async () => true}
    />,
  );
  assert.ok(card('Alex Coal').querySelector('.card-actions') !== null);

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

  assert.equal(card('Alex Coal').querySelector('.card-actions') === null, true);
});

test('a requery error goes away once a fresher answer arrives', async () => {
  // The message describes one attempt. A card that has since updated must not
  // keep wearing the reason an earlier attempt failed — the answer on screen
  // is no longer the one the error was about.
  const { rerender } = render(
    <MediaCard
      group={{ ...GROUP, metadata: CONFIRMED }}
      onPick={() => {}}
      onRequeryMetadata={refuseRequery}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Requery metadata' }));
  await waitFor(() => assert.ok(screen.getByText('Metadata lookups are unavailable.')));

  const fresher: MetadataView = { ...CONFIRMED, synopsis: 'A fresher synopsis.' };
  rerender(
    <MediaCard
      group={{ ...GROUP, metadata: fresher }}
      onPick={() => {}}
      onRequeryMetadata={refuseRequery}
    />,
  );

  assert.ok(screen.getByText('A fresher synopsis.'));
  assert.equal(gone('Metadata lookups are unavailable.'), true);
});

// The cast is a fact about the group, not about the scene answer. The performer
// search exists to find one for a group whose scene lookup settled *without* a
// cast, and the commonest form of that is `state: 'none'` — no scene matched.
// Reported live: such a group never showed a cast, because the server dropped it
// (`metadataViewOf`) and this card renders performers only inside its
// confirmed-only block. Both halves had to change; this is the card's half.

test('a group with no scene data still shows the cast the performer search found', () => {
  render(
    <MediaCard
      group={{
        ...GROUP,
        metadata: {
          state: 'none',
          performers: [
            { id: 9, name: 'Amalia Davis', url: 'https://theporndb.net/performers/amalia-davis',
              hasAvatar: false, hasImage: false },
          ],
        },
      }}
      onPick={() => {}}
    />,
  );

  const link = screen.getByRole('link', { name: 'Amalia Davis' });
  assert.equal(link.getAttribute('href'), 'https://theporndb.net/performers/amalia-davis');
});

test('a cast shows without scene data, and the rest of the scene data still does not', () => {
  // The fix must not smuggle the provider's other scene fields out of their
  // confirmed-only gate: a group the provider was asked about and had nothing
  // for has no title, synopsis, date or poster to show, and never gains one by
  // acquiring a cast.
  render(
    <MediaCard
      group={{
        ...GROUP,
        metadata: {
          state: 'none',
          performers: [
            { id: 9, name: 'Amalia Davis', url: 'https://theporndb.net/performers/amalia-davis',
              hasAvatar: false, hasImage: false },
          ],
        },
      }}
      onPick={() => {}}
    />,
  );

  assert.ok(screen.getByRole('link', { name: 'Amalia Davis' }));
  assert.ok(!screen.queryByText('A synopsis from the provider.'));
  assert.ok(!screen.queryByText('A Different Title'));
  assert.equal(gone('pending'), true);
});

test('a group with neither scene data nor a cast renders no performer list at all', () => {
  // The empty case stays empty. Not over a bullet — `.metadata-performers` is
  // `list-style: none` — but over that rule's `margin: var(--space-2) 0`,
  // which an empty `<ul>` would leave as a band of blank space at the foot of
  // the identity column on every unanswered card in the library.
  render(<MediaCard group={{ ...GROUP, metadata: { state: 'none', performers: [] } }} onPick={() => {}} />);
  assert.equal(document.querySelectorAll('.metadata-performers').length, 0);
});
