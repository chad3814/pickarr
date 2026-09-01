import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { Dismissed } from '../src/routes/Dismissed.tsx';
import type {
  DismissedResponse,
  FailedItemView,
  GroupView,
  ManualField,
  ManualFieldsResponse,
  ResolveResponse,
} from '../src/api/client.ts';
import { fetchStub } from './fetchStub.ts';
import { gone } from './dom.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its cards behind and every later `getBy*` sees two
// copies of the list.
afterEach(cleanup);

const FIELDS: ManualField[] = [
  { name: 'site', label: 'Site', type: 'text', scope: 'identity', required: true },
  { name: 'title', label: 'Title', type: 'text', scope: 'identity', required: true },
];

/** Every item this tab ever serves already carries a `dismissedAt`. */
function item(id: number, rawTitle: string, over: Partial<FailedItemView> = {}): FailedItemView {
  return {
    id,
    feedId: 'scenes-daily',
    plugin: 'scenes',
    rawTitle,
    link: `http://feed.invalid/${id}`,
    parseError: `no anchor in ${rawTitle}`,
    firstSeenAt: 1700 - id,
    publishedAt: null,
    suggestedValues: {},
    dismissedAt: 1690,
    ...over,
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

const ITEMS: FailedItemView[] = [
  item(1, 'Alpha.RAW.1080p', { suggestedValues: { site: 'brazzers' } }),
  item(2, 'Beta.RAW.720p'),
];

function respond(url: URL, init: RequestInit | undefined, joinedExisting: boolean): unknown {
  if (url.pathname === '/api/manual-fields') return { scenes: FIELDS } satisfies ManualFieldsResponse;
  if (url.pathname === '/api/dismissed') return { items: ITEMS, nextCursor: null } satisfies DismissedResponse;
  if (url.pathname.endsWith('/resolve')) {
    return { group: group('Alpha Thing'), joinedExisting } satisfies ResolveResponse;
  }
  throw new Error(`unexpected request to ${url.pathname}`);
}

function serve(joinedExisting = false): void {
  globalThis.fetch = fetchStub(async (input, init) => {
    const url = new URL(input, 'http://test.invalid');
    return new Response(JSON.stringify(respond(url, init, joinedExisting)), {
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** The card holding this raw title, for queries that must not see its siblings. */
function card(rawTitle: string): HTMLElement {
  const element = screen.getByText(rawTitle).closest('article');
  assert.ok(element !== null, `no card for ${rawTitle}`);
  return element;
}

async function load(): Promise<void> {
  render(<Dismissed />);
  // The Fix control waits on `/api/manual-fields`, so a test that clicks it
  // needs the schema landed, not just the list.
  await waitFor(() => assert.ok(within(card('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i })));
}

test('the tab lists dismissed items and nothing else', async () => {
  serve();
  await load();

  assert.ok(screen.getByText('Alpha.RAW.1080p'));
  assert.ok(screen.getByText('Beta.RAW.720p'));
});

test('a dismissed item still offers Fix…, because that is how it stays fixable', async () => {
  serve();
  await load();

  assert.ok(within(card('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));
});

test('fixing one drops it from the list and reports where the release went', async () => {
  serve(true);
  await load();

  fireEvent.click(within(card('Alpha.RAW.1080p')).getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.ok(gone('Alpha.RAW.1080p')));
  assert.ok(screen.getByText('Alpha Thing joined an existing group'));
  assert.ok(screen.getByText('Beta.RAW.720p'));
});

// The second half of what was `Failed.test.tsx`'s
// "dismissed items are asked for only when shown, and offer no second
// dismissal" — the first half was about a "show dismissed" toggle this tab
// has no need of, since every item it lists is already dismissed.
test('it shows the Dismissed badge rather than a Dismiss button', async () => {
  serve();
  await load();

  const alpha = within(card('Alpha.RAW.1080p'));
  assert.ok(alpha.getByText('Dismissed'));
  assert.equal(alpha.queryAllByRole('button', { name: /dismiss/i }).length, 0);
});

test('an empty list says so rather than rendering nothing', async () => {
  globalThis.fetch = fetchStub(async (input) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname === '/api/manual-fields') {
      return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ items: [], nextCursor: null }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  render(<Dismissed />);

  await waitFor(() => assert.ok(screen.getByText('Nothing dismissed.')));
});
