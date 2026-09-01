import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Picks } from '../src/routes/Picks.tsx';
import { groupAnchor } from '../src/api/anchors.ts';
import {
  api,
  type DownloadsResponse,
  type DownloadView,
  type GroupEditResponse,
  type GroupView,
  type IdentityPlanView,
  type ManualField,
  type ManualFieldsResponse,
  type MetadataRequestResponse,
  type MetadataRequeryResponse,
  type MetadataView,
  type PicksResponse,
  type ReleaseDownloadsResponse,
  type ReleaseDownloadView,
  type UntrackedEntry,
} from '../src/api/client.ts';
import { POLL_MS } from '../src/api/useGroupDownloads.ts';
import { fetchStub } from './fetchStub.ts';
import { gone } from './dom.ts';

afterEach(cleanup);

/**
 * `/api/downloads`'s answer for every test that has no interest in the
 * download client's own queue — Picks now fetches it unconditionally on
 * mount, so every stub in this file has to answer the route even though most
 * tests are about picking, not about downloads.
 */
const EMPTY_DOWNLOADS: DownloadsResponse = { tracked: [], untracked: [], nextCursor: null };

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
      release.id === healthy.pickedReleaseId
        ? { ...release, download: { downloadId: 1, status: 'failed', error: null, absentSince: null } }
        : release,
    ),
  };
}

/**
 * `failedPick`'s own shape, generalized to any status (and, when a test needs
 * one, an overridden `downloadId` or `absentSince`): the mark on the release
 * that holds the download, and nothing else — `download` is per release
 * (`ReleaseView.download`'s own doc), not a group-level field, so this never
 * needs to touch the rest of `healthy`.
 */
function withDownload(
  healthy: GroupView,
  over: { status: string } & Partial<Pick<ReleaseDownloadView, 'downloadId' | 'absentSince'>>,
): GroupView {
  return {
    ...healthy,
    releases: healthy.releases.map((release) =>
      release.id === healthy.pickedReleaseId
        ? {
            ...release,
            download: {
              downloadId: release.id,
              error: null,
              absentSince: null,
              ...over,
            },
          }
        : release,
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
    if (url.pathname === '/api/downloads') {
      return new Response(JSON.stringify(EMPTY_DOWNLOADS), {
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
function serve(first: GroupView[], reloaded?: GroupView[], untracked: UntrackedEntry[] = []): void {
  let loads = 0;
  metadataRequestBodies.length = 0;
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');

    if (url.pathname === '/api/downloads') {
      const body: DownloadsResponse = { tracked: [], untracked, nextCursor: null };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }
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

interface DownloadsStubOptions {
  /**
   * `/api/picks`'s answer, as a function of how many times it has now been
   * called (1-based) — the same "first vs. every load after" shape `serve()`
   * hard-codes for two calls, generalized so a test can drive a reload with a
   * click rather than a second fixed argument.
   */
  picksFor(loadNumber: number): GroupView[];
  /**
   * `/api/downloads/for-groups`'s answer, read the same way
   * `useGroupDownloads.test.tsx`'s own stub reads the `ids` query param —
   * this is `useGroupDownloads`'s only channel in, so a test proves what
   * Picks watched by inspecting the `ids` it was actually asked about.
   */
  answerDownloads(ids: number[]): ReleaseDownloadsResponse;
  /**
   * `POST /api/downloads/:id/retry`'s answer. Absent for every test that
   * never clicks Retry, which is most of them.
   */
  retry?(downloadId: number): Response;
}

/**
 * `serve()`'s own endpoints, plus `/api/downloads/for-groups` and
 * `POST /api/downloads/:id/retry` — the two this task wires up for the first
 * time. Kept separate from `serve()` itself rather than folded into it: every
 * test written before this task passes no downloads answer at all, and
 * `useGroupDownloads`'s own early return on an empty `watched` list means
 * none of them ever reach this endpoint — adding it to `serve()` unconditionally
 * would just be dead code there.
 */
function serveWithDownloads(options: DownloadsStubOptions): {
  forGroupsCalls: number[][];
  picksCalls: number;
} {
  const state = { forGroupsCalls: [] as number[][], picksCalls: 0 };
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');

    if (url.pathname === '/api/downloads') {
      return new Response(JSON.stringify(EMPTY_DOWNLOADS), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/downloads/for-groups') {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',')
        .filter((part) => part.length > 0)
        .map(Number);
      state.forGroupsCalls.push(ids);
      return new Response(JSON.stringify(options.answerDownloads(ids)), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const retryMatch = /^\/api\/downloads\/(\d+)\/retry$/.exec(url.pathname);
    if (retryMatch !== null && options.retry !== undefined) {
      return options.retry(Number(retryMatch[1]));
    }
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
      return new Response(JSON.stringify({} satisfies ManualFieldsResponse), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // A pick POSTs and then reloads; its response body goes unread — the
    // same shape `serve()`'s own POST branch is.
    if (init?.method === 'POST') {
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/picks') {
      state.picksCalls += 1;
      const body: PicksResponse = { groups: options.picksFor(state.picksCalls) };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  });
  return state;
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
    // Picks now fetches the download client's own queue on mount too; this
    // test is about the metadata poll, so the answer carries nothing.
    if (url.pathname === '/api/downloads') {
      return new Response(JSON.stringify(EMPTY_DOWNLOADS), {
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
    // Picks now fetches the download client's own queue on mount too; this
    // test is about the metadata poll, so the answer carries nothing.
    if (url.pathname === '/api/downloads') {
      return new Response(JSON.stringify(EMPTY_DOWNLOADS), {
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
  assert.ok(!screen.queryByRole('dialog'), 'the dialog is closed');
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
  // makes the group settled — so the button lookup itself must be inside the
  // retry, not just the article it lives in. Guarding only the article and
  // then querying for the button on the next, unretried line let this pass or
  // fail depending on how far act's async flush had drained the fetch chain.
  const requeryButton = await waitFor(() => {
    const element = screen.getByText('Beta').closest('article');
    assert.ok(element !== null);
    return within(element).getByRole('button', { name: 'Requery metadata' });
  });
  fireEvent.click(requeryButton);

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
  assert.ok(gone('Alpha'), 'Alpha is filtered out');
  assert.ok(gone('Gamma'), 'Gamma is filtered out');
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
    assert.ok(gone('Beta'), `"${term}" must not reach the other card`);
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
  assert.ok(gone('Beta'), 'Beta is filtered out');

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
  await waitFor(() => assert.ok(gone('Gamma'), 'Gamma is gone'));

  // Long enough that a hook handed a narrowed list would have asked again.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(metadataRequestBodies, [[1, 2, 3]]);
});

// Picks watching its own downloads. `useGroupDownloads` (Task 4) does the
// polling; what belongs here is the wiring the Downloads tab used to own
// outright — which groups are worth asking about, merging the live answer
// over what `/api/picks` already said, and a retry that patches rather than
// reloading.

/** A `DownloadView`, defaulted the same way `Downloads.test.tsx`'s own `download()` is. */
function download(over: Partial<DownloadView> = {}): DownloadView {
  return {
    id: 1,
    groupId: 1,
    releaseId: 10,
    title: 'Alpha',
    kind: 'initial',
    status: 'downloading',
    error: null,
    attempts: 0,
    updatedAt: 1,
    absentSince: null,
    ...over,
  };
}

/** Lets an already-queued microtask run, and React commit what it produced. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('only groups with something in flight are polled', async () => {
  // One group already landed, one still going — `watched` must reach exactly
  // the second.
  const groups = [withDownload(group(1, 'Alpha'), { status: 'imported' }), withDownload(group(2, 'Beta'), { status: 'downloading' })];
  const stub = serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: () => ({}),
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Beta')));
  await waitFor(() => assert.ok(stub.forGroupsCalls.length > 0));
  assert.deepEqual(stub.forGroupsCalls[0], [2], 'only the downloading group is watched');
});

test('a live status overrides the one the payload arrived with', async () => {
  // `/api/picks` said "downloading"; the poll's own answer says the download
  // has since failed. The row has to show the fresher of the two.
  const groups = [withDownload(group(1, 'Alpha'), { status: 'downloading' })];
  const stub = serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: (ids) =>
      ids.includes(1)
        ? { 1: { 10: { downloadId: 1, status: 'failed', error: 'disk full', absentSince: null } } }
        : {},
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  await waitFor(() => assert.ok(screen.getByText('Failed')));
  assert.ok(gone('downloading'), 'the static answer no longer shows once a fresher one has landed');
  assert.deepEqual(stub.forGroupsCalls[0], [1]);
});

test('a download that imports mid-poll stops being watched', async () => {
  // Otherwise the poll runs forever on a finished download. `watched` is
  // recomputed from `groups` on every render — not from the live answer
  // itself, which this hook has no way to feed back in — so what has to
  // change is the *static* payload: a reload (here, picking the untried
  // alternative) that reports the download has landed.
  //
  // Real timers, not `t.mock.timers`: mocking `setInterval` ahead of this
  // component's initial async load is a measured source of stalls in this
  // file. Run solo eight times before this change, this test failed twice —
  // both times on the first `waitFor` below, timing out on an empty screen —
  // and the two retry tests further down that already prefer real timers
  // give the same reason. The cost here is the same one they already pay: a
  // few real seconds waiting a `POLL_MS` tick out instead of ticking a mock.
  const downloading = [withDownload(group(1, 'Alpha'), { status: 'downloading' })];
  const imported = [withDownload(group(1, 'Alpha'), { status: 'imported' })];
  const stub = serveWithDownloads({
    picksFor: (loadNumber) => (loadNumber === 1 ? downloading : imported),
    answerDownloads: () => ({}),
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  await waitFor(() => assert.deepEqual(stub.forGroupsCalls, [[1]]));

  // The untried alternative's Pick button — the only one rendered, since the
  // downloading release is both current and in flight. A click here already
  // runs `reload()`.
  fireEvent.click(screen.getByRole('button', { name: /pick/i }));
  // `imported`, not `Current`: this is only a synchronisation point for "the
  // reload landed and reported the download settled", and an imported download
  // now shows its own status instead of borrowing `Current` (§4, amended).
  await waitFor(() => assert.ok(screen.getByText('imported')), { timeout: 5_000 });
  assert.equal(stub.picksCalls, 2);

  // No further request for group 1 ever fires: `watched` is now empty, so
  // `useGroupDownloads`'s effect returns before scheduling one. Waiting out a
  // real `POLL_MS` tick is what would have produced a second call if the
  // filter had kept watching it.
  await new Promise((resolve) => setTimeout(resolve, POLL_MS + 500));
  assert.deepEqual(stub.forGroupsCalls, [[1]], 'nothing left to watch, so no further request');
});

test('a download that imports through the poll alone, with no reload, stops being watched', async () => {
  // The passive case the test above cannot reach: nothing here ever picks,
  // edits, or retries anything — `/api/picks` answers the same `downloading`
  // group on every load, so the *only* way this group's `imported` status can
  // ever reach `groups` is the write-back effect folding the poll's own
  // answer in. Assert on the request ids the stub receives, not on what the
  // row displays: `mergedReleases` always prefers the live answer over
  // `groups`, so the display was already correct before this effect existed
  // — a display assertion here would pass whether or not the fix exists,
  // which is exactly why the bug shipped unnoticed.
  const groups = [withDownload(group(1, 'Alpha'), { status: 'downloading' })];
  let pollCount = 0;
  const stub = serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: () => {
      pollCount += 1;
      return {
        1: { 10: { downloadId: 10, status: pollCount === 1 ? 'downloading' : 'imported', error: null, absentSince: null } },
      };
    },
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  await waitFor(() => assert.deepEqual(stub.forGroupsCalls, [[1]]));

  // The next real `POLL_MS` tick reports `imported`. Once `groups` absorbs
  // it, `watched` drops group 1 on its own — no click, no reload.
  await waitFor(() => assert.equal(stub.forGroupsCalls.length, 2), { timeout: POLL_MS + 3_000 });
  assert.equal(stub.picksCalls, 1, 'the mount load only — nothing here ever reloads');

  // No third request ever fires: waiting out another real `POLL_MS` tick is
  // what would have produced one had `watched` kept including this group.
  await new Promise((resolve) => setTimeout(resolve, POLL_MS + 500));
  assert.deepEqual(
    stub.forGroupsCalls,
    [[1], [1]],
    'group 1 drops out of watched once its download settles, with no reload',
  );
});

test('a poll landing that changes nothing does not loop', async () => {
  // Every tick reports the same non-terminal status, forever — nothing for
  // the write-back effect to ever settle. If writing to `groups` were not
  // guarded against a no-op change, each poll tick (a new `Map` every time,
  // per `useGroupDownloads`) would trigger a `groups` update, a re-render,
  // and — since the effect depends on `liveDownloads` — the risk of driving
  // more polls or renders than the flat `POLL_MS` interval itself calls for.
  // One request per elapsed `POLL_MS` is what a correctly-guarded effect
  // produces; a tight loop would blow well past that in the same window.
  const groups = [withDownload(group(1, 'Alpha'), { status: 'downloading' })];
  const stub = serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: () => ({
      1: { 10: { downloadId: 10, status: 'downloading', error: null, absentSince: null } },
    }),
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  await waitFor(() => assert.ok(stub.forGroupsCalls.length > 0));

  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2 + 500));
  assert.ok(
    stub.forGroupsCalls.length <= 3,
    `expected at most 3 requests (the mount poll plus two real ticks), got ${stub.forGroupsCalls.length}`,
  );
});

test('a refused retry surfaces instead of vanishing', async () => {
  // Re-homed from `Downloads.test.tsx` — the row moved, the failure mode
  // (a click that looked like it did nothing) did not.
  const groups = [failedPick(group(1, 'Alpha'))];
  serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: () => ({}),
    retry: () =>
      new Response(JSON.stringify({ error: 'Only a failed download can be retried' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByRole('button', { name: /retry/i })));
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));

  await waitFor(() => assert.ok(screen.getByText(/only a failed download can be retried/i)));
});

test('retry refreshes the row immediately, without waiting on the poll', async () => {
  // Re-homed from `Downloads.test.tsx`, now proving the same property through
  // `useGroupDownloads`'s `patch` instead of a screen-owned `setItems` — and
  // built around `failed`, retry's primary case, rather than an absent-but-
  // not-failed download: a `failed` release is excluded from `watched`
  // before the click, so nothing here can reach `queued` except `retry`
  // itself, either through `patch` directly or through the immediate poll
  // `watched` triggers once `groups` reflects the retried status. Real
  // timers throughout, deliberately: this test finishes in well under
  // `POLL_MS`, so nothing here needs to freeze the recurring poll to prove
  // it never fired — and mocking `setInterval` before this component's
  // initial async load lands is its own hazard (see the "not wiped" test
  // below for the measured cost).
  const groups = [withDownload(group(1, 'Alpha'), { status: 'failed', downloadId: 5 })];

  const stub = serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: (ids) =>
      ids.includes(1) ? { 1: { 10: { downloadId: 5, status: 'queued', error: null, absentSince: null } } } : {},
    retry: () =>
      new Response(
        JSON.stringify(download({ id: 5, groupId: 1, releaseId: 10, status: 'queued', attempts: 1 }) satisfies DownloadView),
        { headers: { 'content-type': 'application/json' } },
      ),
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByRole('button', { name: /retry/i })));
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));

  await waitFor(() => assert.equal(screen.getByText('queued').textContent, 'queued'));
  // The mount's own load, and nothing else: the retry patched the row rather
  // than reloading the screen to learn it.
  assert.equal(stub.picksCalls, 1);
});

test('a retried failed download is not wiped by the next poll when another group is watched', async () => {
  // The bug this pins: `watched` is derived from `groups`, and a `failed`
  // download is excluded from it by design. If `retry` only patched
  // `useGroupDownloads`'s own map — never `groups` — then with group 2
  // already watched, the next poll would replace that map wholesale for
  // *group 2's* answer alone (`useGroupDownloads.ts`'s poll always replaces
  // its whole map with exactly what it just asked about) and wipe the
  // patched `queued` entry straight back out, reverting the row to `Failed`
  // even though the retry succeeded on the server.
  //
  // Real timers, not `t.mock.timers`: mocking `setInterval` ahead of this
  // component's initial async load turns out to be its own source of
  // flakiness in this test environment — a genuine, reproducible stall (the
  // very first `waitFor` below sometimes never sees the mount's own fetch
  // land, ~30-40% of runs measured in isolation) rather than a slow-poll
  // race, and it pre-dates this task: the same pattern already flakes the
  // same way in `Downloads.test.tsx`'s own un-mocked-by-this-task version of
  // this test. Waiting out a real `POLL_MS` below costs a few seconds but
  // sidesteps that hazard entirely, the same way `useGroupDownloads.test.tsx`
  // itself already prefers real timers over mocked ones for its own poll
  // assertions.
  const groups = [
    withDownload(group(1, 'Alpha'), { status: 'failed', downloadId: 5 }),
    withDownload(group(2, 'Beta'), { status: 'downloading', downloadId: 6 }),
  ];

  serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: (ids) => {
      const answer: ReleaseDownloadsResponse = {};
      if (ids.includes(1)) answer[1] = { 10: { downloadId: 5, status: 'queued', error: null, absentSince: null } };
      if (ids.includes(2)) answer[2] = { 20: { downloadId: 6, status: 'downloading', error: null, absentSince: null } };
      return answer;
    },
    retry: () =>
      new Response(
        JSON.stringify(download({ id: 5, groupId: 1, releaseId: 10, status: 'queued', attempts: 1 }) satisfies DownloadView),
        { headers: { 'content-type': 'application/json' } },
      ),
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByRole('button', { name: /retry/i })));
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  await waitFor(() => assert.equal(screen.getByText('queued').textContent, 'queued'));

  // One real `POLL_MS` tick must not wipe the retried row back to Failed.
  await new Promise((resolve) => setTimeout(resolve, POLL_MS + 500));
  assert.equal(screen.getByText('queued').textContent, 'queued', 'the retried row must not revert to Failed');
  assert.ok(gone('Failed'), 'the row must not have reverted to Failed');
});

test('a retried failed download joins the watch list instead of freezing when nothing else is watched', async () => {
  // The other half of the same bug: with no other group watched,
  // `useGroupDownloads`'s effect never starts at all for an empty `watched`
  // list, so if `retry` left `groups` unchanged the patched `queued` state
  // would freeze forever — never confirmed, never corrected — instead of
  // reflecting real progress. A freshly-`queued` download is genuinely
  // non-terminal, so it has to earn its way back onto `watched` rather than
  // sitting there unpolled.
  //
  // Real timers, for the same reason the "not wiped" test above gives: this
  // only needs the *immediate* poll a newly non-empty `watched` triggers, not
  // the recurring one, so there is nothing here worth mocking `setInterval`
  // for in the first place.
  const groups = [withDownload(group(1, 'Alpha'), { status: 'failed', downloadId: 5 })];

  const stub = serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: (ids) =>
      ids.includes(1) ? { 1: { 10: { downloadId: 5, status: 'queued', error: null, absentSince: null } } } : {},
    retry: () =>
      new Response(
        JSON.stringify(download({ id: 5, groupId: 1, releaseId: 10, status: 'queued', attempts: 1 }) satisfies DownloadView),
        { headers: { 'content-type': 'application/json' } },
      ),
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByRole('button', { name: /retry/i })));
  assert.deepEqual(stub.forGroupsCalls, [], 'a failed-only group is never watched before the retry');

  fireEvent.click(screen.getByRole('button', { name: /retry/i }));

  // The retry's own response makes the download non-terminal, so the poll
  // must actually start for it now — not just the hook's map getting one
  // write that then sits with nothing left to confirm or correct it.
  await waitFor(() => assert.ok(stub.forGroupsCalls.length > 0));
  assert.deepEqual(stub.forGroupsCalls[0], [1]);
});

test('a bodyless request carries no json content-type', async () => {
  // Re-homed from `Downloads.test.tsx`. Retry sends no body. Declaring one
  // anyway made Fastify reject it with a 400 before the route ran, so the
  // button never worked — and the click site had no catch, so it failed in
  // silence (`client.ts` around line 449 records why).
  const sent: RequestInit[] = [];
  globalThis.fetch = fetchStub(async (_input, init) => {
    sent.push(init ?? {});
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });

  await api.retry(7);
  assert.equal(sent[0]?.headers, undefined);

  await api.pick(1, 2);
  assert.deepEqual(sent[1]?.headers, { 'content-type': 'application/json' });
});

test('a poll landing does not clear the term or unfilter the list', async () => {
  // Re-homed from `Downloads.test.tsx`, and newly relevant: `useGroupDownloads`
  // is the first poll Picks has ever had, so it is the first thing that could
  // do to this screen what an equivalent bug did to Downloads — a box that
  // still holds a term while the list has silently gone back to showing
  // everything, or a card the term is hiding that reappears the moment fresh
  // information lands for it.
  //
  // Real timers, not `t.mock.timers`: mocking `setInterval` ahead of this
  // component's initial async load is a measured source of stalls in this
  // file — see "a download that imports mid-poll stops being watched" above
  // for the counts. Deferred promises (rather than `waitFor`) still pin
  // exactly which poll has landed, for the same reason `Downloads.test.tsx`'s
  // own version of this test gives; the second poll is now awaited out over
  // the real interval instead of ticked forward on a mocked one.
  const groups = [withDownload(group(1, 'Alpha'), { status: 'downloading' }), group(2, 'Beta')];

  const resolvers: (() => void)[] = [];
  const handedBack = Array.from({ length: 2 }, () => new Promise<void>((resolve) => resolvers.push(resolve)));
  let polls = 0;
  serveWithDownloads({
    picksFor: () => groups,
    answerDownloads: (ids) => {
      polls += 1;
      // The second poll is the one that matters: Alpha's status changes
      // under the term, which is the case a filter re-derived from fresh
      // data must not let through.
      const status = polls === 1 ? 'downloading' : 'failed';
      resolvers[polls - 1]?.();
      return ids.includes(1) ? { 1: { 10: { downloadId: 1, status, error: null, absentSince: null } } } : {};
    },
  });

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );
  await handedBack[0];
  await flush();
  assert.ok(screen.getByText('Beta'));

  const box = screen.getByRole('searchbox', { name: 'Search picks' });
  fireEvent.change(box, { target: { value: 'beta' } });
  assert.ok(gone('Alpha'));

  // The real interval, not a ticked mock, is what produces the second poll.
  await handedBack[1];
  assert.equal(polls, 2);
  await flush();

  // The term survived the landing, and the card it hides stayed hidden.
  assert.equal((box as HTMLInputElement).value, 'beta', 'the term is still what was typed');
  assert.ok(screen.getByText('Beta'));
  assert.ok(gone('Alpha'), 'a live status change must not unfilter a card the term is hiding');

  // And it really did arrive — without this, every assertion above would also
  // hold if the second answer had simply never reached state, which is the
  // vacuous pass this guards against.
  fireEvent.change(box, { target: { value: '' } });
  assert.ok(screen.getByText('Alpha'));
  assert.ok(screen.getByText('Failed'));
});

// The download client's own queue — re-homed from `Downloads.test.tsx`, now
// rendered at the foot of this screen instead of on its own tab. `serve()`'s
// third argument is `untracked`; every test above this point passes none,
// which is what keeps the section absent from every one of them.

test('untracked entries render inert and labelled', async () => {
  serve(
    [],
    undefined,
    [{ clientId: 'sab', ref: 'x', name: 'Someone Elses', state: 'downloading', percentage: 40 }],
  );

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );

  await waitFor(() => assert.ok(screen.getByText('Someone Elses')));
  assert.ok(screen.getByText(/not managed by pickarr/i));
  assert.ok(!screen.queryByRole('button', { name: /retry/i }), 'no retry button on this row');
});

test('the term filters untracked entries too, and takes their heading with them', async () => {
  // The heading is the whole of what says these rows are not Pickarr's.
  // Leaving it standing over an empty list would read as "Pickarr has lost
  // track of something", when all that happened is the reader typed.
  serve(
    [group(1, 'Alex Coal'), group(2, 'Riley Reid')],
    undefined,
    [
      { clientId: 'sab', ref: 'a', name: 'Someone Elses', state: 'downloading', percentage: 40 },
      { clientId: 'sab', ref: 'b', name: 'Alex Coal Extras', state: 'completed', percentage: 100 },
    ],
  );

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Someone Elses')));
  const box = screen.getByRole('searchbox', { name: 'Search picks' });

  // A term both halves can satisfy filters each of them and keeps the heading
  // between: the two lists are filtered independently, not one and then the
  // other discarded.
  fireEvent.change(box, { target: { value: 'alex' } });
  assert.ok(screen.getByText('Alex Coal'));
  assert.ok(screen.getByText('Alex Coal Extras'));
  assert.ok(screen.getByText(/not managed by pickarr/i));
  assert.ok(gone('Riley Reid'));
  assert.ok(gone('Someone Elses'));

  // A term only a card can satisfy takes the whole section, heading and all,
  // rather than leaving the label over nothing.
  fireEvent.change(box, { target: { value: 'riley' } });
  assert.ok(screen.getByText('Riley Reid'));
  assert.ok(gone('Alex Coal Extras'));
  assert.ok(gone('Someone Elses'));
  assert.ok(gone(/not managed by pickarr/i));
});

// A term filtering both halves is exercised above only through the "takes the
// heading with them" case, i.e. one term that clears the whole section. This
// pins the pairing directly: one term, still narrowing both a card and an
// untracked entry down to the ones that match, with neither list emptied.
test('a term filters cards and untracked entries together', async () => {
  serve(
    [group(1, 'Alex Coal'), group(2, 'Riley Reid')],
    undefined,
    [
      { clientId: 'sab', ref: 'a', name: 'Alex Coal Extras', state: 'downloading', percentage: 40 },
      { clientId: 'sab', ref: 'b', name: 'Someone Elses', state: 'completed', percentage: 100 },
    ],
  );

  render(
    <MemoryRouter initialEntries={['/picks']}>
      <Picks />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Someone Elses')));

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search picks' }), {
    target: { value: 'alex' },
  });

  assert.ok(screen.getByText('Alex Coal'), 'the matching card stays');
  assert.ok(screen.getByText('Alex Coal Extras'), 'the matching untracked entry stays');
  assert.ok(gone('Riley Reid'), 'the non-matching card is filtered');
  assert.ok(gone('Someone Elses'), 'the non-matching untracked entry is filtered');
});

// Two clients can each be running a job the other knows nothing about, and
// `nzo_id` is unique only within one SABnzbd — so once #34 made a second
// client reachable, two untracked entries can arrive sharing a `ref`.
//
// The console is asserted on rather than the rows, because keying on `ref`
// alone does *not* visibly drop a row on first render: React renders both and
// complains that the behaviour "may cause children to be duplicated and/or
// omitted" and "could change in a future version". That warning is the whole
// observable defect on mount. Unlike `Downloads.tsx`'s old copy of this list,
// nothing here repolls it (see `Picks.tsx`'s own comment on why), but the
// list still re-renders on every render of this screen — a search keystroke
// among them — so a duplicate key is exactly as live a hazard here as it was
// on a poll-driven re-render.
test('two untracked entries from different clients sharing a ref are keyed apart', async () => {
  serve(
    [],
    undefined,
    [
      { clientId: 'sab-a', ref: 'nzo_1', name: 'Stranger On A', state: 'downloading', percentage: 5 },
      { clientId: 'sab-b', ref: 'nzo_1', name: 'Stranger On B', state: 'completed', percentage: null },
    ],
  );

  const complaints: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => complaints.push(args.map(String).join(' '));
  try {
    render(
      <MemoryRouter initialEntries={['/picks']}>
        <Picks />
      </MemoryRouter>,
    );
    await waitFor(() => assert.ok(screen.getByText('Stranger On A')));
    assert.ok(screen.getByText('Stranger On B'));
  } finally {
    console.error = realError;
  }
  assert.deepEqual(complaints, []);
});
