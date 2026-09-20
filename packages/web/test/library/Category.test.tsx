import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { getRows, listByTablePlugin } from '../../src/store/rows.ts';
import { subscribe, subscribeInserts } from '../../src/store/notify.ts';
import { gatherMediaItem } from '../../src/store/gather.ts';
import { Category, type CategorySource } from '../../src/library/Category.tsx';
import type { PickSubmit } from '../../src/library/postPick.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave a `Category` still mounted,
 * still subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/** One `create` `SyncOp` for the `media_item` table, matching `useMediaItems.test.tsx`'s own helper. */
function mediaItem({
  id,
  pluginId,
  title,
  updatedAt,
}: {
  id: number;
  pluginId: string;
  title: string;
  updatedAt: number;
}): SyncOp {
  return {
    op: 'create',
    table: 'media_item',
    id,
    value: {
      id,
      pluginId,
      createdAt: updatedAt,
      updatedAt,
      provider: null,
      providerRef: null,
      title,
      releaseDate: null,
      description: null,
    },
  };
}

/** Everything `Category` needs, bound straight to a raw database -- no `Store`, nothing this suite has to stop afterwards. */
function sourceFor(db: IDBDatabase): CategorySource {
  return {
    listByTablePlugin: (table, pluginId, opts) => listByTablePlugin(db, table, pluginId, opts),
    subscribeInserts,
    gatherMediaItem: (mediaItemId) => gatherMediaItem(db, mediaItemId),
    subscribe,
    getRows: (table, ids) => getRows(db, table, ids),
  };
}

/** A `submit` that accepts. No test in this file presses a Pick button; `MediaItemCard.test.tsx` is where that wire is driven. */
const acceptsPick: PickSubmit = () => Promise.resolve({ accepted: true });

function titlesShown(): string[] {
  return screen.getAllByRole('heading').map((heading) => heading.textContent ?? '');
}

test('the category screen carries the route-mapping marker on its root element', async () => {
  // `Category.tsx`'s own doc: task 4's three mapping tests in
  // `Shell.test.tsx` find whichever category screen renders by this marker
  // alone, so it is a contract this component inherited rather than
  // decoration it is free to drop.
  const db = await freshDb();
  render(<Category store={sourceFor(db)} pluginId="tv" submit={acceptsPick} />);
  assert.ok(screen.getByTestId('category-tv'), 'the marker names this category');

  await waitFor(() => {
    assert.ok(screen.getByText(/nothing here yet/i));
  });

  db.close();
});

test('a category lists its items newest first, each as its own card', async () => {
  const db = await freshDb();
  await seed(db, [
    mediaItem({ id: 1, pluginId: 'tv', title: 'Older Show', updatedAt: 10 }),
    mediaItem({ id: 2, pluginId: 'tv', title: 'Newer Show', updatedAt: 20 }),
  ]);
  render(<Category store={sourceFor(db)} pluginId="tv" submit={acceptsPick} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newer Show', 'Older Show'], 'newest first');
  });

  db.close();
});

test('an empty category says so rather than rendering nothing', async () => {
  const db = await freshDb();
  render(<Category store={sourceFor(db)} pluginId="tv" submit={acceptsPick} />);

  await waitFor(() => {
    assert.ok(screen.getByText(/nothing here yet/i));
  });
  assert.ok(screen.queryByRole('button', { name: /load more/i }) === null, 'no more to load');

  db.close();
});

test('a category with no store yet renders only its marker, not "nothing here yet"', () => {
  // `store` is `undefined` until `Shell`'s own store finishes opening
  // (`Shell.tsx`'s state, `Category.tsx`'s own doc). This must not be
  // mistaken for a confirmed-empty replica.
  render(<Category store={undefined} pluginId="tv" submit={acceptsPick} />);
  assert.ok(screen.getByTestId('category-tv'), 'the marker renders even with no store yet');
  assert.ok(!screen.queryByText(/nothing here yet/i), 'not yet knowable whether the category is empty');
});

test('expanding a card gathers through the same store the list read from', async () => {
  const db = await freshDb();
  await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: 'The Show', updatedAt: 10 })]);
  render(<Category store={sourceFor(db)} pluginId="tv" submit={acceptsPick} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['The Show']);
  });

  fireEvent.click(screen.getByRole('button', { name: 'The Show' }));
  await waitFor(() => {
    assert.ok(screen.getByRole('list', { name: /releases/i }), 'the card gathered through the store Category was given');
  });

  db.close();
});

test('no fetch is issued while a category renders', async () => {
  // Global Constraint, restated at the component this task built rather
  // than only at the hook underneath it.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('no fetch may be issued while rendering a category');
  };
  try {
    const db = await freshDb();
    await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: 'Local Show', updatedAt: 10 })]);
    render(<Category store={sourceFor(db)} pluginId="tv" submit={acceptsPick} />);
    await waitFor(() => {
      assert.deepEqual(titlesShown(), ['Local Show']);
    });
    assert.equal(calls, 0, 'the replica answered without the network');
    db.close();
  } finally {
    globalThis.fetch = original;
  }
});
