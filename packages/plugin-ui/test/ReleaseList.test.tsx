import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { NzbDownloadSyncRead, RssItemSyncRead, TorrentDownloadSyncRead } from '@pickarr/contract';
import { ReleaseList, PICK_LABELS } from '../src/ReleaseList.tsx';
import {
  PICK_REFUSAL_MESSAGES,
  type GatheredDownloadView as GatheredDownload,
  type GatheredReleaseView as GatheredRelease,
  type PickOutcome,
  type PickSubmit,
} from '../src/types.ts';

afterEach(cleanup);

/** An `RssItemSyncRead` with everything but `id`, `filename`, `resolution` and `rankingScore` defaulted. */
function rssItem({
  id,
  filename,
  resolution,
  rankingScore = null,
}: {
  id: number;
  filename: string;
  resolution: string;
  rankingScore?: number | null;
}): RssItemSyncRead {
  return {
    id,
    feedId: 1,
    filename,
    createdAt: 0,
    updatedAt: 0,
    downloadType: 'torrent',
    mediaItemId: null,
    rankingScore,
    resolution,
    resolutionDetail: null,
    lookupJson: null,
    deliveredAt: null,
  };
}

/** A `TorrentDownloadSyncRead` with everything but `id`, `status` and `percentage` defaulted. */
function torrent({
  id,
  status,
  percentage,
}: {
  id: number;
  status: string;
  percentage: number | null;
}): TorrentDownloadSyncRead {
  return {
    id,
    rssItemId: id,
    downloadClientId: 1,
    infohash: null,
    clientRef: null,
    status,
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    percentage,
    absentSince: null,
    deliveredAt: null,
    reclaimedAt: null,
  };
}

/** An `NzbDownloadSyncRead` with everything but `id` and `status` defaulted. */
function nzb({ id, status }: { id: number; status: string }): NzbDownloadSyncRead {
  return {
    id,
    rssItemId: id,
    downloadClientId: 1,
    clientRef: null,
    status,
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    percentage: null,
    absentSince: null,
    deliveredAt: null,
    reclaimedAt: null,
  };
}

function torrentDownload(row: TorrentDownloadSyncRead): GatheredDownload {
  return { table: 'torrent_download', id: row.id, row };
}

function nzbDownload(row: NzbDownloadSyncRead): GatheredDownload {
  return { table: 'nzb_download', id: row.id, row };
}

/**
 * A `submit` that accepts everything, for the tests that are not about
 * picking. Spelled out at every call site rather than defaulted inside the
 * component, which is the whole point: a default that performed network
 * I/O would give a test that forgot the prop a real `fetch` under jsdom.
 */
const accepts: PickSubmit = () => Promise.resolve({ accepted: true });

/** A `submit` that never settles -- what a pick in flight looks like. */
const neverSettles: PickSubmit = () => new Promise<PickOutcome>(() => {});

/** `count` releases with no downloads, `release-1.mkv` upwards. */
function releasesFor(count: number): GatheredRelease[] {
  const releases: GatheredRelease[] = [];
  for (let id = 1; id <= count; id += 1) {
    releases.push({
      id,
      row: rssItem({ id, filename: `release-${String(id)}.mkv`, resolution: '1080p' }),
      downloads: [],
    });
  }
  return releases;
}

/** Release 1, named `filename` and nothing else special -- for the two title-attribute tests. */
function longRelease(filename: string): GatheredRelease {
  return { id: 1, row: rssItem({ id: 1, filename, resolution: '2160p' }), downloads: [] };
}

/** One release row's Pick button, found through the row rather than by name, so these tests do not depend on how the button is announced. */
function pickButton(filename: string): HTMLButtonElement {
  return within(screen.getByRole('listitem', { name: filename })).getByRole<HTMLButtonElement>('button');
}

test('no releases still renders a releases list, with nothing inside it', () => {
  render(<ReleaseList releases={[]} submit={accepts} />);
  assert.ok(screen.getByRole('list', { name: /releases/i }));
  assert.equal(screen.queryAllByRole('listitem').length, 0, 'no releases means no rows');
});

test('a release with a download shows its filename, resolution and download status', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.2160p.mkv', resolution: '2160p' }),
    downloads: [torrentDownload(torrent({ id: 9, status: 'downloading', percentage: 42 }))],
  };
  render(<ReleaseList releases={[release]} submit={accepts} />);

  const item = screen.getByRole('listitem', { name: /the.thing.2160p.mkv/ });
  assert.ok(item.textContent?.includes('2160p'), 'the resolution is shown');
  assert.ok(item.textContent?.includes('downloading'), 'and the download status');
  assert.ok(item.textContent?.includes('42'), 'and how far along it is');
});

test('a release with no downloads shows no status label at all', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.1080p.mkv', resolution: '1080p' }),
    downloads: [],
  };
  render(<ReleaseList releases={[release]} submit={accepts} />);

  const item = screen.getByRole('listitem', { name: /the.thing.1080p.mkv/ });
  assert.ok(item.textContent?.includes('1080p'));
  assert.ok(!/status/i.test(item.textContent ?? ''), 'no status label with nothing to put in it');
});

test('a release with a torrent and an nzb download shows both statuses', () => {
  // Two downloads for one release is not the normal case, but
  // `GatheredRelease.downloads` is an array and nothing in `gatherMediaItem`
  // rules it out -- each download's own table+id keys its row (`downloadKey`
  // in `ReleaseList.tsx`), which this pins directly.
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.mkv', resolution: '1080p' }),
    downloads: [
      torrentDownload(torrent({ id: 9, status: 'downloading', percentage: 42 })),
      nzbDownload(nzb({ id: 11, status: 'queued' })),
    ],
  };
  render(<ReleaseList releases={[release]} submit={accepts} />);

  const item = screen.getByRole('listitem', { name: /the.thing.mkv/ });
  assert.ok(item.textContent?.includes('downloading'), 'the torrent status is shown');
  assert.ok(item.textContent?.includes('queued'), 'and the nzb status alongside it');
});

test('a release with a download but no percentage shows the status without one', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.720p.mkv', resolution: '720p' }),
    downloads: [torrentDownload(torrent({ id: 9, status: 'queued', percentage: null }))],
  };
  render(<ReleaseList releases={[release]} submit={accepts} />);

  const item = screen.getByRole('listitem', { name: /the.thing.720p.mkv/ });
  assert.ok(item.textContent?.includes('queued'));
  assert.ok(!item.textContent?.includes('%'), 'nothing to show when the download carries no percentage');
});

test('a release shows its ranking score', () => {
  // Design spec §5 names the ranking score alongside the resolution and the
  // download status. It was dropped in the spec-to-plan translation and
  // nothing downstream caught it, because every downstream seat checked
  // against the plan.
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.2160p.mkv', resolution: '2160p', rankingScore: 84 }),
    downloads: [],
  };
  render(<ReleaseList releases={[release]} submit={accepts} />);

  const item = screen.getByRole('listitem', { name: /the.thing.2160p.mkv/ });
  assert.ok(item.textContent?.includes('Score: 84'), 'the ranking score is shown');
});

test('a ranking score of zero is shown, and an absent one shows nothing', () => {
  // Zero is an answer (Global Constraint): a ranker that scored this
  // release 0 said something, and a falsy check would hide it behind the
  // same blank as a release nothing has ranked. Both in one test, because
  // the property is the distinction between them.
  const scoredZero: GatheredRelease = {
    id: 1,
    row: rssItem({ id: 1, filename: 'scored.zero.mkv', resolution: '1080p', rankingScore: 0 }),
    downloads: [],
  };
  const unranked: GatheredRelease = {
    id: 2,
    row: rssItem({ id: 2, filename: 'unranked.mkv', resolution: '1080p' }),
    downloads: [],
  };
  render(<ReleaseList releases={[scoredZero, unranked]} submit={accepts} />);

  assert.ok(
    screen.getByRole('listitem', { name: /scored.zero.mkv/ }).textContent?.includes('Score: 0'),
    'a score of zero is a score',
  );
  assert.ok(
    !/score/i.test(screen.getByRole('listitem', { name: /unranked.mkv/ }).textContent ?? ''),
    'and a release nothing has ranked shows no score label at all',
  );
});

/* --- the pick button (picks design §2, §3) --------------------------- */

test('a release with no download offers a Pick button, and one that has a download offers none', () => {
  // Picks design §2's two halves in one test, because the property is the
  // distinction between them: the button is what a release nobody has acted
  // on gets, and a status is what a release somebody has acted on gets
  // instead.
  const pickable: GatheredRelease = {
    id: 1,
    row: rssItem({ id: 1, filename: 'pickable.mkv', resolution: '1080p' }),
    downloads: [],
  };
  const picked: GatheredRelease = {
    id: 2,
    row: rssItem({ id: 2, filename: 'picked.mkv', resolution: '1080p' }),
    downloads: [torrentDownload(torrent({ id: 2, status: 'downloading', percentage: 7 }))],
  };
  render(<ReleaseList releases={[pickable, picked]} submit={accepts} />);

  assert.equal(pickButton('pickable.mkv').textContent, 'Pick', 'a release nobody has acted on can be picked');

  const pickedRow = screen.getByRole('listitem', { name: 'picked.mkv' });
  assert.ok(pickedRow.textContent?.includes('Status: downloading (7%)'), 'a picked release shows its status');
  assert.equal(within(pickedRow).queryAllByRole('button').length, 0,
    'and offers no way to pick it a second time');
});

test('the full filename is reachable as a title, even when the rendered one is cut off', () => {
  // A release filename is the longest string on this screen and the one
  // that distinguishes two otherwise-identical releases, so it has to be
  // readable in full however narrowly the column renders. Asserted on the
  // element the row is labelled by, which is the one holding the name.
  const long = 'Some.Show.S01E01.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-GROUP.mkv';
  render(<ReleaseList releases={[longRelease(long)]} submit={accepts} />);
  const row = screen.getByRole('listitem', { name: long });
  const named = row.querySelector('#release-1-filename');
  assert.ok(named !== null, 'the filename span is the one the row is labelled by');
  assert.equal(named.getAttribute('title'), long, 'and carries the whole name as its title');
});

test('the filename title does not rename anything it is attached to', () => {
  // **`title` is the last fallback in the accessible-name algorithm**, so
  // an element with content is named by its content and this attribute is
  // inert for naming -- but the filename span is pointed at by *two*
  // `aria-labelledby` references (the row's and the Pick button's), so a
  // `title` that did win would silently rename every row and every button
  // on the card. Asserted rather than reasoned about.
  const long = 'Some.Show.S01E01.2160p.WEB-DL-GROUP.mkv';
  render(<ReleaseList releases={[longRelease(long)]} submit={accepts} />);
  assert.ok(screen.getByRole('listitem', { name: long }), 'the row is still named by the filename alone');
  assert.ok(screen.getByRole('button', { name: `Pick ${long}` }), 'and the button by Pick plus the filename');
});

test('the Pick button is announced with the release it picks, from two strings that are both on screen', () => {
  // The visible label is `Pick` on every row, which is ambiguous announced in
  // a list of them. The accessible name composes the button's own text with
  // the filename span the row is already labelled by, so nothing is announced
  // that a sighted reader cannot also see -- the opposite of an `aria-label`
  // carrying a second copy of a string already rendered (`CLAUDE.md`).
  render(<ReleaseList releases={releasesFor(1)} submit={accepts} />);
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Pick release-1.mkv' });
  assert.equal(button.textContent, 'Pick', 'and the visible half is still just the verb');
});

test('clicking Pick disables that button and it reads Picking…', () => {
  render(<ReleaseList releases={releasesFor(1)} submit={neverSettles} />);
  assert.ok(!pickButton('release-1.mkv').disabled, 'enabled before anything is clicked');

  fireEvent.click(pickButton('release-1.mkv'));

  assert.equal(pickButton('release-1.mkv').textContent, 'Picking…', 'the button says what is happening');
  assert.ok(pickButton('release-1.mkv').disabled, 'and cannot be clicked again while it happens');
});

test('an accepted pick stays Picking… through the 202, and the status replaces it when the row arrives', async () => {
  // Acceptance 6, end to end through the only two things this component
  // ever sees: an answer from `submit`, and a `releases` array.
  //
  // The `await act` is what makes the middle assertion mean anything. The
  // 202 resolves in a microtask, so without flushing it this would pass
  // against a version that re-enables on success -- which is exactly the
  // version that shipped, and which the browser measured re-enabling the
  // button 33ms after the click with the row 2934ms away.
  const view = render(<ReleaseList releases={releasesFor(1)} submit={accepts} />);
  fireEvent.click(pickButton('release-1.mkv'));
  await act(async () => {
    await Promise.resolve();
  });

  assert.equal(pickButton('release-1.mkv').textContent, PICK_LABELS.pending,
    'the host accepted it; this browser still has no row for it');
  assert.ok(pickButton('release-1.mkv').disabled, 'so there is nothing to click a second time');
  assert.equal(screen.queryAllByRole('alert').length, 0, 'an acceptance is not something to report');

  const arrived: GatheredRelease[] = [
    {
      id: 1,
      row: rssItem({ id: 1, filename: 'release-1.mkv', resolution: '1080p' }),
      downloads: [torrentDownload(torrent({ id: 1, status: 'submitted', percentage: null }))],
    },
  ];
  view.rerender(<ReleaseList releases={arrived} submit={accepts} />);

  const row = screen.getByRole('listitem', { name: 'release-1.mkv' });
  assert.ok(row.textContent?.includes('Status: submitted'), 'the status the replica now holds');
  assert.equal(within(row).queryAllByRole('button').length, 0, 'and the pending button is gone with it');
});

test('the Pick button renders exactly the two labels --size-pick-button was measured against', () => {
  // `styles/tokens.css`'s floor is 72px because these two strings measure
  // 40.64px and 66.58px in Chromium. Nothing recomputes that, so a third
  // label or a longer one widens the button and moves everything to its
  // left with no stylesheet able to notice.
  assert.deepEqual(PICK_LABELS, { idle: 'Pick', pending: 'Picking…' },
    'a changed, longer or third label needs `--size-pick-button` (styles/tokens.css) re-measured');

  // And these are the strings the button actually renders, not a pair of
  // constants nothing reads (`CLAUDE.md`: pinning a value does not pin that
  // anyone uses it).
  render(<ReleaseList releases={releasesFor(1)} submit={neverSettles} />);
  assert.equal(pickButton('release-1.mkv').textContent, PICK_LABELS.idle);
  fireEvent.click(pickButton('release-1.mkv'));
  assert.equal(pickButton('release-1.mkv').textContent, PICK_LABELS.pending);
});

/** One of {@link PickOutcome}'s two refusal members -- everything that is not an acceptance. */
type Refusal = Extract<PickOutcome, { refusal: unknown }>;

/**
 * Every refusal the host can send, plus this client's own two. Spelled out
 * rather than derived from `PICK_REFUSAL_MESSAGES`'s keys: an expectation
 * computed by the code under test cannot detect that code changing
 * (`CLAUDE.md`). `postPick.test.tsx` is where the key set itself is pinned
 * against the contract's array.
 */
const REFUSALS: readonly Refusal[] = [
  { refusal: 'unknown-release' },
  { refusal: 'plugin-not-registered' },
  { refusal: 'no-client-of-type' },
  { refusal: 'client-type-mismatch' },
  { refusal: 'already-submitted' },
  { refusal: 'offline' },
  { refusal: 'unrecognised' },
];

/** A `submit` answering release `n` with `outcomes[n - 1]`, and *rejecting* for any release it has no answer planned for. */
function submitPlan(outcomes: readonly PickOutcome[]): PickSubmit {
  const planned = new Map<number, PickOutcome>(outcomes.map((outcome, index) => [index + 1, outcome]));
  return (rssItemId) => {
    const outcome = planned.get(rssItemId);
    return outcome === undefined
      ? Promise.reject(new Error('this submit rejects rather than resolving'))
      : Promise.resolve(outcome);
  };
}

test('every refusal reaches the screen as its own sentence, in text a human can read', async () => {
  // **The rendered text, never the accessible name.** `getByRole`'s `name`
  // option is satisfied by an `aria-label` on an element with no visible
  // content, so a test asserting it passes against a component a sighted
  // person sees nothing in -- `IdentityChangeConfirm` shipped exactly that
  // and ten tests over it stayed green (`CLAUDE.md`'s longest hazard).
  // `screen.getByText` reads what is rendered, and it throws on a duplicate
  // too, so this reddens both ways: a refusal that stops being visible, and
  // two refusals collapsing onto one sentence.
  //
  // One release per outcome in one render, rather than a render per outcome,
  // so the whole set is on screen at once and that duplicate check is real.
  render(<ReleaseList releases={releasesFor(REFUSALS.length)} submit={submitPlan(REFUSALS)} />);
  for (let index = 1; index <= REFUSALS.length; index += 1) {
    fireEvent.click(pickButton(`release-${String(index)}.mkv`));
  }

  await waitFor(() => {
    assert.equal(screen.queryAllByRole('alert').length, REFUSALS.length, 'every pick has been answered');
  });

  for (const [index, outcome] of REFUSALS.entries()) {
    const sentence = PICK_REFUSAL_MESSAGES[outcome.refusal];
    assert.equal(screen.getByText(sentence).textContent, sentence,
      `${outcome.refusal} is on screen as words, not as an attribute`);
    const row = screen.getByRole('listitem', { name: `release-${String(index + 1)}.mkv` });
    assert.equal(within(row).queryAllByText(sentence).length, 1,
      `and on the row that was refused, not some other row`);
  }
});

test('every refusal and every error re-enables the button, including a submit that rejects outright', async () => {
  // The `finally` is the only thing that makes this true, and this is the
  // half of its job that did not change: the last release has no planned
  // outcome, so `submitPlan` rejects for it -- the case the feeds slice
  // shipped without a `finally` for, which left its form wedged with the
  // button disabled and nothing on screen.
  //
  // **`{ accepted: true }` is deliberately not in this list.** A 202 is the
  // one outcome that must *not* re-enable, and the test above is where that
  // is pinned; putting it here would make the two contradict each other.
  const outcomes: readonly PickOutcome[] = REFUSALS;
  const count = outcomes.length + 1;
  render(<ReleaseList releases={releasesFor(count)} submit={submitPlan(outcomes)} />);
  for (let index = 1; index <= count; index += 1) {
    fireEvent.click(pickButton(`release-${String(index)}.mkv`));
  }

  await waitFor(() => {
    const buttons = screen.getAllByRole<HTMLButtonElement>('button');
    assert.equal(buttons.length, count, 'every release still offers its button');
    assert.ok(buttons.every((button) => !button.disabled), 'and not one of them is left disabled');
    assert.ok(buttons.every((button) => button.textContent === PICK_LABELS.idle),
      'and none is still reading Picking…');
  });
});

test('picking one release leaves every other release pickable', () => {
  // A single pending flag shared by the whole list passes every other test in
  // this file: with one release in flight the screen looks identical either
  // way, unless something else is on it. This is the test that can see the
  // difference, which is why the flag lives on the row rather than the list.
  //
  // `neverSettles`, so nothing here depends on when a promise resolves: the
  // pick is still in flight for as long as the assertions take.
  render(<ReleaseList releases={releasesFor(3)} submit={neverSettles} />);
  fireEvent.click(pickButton('release-2.mkv'));

  assert.ok(pickButton('release-2.mkv').disabled, 'the release that was picked is in flight');
  assert.equal(pickButton('release-2.mkv').textContent, 'Picking…');
  for (const other of ['release-1.mkv', 'release-3.mkv']) {
    assert.ok(!pickButton(other).disabled, `${other} is untouched by a pick on another release`);
    assert.equal(pickButton(other).textContent, 'Pick', `${other} still reads Pick`);
  }
});
