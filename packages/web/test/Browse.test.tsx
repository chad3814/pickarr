import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { Browse } from '../src/routes/Browse.tsx';
import { stubIntersectionObserver, type Intersection } from './intersection.ts';
import type {
  BrowseItem,
  BrowseResponse,
  DismissResponse,
  FailedItemView,
  GroupEditResponse,
  GroupView,
  IdentityPlanView,
  ManualField,
  ManualFieldsResponse,
  MetadataRequestResponse,
  MetadataRequeryResponse,
  MetadataView,
  PickResponse,
  ReleaseEditResponse,
  ReleaseView,
  ResolveResponse,
} from '../src/api/client.ts';
import { fetchStub } from './fetchStub.ts';
import { gone } from './dom.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of the list.
afterEach(cleanup);

const FIELDS: ManualField[] = [
  { name: 'site', label: 'Site', type: 'text', scope: 'identity', required: true },
  { name: 'title', label: 'Scene', type: 'text', scope: 'identity', required: true },
  {
    name: 'resolution',
    label: 'Resolution',
    type: 'select',
    scope: 'quality',
    options: ['', '1080p', '2160p'],
  },
];

interface Overrides {
  /**
   * Omit the prefill, which is what the server does for a plugin with no
   * `toManualValues` — and the only signal the SPA has that a record cannot be
   * edited. The two halves are independent: a group carries the identity
   * values, each release its own quality ones.
   */
  noGroupValues?: boolean;
  noReleaseValues?: boolean;
  resolution?: number;
  /** A plugin the schema map has never heard of, as one out of configuration is. */
  plugin?: string;
}

function group(id: number, title: string, over: Overrides = {}): GroupView {
  const resolution = over.resolution ?? 1080;
  const release: ReleaseView = {
    id: id * 10,
    score: resolution,
    quality: { resolution },
    releaseName: 'R',
    publishedAt: null,
  };
  // A release's prefill is the whole form, identity included: `toManualValues`
  // reads a whole `ParsedRelease`. The form takes the quality half of it.
  if (over.noReleaseValues !== true) {
    release.manualValues = { site: 'brazzers', title, resolution: `${resolution}p` };
  }

  const view: GroupView = {
    id,
    plugin: over.plugin ?? 'scenes',
    display: { title, fields: [] },
    state: 'new',
    pickedReleaseId: null,
    upgradeReleaseId: null,
    listRankAt: 1000 - id,
    releases: [release],
    // What a fresh browse page carries before anything has asked the
    // metadata endpoint about this group — matches the server's own default
    // for a group `metadataForGroups` found nothing for.
    metadata: { state: 'absent' },
  };
  // A group has no quality of its own, so the server builds its prefill from an
  // empty one.
  if (over.noGroupValues !== true) {
    view.manualValues = { site: 'brazzers', title, resolution: '' };
  }
  return view;
}

/** A page of plain groups, wrapped as `BrowseResponse.items` now carries them.
 * Most of these tests exercise only the group half of the merge — editing,
 * picking, paging — so this is the default `serve` reaches for; `failedItems`
 * below is its counterpart for the tests that exercise the other half. */
function groupItems(groups: readonly GroupView[]): BrowseItem[] {
  return groups.map((g) => ({ kind: 'group', group: g }));
}

/** One name the parser refused, with just enough shape for a `FailedCard` to
 * render and its Fix form to submit: a schema-matching plugin id, and the
 * suggestions actually offered. */
function failedItem(
  id: number,
  rawTitle: string,
  over: { suggestedValues?: Record<string, string>; plugin?: string } = {},
): FailedItemView {
  return {
    id,
    feedId: 'scenes-daily',
    plugin: over.plugin ?? 'scenes',
    rawTitle,
    link: `http://feed.invalid/${id}`,
    parseError: `no anchor in ${rawTitle}`,
    firstSeenAt: 1700 - id,
    publishedAt: null,
    suggestedValues: over.suggestedValues ?? {},
    dismissedAt: null,
  };
}

/** `failedItem`'s counterpart to `groupItems`, for a page carrying the other
 * half of the merge. */
function failedItems(items: readonly FailedItemView[]): BrowseItem[] {
  return items.map((item) => ({ kind: 'failed', item }));
}

interface Options {
  /** What `PATCH /api/groups/:id` answers. */
  groupEdit?: GroupEditResponse;
  /** What `PATCH /api/releases/:id` answers. */
  releaseEdit?: ReleaseEditResponse;
  /** Both PATCH routes answer 409 with this instead, as a refused merge does. */
  refusal?: string;
  /** The same, but only for the first PATCH; the next one succeeds. */
  refuseOnce?: string;
  /** Replaces the first page, for the cards a default page has no room for. */
  firstPage?: GroupView[];
  /** Replaces the second page, to tell "the page survived" from "the card was patched". */
  secondPage?: GroupView[];
  /**
   * Replaces the first/second page with raw items rather than groups alone —
   * for a page mixing a group and a refused name. Takes priority over
   * `firstPage`/`secondPage` when given.
   */
  firstPageItems?: BrowseItem[];
  secondPageItems?: BrowseItem[];
  /** What `POST /api/feed-items/:id/resolve` answers. */
  resolve?: ResolveResponse;
  /** What `POST /api/feed-items/:id/dismiss` answers. */
  dismiss?: DismissResponse;
  /**
   * The status `refusal`/`refuseOnce` answer with. Defaults to 409, right for
   * a release edit (untouched by the identity-plan flow, so any status just
   * reports through `setError`). A group edit's `applyEdit` treats 409
   * specifically as a stale `planDigest` and says nothing to the user about
   * it — `useIdentityChange`'s own contract — so a test proving a *reported*
   * group-edit refusal must use a different status, as a real plugin
   * rejection does (see `resolveIdentityFor`'s 400s in
   * `packages/core/src/manual/values.ts`).
   */
  refusalStatus?: number;
  /**
   * Overrides `POST /api/groups/:id/identity-plan`'s answer. Defaults to a
   * plan that moves nothing, which is what keeps a plain rename a one-click
   * save with no confirmation — a test only needs this when it means to
   * exercise the dialog, i.e. a merge.
   */
  identityPlan?: Partial<IdentityPlanView>;
  /**
   * What `GET /api/metadata` answers for these ids, overriding the echo below.
   *
   * The one shape the echo cannot express, and the ordinary production one:
   * browse carries `absent` and the live endpoint answers `confirmed` a moment
   * later. Echoing the page's own metadata keeps a *confirmed* page honest
   * (see `servedGroups`), but it means every group a page serves as `absent`
   * can only ever settle `'none'` — so no test could deliver a provider title
   * through the poll alone, which is the only path `useGroupMetadata` exists
   * for.
   */
  liveMetadata?: Record<number, MetadataView>;
}

/**
 * The plan `useIdentityChange.begin` fetches before a card edit ever reaches
 * a PATCH. `kind: 'display-only'` with no renames or trashing is the
 * no-confirmation case (§ the hook's own `moves` check), so a test that never
 * sets `Options.identityPlan` gets the one-click save Browse always offered.
 */
function defaultPlan(groupId: number): IdentityPlanView {
  return {
    groupId,
    identityKey: 'scenes:brazzers:draft',
    kind: 'display-only',
    mergeInto: null,
    releasesMoving: 0,
    downloadsMoving: 0,
    pick: { surviving: null, superseded: null },
    renames: [],
    trashing: [],
    warnings: [],
    blockers: [],
    digest: 'plan-digest',
  };
}

/** The values each PATCH carried, so a test can see which half was submitted. */
const sent: { path: string; values: Record<string, string> }[] = [];

/**
 * Two pages of one group each, then a pick or an edit. `pick` decides what the
 * server says about the picked group's standing afterwards.
 */
function serve(pick: PickResponse['group'], options: Options = {}): () => string[] {
  const calls: string[] = [];
  sent.length = 0;
  const pages = new Map<string, BrowseResponse>([
    [
      '',
      {
        items: options.firstPageItems ?? groupItems(options.firstPage ?? [group(1, 'Alpha')]),
        nextCursor: '999:1',
      },
    ],
    [
      '999:1',
      {
        items: options.secondPageItems ?? groupItems(options.secondPage ?? [group(2, 'Beta')]),
        nextCursor: null,
      },
    ],
  ]);
  // Indexed by id so `/api/metadata` can echo back whatever a page already
  // carried. A blanket `'none'` was fine while every served group's own
  // metadata was `'absent'` — the two read identically on a card, since
  // neither has a title to disagree with the parsed one. A group built with
  // a `'confirmed'` answer breaks that: a real server's live endpoint agrees
  // with its own browse listing, and a stub that does not would settle the
  // poll on an answer the page it just served never gave.
  //
  // Built from `pages` only, so this guarantee covers a page-served group,
  // not one that only ever appears via `options.groupEdit`, `options.releaseEdit`
  // or the `pick` response: a confirmed group returned solely from one of
  // those three still gets a blanket `'none'` back from `/api/metadata`. No
  // test today serves a confirmed group only that way, so nothing is
  // affected — but a test that starts doing so will hit this same
  // disagreement rather than a documented limit here, until someone extends
  // this map to those three paths too.
  const servedGroups = new Map<number, GroupView>();
  for (const page of pages.values()) {
    for (const item of page.items) if (item.kind === 'group') servedGroups.set(item.group.id, item.group);
  }
  let patches = 0;

  const picked: PickResponse = {
    download: {
      id: 1,
      groupId: 1,
      releaseId: 10,
      title: 'Alpha',
      kind: 'initial',
      status: 'queued',
      error: null,
      attempts: 0,
      updatedAt: 1,
      absentSince: null,
    },
    group: pick,
  };

  function respond(url: URL, init: RequestInit | undefined): unknown {
    if (url.pathname === '/api/browse') return pages.get(url.searchParams.get('cursor') ?? '');
    if (url.pathname === '/api/manual-fields') return { scenes: FIELDS } satisfies ManualFieldsResponse;
    if (url.pathname === '/api/metadata/request') {
      const body = JSON.parse(String(init?.body)) as { groupIds: number[] };
      return {
        queued: 0,
        alreadyAnswered: body.groupIds.length,
        pending: 0,
        missing: 0,
        unavailable: 0,
      } satisfies MetadataRequestResponse;
    }
    if (url.pathname === '/api/metadata') {
      // Settled either way, so `useGroupMetadata` never polls again for it:
      // `'none'` for a group whose own browse metadata was never
      // `'confirmed'` (every group these tests build, except where a test
      // deliberately sets one), and that group's own answer otherwise — see
      // `servedGroups` above for why echoing it, rather than a blanket
      // `'none'`, is what a real live endpoint does too.
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((part) => part.length > 0);
      const response: Record<number, MetadataView> = {};
      for (const id of ids) {
        const served = servedGroups.get(Number(id));
        const live = options.liveMetadata?.[Number(id)];
        response[Number(id)] =
          live ?? (served?.metadata.state === 'confirmed' ? served.metadata : { state: 'none' });
      }
      return response;
    }
    if (url.pathname.endsWith('/identity-plan')) {
      // `/api/groups/:id/identity-plan`; the id is the path's third segment.
      const groupId = Number(url.pathname.split('/')[3]);
      return { ...defaultPlan(groupId), ...options.identityPlan } satisfies IdentityPlanView;
    }
    if (url.pathname === '/api/manual-preview') {
      // Echoes what it was asked, so a test can tell that the live draft is
      // what reached the server.
      const body = JSON.parse(String(init?.body)) as { plugin: string; values: Record<string, string> };
      return { identityKey: `${body.plugin}:${body.values['site'] ?? ''}:${body.values['title'] ?? ''}` };
    }
    if (url.pathname.endsWith('/resolve')) {
      return options.resolve ?? ({ group: group(9, 'Resolved'), joinedExisting: true } satisfies ResolveResponse);
    }
    if (url.pathname.endsWith('/dismiss')) {
      return options.dismiss ?? ({ id: 1, dismissedAt: 1800 } satisfies DismissResponse);
    }
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { values: Record<string, string> };
      sent.push({ path: url.pathname, values: body.values });
      return url.pathname.startsWith('/api/releases/')
        ? (options.releaseEdit ?? ({ group: group(1, 'Alpha') } satisfies ReleaseEditResponse))
        : (options.groupEdit ??
            ({
              group: group(1, 'Alpha'),
              mergedInto: null,
              renamed: 0,
              trashed: 0,
              failed: [],
            } satisfies GroupEditResponse));
    }
    return picked;
  }

  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);

    if (init?.method === 'PATCH') patches += 1;
    const refusal = options.refusal ?? (patches === 1 ? options.refuseOnce : undefined);
    if (refusal !== undefined && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { values: Record<string, string> };
      sent.push({ path: url.pathname, values: body.values });
      return new Response(JSON.stringify({ error: refusal }), {
        status: options.refusalStatus ?? 409,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(respond(url, init)), {
      headers: { 'content-type': 'application/json' },
    });
  });

  return () => calls;
}

/** The card with this title, for queries that must not see its neighbours. */
function card(title: string): HTMLElement {
  const element = screen.getByText(title).closest('article');
  assert.ok(element !== null, `no card for ${title}`);
  return element;
}

function browseRequests(calls: string[]): string[] {
  return calls.filter((call) => call.includes('/api/browse'));
}

async function loadBothPages(): Promise<void> {
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => assert.ok(screen.getByText('Beta')));
}

/**
 * The same two pages, reached the way a reader now normally reaches them. Kept
 * beside `loadBothPages` rather than replacing it: the button is the fallback for
 * an observer that never fires, so both paths need a test that uses them.
 */
async function loadBothPagesByScrolling(view: Intersection): Promise<void> {
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  view.enter();
  await waitFor(() => assert.ok(screen.getByText('Beta')));
}

/**
 * The Edit controls wait on `/api/manual-fields`, so a test that clicks one
 * needs the schemas landed, not just the list.
 */
async function loadEditable(): Promise<void> {
  await loadBothPages();
  await waitFor(() => assert.ok(within(card('Alpha')).getByRole('button', { name: 'Edit' })));
}

test('picking after "load more" keeps the pages already loaded', async () => {
  // The regression: picking refetched the first page and replaced the list
  // with it, so the second page vanished and the list snapped back to its
  // original length.
  serve(null);
  await loadBothPages();

  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);

  await waitFor(() => assert.ok(gone('Alpha')));
  assert.ok(screen.getByText('Beta'));
});

test('the next page arrives when the end of the list comes into view, with no click', async () => {
  const view = stubIntersectionObserver();
  try {
    serve(null);
    render(<Browse />);
    await waitFor(() => assert.ok(screen.getByText('Alpha')));

    view.enter();

    await waitFor(() => assert.ok(screen.getByText('Beta')));
  } finally {
    view.restore();
  }
});

test('picking after a page arrived by scrolling keeps the pages already loaded', async () => {
  // The same regression as the "load more" test above, and the reason the issue
  // called it out: under a button, a reader who lost twenty pages noticed. Under
  // scrolling the list silently shortens and they scroll again, so the invariant
  // has to be pinned on the path that now loads most pages.
  const view = stubIntersectionObserver();
  try {
    serve(null);
    await loadBothPagesByScrolling(view);

    fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);

    await waitFor(() => assert.ok(gone('Alpha')));
    assert.ok(screen.getByText('Beta'));
  } finally {
    view.restore();
  }
});

test('a group the server still lists is updated in place, not dropped', async () => {
  // Picking a lesser release leaves the group listed with the better one still
  // on offer. It keeps its position; it does not disappear and it does not
  // move to the end.
  const picked: GroupView = {
    ...group(1, 'Alpha'),
    state: 'picked',
    pickedReleaseId: 10,
    upgradeReleaseId: 11,
  };
  serve(picked);
  await loadBothPages();

  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);

  await waitFor(() => assert.ok(screen.getByText(/upgrade available/i)));
  const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  assert.deepEqual(titles, ['Alpha', 'Beta']);
});

test('picking costs one request, not a refetch', async () => {
  const calls = serve(null);
  await loadBothPages();
  const beforePick = calls().length;

  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);
  await waitFor(() => assert.ok(gone('Alpha')));

  assert.deepEqual(calls().slice(beforePick), ['POST /api/groups/1/pick']);
});

test('the card Edit opens the identity fields, prefilled, and not the quality ones', async () => {
  // The card edit is the group's identity and display (§7.3). Quality belongs
  // to a release and is edited on its own row.
  serve(null);
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));

  assert.equal((screen.getByLabelText('Site') as HTMLInputElement).value, 'brazzers');
  assert.equal((screen.getByLabelText('Scene') as HTMLInputElement).value, 'Alpha');
  assert.equal(screen.queryAllByLabelText('Resolution').length, 0);
});

test('the card Edit previews the identity key the draft would build', async () => {
  serve(null);
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Alpha Fixed' } });

  await waitFor(() => assert.ok(screen.getByText('scenes:brazzers:Alpha Fixed')));
});

test('saving a card edit patches that card in place and keeps the pages already loaded', async () => {
  const calls = serve(null, {
    groupEdit: { group: group(1, 'Alpha Fixed'), mergedInto: null, renamed: 0, trashed: 0, failed: [] },
  });
  await loadEditable();
  const before = browseRequests(calls()).length;

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Alpha Fixed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(screen.getByText('Alpha Fixed')));
  assert.ok(gone('Alpha'));
  // The second page is still there, and nothing was refetched to get here.
  assert.ok(screen.getByText('Beta'));
  assert.equal(browseRequests(calls()).length, before);
  // Only the identity half is submitted; the server merges it over the record.
  assert.deepEqual(sent, [
    { path: '/api/groups/1', values: { site: 'brazzers', title: 'Alpha Fixed' } },
  ]);
  // The form closed, because the edit landed.
  assert.equal(screen.queryAllByLabelText('Site').length, 0);
  // A rename moves no releases, so there is nothing to report about where any
  // went.
  assert.ok(gone(/moved into/i));
});

test('a merge drops the card that was edited and patches the one it joined', async () => {
  // The edited group is gone: its releases now live under the group whose
  // identity the new values matched, and that group came back in the response.
  //
  // Gamma shares the second page with the merge target so that "the page
  // survived" and "the target was patched" are two assertions rather than one:
  // with Beta alone on that page, its presence proved both at once and neither
  // on its own.
  serve(null, {
    secondPage: [group(2, 'Beta'), group(3, 'Gamma')],
    // `kind: 'merge'` is what makes `useIdentityChange` show the
    // confirmation before ever sending the PATCH.
    identityPlan: { kind: 'merge', mergeInto: { id: 2, title: 'Beta' } },
    groupEdit: {
      group: { ...group(2, 'Beta'), upgradeReleaseId: 20 },
      mergedInto: 2,
      renamed: 0,
      trashed: 0,
      failed: [],
    },
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.ok(gone('Alpha')));
  const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  assert.deepEqual(titles, ['Beta', 'Gamma']);
  // The target was patched, not merely left alone: it arrived flagged.
  assert.ok(within(card('Beta')).getByText(/upgrade available/i));
});

test('a merge into a group on no loaded page inserts nothing', async () => {
  // The target belongs somewhere in a list ordered by rank, and only the server
  // knows where. Putting it on the end would show it out of order and then show
  // it twice, once the page it really lives on is loaded.
  serve(null, {
    firstPage: [group(1, 'Alpha'), group(3, 'Gamma')],
    identityPlan: { kind: 'merge', mergeInto: { id: 7, title: 'Zeta' } },
    groupEdit: { group: group(7, 'Zeta'), mergedInto: 7, renamed: 0, trashed: 0, failed: [] },
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Zeta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.ok(gone('Alpha')));
  const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  assert.deepEqual(titles, ['Gamma', 'Beta']);
});

test('a merge says where the releases went, confirmation included', async () => {
  // The card vanishes and, when the target is not loaded, nothing else on
  // screen changes — so without this the user is told nothing at all. The
  // `fix` tests below report the same thing when a fix joins an existing group.
  //
  // This behaviour predates `useIdentityChange` — it is pinned here rather
  // than only exercised incidentally, because routing `onEditGroup` through
  // the plan/confirm hook is exactly the kind of change that could silence a
  // notice that used to fire straight off a PATCH.
  serve(null, {
    identityPlan: { kind: 'merge', mergeInto: { id: 7, title: 'Zeta' } },
    groupEdit: { group: group(7, 'Zeta'), mergedInto: 7, renamed: 0, trashed: 0, failed: [] },
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Zeta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  // The notice must not appear before the merge is confirmed.
  assert.ok(gone('Releases moved into Zeta'));
  fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.ok(screen.getByText('Releases moved into Zeta')));
});

test('a refused group edit says why and leaves the card as it was', async () => {
  // 400, not 409: a group edit's `applyEdit` treats 409 as a stale
  // `planDigest` and says nothing on purpose (`useIdentityChange` retries
  // that by re-planning) — a refusal meant to be *read* has to be the status
  // a real plugin rejection uses (`resolveIdentityFor`'s 400s). Nothing
  // changed, and the typed values are still needed.
  serve(null, {
    refusal: 'site must be one of the configured values',
    refusalStatus: 400,
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(screen.getByText('site must be one of the configured values')));
  assert.ok(screen.getByText('Alpha'));
  assert.equal((screen.getByLabelText('Scene') as HTMLInputElement).value, 'Beta');
});

test('a release Edit offers quality alone and rescores the card in place', async () => {
  // §7.4: the quality decides the score, so the server answers with the whole
  // group — reordered — and the card is replaced by it.
  const calls = serve(null, { releaseEdit: { group: group(1, 'Alpha', { resolution: 2160 }) } });
  await loadEditable();
  const before = browseRequests(calls()).length;

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit quality' }));
  assert.equal(screen.queryAllByLabelText('Site').length, 0);
  fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '2160p' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  // The form closes when the edit lands; waiting for that also takes the
  // select's own '2160p' option out of the document, leaving one such text.
  await waitFor(() => assert.ok(gone('Resolution')));
  assert.ok(within(card('Alpha')).getByText('2160p'));
  assert.deepEqual(sent, [{ path: '/api/releases/10', values: { resolution: '2160p' } }]);
  assert.ok(screen.getByText('Beta'));
  assert.equal(browseRequests(calls()).length, before);
});

test('a release edit that takes the group out of the list drops the card', async () => {
  // Downgrading the release that was the only reason a picked group was listed
  // clears its upgrade flag, and the server answers null to say so. Patching
  // the card back in leaves a Pick button that queues an *upgrade* to the
  // release just downgraded — which on import trashes the file already there.
  serve(null, { releaseEdit: { group: null } });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit quality' }));
  fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('Alpha')));
  assert.ok(screen.getByText('Beta'));
});

test('a refused release edit says why and leaves the row form open', async () => {
  // A quality edit is refusable in its own right: the plugin can reject the
  // values. The typed values are still what the user meant, so they stay.
  serve(null, { refusal: 'resolution must be one of 1080p, 2160p' });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit quality' }));
  fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '2160p' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(screen.getByText(/resolution must be one of/)));
  assert.equal((screen.getByLabelText('Resolution') as HTMLSelectElement).value, '2160p');
});

test('a card edit that lands clears the error the last one left', async () => {
  // 400, not 409, for the same reason the refusal tests above use it: a
  // group edit's `applyEdit` treats 409 as a stale `planDigest` and reports
  // nothing on purpose.
  serve(null, {
    refuseOnce: 'site must be one of the configured values',
    refusalStatus: 400,
    groupEdit: { group: group(1, 'Alpha Fixed'), mergedInto: null, renamed: 0, trashed: 0, failed: [] },
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Alpha Fixed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.ok(screen.getByText('site must be one of the configured values')));

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  // A banner left standing over a list that just did what it was asked reads as
  // a failure that did not happen.
  await waitFor(() => assert.ok(gone('site must be one of the configured values')));
  assert.ok(screen.getByText('Alpha Fixed'));
});

test('a release edit that lands clears the error the last one left', async () => {
  serve(null, {
    refuseOnce: 'resolution must be one of 1080p, 2160p',
    releaseEdit: { group: group(1, 'Alpha', { resolution: 2160 }) },
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit quality' }));
  fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '2160p' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.ok(screen.getByText(/resolution must be one of/)));

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('resolution must be one of 1080p, 2160p')));
  assert.ok(within(card('Alpha')).getByText('2160p'));
});

test('a group whose plugin has no schema offers no editing at all', async () => {
  // A plugin with no manual hooks is *missing* from `/api/manual-fields`, and a
  // group can outlive the package that made it. Reading that absence as an
  // empty field list would put an Edit button on a form with no fields.
  serve(null, { firstPage: [group(1, 'Alpha'), group(6, 'Zeta', { plugin: 'gone' })] });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Alpha')).getByRole('button', { name: 'Edit' })));

  const zeta = within(card('Zeta'));
  assert.equal(zeta.queryAllByRole('button', { name: 'Edit' }).length, 0);
  assert.equal(zeta.queryAllByRole('button', { name: 'Edit quality' }).length, 0);
});

test('a group with no manual values offers no card Edit', async () => {
  // Absence of `manualValues` is the §4 degradation rule reaching the UI: the
  // plugin cannot read this record back, so there is nothing to prefill a form
  // with. Its releases are unaffected — the two halves are separate.
  serve(null, { firstPage: [group(1, 'Alpha'), group(4, 'Delta', { noGroupValues: true })] });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Alpha')).getByRole('button', { name: 'Edit' })));

  const delta = within(card('Delta'));
  assert.equal(delta.queryAllByRole('button', { name: 'Edit' }).length, 0);
  assert.equal(delta.queryAllByRole('button', { name: 'Edit quality' }).length, 1);
});

test('a release with no manual values offers no row Edit', async () => {
  serve(null, { firstPage: [group(1, 'Alpha'), group(3, 'Gamma', { noReleaseValues: true })] });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Alpha')).getByRole('button', { name: 'Edit' })));

  const gamma = within(card('Gamma'));
  assert.equal(gamma.queryAllByRole('button', { name: 'Edit quality' }).length, 0);
  assert.equal(gamma.queryAllByRole('button', { name: 'Edit' }).length, 1);
});

test('the schemas are fetched once for the screen, not once per card', async () => {
  const calls = serve(null);
  await loadEditable();

  assert.deepEqual(
    calls().filter((call) => call.includes('/api/manual-fields')),
    ['GET /api/manual-fields'],
  );
});

// The failed half of the merge: a refused name renders as `FailedCard`
// alongside `MediaCard`, in the order the response listed them, and its Fix
// and Dismiss actions live here now — moved from the Failed tab this branch
// went on to delete.

test('a page of both kinds renders a media card and a failed card', async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'group', group: group(1, 'Alpha') },
      { kind: 'failed', item: failedItem(2, 'Beta.RAW') },
    ],
    secondPageItems: [],
  });
  render(<Browse />);

  await waitFor(() => assert.ok(screen.getByText('Beta.RAW')));
  assert.ok(card('Alpha').classList.contains('media-card'), 'a group renders MediaCard');
  assert.ok(card('Beta.RAW').classList.contains('failed-card'), 'a failed item renders FailedCard');
});

test('the cards appear in the order the response listed them', async () => {
  // Not just "both are present" — the interleaving is the feature. Rendering
  // both kinds but sorting by kind first would still pass a test that only
  // checked presence.
  serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(3, 'Zeta.RAW') },
      { kind: 'group', group: group(1, 'Alpha') },
      { kind: 'failed', item: failedItem(4, 'Eta.RAW') },
      { kind: 'group', group: group(2, 'Beta') },
    ],
    secondPageItems: [],
  });
  render(<Browse />);

  await waitFor(() => assert.ok(screen.getByText('Beta')));
  const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  assert.deepEqual(titles, ['Zeta.RAW', 'Alpha', 'Eta.RAW', 'Beta']);
});

test('saving a fix drops the row and says it joined an existing group', async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(2, 'Beta.RAW', { suggestedValues: { site: 'brazzers' } }) },
      { kind: 'group', group: group(1, 'Gamma') },
    ],
    secondPageItems: [],
    resolve: { group: group(9, 'Zed Thing'), joinedExisting: true },
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Beta.RAW')).getByRole('button', { name: /fix/i })));

  fireEvent.click(within(card('Beta.RAW')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('Beta.RAW')));
  assert.ok(screen.getByText('Zed Thing joined an existing group'));
  // The rest of the list is untouched.
  assert.ok(screen.getByText('Gamma'));
});

test('a fix that made a new group says that instead', async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(2, 'Beta.RAW', { suggestedValues: { site: 'brazzers' } }) },
    ],
    secondPageItems: [],
    resolve: { group: group(9, 'Zed Thing'), joinedExisting: false },
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Beta.RAW')).getByRole('button', { name: /fix/i })));

  fireEvent.click(within(card('Beta.RAW')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(screen.getByText('Zed Thing became a new group')));
});

test('the resolved group does not appear until the next load, and the notice says so', async () => {
  // Placing it correctly in a keyset-ordered list means computing where the
  // server would have put it — the client re-deriving the server's ordering
  // rule, which this design keeps out of the client. The notice is the whole
  // account of where it went.
  serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(2, 'Beta.RAW', { suggestedValues: { site: 'brazzers' } }) },
    ],
    secondPageItems: [],
    resolve: { group: group(9, 'Zed Thing'), joinedExisting: true },
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Beta.RAW')).getByRole('button', { name: /fix/i })));

  fireEvent.click(within(card('Beta.RAW')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(screen.getByText('Zed Thing joined an existing group')));
  assert.ok(!screen.queryByRole('heading', { level: 2, name: 'Zed Thing' }), 'not patched in');
});

test('Dismiss drops the row', async () => {
  const calls = serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(3, 'Gamma.RAW', { plugin: '' }) },
      { kind: 'group', group: group(1, 'Alpha') },
    ],
    secondPageItems: [],
    dismiss: { id: 3, dismissedAt: 1800 },
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Gamma.RAW')).getByRole('button', { name: /dismiss/i })));

  fireEvent.click(within(card('Gamma.RAW')).getByRole('button', { name: /dismiss/i }));

  await waitFor(() => assert.ok(gone('Gamma.RAW')));
  assert.ok(screen.getByText('Alpha'));
  assert.ok(calls().includes('POST /api/feed-items/3/dismiss'));
});

test('a failed request while fixing reports and leaves the card in place', async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(2, 'Beta.RAW', { suggestedValues: { site: 'brazzers' } }) },
    ],
    secondPageItems: [],
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Beta.RAW')).getByRole('button', { name: /fix/i })));
  fireEvent.click(within(card('Beta.RAW')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'A Thing' } });

  // Refuses only `/resolve`: the form's own debounced identity preview keeps
  // hitting `/api/manual-preview` while this is open, and answering that with
  // the same 400 body would put the identical text under the form too — a
  // read that would pass whether or not `fix`'s own error handling worked.
  const original = globalThis.fetch;
  globalThis.fetch = fetchStub(async (url, init) => {
    if (new URL(url, 'http://test.invalid').pathname.endsWith('/resolve')) {
      return new Response(JSON.stringify({ error: 'site must be one of the configured values' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return original(url, init);
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.equal(document.querySelector('p.error')?.textContent, 'site must be one of the configured values'));
  assert.ok(screen.getByText('Beta.RAW'));
  assert.equal((screen.getByLabelText('Scene') as HTMLInputElement).value, 'A Thing');
});

test('a refused request is reported rather than swallowed', async () => {
  serve(null, {
    firstPageItems: failedItems([failedItem(3, 'Gamma.RAW', { plugin: '' })]),
    secondPageItems: [],
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Gamma.RAW')).getByRole('button', { name: /dismiss/i })));

  globalThis.fetch = fetchStub(async () =>
    new Response(JSON.stringify({ error: 'Feed item 3 is already dismissed' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));

  fireEvent.click(within(card('Gamma.RAW')).getByRole('button', { name: /dismiss/i }));

  await waitFor(() => assert.ok(screen.getByText('Feed item 3 is already dismissed')));
  // The row stays: nothing happened to it.
  assert.ok(screen.getByText('Gamma.RAW'));
});

test('a term that matches nothing leaves an empty list rather than a stale one', async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'group', group: group(1, 'Alpha') },
      { kind: 'failed', item: failedItem(2, 'Beta.RAW') },
    ],
    secondPageItems: [],
  });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta.RAW')));

  // A term whose page is empty. Reinstall the stub so the next fetch answers
  // with nothing, then change the term, which rebuilds the list.
  serve(null, { firstPageItems: [], secondPageItems: [] });
  fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'coal' } });

  await waitFor(() => assert.equal(document.querySelectorAll('article').length, 0));
  assert.ok(gone('Alpha'));
  assert.ok(gone('Beta.RAW'));
});

test('fixing after "load more" keeps the pages already loaded', async () => {
  // The regression this mirrors on Browse's group half: acting on a row
  // refetched the first page and replaced the list with it, so everything
  // loaded past it vanished.
  const calls = serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(1, 'Alpha.RAW', { suggestedValues: { site: 'brazzers' } }) },
    ],
    secondPageItems: groupItems([group(2, 'Beta')]),
    resolve: { group: group(9, 'Zed Thing'), joinedExisting: true },
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Alpha.RAW')).getByRole('button', { name: /fix/i })));
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  const before = browseRequests(calls()).length;

  fireEvent.click(within(card('Alpha.RAW')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('Alpha.RAW')));
  assert.ok(screen.getByText('Beta'));
  assert.equal(browseRequests(calls()).length, before);
});

test('dismissing after "load more" keeps the pages already loaded', async () => {
  const calls = serve(null, {
    firstPageItems: failedItems([failedItem(1, 'Alpha.RAW')]),
    secondPageItems: groupItems([group(2, 'Beta')]),
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Alpha.RAW')).getByRole('button', { name: /dismiss/i })));
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  const before = browseRequests(calls()).length;

  fireEvent.click(within(card('Alpha.RAW')).getByRole('button', { name: /dismiss/i }));

  await waitFor(() => assert.ok(gone('Alpha.RAW')));
  assert.ok(screen.getByText('Beta'));
  assert.equal(browseRequests(calls()).length, before);
});

test('fixing after a page arrived by scrolling keeps the pages already loaded', async () => {
  // The same invariant as the "load more" test above, on the path that now
  // loads most pages: under a button a reader who lost a page noticed, under
  // scrolling the list silently shortens and they scroll again.
  const view = stubIntersectionObserver();
  try {
    const calls = serve(null, {
      firstPageItems: [
        { kind: 'failed', item: failedItem(1, 'Alpha.RAW', { suggestedValues: { site: 'brazzers' } }) },
      ],
      secondPageItems: groupItems([group(2, 'Beta')]),
      resolve: { group: group(9, 'Zed Thing'), joinedExisting: true },
    });
    render(<Browse />);
    await waitFor(() => assert.ok(within(card('Alpha.RAW')).getByRole('button', { name: /fix/i })));
    view.enter();
    await waitFor(() => assert.ok(screen.getByText('Beta')));
    const before = browseRequests(calls()).length;

    fireEvent.click(within(card('Alpha.RAW')).getByRole('button', { name: /fix/i }));
    fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'A Thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => assert.ok(gone('Alpha.RAW')));
    assert.ok(screen.getByText('Beta'));
    assert.equal(browseRequests(calls()).length, before);
  } finally {
    view.restore();
  }
});

test('dismissing after a page arrived by scrolling keeps the pages already loaded', async () => {
  const view = stubIntersectionObserver();
  try {
    const calls = serve(null, {
      firstPageItems: failedItems([failedItem(1, 'Alpha.RAW')]),
      secondPageItems: groupItems([group(2, 'Beta')]),
    });
    render(<Browse />);
    await waitFor(() => assert.ok(within(card('Alpha.RAW')).getByRole('button', { name: /dismiss/i })));
    view.enter();
    await waitFor(() => assert.ok(screen.getByText('Beta')));
    const before = browseRequests(calls()).length;

    fireEvent.click(within(card('Alpha.RAW')).getByRole('button', { name: /dismiss/i }));

    await waitFor(() => assert.ok(gone('Alpha.RAW')));
    assert.ok(screen.getByText('Beta'));
    assert.equal(browseRequests(calls()).length, before);
  } finally {
    view.restore();
  }
});

test('"load more" appends the next page rather than replacing the list', async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'group', group: group(1, 'Alpha') },
      { kind: 'failed', item: failedItem(2, 'Beta.RAW') },
    ],
    secondPageItems: groupItems([group(3, 'Gamma')]),
  });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta.RAW')));
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => assert.ok(screen.getByText('Gamma')));

  const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  assert.deepEqual(titles, ['Alpha', 'Beta.RAW', 'Gamma']);
  // Exhausted, so there is nothing left to ask for.
  assert.equal(screen.queryAllByRole('button', { name: /load more/i }).length, 0);
});

test('the schemas are fetched once for the screen, not once per row', async () => {
  const calls = serve(null, {
    firstPageItems: failedItems([failedItem(1, 'Alpha.RAW')]),
    secondPageItems: failedItems([failedItem(2, 'Beta.RAW')]),
  });
  render(<Browse />);
  await waitFor(() => assert.ok(within(card('Alpha.RAW')).getByRole('button', { name: /fix/i })));
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => assert.ok(within(card('Beta.RAW')).getByRole('button', { name: /fix/i })));

  assert.deepEqual(
    calls().filter((call) => call.includes('/api/manual-fields')),
    ['GET /api/manual-fields'],
  );
});

/** The settled answer both Requery tests below start from, and the fresher one they end at. */
const REQUERY_ORIGINAL: MetadataView = {
  state: 'confirmed',
  title: 'Original title',
  performerNames: [],
  releaseDate: null,
  durationSeconds: null,
  synopsis: 'The original synopsis.',
  hasPoster: false,
  hasBackground: false,
};
const REQUERY_FRESHER: MetadataView = { ...REQUERY_ORIGINAL, synopsis: 'The fresher synopsis.' };

/**
 * One already-settled group on the first page, and a `GET /api/metadata` that
 * walks `answers` by call count (the last one repeating). Shared by the two
 * Requery tests below, which differ in nothing but that sequence — one drives
 * the defensive `pending` the server never actually emits, the other the
 * sequence it does.
 *
 * Returns a reader for the number of `GET /api/metadata` calls, which is how a
 * test tells "the id is being watched again" from "the click did nothing".
 */
function serveSettledGroup(answers: readonly MetadataView[]): () => number {
  const alpha: GroupView = {
    id: 1,
    plugin: 'scenes',
    display: { title: 'Alpha', fields: [] },
    state: 'new',
    pickedReleaseId: null,
    upgradeReleaseId: null,
    listRankAt: 1000,
    releases: [],
    metadata: answers[0]!,
  };

  let metadataCalls = 0;
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/browse') {
      return new Response(
        JSON.stringify({ items: groupItems([alpha]), nextCursor: null } satisfies BrowseResponse),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/manual-fields') {
      return new Response(JSON.stringify({} satisfies ManualFieldsResponse), {
        headers: { 'content-type': 'application/json' },
      });
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
    if (url.pathname === '/api/metadata/requery') {
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
    if (url.pathname === '/api/metadata') {
      metadataCalls += 1;
      const view = answers[Math.min(metadataCalls, answers.length) - 1]!;
      return new Response(JSON.stringify({ 1: view }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  });

  return () => metadataCalls;
}

test('clicking Requery re-arms the poll end to end: no blanking on a pending answer, and a fresher one lands without a reload', async () => {
  // The full stack this bug lived in: Browse wires the button's callback to
  // `api.requeryMetadata` + `useGroupMetadata`'s `rearm`, and it is that
  // wiring — not anything inside `MediaCard` — that has to keep the card
  // from blanking. This test would have failed against the first cut, which
  // had `MediaCard` call `api` directly and had no `rearm` at all: the
  // second `GET /api/metadata` below answering `pending` would have
  // reached the card as `group.metadata` unmodified, and the card renders a
  // `pending` group with no title or synopsis panel at all (see "the
  // metadata panel renders only once the answer is confirmed" in
  // `MediaCard.test.tsx`).
  //
  // The `pending` in the middle is defensive, not real: the server never
  // reports an already-answered group as `pending`. The test below drives the
  // sequence it does emit, which is the one the feature actually depends on.
  const metadataCalls = serveSettledGroup([
    REQUERY_ORIGINAL,
    { state: 'pending' },
    REQUERY_FRESHER,
  ]);

  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('The original synopsis.')));
  const callsBeforeClick = metadataCalls();

  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Requery metadata' })));

  // The second answer (`pending`) must reach this hook — proof the id is
  // actually being watched again — but must never reach the card.
  await waitFor(() => assert.ok(metadataCalls() > callsBeforeClick), { timeout: 3_000 });
  assert.ok(screen.getByText('The original synopsis.'));
  assert.ok(!screen.queryByText('pending'));

  // The third answer is genuinely different, and it is what finally shows
  // up — without a reload, and without the button ever having been clicked
  // a second time.
  await waitFor(() => assert.ok(screen.getByText('The fresher synopsis.')), { timeout: 3_000 });
  assert.ok(!screen.queryByText('The original synopsis.'));
});

test('clicking Requery survives the answer sequence the real server emits: the same answer, then a fresher one', async () => {
  // `[original, original, fresher]`, which is what actually happens:
  // `requeueMetadata` leaves `group_metadata` alone and `metadataViewOf`
  // short-circuits on the answer row, so every poll before the worker writes
  // a new answer returns the *old* one, byte for byte. The test above cannot
  // catch a regression here — its artificial `pending` keeps the poll alive on
  // its own, so `sameMetadata` could be broken outright and the fresher answer
  // would still land. This one goes back to "the click does nothing until you
  // reload" the moment that comparison stops working.
  const metadataCalls = serveSettledGroup([REQUERY_ORIGINAL, REQUERY_ORIGINAL, REQUERY_FRESHER]);

  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('The original synopsis.')));
  const callsBeforeClick = metadataCalls();

  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Requery metadata' })));

  // The answer that comes back first is the one already on screen, and the
  // watch has to survive it.
  await waitFor(() => assert.ok(metadataCalls() > callsBeforeClick), { timeout: 3_000 });
  assert.ok(screen.getByText('The original synopsis.'));

  await waitFor(() => assert.ok(screen.getByText('The fresher synopsis.')), { timeout: 3_000 });
  assert.ok(!screen.queryByText('The original synopsis.'));
});

test('typing a term sends it to the server and starts the list over from page one', async () => {
  // Browse's search box had no test at all, which made it the one place the
  // shared `SearchBox` could be wired in wrongly and nothing would say so.
  // Unlike Picks and Downloads, this term is not a filter over rows already in
  // hand: browse is paginated, so the matches may be on pages nobody has
  // loaded, and the term has to reach `/api/browse?q=` and reset the cursor.
  const calls = serve(null);

  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => assert.ok(screen.getByText('Beta')));

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search groups' }), {
    target: { value: 'coal' },
  });

  await waitFor(() =>
    assert.deepEqual(browseRequests(calls()), [
      'GET /api/browse',
      'GET /api/browse?cursor=999%3A1',
      // No cursor: a new term is a new list, not the next page of the old one.
      'GET /api/browse?q=coal',
    ]),
  );
});

/**
 * The view preference outlives a `cleanup()`, so a test that switches views
 * would otherwise change the view every later test starts in. Cleared here
 * rather than in each test, so a test added later cannot forget.
 */
afterEach(() => {
  localStorage.removeItem('pickarr.browseView');
});

/** A confirmed answer whose title disagrees with the parsed one, as most real ones do. */
function answered(title: string): MetadataView {
  return {
    state: 'confirmed',
    title,
    releaseDate: null,
    durationSeconds: null,
    synopsis: null,
    hasPoster: false,
    hasBackground: false,
  };
}

test('a fresh browser gets the card list', () => {
  // Spec §7: nobody's Browse changes shape without them asking.
  serve(null);
  render(<Browse />);
  // #40: never `assert.equal(screen.queryBy*(...), null)`.
  assert.ok(!screen.queryByRole('listbox', { name: 'Groups' }));
});

test('choosing the split view shows the list, and no card until a row is picked', async () => {
  serve(null);
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Alpha')));

  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));

  assert.ok(screen.getByRole('listbox', { name: 'Groups' }));
  assert.ok(!document.querySelector('article.media-card'), 'nothing selected, so no card');
  assert.ok(screen.getByText(/select a group/i), 'the pane says what to do instead');
});

test('clicking a row fills the pane with that group', async () => {
  serve(null, { firstPage: [group(1, 'Alpha'), group(2, 'Beta')] });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));

  fireEvent.click(screen.getAllByRole('option')[1]!);

  // The pane is a `MediaCard`, so the group's title is its heading.
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Beta' }));
  assert.equal(document.querySelectorAll('article.media-card').length, 1, 'one card, not one per group');
});

test('the row and the pane show the same title, not the row the parsed one', async () => {
  // The whole reason `groupTitle` is a shared function: a provider title that
  // disagrees with the parsed one must reach both surfaces.
  const alpha = group(1, 'Alpha');
  alpha.metadata = answered('Provider Alpha');
  serve(null, { firstPage: [alpha] });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Provider Alpha')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));

  const row = screen.getByRole('option');
  assert.match(row.textContent ?? '', /Provider Alpha/);
  assert.equal(
    row.querySelector('.group-row-title')?.textContent,
    'Provider Alpha',
    'the row shows the provider title and nothing else in its title slot',
  );

  fireEvent.click(row);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Provider Alpha' }));
});

test('a provider title that arrives by poll reaches the row, not just the pane', async () => {
  // The test above puts the confirmed answer on the browse payload, so both
  // surfaces read it out of `groups` and agree whatever the route does with
  // the poll. This is the path that actually happens: browse says `absent`
  // and `GET /api/metadata` answers `confirmed` a moment later — the sequence
  // `useGroupMetadata` exists for, and the one Requery goes through too. Spec
  // §5: the row and the pane must not disagree about what a group is called.
  serve(null, { firstPage: [group(1, 'Alpha')], liveMetadata: { 1: answered('Provider Alpha') } });
  render(<Browse />);
  // Switched first, and the landing waited on by role rather than by the
  // parsed title: the poll's answer can arrive before a `getByText('Alpha')`
  // ever resolves, and then that wait fails on a page that is working
  // perfectly. The divergence does not depend on the order either way — it
  // lasts for the life of the mount, because nothing ever patches `groups`.
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  await waitFor(() => assert.ok(screen.getByRole('option')));
  fireEvent.click(screen.getByRole('option'));

  // The pane is where the answer showed up first when the merge lived only in
  // `cardFor`, so waiting on the heading is waiting for the answer to have
  // landed at all; the row is what the assertion is about.
  await waitFor(() => assert.ok(screen.getByRole('heading', { level: 2, name: 'Provider Alpha' })));
  assert.equal(
    screen.getByRole('option').querySelector('.group-row-title')?.textContent,
    'Provider Alpha',
    'the row shows the title the poll delivered, the same one the pane is showing',
  );
});

test('the selection clears when a term filters the selected group out', async () => {
  // Spec §4: an id pointing at nothing leaves a pane showing a group the list
  // beside it denies. `serve` answers every `?q=` with the same two pages, so
  // the term is applied by replacing the page — which is what a real
  // server-side search does, and what rebuilds `items`.
  serve(null, { firstPage: [group(1, 'Alpha'), group(2, 'Beta')] });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  fireEvent.click(screen.getAllByRole('option')[1]!);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Beta' }));

  // A term whose page omits Beta. Reinstall the stub so the next fetch answers
  // with one group, then change the term, which rebuilds the list.
  serve(null, { firstPage: [group(1, 'Alpha')] });
  fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'alpha' } });

  await waitFor(() => assert.ok(!document.querySelector('article.media-card')));
  assert.ok(screen.getByText(/select a group/i), 'the pane returned to its empty state');

  // The pane empties either way, because `selected` re-derives from `groups`.
  // What the clearing effect protects is the list: `GroupList`'s roving
  // `tabIndex` keys the tab stop off `selectedId ?? groups[0]?.id`, so an id
  // left pointing at a filtered-out group matches no row, every row gets
  // `tabIndex={-1}`, and the list becomes unreachable by keyboard.
  const stops = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(stops.length, 1, 'the list keeps exactly one tab stop');
});

test('a selection does not resurrect once a term matching nothing is cleared', async () => {
  // A narrowed page (the test above) still leaves `groups` non-empty, so its
  // pane-is-empty check is meaningful on its own. A term matching *nothing*
  // is a different case, and a weaker one to assert on directly: `groups`
  // becomes `[]`, and `selected` re-derives to `null` from an empty `groups`
  // regardless of whether `selectedId` was ever cleared — so the pane looks
  // identical, empty, whether or not the fix in `Browse.tsx` actually ran.
  // The only place a survived `selectedId` becomes visible is on the way
  // back: if it was never cleared, repopulating `groups` hands the pane a
  // group matching that id again, and it reappears without the reader
  // re-selecting anything — exactly what spec §4 forbids.
  serve(null, { firstPage: [group(1, 'Alpha'), group(2, 'Beta')] });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  fireEvent.click(screen.getAllByRole('option')[1]!);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Beta' }));

  // A term whose page is empty, not merely narrowed. Waited for by row count
  // rather than the pane, which (as above) would already read empty before
  // this fetch even lands.
  serve(null, { firstPage: [] });
  fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'nothing' } });
  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 0));

  // Clear the term. Both groups return, Beta included. Waited for by row
  // count, not by finding "Beta" — a resurrected selection would put that
  // text in both the row and the pane's heading, and `getByText` throwing on
  // an ambiguous match is not the failure this test is about.
  serve(null, { firstPage: [group(1, 'Alpha'), group(2, 'Beta')] });
  fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: '' } });

  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 2));
  assert.ok(!document.querySelector('article.media-card'), 'a returning group is not a resurrected selection');
  assert.ok(screen.getByText(/select a group/i), 'the pane stayed empty rather than repopulating on its own');
});

test('the chosen view survives a remount', async () => {
  serve(null);
  const first = render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Alpha')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  first.unmount();

  serve(null);
  render(<Browse />);
  assert.ok(screen.getByRole('listbox', { name: 'Groups' }), 'the preference was read back');
});

// The split view's list now interleaves both kinds too (Task 6), addressed by
// `{ kind, id }` rather than a bare id for the same reason `GroupList.test.tsx`
// exercises directly: a group and a failed item can carry the same number.

test('selecting a failed row shows its card in the detail pane', async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'group', group: group(1, 'Alpha') },
      { kind: 'failed', item: failedItem(2, 'Beta.RAW') },
    ],
    secondPageItems: [],
  });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta.RAW')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));

  const failedRow = screen.getAllByRole('option').find((row) => /Beta\.RAW/.test(row.textContent ?? ''));
  assert.ok(failedRow !== undefined, 'the failed row is in the list');
  fireEvent.click(failedRow);

  assert.ok(screen.getByRole('heading', { level: 2, name: 'Beta.RAW' }));
  assert.equal(document.querySelectorAll('article.failed-card').length, 1, 'a failed card, not a media card');
  assert.ok(!document.querySelector('article.media-card'), 'not the group card');
});

test('selecting a group row shows its media card in the detail pane', async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(2, 'Beta.RAW') },
      { kind: 'group', group: group(1, 'Alpha') },
    ],
    secondPageItems: [],
  });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta.RAW')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));

  const groupRow = screen.getAllByRole('option').find((row) => /Alpha/.test(row.textContent ?? ''));
  assert.ok(groupRow !== undefined, 'the group row is in the list');
  fireEvent.click(groupRow);

  assert.ok(screen.getByRole('heading', { level: 2, name: 'Alpha' }));
  assert.equal(document.querySelectorAll('article.media-card').length, 1, 'a media card, not a failed card');
  assert.ok(!document.querySelector('article.failed-card'), 'not the failed card');
});

test('a selection filtered out by a term is cleared once loading settles', async () => {
  // The group-only case is covered above ("the selection clears when a term
  // filters the selected group out"); this is the case that only exists once
  // the split view addresses a failed row too — the clearing effect has to
  // recognise a *failed* selection the term dropped, not just a group one.
  serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(2, 'Beta.RAW') },
      { kind: 'group', group: group(1, 'Alpha') },
    ],
    secondPageItems: [],
  });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta.RAW')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  const failedRow = screen.getAllByRole('option').find((row) => /Beta\.RAW/.test(row.textContent ?? ''));
  assert.ok(failedRow !== undefined);
  fireEvent.click(failedRow);
  assert.ok(screen.getByRole('heading', { level: 2, name: 'Beta.RAW' }));

  // A term whose page omits the failed row entirely.
  serve(null, { firstPageItems: [{ kind: 'group', group: group(1, 'Alpha') }], secondPageItems: [] });
  fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'alpha' } });

  await waitFor(() => assert.ok(!document.querySelector('article.failed-card')));
  assert.ok(screen.getByText(/select a group/i), 'the pane returned to its empty state');

  const stops = screen.getAllByRole('option').filter((row) => row.getAttribute('tabindex') === '0');
  assert.equal(stops.length, 1, 'the list keeps exactly one tab stop once the failed selection clears');
});

test("a failed item's Fix… form opens inside the detail pane", async () => {
  serve(null, {
    firstPageItems: [
      { kind: 'failed', item: failedItem(2, 'Beta.RAW', { suggestedValues: { site: 'brazzers' } }) },
    ],
    secondPageItems: [],
  });
  render(<Browse />);
  await waitFor(() => assert.ok(screen.getByText('Beta.RAW')));
  fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
  fireEvent.click(screen.getByRole('option'));
  await waitFor(() => assert.ok(screen.getByRole('heading', { level: 2, name: 'Beta.RAW' })));

  const pane = document.querySelector<HTMLElement>('.browse-detail');
  assert.ok(pane !== null, 'the detail pane exists');
  fireEvent.click(within(pane).getByRole('button', { name: /fix/i }));

  assert.ok(within(pane).getByLabelText('Scene'), 'the fix form opened inside the pane');
});
