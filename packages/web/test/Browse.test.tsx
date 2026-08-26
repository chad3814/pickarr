import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { Browse } from '../src/routes/Browse.tsx';
import { stubIntersectionObserver, type Intersection } from './intersection.ts';
import type {
  BrowseResponse,
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
    ['', { groups: options.firstPage ?? [group(1, 'Alpha')], nextCursor: '999:1' }],
    ['999:1', { groups: options.secondPage ?? [group(2, 'Beta')], nextCursor: null }],
  ]);
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
      // Every id answers `'none'` — settled, so `useGroupMetadata` never polls
      // again for it. These tests are about browse and edit flows, not the
      // metadata panel, so nothing here needs a `'confirmed'` answer.
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((part) => part.length > 0);
      const response: Record<number, MetadataView> = {};
      for (const id of ids) response[Number(id)] = { state: 'none' };
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
  // Failed tab reports the same thing when a fix joins an existing group.
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
        JSON.stringify({ groups: [alpha], nextCursor: null } satisfies BrowseResponse),
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
