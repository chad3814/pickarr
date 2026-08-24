import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App.tsx';
import { Failed } from '../src/routes/Failed.tsx';
import { stubIntersectionObserver, type Intersection } from './intersection.ts';
import type {
  DismissResponse,
  FailedItemView,
  FailedResponse,
  GroupView,
  ManualField,
  ManualFieldsResponse,
  ResolveResponse,
} from '../src/api/client.ts';
import { fetchStub } from './fetchStub.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of the list.
afterEach(cleanup);

const FIELDS: ManualField[] = [
  { name: 'site', label: 'Site', type: 'text', scope: 'identity', required: true },
  { name: 'title', label: 'Title', type: 'text', scope: 'identity', required: true },
  { name: 'date', label: 'Date', type: 'text', scope: 'identity' },
];

interface Overrides {
  plugin?: string;
  suggestedValues?: Record<string, string>;
  dismissedAt?: number;
}

function item(id: number, rawTitle: string, over: Overrides = {}): FailedItemView {
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
    dismissedAt: over.dismissedAt ?? null,
  };
}

/** The group the server says a resolve produced. */
function group(title: string): GroupView {
  return {
    id: 7,
    plugin: 'scenes',
    display: { title, fields: [] },
    state: 'new',
    pickedReleaseId: null,
    upgradeReleaseId: null,
    listRankAt: 1700,
    releases: [],
    metadata: { state: 'absent' },
  };
}

/**
 * Three refused items on the first page and one on the second, so that acting
 * on a row after "Load more" has a second page to lose.
 *
 * Gamma's feed has left configuration, so the server reports it with an empty
 * plugin id — the case that finds no schema and must still be dismissable.
 */
const PAGE_ONE = [
  item(1, 'Alpha.RAW.1080p', { suggestedValues: { site: 'brazzers' } }),
  item(2, 'Beta.RAW.720p', { suggestedValues: { site: 'evilangel', title: 'Beta Thing' } }),
  item(3, 'Gamma.RAW', { plugin: '' }),
];
const PAGE_TWO = [item(4, 'Delta.RAW', { suggestedValues: { site: 'vixen' } })];
const EPSILON = item(5, 'Epsilon.RAW', { dismissedAt: 1690 });

function page(url: URL): FailedResponse {
  if (url.searchParams.get('includeDismissed') === '1') {
    return { items: [...PAGE_ONE, EPSILON], nextCursor: null };
  }
  return url.searchParams.get('cursor') === null
    ? { items: PAGE_ONE, nextCursor: '1699:1' }
    : { items: PAGE_TWO, nextCursor: null };
}

function respond(url: URL, init: RequestInit | undefined, joinedExisting: boolean): unknown {
  if (url.pathname === '/api/manual-fields') return { scenes: FIELDS } satisfies ManualFieldsResponse;
  if (url.pathname === '/api/failed') return page(url);
  if (url.pathname === '/api/manual-preview') {
    // Echoes what it was asked, so a test can tell that the plugin id and the
    // live draft — not the item's suggestions — are what reached the server.
    const body = JSON.parse(String(init?.body)) as { plugin: string; values: Record<string, string> };
    return { identityKey: `${body.plugin}:${body.values['site'] ?? ''}:${body.values['title'] ?? ''}` };
  }
  if (url.pathname.endsWith('/resolve')) {
    return { group: group('Alpha Thing'), joinedExisting } satisfies ResolveResponse;
  }
  return { id: 1, dismissedAt: 1800 } satisfies DismissResponse;
}

function serve(joinedExisting = false): () => string[] {
  const calls: string[] = [];
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    return new Response(JSON.stringify(respond(url, init, joinedExisting)), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return () => calls;
}

/**
 * Absence, as a boolean.
 *
 * `assert.equal(screen.queryByText(x), null)` is the obvious spelling and it
 * kills the test run: inside `waitFor` the first check normally fails, and
 * building that AssertionError's message means node:assert deep-inspecting a
 * live DOM element, several hundred times over. See `gone()` in
 * `Browse.test.tsx`.
 */
function gone(text: string): boolean {
  return screen.queryByText(text) === null;
}

/** The row holding this raw title, for queries that must not see its siblings. */
function row(rawTitle: string): HTMLElement {
  const element = screen.getByText(rawTitle).closest('li');
  assert.ok(element !== null, `no row for ${rawTitle}`);
  return element;
}

async function loadFirstPage(): Promise<void> {
  render(<Failed />);
  // The Fix control waits on `/api/manual-fields`, so a test that clicks it
  // needs the schemas landed, not just the list.
  await waitFor(() => assert.ok(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i })));
}

async function loadBothPages(): Promise<void> {
  await loadFirstPage();
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => assert.ok(screen.getByText('Delta.RAW')));
}

/**
 * The same two pages, reached the way a reader now normally reaches them. Kept
 * beside `loadBothPages` rather than replacing it: the button is the fallback for
 * an observer that never fires, so both paths need a test that uses them.
 */
async function loadBothPagesByScrolling(view: Intersection): Promise<void> {
  await loadFirstPage();
  view.enter();
  await waitFor(() => assert.ok(screen.getByText('Delta.RAW')));
}

function failedRequests(calls: string[]): string[] {
  return calls.filter((call) => call.includes('/api/failed'));
}

test('every refused name is listed with the reason it was refused', async () => {
  serve();
  await loadFirstPage();

  for (const raw of ['Alpha.RAW.1080p', 'Beta.RAW.720p', 'Gamma.RAW']) {
    assert.ok(screen.getByText(raw), raw);
    assert.ok(within(row(raw)).getByText(`no anchor in ${raw}`), `reason for ${raw}`);
  }
  assert.ok(within(row('Alpha.RAW.1080p')).getByText(/scenes-daily/));
});

test('Fix prefills from the suggestions and leaves the rest of the schema blank', async () => {
  // `suggestManualValues` answers sparsely — it runs on a name the parser has
  // already refused. The form still has to offer every field the schema
  // declares, not only the ones that were guessed.
  serve();
  await loadFirstPage();

  fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));

  assert.equal((screen.getByLabelText('Site') as HTMLInputElement).value, 'brazzers');
  assert.equal((screen.getByLabelText('Title') as HTMLInputElement).value, '');
  assert.ok(screen.getByLabelText('Date'));
});

test('opening Fix on another row shows that row, not the first one', async () => {
  // `ManualForm` seeds its draft once, deliberately, so that a parent render
  // cannot overwrite what is being typed. A form shared between rows would
  // therefore keep showing the first row's suggestions forever.
  serve();
  await loadFirstPage();

  fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));
  assert.equal((screen.getByLabelText('Site') as HTMLInputElement).value, 'brazzers');

  fireEvent.click(within(row('Beta.RAW.720p')).getByRole('button', { name: /fix/i }));
  assert.equal((screen.getByLabelText('Site') as HTMLInputElement).value, 'evilangel');
  assert.equal((screen.getByLabelText('Title') as HTMLInputElement).value, 'Beta Thing');
});

test('the identity preview describes the draft, under the plugin that will build it', async () => {
  serve();
  await loadFirstPage();

  fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });

  await waitFor(() => assert.ok(screen.getByText('scenes:brazzers:A Thing')));
});

test('saving a fix drops the row and says it joined an existing group', async () => {
  serve(true);
  await loadFirstPage();

  fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('Alpha.RAW.1080p')));
  assert.ok(screen.getByText('Alpha Thing joined an existing group'));
  assert.ok(screen.getByText('Beta.RAW.720p'));
});

test('a fix that made a new group says that instead', async () => {
  serve(false);
  await loadFirstPage();

  fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(screen.getByText('Alpha Thing became a new group')));
});

test('the values submitted are the whole schema, sent to the row being fixed', async () => {
  const calls = serve();
  await loadFirstPage();

  fireEvent.click(within(row('Beta.RAW.720p')).getByRole('button', { name: /fix/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('Beta.RAW.720p')));
  assert.ok(calls().includes('POST /api/feed-items/2/resolve'));
});

test('Dismiss drops the row', async () => {
  const calls = serve();
  await loadFirstPage();

  fireEvent.click(within(row('Gamma.RAW')).getByRole('button', { name: /dismiss/i }));

  await waitFor(() => assert.ok(gone('Gamma.RAW')));
  assert.ok(screen.getByText('Alpha.RAW.1080p'));
  assert.ok(calls().includes('POST /api/feed-items/3/dismiss'));
});

test('an item whose plugin has no schema offers no Fix, only Dismiss', async () => {
  // `/api/manual-fields` omits a plugin with no manual hooks, and an item whose
  // feed has left configuration reports no plugin at all. Neither can be
  // resolved — but dismissing is core's own bookkeeping and needs no plugin.
  serve();
  await loadFirstPage();

  const gamma = within(row('Gamma.RAW'));
  assert.equal(gamma.queryAllByRole('button', { name: /fix/i }).length, 0);
  assert.equal(gamma.queryAllByRole('button', { name: /dismiss/i }).length, 1);
});

test('fixing after "load more" keeps the pages already loaded', async () => {
  // The regression this mirrors on Browse: acting on a row refetched the first
  // page and replaced the list with it, so everything loaded past it vanished.
  const calls = serve(true);
  await loadBothPages();
  const before = failedRequests(calls()).length;

  fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('Alpha.RAW.1080p')));
  assert.ok(screen.getByText('Delta.RAW'));
  assert.equal(failedRequests(calls()).length, before);
});

test('dismissing after "load more" keeps the pages already loaded', async () => {
  const calls = serve();
  await loadBothPages();
  const before = failedRequests(calls()).length;

  fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /dismiss/i }));

  await waitFor(() => assert.ok(gone('Alpha.RAW.1080p')));
  assert.ok(screen.getByText('Delta.RAW'));
  assert.equal(failedRequests(calls()).length, before);
});

test('the next page arrives when the end of the list comes into view, with no click', async () => {
  const view = stubIntersectionObserver();
  try {
    serve();
    await loadFirstPage();

    view.enter();

    await waitFor(() => assert.ok(screen.getByText('Delta.RAW')));
    // Appended, not swapped in: the rule "load more" already had.
    assert.ok(screen.getByText('Alpha.RAW.1080p'));
  } finally {
    view.restore();
  }
});

test('fixing after a page arrived by scrolling keeps the pages already loaded', async () => {
  // The invariant the issue insists must survive, on the path that now loads
  // most pages. Under a button a reader who lost a page noticed; under scrolling
  // the list silently shortens and they scroll again.
  const view = stubIntersectionObserver();
  try {
    const calls = serve(true);
    await loadBothPagesByScrolling(view);
    const before = failedRequests(calls()).length;

    fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));
    // Alpha's suggestions cover only the site, and Title is required.
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => assert.ok(gone('Alpha.RAW.1080p')));
    assert.ok(screen.getByText('Delta.RAW'));
    assert.equal(failedRequests(calls()).length, before);
  } finally {
    view.restore();
  }
});

test('dismissing after a page arrived by scrolling keeps the pages already loaded', async () => {
  const view = stubIntersectionObserver();
  try {
    const calls = serve();
    await loadBothPagesByScrolling(view);
    const before = failedRequests(calls()).length;

    fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => assert.ok(gone('Alpha.RAW.1080p')));
    assert.ok(screen.getByText('Delta.RAW'));
    assert.equal(failedRequests(calls()).length, before);
  } finally {
    view.restore();
  }
});

test('"load more" appends the next page rather than replacing the list', async () => {
  serve();
  await loadBothPages();

  const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  assert.deepEqual(titles, ['Alpha.RAW.1080p', 'Beta.RAW.720p', 'Gamma.RAW', 'Delta.RAW']);
  // Exhausted, so there is nothing left to ask for.
  assert.equal(screen.queryAllByRole('button', { name: /load more/i }).length, 0);
});

test('the schemas are fetched once for the screen, not once per row', async () => {
  const calls = serve();
  await loadBothPages();

  assert.deepEqual(
    calls().filter((call) => call.includes('/api/manual-fields')),
    ['GET /api/manual-fields'],
  );
});

test('dismissed items are asked for only when shown, and offer no second dismissal', async () => {
  const calls = serve();
  await loadFirstPage();
  assert.ok(gone('Epsilon.RAW'));

  fireEvent.click(screen.getByLabelText(/dismissed/i));
  await waitFor(() => assert.ok(screen.getByText('Epsilon.RAW')));

  assert.ok(calls().includes('GET /api/failed?includeDismissed=1'));
  const epsilon = within(row('Epsilon.RAW'));
  assert.equal(epsilon.queryAllByRole('button', { name: /dismiss/i }).length, 0);
  // Still fixable: that is what the flag is for, there being no un-dismiss.
  assert.equal(epsilon.queryAllByRole('button', { name: /fix/i }).length, 1);
});

test('dismissing while dismissed items are shown keeps the row and flips it to the badge', async () => {
  // The row's `Dismissed` badge was previously unreachable without a reload:
  // dismissing filtered the row out whatever the checkbox said, so the only
  // way to see the badge was a server round trip. With the box ticked the row
  // belongs on the list — the next page load returns it — and a screen that
  // disagrees with a refresh is the bug.
  serve();
  await loadFirstPage();
  fireEvent.click(screen.getByLabelText(/show dismissed/i));
  await waitFor(() => assert.ok(screen.getByText('Epsilon.RAW')));

  fireEvent.click(within(row('Alpha.RAW.1080p')).getByRole('button', { name: /dismiss/i }));

  await waitFor(() => assert.ok(within(row('Alpha.RAW.1080p')).getByText('Dismissed')));
  assert.equal(
    within(row('Alpha.RAW.1080p')).queryAllByRole('button', { name: /dismiss/i }).length,
    0,
  );
  // Still fixable, which is the whole reason a dismissed row is listed at all.
  assert.equal(within(row('Alpha.RAW.1080p')).queryAllByRole('button', { name: /fix/i }).length, 1);
  // The rest of the list is untouched.
  assert.ok(screen.getByText('Beta.RAW.720p'));
  assert.ok(screen.getByText('Epsilon.RAW'));
});

test('a refused request is reported rather than swallowed', async () => {
  serve();
  await loadFirstPage();
  globalThis.fetch = fetchStub(async () =>
    new Response(JSON.stringify({ error: 'Feed item 3 is already dismissed' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));

  fireEvent.click(within(row('Gamma.RAW')).getByRole('button', { name: /dismiss/i }));

  await waitFor(() => assert.ok(screen.getByText('Feed item 3 is already dismissed')));
  // The row stays: nothing happened to it.
  assert.ok(screen.getByText('Gamma.RAW'));
});

test('the Failed tab is reachable from the nav', async () => {
  serve();
  render(
    <MemoryRouter initialEntries={['/failed']}>
      <App />
    </MemoryRouter>,
  );

  assert.ok(screen.getByRole('link', { name: 'Failed' }));
  await waitFor(() => assert.ok(screen.getByText('Alpha.RAW.1080p')));
});
