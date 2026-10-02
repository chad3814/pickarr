import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { NzbDownloadSyncRead, RssItemSyncRead, TorrentDownloadSyncRead } from '@pickarr/contract';
import type { IdentifyRequest } from '@pickarr/contract';
import { ReleaseList, PICK_LABELS } from '../src/ReleaseList.tsx';
import {
  IDENTIFY_REFUSAL_MESSAGES,
  PICK_REFUSAL_MESSAGES,
  REQUERY_LABELS,
  type GatheredDownloadView as GatheredDownload,
  type GatheredReleaseView as GatheredRelease,
  type IdentifyOutcome,
  type IdentifySubmit,
  type PickOutcome,
  type PickSubmit,
} from '../src/types.ts';

afterEach(cleanup);

/** An `RssItemSyncRead` with everything but `id`, `filename` and `rankingScore` defaulted -- `lookupState` is the lookup state, `resolved` unless a test says otherwise, and `videoResolution` is the stored field, `null` unless a test says otherwise. */
function rssItem({
  id,
  filename,
  lookupState = 'resolved',
  rankingScore = null,
  videoResolution = null,
}: {
  id: number;
  filename: string;
  lookupState?: string;
  rankingScore?: number | null;
  videoResolution?: string | null;
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
    lookupState,
    lookupStateDetail: null,
    videoResolution,
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

/** An `identify` for the tests that are not about identifying: it fails loudly if anything calls it. */
const identifies: IdentifySubmit = {
  identify: () => Promise.reject(new Error('not exercised by this test')),
  suggest: () => Promise.reject(new Error('not exercised by this test')),
};

/** A `submit` that never settles -- what a pick in flight looks like. */
const neverSettles: PickSubmit = () => new Promise<PickOutcome>(() => {});

/** `count` releases with no downloads, `release-1.mkv` upwards. */
function releasesFor(count: number): GatheredRelease[] {
  const releases: GatheredRelease[] = [];
  for (let id = 1; id <= count; id += 1) {
    releases.push({
      id,
      row: rssItem({ id, filename: `release-${String(id)}.mkv` }),
      downloads: [],
    });
  }
  return releases;
}

/** Release 1, named `filename` and nothing else special -- for the two title-attribute tests. */
function longRelease(filename: string): GatheredRelease {
  return { id: 1, row: rssItem({ id: 1, filename }), downloads: [] };
}

/** One release row's Pick button, found through the row rather than by name, so these tests do not depend on how the button is announced. */
function pickButton(filename: string): HTMLButtonElement {
  return within(screen.getByRole('listitem', { name: filename })).getByRole<HTMLButtonElement>('button', { name: /^Pick/ });
}

test('no releases still renders a releases list, with nothing inside it', () => {
  render(<ReleaseList releases={[]} submit={accepts} identify={identifies} pluginId="tv" />);
  assert.ok(screen.getByRole('list', { name: /releases/i }));
  assert.equal(screen.queryAllByRole('listitem').length, 0, 'no releases means no rows');
});

test('a release with a download shows its filename, resolution and download status', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.2160p.mkv', videoResolution: '2160p' }),
    downloads: [torrentDownload(torrent({ id: 9, status: 'downloading', percentage: 42 }))],
  };
  render(<ReleaseList releases={[release]} submit={accepts} identify={identifies} pluginId="tv" />);

  const item = screen.getByRole('listitem', { name: /the.thing.2160p.mkv/ });
  assert.ok(item.textContent?.includes('2160p'), 'the resolution is shown');
  assert.ok(item.textContent?.includes('downloading'), 'and the download status');
  assert.ok(item.textContent?.includes('42'), 'and how far along it is');
});

test('a release with no downloads shows no status label at all', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.1080p.mkv' }),
    downloads: [],
  };
  render(<ReleaseList releases={[release]} submit={accepts} identify={identifies} pluginId="tv" />);

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
    row: rssItem({ id: 3, filename: 'the.thing.mkv' }),
    downloads: [
      torrentDownload(torrent({ id: 9, status: 'downloading', percentage: 42 })),
      nzbDownload(nzb({ id: 11, status: 'queued' })),
    ],
  };
  render(<ReleaseList releases={[release]} submit={accepts} identify={identifies} pluginId="tv" />);

  const item = screen.getByRole('listitem', { name: /the.thing.mkv/ });
  assert.ok(item.textContent?.includes('downloading'), 'the torrent status is shown');
  assert.ok(item.textContent?.includes('queued'), 'and the nzb status alongside it');
});

test('a release with a download but no percentage shows the status without one', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.720p.mkv' }),
    downloads: [torrentDownload(torrent({ id: 9, status: 'queued', percentage: null }))],
  };
  render(<ReleaseList releases={[release]} submit={accepts} identify={identifies} pluginId="tv" />);

  const item = screen.getByRole('listitem', { name: /the.thing.720p.mkv/ });
  assert.ok(item.textContent?.includes('queued'));
  assert.ok(!item.textContent?.includes('%'), 'nothing to show when the download carries no percentage');
});

test('a percentage is shown only while a download is downloading', () => {
  // The host writes `percentage` from the client's queue and never clears
  // it, so a download that left the queue at 97% keeps 97 on its row
  // through `completed` and `delivered`. Rendering it there read as
  // "delivered, 97% done".
  const releases: GatheredRelease[] = ['downloading', 'completed', 'delivered', 'failed'].map((status, index) => {
    const id = index + 1;
    return {
      id,
      row: rssItem({ id, filename: `${status}.mkv` }),
      downloads: [torrentDownload(torrent({ id, status, percentage: 97 }))],
    };
  });
  render(<ReleaseList releases={releases} submit={accepts} identify={identifies} pluginId="tv" />);

  const text = (filename: string): string => screen.getByRole('listitem', { name: filename }).textContent ?? '';
  assert.ok(text('downloading.mkv').includes('Status: downloading (97%)'), 'downloading shows how far along');
  for (const status of ['completed', 'delivered', 'failed']) {
    assert.ok(text(`${status}.mkv`).includes(`Status: ${status}`), `${status} still shows its status`);
    assert.ok(!text(`${status}.mkv`).includes('%'), `${status} does not show a stale percentage`);
  }
});

test("a row shows the release's stored video resolution, and unknown when it has none", () => {
  // The stored value, not a parse of the filename: this name says 2160p and
  // the row says 1080p, which is only possible if the component reads the
  // field.
  const releases: GatheredRelease[] = [
    { id: 1, row: rssItem({ id: 1, filename: 'the.thing.2160p.mkv', videoResolution: '1080p' }), downloads: [] },
    { id: 2, row: rssItem({ id: 2, filename: 'the.thing.1080p.mkv', videoResolution: null }), downloads: [] },
  ];
  render(<ReleaseList releases={releases} submit={accepts} identify={identifies} pluginId="tv" />);

  const spans = (filename: string): string[] =>
    [...screen.getByRole('listitem', { name: filename }).querySelectorAll('span')].map((span) => span.textContent ?? '');
  assert.ok(spans('the.thing.2160p.mkv').includes('1080p'), 'the stored value');
  assert.ok(!spans('the.thing.2160p.mkv').includes('2160p'), 'not the filename');
  assert.ok(spans('the.thing.1080p.mkv').includes('unknown'), 'null reads as unknown');
});

test('a replica row from before the field existed reads as unknown, not undefined', () => {
  // Review Focus 1: a replica that missed the re-bootstrap holds rows with
  // no `videoResolution` key at all.
  const { videoResolution: _dropped, ...legacy } = rssItem({ id: 1, filename: 'old.row.mkv' });
  const release = { id: 1, row: legacy, downloads: [] } as unknown as GatheredRelease;
  render(<ReleaseList releases={[release]} submit={accepts} identify={identifies} pluginId="tv" />);
  const text = screen.getByRole('listitem', { name: 'old.row.mkv' }).textContent ?? '';
  assert.ok(text.includes('unknown'));
  assert.ok(!text.includes('undefined'));
});

test("a row does not show the release's lookup state", () => {
  // `rss_item.lookup_state` is the lookup state, not a video resolution. It
  // says nothing on a browse card (every release there is `resolved`) that
  // the screen does not already say.
  const release: GatheredRelease = {
    id: 1,
    row: rssItem({ id: 1, filename: 'the.thing.1080p.mkv', lookupState: 'resolved' }),
    downloads: [],
  };
  render(<ReleaseList releases={[release]} submit={accepts} identify={identifies} pluginId="tv" />);

  const item = screen.getByRole('listitem', { name: 'the.thing.1080p.mkv' });
  assert.ok(!item.textContent?.includes('resolved'), 'the lookup state is not rendered');
});

test('a row starts with an icon naming its download type', () => {
  const releases: GatheredRelease[] = [
    { id: 1, row: { ...rssItem({ id: 1, filename: 'a.torrent.mkv' }), downloadType: 'torrent' }, downloads: [] },
    { id: 2, row: { ...rssItem({ id: 2, filename: 'an.nzb.mkv' }), downloadType: 'nzb' }, downloads: [] },
  ];
  render(<ReleaseList releases={releases} submit={accepts} identify={identifies} pluginId="tv" />);

  for (const [filename, type] of [['a.torrent.mkv', 'torrent'], ['an.nzb.mkv', 'nzb']] as const) {
    const item = screen.getByRole('listitem', { name: filename });
    const first = item.firstElementChild;
    assert.ok(first?.tagName.toLowerCase() === 'svg', `${filename}'s first child is the icon`);
    assert.ok(within(item).getByRole('img', { name: type }), `${filename}'s icon is named ${type}`);
  }
});

test("the icon does not change the row's accessible name", () => {
  // The row is named by `aria-labelledby` pointing at the filename alone,
  // so an icon title cannot leak into it -- pinned because every Pick
  // button's name is composed the same way.
  render(<ReleaseList releases={releasesFor(1)} submit={accepts} identify={identifies} pluginId="tv" />);
  assert.ok(screen.getByRole('listitem', { name: 'release-1.mkv' }));
  assert.ok(screen.getByRole('button', { name: 'Pick release-1.mkv' }));
});

test('a release shows its ranking score', () => {
  // Design spec §5 names the ranking score alongside the resolution and the
  // download status. It was dropped in the spec-to-plan translation and
  // nothing downstream caught it, because every downstream seat checked
  // against the plan.
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.2160p.mkv', rankingScore: 84 }),
    downloads: [],
  };
  render(<ReleaseList releases={[release]} submit={accepts} identify={identifies} pluginId="tv" />);

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
    row: rssItem({ id: 1, filename: 'scored.zero.mkv', rankingScore: 0 }),
    downloads: [],
  };
  const unranked: GatheredRelease = {
    id: 2,
    row: rssItem({ id: 2, filename: 'unranked.mkv' }),
    downloads: [],
  };
  render(<ReleaseList releases={[scoredZero, unranked]} submit={accepts} identify={identifies} pluginId="tv" />);

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
    row: rssItem({ id: 1, filename: 'pickable.mkv' }),
    downloads: [],
  };
  const picked: GatheredRelease = {
    id: 2,
    row: rssItem({ id: 2, filename: 'picked.mkv' }),
    downloads: [torrentDownload(torrent({ id: 2, status: 'downloading', percentage: 7 }))],
  };
  render(<ReleaseList releases={[pickable, picked]} submit={accepts} identify={identifies} pluginId="tv" />);

  assert.equal(pickButton('pickable.mkv').textContent, 'Pick', 'a release nobody has acted on can be picked');

  const pickedRow = screen.getByRole('listitem', { name: 'picked.mkv' });
  assert.ok(pickedRow.textContent?.includes('Status: downloading (7%)'), 'a picked release shows its status');
  assert.equal(within(pickedRow).queryAllByRole('button', { name: /^Pick/ }).length, 0,
    'and offers no way to pick it a second time');
});

test('the full filename is reachable as a title, even when the rendered one is cut off', () => {
  // A release filename is the longest string on this screen and the one
  // that distinguishes two otherwise-identical releases, so it has to be
  // readable in full however narrowly the column renders. Asserted on the
  // element the row is labelled by, which is the one holding the name.
  const long = 'Some.Show.S01E01.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-GROUP.mkv';
  render(<ReleaseList releases={[longRelease(long)]} submit={accepts} identify={identifies} pluginId="tv" />);
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
  render(<ReleaseList releases={[longRelease(long)]} submit={accepts} identify={identifies} pluginId="tv" />);
  assert.ok(screen.getByRole('listitem', { name: long }), 'the row is still named by the filename alone');
  assert.ok(screen.getByRole('button', { name: `Pick ${long}` }), 'and the button by Pick plus the filename');
});

test('the Pick button is announced with the release it picks, from two strings that are both on screen', () => {
  // The visible label is `Pick` on every row, which is ambiguous announced in
  // a list of them. The accessible name composes the button's own text with
  // the filename span the row is already labelled by, so nothing is announced
  // that a sighted reader cannot also see -- the opposite of an `aria-label`
  // carrying a second copy of a string already rendered (`CLAUDE.md`).
  render(<ReleaseList releases={releasesFor(1)} submit={accepts} identify={identifies} pluginId="tv" />);
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Pick release-1.mkv' });
  assert.equal(button.textContent, 'Pick', 'and the visible half is still just the verb');
});

test('clicking Pick disables that button and it reads Picking…', () => {
  render(<ReleaseList releases={releasesFor(1)} submit={neverSettles} identify={identifies} pluginId="tv" />);
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
  const view = render(<ReleaseList releases={releasesFor(1)} submit={accepts} identify={identifies} pluginId="tv" />);
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
      row: rssItem({ id: 1, filename: 'release-1.mkv' }),
      downloads: [torrentDownload(torrent({ id: 1, status: 'submitted', percentage: null }))],
    },
  ];
  view.rerender(<ReleaseList releases={arrived} submit={accepts} identify={identifies} pluginId="tv" />);

  const row = screen.getByRole('listitem', { name: 'release-1.mkv' });
  assert.ok(row.textContent?.includes('Status: submitted'), 'the status the replica now holds');
  assert.equal(within(row).queryAllByRole('button', { name: /^Pick/ }).length, 0, 'and the pending button is gone with it');
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
  render(<ReleaseList releases={releasesFor(1)} submit={neverSettles} identify={identifies} pluginId="tv" />);
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
  render(<ReleaseList releases={releasesFor(REFUSALS.length)} submit={submitPlan(REFUSALS)} identify={identifies} pluginId="tv" />);
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
  render(<ReleaseList releases={releasesFor(count)} submit={submitPlan(outcomes)} identify={identifies} pluginId="tv" />);
  for (let index = 1; index <= count; index += 1) {
    fireEvent.click(pickButton(`release-${String(index)}.mkv`));
  }

  await waitFor(() => {
    const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: /^Pick/ });
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
  render(<ReleaseList releases={releasesFor(3)} submit={neverSettles} identify={identifies} pluginId="tv" />);
  fireEvent.click(pickButton('release-2.mkv'));

  assert.ok(pickButton('release-2.mkv').disabled, 'the release that was picked is in flight');
  assert.equal(pickButton('release-2.mkv').textContent, 'Picking…');
  for (const other of ['release-1.mkv', 'release-3.mkv']) {
    assert.ok(!pickButton(other).disabled, `${other} is untouched by a pick on another release`);
    assert.equal(pickButton(other).textContent, 'Pick', `${other} still reads Pick`);
  }
});

/** A row for release 1 whose `updatedAt` and lookup state a test sets. */
function lineRelease(updatedAt: number, lookupState = 'resolved'): GatheredRelease {
  return {
    id: 1,
    row: { ...rssItem({ id: 1, filename: 'release-1.mkv', lookupState }), updatedAt },
    downloads: [],
  };
}

function lineButton(name: string): HTMLButtonElement {
  return within(screen.getByRole('listitem', { name: 'release-1.mkv' })).getByRole<HTMLButtonElement>('button', {
    name: new RegExp(`^${name}`),
  });
}

/** An `IdentifySubmit` whose `identify` records its calls and answers with `outcome`. */
function identifyAnswering(outcome: IdentifyOutcome): { identify: IdentifySubmit; calls: IdentifyRequest[] } {
  const calls: IdentifyRequest[] = [];
  return {
    calls,
    identify: {
      identify: (_id, request) => {
        calls.push(request);
        return Promise.resolve(outcome);
      },
      suggest: () => Promise.resolve([]),
    },
  };
}

test("each release line offers Requery and Edit after Pick, and Requery stays pending until the row's updatedAt advances", async () => {
  const answering = identifyAnswering({ accepted: true });
  const view = render(
    <ReleaseList releases={[lineRelease(5)]} submit={accepts} identify={answering.identify} pluginId="tv" />,
  );

  const names = within(screen.getByRole('listitem', { name: 'release-1.mkv' }))
    .getAllByRole('button')
    .map((b) => b.textContent);
  assert.deepEqual(names, ['Pick', 'Requery', 'Edit']);
  assert.equal(
    screen.getByRole('button', { name: 'Requery release-1.mkv' }).textContent,
    'Requery',
    'announced with the release it requeries',
  );
  assert.ok(screen.getByRole('button', { name: 'Edit release-1.mkv' }), 'and Edit likewise');

  fireEvent.click(lineButton('Requery'));
  assert.equal(lineButton('Requerying').textContent, REQUERY_LABELS.pending);
  assert.ok(lineButton('Requerying').disabled);
  await act(async () => {
    await Promise.resolve();
  });
  assert.deepEqual(answering.calls, [{ mode: 'requery' }]);
  assert.equal(lineButton('Requerying').textContent, REQUERY_LABELS.pending, 'an acceptance does not end the wait');
  assert.ok(lineButton('Requerying').disabled);

  view.rerender(
    <ReleaseList releases={[lineRelease(6)]} submit={accepts} identify={answering.identify} pluginId="tv" />,
  );
  assert.equal(lineButton('Requery').textContent, REQUERY_LABELS.idle, 'a newer row ends it');
  assert.ok(!lineButton('Requery').disabled);
});

test('a Requery refusal re-enables the button and announces the sentence', async () => {
  const answering = identifyAnswering({ refusal: 'unknown-release' });
  render(<ReleaseList releases={[lineRelease(5)]} submit={accepts} identify={answering.identify} pluginId="tv" />);

  fireEvent.click(lineButton('Requery'));
  await waitFor(() => {
    assert.equal(screen.getByRole('alert').textContent, IDENTIFY_REFUSAL_MESSAGES['unknown-release']);
  });
  assert.equal(lineButton('Requery').textContent, REQUERY_LABELS.idle);
  assert.ok(!lineButton('Requery').disabled);
});

test('a Requery that rejects shows the offline sentence and re-enables the button', async () => {
  const rejecting: IdentifySubmit = {
    identify: () => Promise.reject(new Error('down')),
    suggest: () => Promise.resolve([]),
  };
  render(<ReleaseList releases={[lineRelease(5)]} submit={accepts} identify={rejecting} pluginId="tv" />);

  fireEvent.click(lineButton('Requery'));
  await waitFor(() => {
    assert.equal(screen.getByRole('alert').textContent, IDENTIFY_REFUSAL_MESSAGES.offline);
  });
  assert.ok(!lineButton('Requery').disabled);
});

test('Edit swaps the three buttons for the form; Cancel restores them', () => {
  render(<ReleaseList releases={[lineRelease(5)]} submit={accepts} identify={identifies} pluginId="tv" />);

  fireEvent.click(lineButton('Edit'));
  assert.ok(screen.getByRole('combobox', { name: 'Title' }), 'the form is open');
  const row = screen.getByRole('listitem', { name: 'release-1.mkv' });
  assert.equal(within(row).queryAllByRole('button', { name: /^(Pick|Requery|Edit)/ }).length, 0, 'in place of the three buttons');

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.equal(screen.queryAllByRole('combobox').length, 0, 'Cancel closes it');
  assert.deepEqual(
    within(row).getAllByRole('button').map((b) => b.textContent),
    ['Pick', 'Requery', 'Edit'],
  );
});

test('saving the form closes it and leaves Requery pending until the row moves', async () => {
  const answering = identifyAnswering({ accepted: true });
  const view = render(
    <ReleaseList releases={[lineRelease(5)]} submit={accepts} identify={answering.identify} pluginId="tv" />,
  );
  fireEvent.click(lineButton('Edit'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Title' }), { target: { value: 'Dune' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    assert.equal(lineButton('Requerying').textContent, REQUERY_LABELS.pending);
  });
  assert.deepEqual(answering.calls, [{ mode: 'name', name: 'Dune' }]);

  view.rerender(
    <ReleaseList releases={[lineRelease(6)]} submit={accepts} identify={answering.identify} pluginId="tv" />,
  );
  assert.equal(lineButton('Requery').textContent, REQUERY_LABELS.idle);
});

test('the line shows Looking up… for pending, the word for unresolved and refused, and nothing for resolved', () => {
  const statusOf = (lookupState: string): string => {
    cleanup();
    render(
      <ReleaseList releases={[lineRelease(5, lookupState)]} submit={accepts} identify={identifies} pluginId="tv" />,
    );
    return screen.getByRole('listitem', { name: 'release-1.mkv' }).textContent ?? '';
  };
  assert.ok(statusOf('pending').includes('Looking up…'));
  assert.ok(statusOf('unresolved').includes('unresolved'));
  assert.ok(statusOf('refused').includes('refused'));
  const resolved = statusOf('resolved');
  assert.ok(!resolved.includes('Looking up…') && !resolved.includes('unresolved') && !resolved.includes('refused'));
});
