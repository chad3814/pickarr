import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribeInserts } from '../../src/store/notify.ts';
import { Feeds, type FeedsSource } from '../../src/settings/Feeds.tsx';
import type { AddFeedInput, AddFeedOutcome } from '../../src/settings/AddFeed.tsx';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave a `Feeds` still mounted,
 * still subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/**
 * One `upsert` `SyncOp` for `rss_feed` -- an `upsert`, not a `create`: the
 * live tail (`packages/host/src/sync/tail.ts`) never emits `create`, only
 * `upsert` for a row's current state, so a test seeded with `create` would
 * prove less than it appears to (task 5's ruling; contrast
 * `Category.test.tsx`'s `mediaItem` helper, which legitimately builds a
 * `create` for a different reason stated there).
 */
function feedOp({ id, name, url = 'https://tracker.example/rss?apikey=***' }: { id: number; name: string; url?: string }): SyncOp {
  return {
    op: 'upsert',
    table: 'rss_feed',
    id,
    value: {
      id,
      pluginId: 'tv',
      name,
      downloadType: 'torrent',
      pollIntervalS: 300,
      downloadClientId: null,
      createdAt: id,
      updatedAt: id,
      url,
    },
  };
}

/** Everything `Feeds` needs, bound straight to a raw database -- no `Store`, nothing this suite has to stop afterwards. */
function sourceFor(db: IDBDatabase): FeedsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribeInserts,
  };
}

/**
 * A `submit` that fails the test if it is ever called. Task 5's ruling: the
 * brief's own first test renders `<Feeds source={...} />` with no `submit`
 * at all, which does not typecheck against a *required* prop -- `submit` is
 * required deliberately (a defaulted one that quietly posted to `/api/feeds`
 * would make a test that forgot the prop hang under jsdom instead of
 * failing loudly). This test is about listing; it must not be silently
 * exercising the add path either.
 */
function neverSubmit(): Promise<AddFeedOutcome> {
  assert.fail('a listing test must not call submit');
}

function submitFor(outcome: 'duplicate-url' | 'unknown-plugin' | 'offline'): (input: AddFeedInput) => Promise<AddFeedOutcome> {
  return () => Promise.resolve({ refusal: outcome });
}

function fillFeedForm({ name, url }: { name: string; url: string }): void {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Feed url'), { target: { value: url } });
}

test('the settings screen carries the route-mapping marker on its root element', async () => {
  const db = await freshDb();
  render(<Feeds source={sourceFor(db)} submit={neverSubmit} />);
  assert.ok(screen.getByTestId('settings'), 'the marker names this screen');
});

test('the list shows a feed by name and host, from the replica', async () => {
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD', url: 'https://tracker.example/rss?apikey=***' })]);
  render(<Feeds source={sourceFor(db)} submit={neverSubmit} />);
  await waitFor(() => {
    assert.ok(screen.getByRole('heading', { name: 'Movies HD' }), 'the feed is named');
  });
  assert.ok(screen.getByText('https://tracker.example/rss?apikey=***'), 'the redacted url is shown as-is');
});

test('adding a feed puts it in the list without a refetch', async () => {
  // The payoff of syncing the table: the POST answers only "accepted", and
  // the row arrives through the replica's own subscription.
  const db = await freshDb();
  render(<Feeds source={sourceFor(db)} submit={() => Promise.resolve({ id: 1 })} />);
  fillFeedForm({ name: 'Movies HD', url: 'https://tracker.example/rss' });
  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  await waitFor(() => {
    assert.ok(screen.getByRole('heading', { name: 'Movies HD' }));
  });
});

test('each refusal reads as its own sentence, and offline is not a refusal', async () => {
  // Three distinct outcomes, three distinct words. An offline submit that
  // read as "already on file" would send the operator hunting for a feed
  // that is not there.
  for (const [outcome, phrase] of [
    ['duplicate-url', /already/i],
    ['unknown-plugin', /plugin/i],
    ['offline', /could not reach/i],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- each iteration renders, asserts and calls its own `cleanup()` before the next; the three outcomes cannot run concurrently against the one shared `screen` (`library/Unmatched.tsx`'s own walk takes the identical exception for the identical reason).
    const db = await freshDb();
    render(<Feeds source={sourceFor(db)} submit={submitFor(outcome)} />);
    fillFeedForm({ name: 'X', url: 'https://tracker.example/rss' });
    fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
    // eslint-disable-next-line no-await-in-loop -- see above
    const alert = await screen.findByRole('alert');
    assert.ok(phrase.test(alert.textContent ?? ''), `${outcome} has its own words`);
    cleanup();
  }
});

test('the error is a visible heading, not only an announced one', async () => {
  // CLAUDE.md's longest hazard: a component once passed ten tests with
  // `role`, an `aria-label`, no visible heading and no stylesheet rule, and
  // the first human to see it read it as an error.
  const db = await freshDb();
  render(<Feeds source={sourceFor(db)} submit={submitFor('duplicate-url')} />);
  fillFeedForm({ name: 'X', url: 'https://tracker.example/rss' });
  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
  const heading = await screen.findByRole('heading', { name: /already/i });
  assert.ok(screen.getByRole('alert').contains(heading), 'the visible heading is inside the announced region');
});

test('an empty replica reads as "no feeds yet", not as still loading forever', async () => {
  const db = await freshDb();
  render(<Feeds source={sourceFor(db)} submit={neverSubmit} />);
  await waitFor(() => {
    assert.ok(screen.getByText(/no feeds yet/i));
  });
});

test('the list never falls back to the network when the replica is empty', async () => {
  // Global Constraint: lists come from the replica only.
  const db = await freshDb();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  try {
    render(<Feeds source={sourceFor(db)} submit={neverSubmit} />);
    await waitFor(() => {
      assert.ok(screen.getByText(/no feeds yet/i));
    });
    assert.equal(fetchCalls, 0, 'Feeds never called fetch: the list comes from the replica only');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
