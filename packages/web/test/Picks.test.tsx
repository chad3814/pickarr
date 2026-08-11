import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App.tsx';
import { Picks } from '../src/routes/Picks.tsx';
import { groupAnchor } from '../src/api/anchors.ts';
import type { DownloadsResponse, GroupView, PicksResponse } from '../src/api/client.ts';

afterEach(cleanup);

function group(id: number, title: string, over: Partial<GroupView> = {}): GroupView {
  return {
    id,
    plugin: 'scenes',
    display: { title, fields: [] },
    state: 'picked',
    pickedReleaseId: id * 10,
    upgradeReleaseId: null,
    listRankAt: 1000 - id,
    releases: [
      {
        id: id * 10,
        score: 2160,
        quality: { resolution: 2160 },
        releaseName: `${title}.2160p`,
        publishedAt: null,
      },
      {
        id: id * 10 + 1,
        score: 1080,
        quality: { resolution: 1080 },
        releaseName: `${title}.1080p`,
        publishedAt: null,
      },
    ],
    ...over,
  };
}

/**
 * The same group as the server would send it once its pick has failed: the mark
 * on the release that actually failed, and nothing else. There is no
 * group-level field — `/api/picks` states that fact by returning such groups
 * first — so the whole of what a card reads is this one release flag.
 */
function failedPick(healthy: GroupView): GroupView {
  return {
    ...healthy,
    releases: healthy.releases.map((release) =>
      release.id === healthy.pickedReleaseId ? { ...release, downloadFailed: true } : release,
    ),
  };
}

/**
 * `/api/picks` answers `first`, and every load after the first answers
 * `reloaded` when one is given — which is how a test tells a re-render apart
 * from the render it started with.
 */
function serve(first: GroupView[], reloaded?: GroupView[]): void {
  let loads = 0;
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    // A pick POSTs and then reloads; its response body goes unread.
    if (init?.method === 'POST') {
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    loads += 1;
    const body: PicksResponse = { groups: loads === 1 ? first : (reloaded ?? first) };
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

/**
 * Records what the route scrolled to. happy-dom has a `scrollIntoView` that
 * does nothing observable, so the call itself is the evidence.
 */
function watchScroll(): string[] {
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this.id);
  };
  return scrolled;
}

test('a link carrying a group anchor lands on that card', async () => {
  // The cards arrive from a fetch after the route has mounted, so the browser
  // has already resolved — and missed — the fragment by the time the target
  // exists. Without this the Downloads link reaches the Picks tab and stops at
  // the top of a list the group may be pages down.
  //
  // The URL is spelled literally while the expectation is `groupAnchor(2)`, so
  // the two ends of this test are not the same expression: it now says "a
  // hand-written `/picks#group-2` reaches the card `groupAnchor` names", which
  // is the property, rather than "the function agrees with itself".
  const scrolled = watchScroll();
  serve([group(1, 'Alpha'), group(2, 'Beta'), group(3, 'Gamma')]);

  render(
    <MemoryRouter initialEntries={['/picks#group-2']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.deepEqual(scrolled, [groupAnchor(2)]));
});

test('landing happens once, not on every reload', async () => {
  // Picking an alternative reloads the list, and the hash is still in the URL.
  // Scrolling again on each reload would drag the page back to the card the
  // user has just finished with.
  const scrolled = watchScroll();
  serve([group(1, 'Alpha'), group(2, 'Beta')], [group(1, 'Alpha'), group(2, 'Beta reloaded')]);

  // Literal both ends: this test is about how many times the effect fires, and
  // borrowing `groupAnchor` for the count would make it blind to the anchor
  // changing as well as uninformative about it.
  render(
    <MemoryRouter initialEntries={['/picks#group-2']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.deepEqual(scrolled, ['group-2']));

  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);
  // The new list on screen is what says the reload landed and the effect that
  // watches `groups` has run.
  await waitFor(() => assert.ok(screen.getByText('Beta reloaded')));
  assert.deepEqual(scrolled, ['group-2']);
});

test('a card that arrives in a later load is still landed on', async () => {
  // The hash is spent only on a landing that happened. Marking it the first
  // time the effect runs — before knowing whether the card is there — burns the
  // one chance on a list that does not contain it, and the later load that does
  // never scrolls: the same "link goes to the top of the list" symptom the
  // effect exists to fix, in the case where the list was slow rather than fast.
  const scrolled = watchScroll();
  serve([group(1, 'Alpha')], [group(1, 'Alpha'), group(2, 'Beta')]);

  // Literal both ends, so this test says nothing about `groupAnchor` and
  // depends on nothing it does — it is about the effect's bookkeeping.
  render(
    <MemoryRouter initialEntries={['/picks#group-2']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  assert.deepEqual(scrolled, [], 'nothing to land on yet');

  // A pick reloads the list, and this time it holds the group.
  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  await waitFor(() => assert.deepEqual(scrolled, ['group-2']));
});

test('a failed download on Downloads reaches its group on Picks', async () => {
  // The two ends of the anchor, joined: the row builds an href and the card
  // builds an id, and this is the only place that proves they are the same
  // string. Reported live as the whole defect — a failure named a title, and
  // the group holding three untried alternatives was unreachable from it.
  //
  // The landing is asserted against the literal `group-2`. Computing it from
  // `groupAnchor` made the strongest test in the suite the blindest: both ends
  // of the journey are built from that one function, so it agreed with itself
  // whatever it returned, and a constant `group-x` sailed through here while
  // every card on the page claimed the same DOM id.
  const scrolled = watchScroll();
  const downloads: DownloadsResponse = {
    tracked: [
      {
        id: 1,
        groupId: 2,
        releaseId: 20,
        title: 'Beta',
        kind: 'initial',
        status: 'failed',
        error: 'Repair failed, not enough repair blocks (92 short)',
        attempts: 1,
        updatedAt: 1,
      },
    ],
    untracked: [],
  };
  const picks: PicksResponse = {
    groups: [failedPick(group(2, 'Beta')), group(1, 'Alpha')],
  };
  globalThis.fetch = (async (input: string) =>
    new Response(JSON.stringify(input.startsWith('/api/downloads') ? downloads : picks), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={['/downloads']}>
      <App />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByRole('link', { name: 'Beta' })));
  fireEvent.click(screen.getByRole('link', { name: 'Beta' }));

  await waitFor(() => assert.deepEqual(scrolled, ['group-2']));
  // Scoped to the card: the nav has a Failed tab of its own, and a bare query
  // for the word finds both.
  const card = document.getElementById('group-2');
  assert.ok(card !== null);
  assert.ok(within(card).getByText('Failed'));
});

test('a failed pick reads Failed on the Picks tab', async () => {
  // End to end for the screen the link lands on: the server flags the group,
  // the card labels the release, and the alternative is still offered.
  serve([failedPick(group(1, 'Alpha'))]);

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Failed')));
  assert.equal(screen.getAllByRole('button', { name: /pick/i }).length, 1);
});
