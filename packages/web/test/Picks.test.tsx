import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App.tsx';
import { Picks } from '../src/routes/Picks.tsx';
import { groupAnchor } from '../src/api/anchors.ts';
import type {
  DownloadsResponse,
  GroupEditResponse,
  GroupView,
  IdentityPlanView,
  ManualField,
  ManualFieldsResponse,
  MetadataRequestResponse,
  MetadataRequeryResponse,
  MetadataView,
  PicksResponse,
} from '../src/api/client.ts';
import { fetchStub } from './fetchStub.ts';

afterEach(cleanup);

function group(id: number, title: string, over: Partial<GroupView> = {}): GroupView {
  return {
    id,
    plugin: 'scenes',
    display: { title, fields: [] },
    state: 'picked',
    // Required since browse and picks share `GroupView`. `'absent'` is what
    // `/api/picks` genuinely carries for a group nothing has asked about yet
    // — Picks now polls `useGroupMetadata` for a live answer the same as
    // Browse does, but that hook's own tests cover the polling itself; this
    // fixture is just the value the route starts from before a poll lands.
    metadata: { state: 'absent' },
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

/** An identity schema, the same shape `Browse.test.tsx` uses for its own. */
const FIELDS: ManualField[] = [
  { name: 'key', label: 'Key', type: 'text', scope: 'identity', required: true },
  { name: 'title', label: 'Title', type: 'text', scope: 'identity', required: true },
];

/**
 * A picked group with an identity prefill, for the edit tests below —
 * `group()` above carries none, since no test before this feature existed
 * needed one.
 */
const PICKED_GROUP: GroupView = { ...group(1, 'Alpha'), manualValues: { key: 'k1', title: 'Alpha' } };

/** A plan that moves nothing, so `useIdentityChange` applies it with no dialog. */
const PLAN_NO_MOVES: IdentityPlanView = {
  groupId: PICKED_GROUP.id,
  identityKey: 'scenes:k1:Fixed',
  kind: 'display-only',
  mergeInto: null,
  releasesMoving: 0,
  downloadsMoving: 0,
  pick: { surviving: null, superseded: null },
  renames: [],
  trashing: [],
  warnings: [],
  blockers: [],
  digest: 'no-moves-digest',
};

/**
 * A rekey with no file work but one blocker — the shape that used to escape
 * confirmation entirely (`needsConfirmation` read only `kind`/`renames`/
 * `trashing`, all of which say "nothing to confirm" here) and got refused 409
 * by the applier, which this hook's contract can only read as a stale digest.
 * The blocker text never reached the user under that bug.
 */
const PLAN_BLOCKED: IdentityPlanView = {
  groupId: PICKED_GROUP.id,
  identityKey: 'scenes:k3:Alpha',
  kind: 'rekey',
  mergeInto: null,
  releasesMoving: 0,
  downloadsMoving: 0,
  pick: { surviving: null, superseded: null },
  renames: [],
  trashing: [],
  warnings: [],
  blockers: [
    '/library/k3/1080.mp4 is already occupied, so /library/k1/1080.mp4 cannot be moved there',
  ],
  digest: 'blocked-digest',
};

/** A plan that merges into another group, so `useIdentityChange` requires confirmation. */
const PLAN_MERGE: IdentityPlanView = {
  groupId: PICKED_GROUP.id,
  identityKey: 'scenes:k2:Alpha',
  kind: 'merge',
  mergeInto: { id: 2, title: 'Target' },
  releasesMoving: 1,
  downloadsMoving: 0,
  pick: { surviving: { releaseId: 20, score: 1080, side: 'source' }, superseded: null },
  renames: [],
  trashing: [],
  warnings: [],
  blockers: [],
  digest: 'merge-digest',
};

interface StubOptions {
  picks: GroupView[];
  manualFields?: ManualFieldsResponse;
  identityPlan?: IdentityPlanView;
  groupEdit?: GroupEditResponse;
}

/** One `PATCH /api/groups/:id` body, as the test can observe it. */
interface Patched {
  groupId: number;
  values: Record<string, string>;
  planDigest?: string;
}

/**
 * Serves the endpoints the edit flow touches — `/api/picks`, `/api/manual-fields`,
 * `POST .../identity-plan` and `PATCH /api/groups/:id` — distinct from `serve()`
 * above, which answers a narrower slice with no schema and no plan to offer,
 * since picking alone never needed either.
 *
 * `patched` and `pickCalls` are what a test reads back: `patched` proves
 * *whether* and *with what digest* a save reached the server, and `pickCalls`
 * proves Picks reloaded rather than patched its list, the way its own comment
 * on `applyEdit` says it must.
 */
function stubApi(options: StubOptions): { patched: Patched[]; pickCalls: number } {
  const state = { patched: [] as Patched[], pickCalls: 0 };

  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');

    if (url.pathname === '/api/metadata/request') {
      const body = JSON.parse(String(init?.body)) as { groupIds: number[] };
      return new Response(
        JSON.stringify({
          queued: 0,
          alreadyAnswered: body.groupIds.length,
          pending: 0,
          missing: 0,
          unavailable: 0,
        } satisfies MetadataRequestResponse),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/metadata') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((part) => part.length > 0);
      const response: Record<number, MetadataView> = {};
      for (const id of ids) response[Number(id)] = { state: 'none' };
      return new Response(JSON.stringify(response), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/manual-fields') {
      return new Response(JSON.stringify(options.manualFields ?? ({} satisfies ManualFieldsResponse)), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/identity-plan')) {
      if (options.identityPlan === undefined) {
        throw new Error(`identity-plan requested but no plan stubbed for ${url.pathname}`);
      }
      return new Response(JSON.stringify(options.identityPlan), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as {
        values: Record<string, string>;
        planDigest?: string;
      };
      const groupId = Number(url.pathname.split('/')[3]);
      // `planDigest` is omitted rather than set to `undefined` — the same
      // idiom `api.editGroup` itself uses — so `patched[n]?.planDigest` reads
      // `undefined` only because the key is genuinely absent, not because it
      // was explicitly written as such.
      state.patched.push(
        body.planDigest === undefined
          ? { groupId, values: body.values }
          : { groupId, values: body.values, planDigest: body.planDigest },
      );
      return new Response(
        JSON.stringify(
          options.groupEdit ??
            ({
              group: options.picks[0]!,
              mergedInto: null,
              renamed: 0,
              trashed: 0,
              failed: [],
            } satisfies GroupEditResponse),
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/picks') {
      state.pickCalls += 1;
      return new Response(JSON.stringify({ groups: options.picks } satisfies PicksResponse), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  });

  return state;
}

/**
 * Every `groupIds` array `serve()`'s mock has seen on `POST
 * /api/metadata/request`, reset at the start of each `serve()` call. A test
 * that only cares about `/api/picks` and picking never reads this; the ones
 * about metadata batching do.
 */
const metadataRequestBodies: number[][] = [];

/**
 * `/api/picks` answers `first`, and every load after the first answers
 * `reloaded` when one is given — which is how a test tells a re-render apart
 * from the render it started with.
 *
 * Also answers the two metadata endpoints `useGroupMetadata` now calls for
 * every group Picks renders: `'none'` for every id on `GET /api/metadata`,
 * settled so the hook never polls again for it, the same default
 * `Browse.test.tsx` uses for the same reason — these tests are about picking
 * and reloading, not the metadata panel.
 */
function serve(first: GroupView[], reloaded?: GroupView[]): void {
  let loads = 0;
  metadataRequestBodies.length = 0;
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');

    if (url.pathname === '/api/metadata/request') {
      const body = JSON.parse(String(init?.body)) as { groupIds: number[] };
      metadataRequestBodies.push(body.groupIds);
      return new Response(
        JSON.stringify({
          queued: 0,
          alreadyAnswered: body.groupIds.length,
          pending: 0,
          missing: 0,
          unavailable: 0,
        } satisfies MetadataRequestResponse),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/metadata') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((part) => part.length > 0);
      const response: Record<number, MetadataView> = {};
      for (const id of ids) response[Number(id)] = { state: 'none' };
      return new Response(JSON.stringify(response), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // Picks now fetches its schema map unconditionally on mount (Task 10);
    // answered here, off the `loads` counter below, so it cannot be mistaken
    // for a `/api/picks` load and thrown off which of `first`/`reloaded` a
    // test sees. No plugin has a schema in these tests, which is exactly what
    // keeps every existing test's cards free of an Edit button.
    if (url.pathname === '/api/manual-fields') {
      return new Response(JSON.stringify({} satisfies ManualFieldsResponse), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // A pick POSTs and then reloads; its response body goes unread.
    if (init?.method === 'POST') {
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    loads += 1;
    const body: PicksResponse = { groups: loads === 1 ? first : (reloaded ?? first) };
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  });
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
        absentSince: null,
      },
    ],
    untracked: [],
    nextCursor: null,
  };
  const picks: PicksResponse = {
    groups: [failedPick(group(2, 'Beta')), group(1, 'Alpha')],
  };
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/downloads') {
      return new Response(JSON.stringify(downloads), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // The Picks route this test navigates to now polls for metadata too; see
    // `serve()`'s own comment for why `'none'` is the right answer here.
    if (url.pathname === '/api/metadata/request') {
      const body = JSON.parse(String(init?.body)) as { groupIds: number[] };
      return new Response(
        JSON.stringify({
          queued: 0,
          alreadyAnswered: body.groupIds.length,
          pending: 0,
          missing: 0,
          unavailable: 0,
        } satisfies MetadataRequestResponse),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/metadata') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((part) => part.length > 0);
      const response: Record<number, MetadataView> = {};
      for (const id of ids) response[Number(id)] = { state: 'none' };
      return new Response(JSON.stringify(response), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // Picks now fetches its schema map on mount (Task 10); no plugin has one
    // here, which is what keeps every card free of an Edit button this test
    // has no interest in.
    if (url.pathname === '/api/manual-fields') {
      return new Response(JSON.stringify({} satisfies ManualFieldsResponse), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(picks), { headers: { 'content-type': 'application/json' } });
  });

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

test('a page of ids is requested once, not once per card', async () => {
  // The invariant `useGroupMetadata`'s own tests guard in isolation, proven
  // here at the point it actually matters: that wiring the hook into Picks
  // hands it one array for the whole list, not a per-card effect.
  serve([group(1, 'Alpha'), group(2, 'Beta'), group(3, 'Gamma')]);

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Gamma')));
  await waitFor(() => assert.equal(metadataRequestBodies.length, 1));
  assert.deepEqual(metadataRequestBodies[0], [1, 2, 3]);
});

test('a reload that keeps the same groups costs no extra metadata request', async () => {
  // Picking an alternative reloads the list (§7.3's "leave it listed, updated"
  // case), and the ids on screen afterwards are exactly what they were before.
  // `useGroupMetadata` keys its effect on the id list's content precisely so a
  // reload like this does not look like a fresh page to ask about again — this
  // is that guard exercised through Picks rather than through the hook alone.
  serve([group(1, 'Alpha')], [{ ...group(1, 'Alpha'), upgradeReleaseId: 11 }]);

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  await waitFor(() => assert.equal(metadataRequestBodies.length, 1));

  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);
  await waitFor(() => assert.ok(screen.getByText(/upgrade available/i)));

  // Comfortably longer than the hook would take to re-ask if the reload had
  // been mistaken for a new page.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(metadataRequestBodies.length, 1);
});

test('polling stops once nothing is pending', async () => {
  let getCalls = 0;
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/picks') {
      const body: PicksResponse = { groups: [group(5, 'Echo')] };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/metadata/request') {
      return new Response(
        JSON.stringify({
          queued: 1,
          alreadyAnswered: 0,
          pending: 0,
          missing: 0,
          unavailable: 0,
        } satisfies MetadataRequestResponse),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/metadata') {
      getCalls += 1;
      // Pending on the first answer (the worker has not run yet), confirmed on
      // every one after — a group's answer settles and stays settled.
      const view: MetadataView =
        getCalls === 1
          ? { state: 'pending' }
          : {
              state: 'confirmed',
              title: 'Echo title',
              performers: [],
              releaseDate: null,
              durationSeconds: null,
              synopsis: null,
              hasPoster: false,
              hasBackground: false,
            };
      return new Response(JSON.stringify({ 5: view }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // Picks now fetches its schema map on mount (Task 10); this test is about
    // polling, not editing, so no plugin has one.
    if (url.pathname === '/api/manual-fields') {
      return new Response(JSON.stringify({} satisfies ManualFieldsResponse), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Echo title')), { timeout: 3_000 });

  const callsOnceConfirmed = getCalls;
  // Comfortably longer than the hook's own backoff would wait before polling
  // again, so a poller that failed to stop would have already made another
  // call by the time this checks.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(getCalls, callsOnceConfirmed);
});

test('does not poll forever when metadata is unavailable server-wide', async () => {
  // `POST /api/metadata/request` refuses to queue when the worker is disabled
  // or no `siteLookup` is configured (packages/core/src/http/server.ts), and
  // reports those ids `unavailable` rather than `queued`. `GET /api/metadata`
  // then has nothing answered and nothing queued for them, so it answers
  // `absent` — settled, not `pending` — which is what stops the poll rather
  // than any special case in the hook for `unavailable` itself.
  let getCalls = 0;
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/picks') {
      const body: PicksResponse = { groups: [group(9, 'Nine')] };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/metadata/request') {
      return new Response(
        JSON.stringify({
          queued: 0,
          alreadyAnswered: 0,
          pending: 0,
          missing: 0,
          unavailable: 1,
        } satisfies MetadataRequestResponse),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/metadata') {
      getCalls += 1;
      return new Response(JSON.stringify({ 9: { state: 'absent' } } satisfies Record<number, MetadataView>), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // Picks now fetches its schema map on mount (Task 10); this test is about
    // polling, not editing, so no plugin has one.
    if (url.pathname === '/api/manual-fields') {
      return new Response(JSON.stringify({} satisfies ManualFieldsResponse), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Nine')));
  await waitFor(() => assert.equal(getCalls, 1));

  // Long enough that a poller which failed to stop on `absent` would have
  // already made a second call.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(getCalls, 1);
});

// Picks had no edit affordance at all before this feature — that was half the
// bug report: a picked group whose corrected identity belonged to another
// group was unreachable here, because Browse only lists groups still
// `state = 'new'` or flagged for upgrade.

test('a picked group offers an edit form', async () => {
  stubApi({ picks: [PICKED_GROUP], manualFields: { scenes: FIELDS } });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  assert.ok(await screen.findByRole('button', { name: /edit/i }));
});

test('a display-only edit saves without a confirmation', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { scenes: FIELDS },
    identityPlan: PLAN_NO_MOVES,
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fixed' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));

  await waitFor(() => assert.equal(stub.patched.length, 1));
  assert.equal(stub.patched[0]?.planDigest, undefined);
  assert.equal(screen.queryByRole('dialog'), null);
});

test('a merge shows the confirmation and only saves once confirmed', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { scenes: FIELDS },
    identityPlan: PLAN_MERGE,
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'k2' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));

  const dialog = await screen.findByRole('dialog');
  assert.ok(dialog);
  assert.equal(stub.patched.length, 0, 'nothing is saved before confirmation');

  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.equal(stub.patched.length, 1));
  assert.equal(stub.patched[0]?.planDigest, PLAN_MERGE.digest);
});

test('a merge reloads the list rather than patching it', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { scenes: FIELDS },
    identityPlan: PLAN_MERGE,
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'k2' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));

  // Two: the initial load, then the reload after the merge. Which list a group
  // belongs to after a merge is the server's answer, not one to reconstruct.
  await waitFor(() => assert.equal(stub.pickCalls, 2));
});

test('a blocked plan with no file work still shows its blocker and saves nothing', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { scenes: FIELDS },
    identityPlan: PLAN_BLOCKED,
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'k3' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));

  const dialog = await screen.findByRole('dialog');
  assert.ok(
    within(dialog).getByText(/is already occupied, so .* cannot be moved there/),
    'the blocker text must reach the user, not just refuse silently later',
  );
  assert.equal(
    screen.getByRole('button', { name: /confirm/i }).getAttribute('disabled'),
    '',
    'Confirm must be disabled while a blocker stands',
  );
  assert.equal(stub.patched.length, 0, 'a blocked plan must never reach the server unconfirmed');
});

test('a save that leaves files unmoved reports how many, and which', async () => {
  // §5.1: a per-file failure in phases 2/3 does not abort the merge, so the
  // save itself succeeds — but the library is left in two layouts, and this
  // banner is the only thing that tells the user that. Exercised on Picks
  // rather than Browse: both routes build the same message from the same
  // `GroupEditResponse.failed` (see `applyEdit`'s own comment on each route),
  // and Picks's `stubApi` already models `groupEdit` directly, with no
  // card-patching to also account for.
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { scenes: FIELDS },
    identityPlan: PLAN_NO_MOVES,
    groupEdit: {
      group: PICKED_GROUP,
      mergedInto: null,
      renamed: 0,
      trashed: 1,
      failed: [{ path: '/library/k1/1080.mp4', error: 'EACCES' }],
    },
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fixed' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));

  await waitFor(() => assert.equal(stub.patched.length, 1));
  assert.ok(await screen.findByText(/Saved, but 1 file\(s\) could not be moved/));
  assert.ok(screen.getByText(/\/library\/k1\/1080\.mp4/));
  assert.ok(screen.getByText(/EACCES/));
});

test('each card\'s Requery button reaches POST /api/metadata/requery with that card\'s group id', async () => {
  // Picks' own `requeryMetadata` was a verbatim copy of Browse's with no test
  // on this route at all. The body of it now lives in `requeryOneGroup`
  // (`requeryMetadata.test.ts` covers the accept-then-rearm ordering and every
  // refusal), so what is left to prove here is the wiring: the prop reaches
  // the card, and the id that goes out is the card's own rather than the first
  // group in the list.
  //
  // Layered over `serve()` rather than replacing it: that stub answers every
  // other endpoint this route touches, including the `'none'` on
  // `GET /api/metadata` that makes a group settled enough to show the button —
  // but its blanket POST branch would swallow the requery.
  serve([group(1, 'Alpha'), group(2, 'Beta')]);
  const base = globalThis.fetch;
  const requeried: number[][] = [];
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/metadata/requery') {
      requeried.push((JSON.parse(String(init?.body)) as { groupIds: number[] }).groupIds);
      return new Response(
        JSON.stringify({
          requeued: 1,
          missing: 0,
          unavailable: 0,
          unaskable: 0,
        } satisfies MetadataRequeryResponse),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return base(input, init);
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  // The button appears only once the metadata answer has landed, which is what
  // makes the group settled.
  const beta = await waitFor(() => {
    const element = screen.getByText('Beta').closest('article');
    assert.ok(element !== null);
    return element;
  });
  fireEvent.click(within(beta).getByRole('button', { name: 'Requery metadata' }));

  await waitFor(() => assert.deepEqual(requeried, [[2]]));
});

// The search box. `/api/picks` answers everything picked in one response, so
// there is nothing off-screen for a term to reach and the filtering is done
// here rather than by a round trip per keystroke — see `groupSearchText`'s own
// doc for why the haystack is built the way the server's `search_text` is.

test('typing a term leaves only the cards that match it', async () => {
  serve([group(1, 'Alpha'), group(2, 'Beta'), group(3, 'Gamma')]);

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Gamma')));

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search picks' }), {
    target: { value: 'bet' },
  });

  assert.ok(screen.getByText('Beta'));
  assert.equal(screen.queryByText('Alpha'), null);
  assert.equal(screen.queryByText('Gamma'), null);
});

test('the term reaches the same parts of a display the server matches on', async () => {
  // Not just the title. `/api/browse?q=` matches `search_text`, which holds the
  // subtitle, the date and every field *value* too — so a term that finds a
  // group on Browse has to find it here, or the two tabs disagree about what
  // the same word means.
  serve([
    {
      ...group(1, 'Alpha'),
      display: {
        title: 'Alpha',
        subtitle: 'Backroom Casting',
        date: '2026-02-14',
        fields: [{ label: 'Site', value: 'BangBros' }],
      },
    },
    group(2, 'Beta'),
  ]);

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  const box = screen.getByRole('searchbox', { name: 'Search picks' });

  for (const term of ['casting', '2026-02', 'bangbros']) {
    fireEvent.change(box, { target: { value: term } });
    assert.ok(screen.getByText('Alpha'), `"${term}" must reach the card`);
    assert.equal(screen.queryByText('Beta'), null, `"${term}" must not reach the other card`);
  }
});

test('clearing the term restores the whole list', async () => {
  serve([group(1, 'Alpha'), group(2, 'Beta')]);

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  const box = screen.getByRole('searchbox', { name: 'Search picks' });

  fireEvent.change(box, { target: { value: 'alpha' } });
  assert.equal(screen.queryByText('Beta'), null);

  // Whitespace, not '': a term deleted with the keyboard often leaves a space
  // behind, and a lone space is not a query.
  fireEvent.change(box, { target: { value: ' ' } });
  assert.ok(screen.getByText('Alpha'));
  assert.ok(screen.getByText('Beta'));
});

test('a filtered-out card keeps its metadata polled', async () => {
  // `useGroupMetadata` is handed every group the route holds, not the ones
  // currently rendered. Narrowing it to the visible cards would make typing
  // look like a new page to the hook — a fresh `POST /api/metadata/request`
  // per keystroke — and would abandon a pending answer for a card the reader
  // is about to bring back by clearing the box.
  serve([group(1, 'Alpha'), group(2, 'Beta'), group(3, 'Gamma')]);

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Gamma')));
  await waitFor(() => assert.deepEqual(metadataRequestBodies, [[1, 2, 3]]));

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search picks' }), {
    target: { value: 'alpha' },
  });
  await waitFor(() => assert.equal(screen.queryByText('Gamma'), null));

  // Long enough that a hook handed a narrowed list would have asked again.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(metadataRequestBodies, [[1, 2, 3]]);
});
