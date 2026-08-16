import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { Browse } from '../src/routes/Browse.tsx';
import type {
  BrowseResponse,
  GroupEditResponse,
  GroupView,
  ManualField,
  ManualFieldsResponse,
  MetadataRequestResponse,
  MetadataView,
  PickResponse,
  ReleaseEditResponse,
  ReleaseView,
} from '../src/api/client.ts';

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
        : (options.groupEdit ?? ({ group: group(1, 'Alpha'), mergedInto: null } satisfies GroupEditResponse));
    }
    return picked;
  }

  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://test.invalid');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);

    if (init?.method === 'PATCH') patches += 1;
    const refusal = options.refusal ?? (patches === 1 ? options.refuseOnce : undefined);
    if (refusal !== undefined && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { values: Record<string, string> };
      sent.push({ path: url.pathname, values: body.values });
      return new Response(JSON.stringify({ error: refusal }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(respond(url, init)), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return () => calls;
}

/**
 * Absence, as a boolean.
 *
 * `assert.equal(screen.queryByText(x), null)` is the obvious spelling and it
 * kills the test run: inside `waitFor` the first check normally fails (the
 * card is still there), and building that AssertionError's message means
 * node:assert deep-inspecting a live DOM element. Retry it a few hundred times
 * and the process is OOM-killed with no output naming a test — a
 * SIGKILL where a one-second timeout was expected.
 */
function gone(text: string | RegExp): boolean {
  return screen.queryByText(text) === null;
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
    groupEdit: { group: group(1, 'Alpha Fixed'), mergedInto: null },
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
    groupEdit: { group: { ...group(2, 'Beta'), upgradeReleaseId: 20 }, mergedInto: 2 },
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

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
    groupEdit: { group: group(7, 'Zeta'), mergedInto: 7 },
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Zeta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('Alpha')));
  const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  assert.deepEqual(titles, ['Gamma', 'Beta']);
});

test('a merge says where the releases went', async () => {
  // The card vanishes and, when the target is not loaded, nothing else on
  // screen changes — so without this the user is told nothing at all. The
  // Failed tab reports the same thing when a fix joins an existing group.
  serve(null, { groupEdit: { group: group(7, 'Zeta'), mergedInto: 7 } });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Zeta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(screen.getByText('Releases moved into Zeta')));
});

test('a refused merge says why and leaves the card as it was', async () => {
  // 409: the source group has a download or imported files, so its releases
  // cannot move (§7.3). Nothing changed, and the typed values are still needed.
  serve(null, {
    refusal: 'cannot merge group 1 into group 2: group 1 has a download recorded against it.',
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(screen.getByText(/has a download recorded against it/)));
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
  serve(null, {
    refuseOnce: 'group 1 has a download recorded against it.',
    groupEdit: { group: group(1, 'Alpha Fixed'), mergedInto: null },
  });
  await loadEditable();

  fireEvent.click(within(card('Alpha')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Scene'), { target: { value: 'Alpha Fixed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.ok(screen.getByText(/has a download recorded against it/)));

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  // A banner left standing over a list that just did what it was asked reads as
  // a failure that did not happen.
  await waitFor(() => assert.ok(gone('group 1 has a download recorded against it.')));
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
