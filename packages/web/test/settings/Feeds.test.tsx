import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribeTable } from '../../src/store/notify.ts';
import type { FeedRemovalSubmit } from '../../src/settings/postFeedRemoval.ts';
import { Feeds, type FeedsSource } from '../../src/settings/Feeds.tsx';
import type { AddFeedOutcome } from '../../src/settings/AddFeed.tsx';
import type { AddFeedInput } from '@pickarr/contract';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave a `Feeds` still mounted,
 * still subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/** No listing test removes anything; these fail the test if one reaches them. */
function neverSubmitFeed(): Promise<never> {
  return assert.fail('a removal test must not add a feed');
}

const neverRemoves: FeedRemovalSubmit = {
  remove: () => assert.fail('a listing test must not remove a feed'),
  setDisabled: () => assert.fail('a listing test must not pause or resume a feed'),
};


/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/**
 * One `upsert` `SyncOp` for `rss_feed` -- an `upsert`, not a `create`: the
 * live tail (`packages/host/src/sync/tail.ts`) never emits `create`, only
 * `upsert` for a row's current state, so a test seeded with `create` would
 * prove less than it appears to (task 5's ruling). `Category.test.tsx`'s own
 * `mediaItem` helper builds a `create` instead -- its docblock states no
 * reason beyond "matching `useMediaItems.test.tsx`'s own helper" (fix round
 * 1, review-found: an earlier version of this comment claimed one that is
 * not there), so that choice is not a precedent this helper follows.
 */
function feedOp({ id, name, url = 'https://tracker.example/rss?apikey=*****', disabledAt = null }: { id: number; name: string; url?: string; disabledAt?: number | null }): SyncOp {
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
      disabledAt,
    },
  };
}

/** Everything `Feeds` needs, bound straight to a raw database -- no `Store`, nothing this suite has to stop afterwards. */
function sourceFor(db: IDBDatabase): FeedsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribeTable,
  };
}

/**
 * A `submit` that fails the test if it is ever called. Task 5's ruling: the
 * brief's own first test renders `<Feeds source={...} removal={neverRemoves} />` with no `submit`
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

test('the list shows a feed by name and host, from the replica', async () => {
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD', url: 'https://tracker.example/rss?apikey=***' })]);
  render(<Feeds source={sourceFor(db)} submit={neverSubmit} removal={neverRemoves} />);
  await waitFor(() => {
    // A length check, not `assert.ok(getByRole(...))`: the latter can only
    // ever pass once the query stops throwing, which proves nothing beyond
    // "found at least one" -- this also catches a duplicate render, the
    // class of defect `useMediaItems.ts`'s own `windowGenerationRef` doc
    // names a real instance of.
    assert.equal(screen.getAllByRole('heading', { name: 'Movies HD' }).length, 1, 'the feed is named, exactly once');
  });
  const urlText = screen.getByText('https://tracker.example/rss?apikey=***');
  assert.equal(urlText.tagName, 'P', 'the redacted url is shown as-is, as its own line of text');
});

test('clicking Add feed calls submit, and the row appears through the replica\'s own subscription, not a refetch', async () => {
  // The payoff of syncing the table: the POST answers only "accepted", and
  // the row arrives through the replica's own subscription -- not because
  // `submit` itself wrote anything (it does not touch `db` at all).
  //
  // A `submit` that resolves and never checking it was *called* would pass
  // even if the click did nothing at all: the row would still show up,
  // because it comes from the `seed` call below regardless (fix round 1,
  // review-found -- M5). `submitCalls` is what proves the click is the
  // thing that fired the request.
  const db = await freshDb();
  let submitCalls = 0;
  render(
    <Feeds
      source={sourceFor(db)}
      submit={() => {
        submitCalls += 1;
        return Promise.resolve({ id: 1 });
      }}
      removal={neverRemoves}
    />,
  );
  fillFeedForm({ name: 'Movies HD', url: 'https://tracker.example/rss' });
  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));

  await waitFor(() => {
    assert.equal(submitCalls, 1, 'the click actually invoked submit');
  });

  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  await waitFor(() => {
    assert.equal(
      screen.getAllByRole('heading', { name: 'Movies HD' }).length,
      1,
      'the seeded row rendered, exactly once, not anything submit itself produced',
    );
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
    render(<Feeds source={sourceFor(db)} submit={submitFor(outcome)} removal={neverRemoves} />);
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
  //
  // **`findByRole('heading', { name: /already/i })` alone does not guard
  // this** (fix round 1, review-found): `getByRole`'s own `name` option
  // reads the *accessibility tree*, which an `aria-label` satisfies with no
  // visible text at all -- so a mutant that swaps `<h3>{error}</h3>` for
  // `<h3 aria-label={error} />` still matches that query and this test
  // still passed against an empty, invisible heading. Asserting the
  // heading's own `textContent` against the literal sentence closes that:
  // an `aria-label` never populates `textContent`, so the mutant now reads
  // an empty string here and reds.
  const db = await freshDb();
  render(<Feeds source={sourceFor(db)} submit={submitFor('duplicate-url')} removal={neverRemoves} />);
  fillFeedForm({ name: 'X', url: 'https://tracker.example/rss' });
  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
  const heading = await screen.findByRole('heading', { name: /already/i });
  assert.equal(heading.textContent, 'That url is already on file.', 'the heading carries real visible text, not just an accessible name');
  assert.ok(screen.getByRole('alert').contains(heading), 'the visible heading is inside the announced region');
});

test('an empty replica reads as "no feeds yet", not as still loading forever', async () => {
  const db = await freshDb();
  render(<Feeds source={sourceFor(db)} submit={neverSubmit} removal={neverRemoves} />);
  await waitFor(() => {
    assert.equal(screen.getByText(/no feeds yet/i).tagName, 'P', 'rendered as its own line of text, not merely present in the tree');
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
    render(<Feeds source={sourceFor(db)} submit={neverSubmit} removal={neverRemoves} />);
    await waitFor(() => {
      assert.equal(screen.getByText(/no feeds yet/i).tagName, 'P');
    });
    assert.equal(fetchCalls, 0, 'Feeds never called fetch: the list comes from the replica only');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('removing a feed that produced nothing says it was removed', async () => {
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  const asked: number[] = [];
  render(
    <Feeds
      source={sourceFor(db)}
      submit={neverSubmitFeed}
      removal={{
        remove: async (id) => { asked.push(id); return { outcome: 'deleted' }; },
        setDisabled: () => assert.fail('this test removes, it does not pause'),
      }}
    />,
  );
  await waitFor(() => { assert.ok(screen.getByRole('button', { name: 'Remove Movies HD' })); });

  fireEvent.click(screen.getByRole('button', { name: 'Remove Movies HD' }));

  await waitFor(() => { assert.ok(screen.getByText('Feed removed.')); });
  assert.deepEqual(asked, [1], 'the id it was asked to remove, not another row\u2019s');
  db.close();
});

test('the removal sentence outlives the row the replica deletes', async () => {
  // A deleted feed's row leaves the list on the next sync tick, about twenty
  // milliseconds after the DELETE answers in a real browser (measured by the
  // e2e spec's own timeline). A sentence held on the row would go with it,
  // and the operator who clicked would never read it.
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  render(
    <Feeds
      source={sourceFor(db)}
      submit={neverSubmitFeed}
      removal={{
        remove: async () => ({ outcome: 'deleted' }),
        setDisabled: () => assert.fail('this test removes, it does not pause'),
      }}
    />,
  );
  await waitFor(() => { assert.ok(screen.getByRole('button', { name: 'Remove Movies HD' })); });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Movies HD' }));
  await waitFor(() => { assert.ok(screen.getByText('Feed removed.')); });

  await applyBatch(db, [{ op: 'delete', table: 'rss_feed', id: 1 }], { since: 2, before: null });

  await waitFor(() => { assert.ok(!screen.queryByRole('heading', { name: 'Movies HD' }), 'the row is gone'); });
  assert.equal(screen.getByText('Feed removed.').tagName, 'P', 'the sentence is still on the page after the row left');
  assert.equal(screen.getByRole('status').textContent, 'Feed removed.', 'announced as a status, outside any row');
  db.close();
});

test('removing a feed that produced releases says it was disabled, and why', async () => {
  // The sentence carries the count because "disabled" is not what the
  // operator asked for, and the number of kept releases is the reason.
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  render(
    <Feeds
      source={sourceFor(db)}
      submit={neverSubmitFeed}
      removal={{
        remove: async () => ({ outcome: 'disabled', items: 3 }),
        setDisabled: () => assert.fail('not this test'),
      }}
    />,
  );
  await waitFor(() => { assert.ok(screen.getByRole('button', { name: 'Remove Movies HD' })); });

  fireEvent.click(screen.getByRole('button', { name: 'Remove Movies HD' }));

  await waitFor(() => {
    assert.ok(screen.getByText(/3 releases were kept, so the feed was disabled rather than deleted/));
  });
  db.close();
});

test('a disabled feed says so and offers to be enabled, not removed', async () => {
  // `disabledAt` comes from the replica, so the row knows its own state
  // without this page asking. Both halves: the control that appears and
  // the one that does not.
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD', disabledAt: 500 })]);
  const asked: Array<{ id: number; disabled: boolean }> = [];
  render(
    <Feeds
      source={sourceFor(db)}
      submit={neverSubmitFeed}
      removal={{
        remove: () => assert.fail('a disabled feed offers Enable, not Remove'),
        setDisabled: async (id, disabled) => { asked.push({ id, disabled }); return { outcome: 'enabled' }; },
      }}
    />,
  );
  await waitFor(() => { assert.ok(screen.getByRole('button', { name: 'Enable Movies HD' })); });
  assert.ok(!screen.queryByRole('button', { name: 'Remove Movies HD' }), 'no Remove on a disabled feed');
  assert.ok(screen.getByText(/no longer polled/));

  fireEvent.click(screen.getByRole('button', { name: 'Enable Movies HD' }));
  await waitFor(() => { assert.deepEqual(asked, [{ id: 1, disabled: false }]); });
  db.close();
});

test('a refused removal says so and leaves the control usable', async () => {
  // The wedge `postFeed` and `postMapping` both record: a control that
  // stays pending forever after a failure. The button must come back.
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  render(
    <Feeds
      source={sourceFor(db)}
      submit={neverSubmitFeed}
      removal={{
        remove: async () => ({ outcome: 'refused', refusal: 'unreachable' }),
        setDisabled: () => assert.fail('not this test'),
      }}
    />,
  );
  await waitFor(() => { assert.ok(screen.getByRole('button', { name: 'Remove Movies HD' })); });

  fireEvent.click(screen.getByRole('button', { name: 'Remove Movies HD' }));

  await waitFor(() => { assert.ok(screen.getByText(/Could not reach Pickarr/)); });
  const button = screen.getByRole('button', { name: 'Remove Movies HD' });
  assert.equal(button.hasAttribute('disabled'), false, 'still clickable, so a retry is possible');
  db.close();
});
