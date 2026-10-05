import { test, afterEach } from 'node:test';
import { act } from '@testing-library/react';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { getRows, listByTablePlugin, pluginRowsByMediaItems } from '../../src/store/rows.ts';
import { listCatalog } from '../../src/store/catalog.ts';
import { done } from '../../src/store/idb.ts';
import { subscribe, subscribeCatalog, subscribeInserts, subscribeTouched } from '../../src/store/notify.ts';
import { gatherMediaItem } from '../../src/store/gather.ts';
import { MemoryRouter, useLocation } from 'react-router';
import type { ReactElement } from 'react';
import { Category, type CategorySource } from '../../src/library/Category.tsx';
import { PAGE_SIZE } from '../../src/library/useMediaItems.ts';
import type { IdentifySubmit } from '@pickarr/plugin-ui';
import type { PickSubmit } from '../../src/library/postPick.ts';

/**
 * The `tables` value for the tests that are not about plugin rows at all --
 * which is most of this file. Two below do name a real one
 * (`TV_RELEASE_TABLE`): the batched-fetch shape, and the late-batch test at
 * the end. This constant used to claim none did, which was false the moment
 * the batched-fetch test landed.
 */
const NO_TABLES: readonly string[] = [];

/**
 * The one table `@pickarr/plugin-tv`'s card declares
 * (`plugin-tv/src/browser.tsx`'s `TV_RELEASE_TABLE`). Named here rather
 * than imported: this file drives `Category` against the registry's real
 * cards, and a literal is what pins that the two agree -- reading the
 * plugin's own constant would make both sides of the comparison move
 * together (`CLAUDE.md`'s `groupAnchor` hazard).
 */
const TV_RELEASE_TABLE = 'tv_release';

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

/**
 * One `create` `SyncOp` for `tv_release`, shaped as the `TvRead` a client
 * receives (`plugin-tv/src/sync.ts`'s `release.read`).
 *
 * `seriesRef` and `kind` are carried because the read shape has them, not
 * because anything here reads them back: `plugin-tv`'s card dereferences
 * `seriesTitle`, `seasonNumber` and `episodeNumber` and no more, and its
 * `isTvRelease` guard checks exactly those three. A row missing any of them
 * is declined rather than rendered, which is a different test's business.
 */
function tvRelease({
  id,
  mediaItemId,
  seriesTitle,
  seasonNumber,
  episodeNumber,
}: {
  id: number;
  mediaItemId: number;
  seriesTitle: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}): SyncOp {
  return {
    op: 'create',
    table: TV_RELEASE_TABLE,
    id,
    value: {
      mediaItemId,
      kind: 'episode',
      seriesTitle,
      seriesRef: `series-ref-${String(id)}`,
      seasonNumber,
      episodeNumber,
    },
  };
}

/** Everything `Category` needs, bound straight to a raw database -- no `Store`, nothing this suite has to stop afterwards. */
function sourceFor(db: IDBDatabase): CategorySource {
  return {
    listByTablePlugin: (table, pluginId, opts) => listByTablePlugin(db, table, pluginId, opts),
    subscribeInserts,
    subscribeTouched,
    gatherMediaItem: (mediaItemId) => gatherMediaItem(db, mediaItemId),
    subscribe,
    getRows: (table, ids) => getRows(db, table, ids),
    pluginRowsByMediaItems: (mediaItemIds, tables) => pluginRowsByMediaItems(db, mediaItemIds, tables),
    listCatalog: (query, opts) => listCatalog(db, query, opts),
    subscribeCatalog,
  };
}

/** Renders under a router at `entry`: `Category` reads its filter and search from the URL. */
function renderAt(ui: ReactElement, entry = '/tv'): void {
  render(<MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>);
}

/** A `submit` that accepts. No test in this file presses a Pick button; `MediaItemCard.test.tsx` is where that wire is driven. */
const acceptsPick: PickSubmit = () => Promise.resolve({ accepted: true });

/** An `identify` for tests that are not about identifying: a call fails the test. */
const throwsOnUse: IdentifySubmit = {
  identify: () => {
    assert.fail('this test must not identify');
  },
  suggest: () => {
    assert.fail('this test must not suggest');
  },
};

function titlesShown(): string[] {
  return screen.getAllByRole('heading').map((heading) => heading.textContent ?? '');
}

test('the category screen carries the route-mapping marker on its root element', async () => {
  // `Category.tsx`'s own doc: task 4's three mapping tests in
  // `Shell.test.tsx` find whichever category screen renders by this marker
  // alone, so it is a contract this component inherited rather than
  // decoration it is free to drop.
  const db = await freshDb();
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);
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
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newer Show', 'Older Show'], 'newest first');
  });

  db.close();
});

test('scrolling to the sentinel loads the next page, and the button is still there', async () => {
  // Infinite scroll, with the control kept. Both halves matter: the scroll
  // is the feature, and the button is what a keyboard user activates and
  // what works where `IntersectionObserver` does not -- which includes this
  // environment, whose observer exists and never fires. So the observer is
  // replaced with one the test can drive, exactly as
  // `useInfiniteScroll.test.tsx` does and for the same measured reason.
  const real = globalThis.IntersectionObserver;
  const fired: Array<() => void> = [];
  class Fake {
    private targets: Element[] = [];
    // A plain assignment, not a parameter property: `erasableSyntaxOnly` is
    // on, and a parameter property is syntax that cannot be erased.
    private readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      fired.push(() => {
        const entries = this.targets.map((target) => ({ target, isIntersecting: true } as IntersectionObserverEntry));
        this.callback(entries, this as unknown as IntersectionObserver);
      });
    }
    observe(element: Element): void { this.targets.push(element); }
    unobserve(): void {}
    disconnect(): void { this.targets = []; }
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  globalThis.IntersectionObserver = Fake as unknown as typeof IntersectionObserver;

  try {
    const db = await freshDb();
    // One more than a page, so there is a second page to reach for.
    const ops = Array.from({ length: PAGE_SIZE + 1 }, (_, index) =>
      mediaItem({ id: index + 1, pluginId: 'tv', title: `Show ${String(index + 1)}`, updatedAt: index + 1 }));
    await seed(db, ops);

    renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);
    await waitFor(() => { assert.equal(titlesShown().length, PAGE_SIZE, 'the first page'); });

    // Sized from `PAGE_SIZE` rather than a literal, deliberately: this test
    // is about reaching a second page, not about the page being 24, and a
    // literal would red on a size change that broke nothing.
    //
    // Worth knowing while reading that: **the default size is not pinned
    // anywhere.** `useMediaItems.test.tsx` passes `pageSize={24}` as an
    // explicit argument, which exercises that size without asserting it is
    // the default -- so changing `PAGE_SIZE` reds nothing. Recorded rather
    // than fixed here; it is that hook's gap, not this test's.
    assert.ok(screen.getByRole('button', { name: 'Load more' }), 'the control is still rendered');

    act(() => { for (const fire of fired) fire(); });
    await waitFor(() => { assert.equal(titlesShown().length, PAGE_SIZE + 1, 'the sentinel loaded the rest'); });

    // And once there is nothing left, both the sentinel and the button go.
    await waitFor(() => { assert.ok(!screen.queryByRole('button', { name: 'Load more' }), 'exhausted, so no control'); });
    assert.ok(!screen.queryByTestId('load-more-sentinel'), 'and nothing left to observe');

    db.close();
  } finally {
    globalThis.IntersectionObserver = real;
  }
});

test('an empty category says so rather than rendering nothing', async () => {
  const db = await freshDb();
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);

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
  renderAt(<Category store={undefined} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);
  assert.ok(screen.getByTestId('category-tv'), 'the marker renders even with no store yet');
  assert.ok(!screen.queryByText(/nothing here yet/i), 'not yet knowable whether the category is empty');
});

test('expanding a card gathers through the same store the list read from', async () => {
  const db = await freshDb();
  await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: 'The Show', updatedAt: 10 })]);
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['The Show']);
  });

  fireEvent.click(screen.getByRole('button', { name: 'The Show' }));
  await waitFor(() => {
    assert.ok(screen.getByRole('list', { name: /releases/i }), 'the card gathered through the store Category was given');
  });

  db.close();
});

test("a category fetches its page's plugin rows once, batched by every item's id, not once per card", async () => {
  // The defect this design replaced: `gatherMediaItem` used to carry
  // `pluginRows`, fetched per card on expand -- which cannot serve a
  // collapsed card's headline at all, and would have cost one call per
  // card rather than one for the page. This pins the page-level shape:
  // one call, naming every item's id, however many cards are on screen.
  const db = await freshDb();
  await seed(db, [
    mediaItem({ id: 1, pluginId: 'tv', title: 'Older Show', updatedAt: 10 }),
    mediaItem({ id: 2, pluginId: 'tv', title: 'Newer Show', updatedAt: 20 }),
  ]);
  let calls = 0;
  let lastIds: readonly number[] = [];
  let lastTables: readonly string[] = [];
  const source: CategorySource = {
    ...sourceFor(db),
    pluginRowsByMediaItems: (mediaItemIds, tables) => {
      calls += 1;
      lastIds = mediaItemIds;
      lastTables = tables;
      return pluginRowsByMediaItems(db, mediaItemIds, tables);
    },
  };
  renderAt(<Category store={source} pluginId="tv" tables={[TV_RELEASE_TABLE]} submit={acceptsPick} identify={throwsOnUse} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Newer Show', 'Older Show']);
  });
  assert.equal(calls, 1, 'one batched call for the whole page, not one per card');
  assert.deepEqual([...lastIds].toSorted((a, b) => a - b), [1, 2], 'every item on the page was named');
  assert.deepEqual(lastTables, [TV_RELEASE_TABLE]);

  db.close();
});

test("a plugin row that replicates in a later batch than its media item still reaches the card", async () => {
  // **A staleness that the e2e proof of this feature could not see, because
  // that harness writes both rows in one synchronous call and they share a
  // sync batch.** Replication does not promise that: `/api/sync` is a
  // `sync_log` walk applied in batches and the contract says plainly that
  // ordering is not preserved across it -- `@pickarr/contract`'s
  // `TvSeasonRead` doc has a client holding a season whose series has not
  // arrived yet, with the referent arriving "elsewhere in the same walk".
  // So a `tv_release` can land in a later batch than its `media_item`
  // whatever the host wrote atomically, and mid-backfill -- 2.0's normal
  // first-run condition, since the database is greenfield and rebuilds from
  // feeds -- is when that is most likely.
  //
  // Before `usePluginRows` subscribed to anything, this card rendered
  // `item.title` and **nothing ever woke it**: no poll, no subscription, and
  // no change to the one effect's `[source, mediaItemIds, tables]`
  // dependencies. The headline appeared only after a remount or a reload.
  //
  // Two batches, deliberately, and this test is worthless as one: a single
  // `applyBatch` carrying both rows passes against the broken code, because
  // the first fetch then already finds the release.
  const db = await freshDb();
  const tables = [TV_RELEASE_TABLE];
  await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: "Dio's World(3)", updatedAt: 10 })]);

  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={tables} submit={acceptsPick} identify={throwsOnUse} />);

  await waitFor(() => {
    assert.deepEqual(titlesShown(), ["Dio's World(3)"], 'no tv_release yet, so the card reads the media item title');
  });

  await seed(db, [tvRelease({
    id: 10,
    mediaItemId: 1,
    seriesTitle: "Jo Jo's Bizarre Adventure",
    seasonNumber: 2,
    episodeNumber: 47,
  })]);

  // The literal, not a call to `tvHeadline` -- the same reason
  // `packages/e2e/tests/shell.spec.ts`'s `TV_HEADLINE` is a literal.
  await waitFor(() => {
    assert.deepEqual(
      titlesShown(),
      ["Jo Jo's Bizarre Adventure S02E47 Dio's World(3)"],
      'the later batch woke the page, with no remount and no reload',
    );
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
    renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);
    await waitFor(() => {
      assert.deepEqual(titlesShown(), ['Local Show']);
    });
    assert.equal(calls, 0, 'the replica answered without the network');
    db.close();
  } finally {
    globalThis.fetch = original;
  }
});

/** Marks `ids` picked in the catalog directly -- picking itself is the server's and the apply path's business, not this page's. */
async function markPicked(db: IDBDatabase, ids: readonly number[]): Promise<void> {
  const tx = db.transaction('catalog', 'readwrite');
  const store = tx.objectStore('catalog');
  for (const id of ids) {
    const request = store.get(id);
    request.onsuccess = () => {
      const record: unknown = request.result;
      if (typeof record === 'object' && record !== null) store.put({ ...record, picked: 1 });
    };
  }
  await done(tx);
}

async function seedPickedAndNot(db: IDBDatabase): Promise<void> {
  await seed(db, [
    mediaItem({ id: 1, pluginId: 'tv', title: 'Alpha Show', updatedAt: 10 }),
    mediaItem({ id: 2, pluginId: 'tv', title: 'Beta Show', updatedAt: 20 }),
    mediaItem({ id: 3, pluginId: 'tv', title: 'Gamma Show', updatedAt: 30 }),
  ]);
  await markPicked(db, [1, 3]);
}

test('the default route reads no catalog', async () => {
  const db = await freshDb();
  await seedPickedAndNot(db);
  let calls = 0;
  const source: CategorySource = {
    ...sourceFor(db),
    listCatalog: (query, opts) => {
      calls += 1;
      return listCatalog(db, query, opts);
    },
  };
  renderAt(<Category store={source} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Gamma Show', 'Beta Show', 'Alpha Show']);
  });
  assert.equal(calls, 0);
  db.close();
});

test('filter=picked lists only picked items, from the catalog', async () => {
  const db = await freshDb();
  await seedPickedAndNot(db);
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, '/tv?filter=picked');
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Gamma Show', 'Alpha Show']);
  });
  assert.ok(screen.getByRole('button', { name: 'Gamma Show' }), 'rendered through MediaItemCard');
  db.close();
});

test('a search term narrows the list', async () => {
  const db = await freshDb();
  await seedPickedAndNot(db);
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, '/tv?q=beta');
  await waitFor(() => {
    assert.deepEqual(titlesShown(), ['Beta Show']);
  });
  db.close();
});

test('each empty filtered view says what it is empty of', async () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['/tv?filter=picked', 'No picked items yet', false],
    ['/tv?filter=unpicked', 'No unpicked items', false],
    ['/tv?q=zz', 'Nothing matches "zz"', true],
    ['/tv?filter=unpicked&q=zz', 'Nothing matches "zz" among unpicked items', true],
    ['/tv?filter=picked&q=zz', 'Nothing matches "zz" among picked items', true],
  ];
  for (const [entry, sentence, withItems] of cases) {
    // eslint-disable-next-line no-await-in-loop -- each case owns a database and a mounted tree
    const db = await freshDb();
    if (withItems) {
      // eslint-disable-next-line no-await-in-loop -- as above
      await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: 'Alpha Show', updatedAt: 10 })]);
    }
    renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, entry);
    // eslint-disable-next-line no-await-in-loop -- as above
    await waitFor(() => {
      assert.ok(screen.getByText(sentence), sentence);
    });
    cleanup();
    db.close();
  }
});

test('Load more pages a filtered list', async () => {
  const db = await freshDb();
  const ops: SyncOp[] = [];
  for (let id = 1; id <= PAGE_SIZE + 1; id += 1) {
    ops.push(mediaItem({ id, pluginId: 'tv', title: `Show ${String(id)}`, updatedAt: id }));
  }
  await seed(db, ops);
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, '/tv?filter=unpicked');
  await waitFor(() => {
    assert.equal(titlesShown().length, PAGE_SIZE);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => {
    assert.equal(titlesShown().length, PAGE_SIZE + 1);
  });
  db.close();
});

for (const entry of ['/tv', '/tv?q=show']) {
  test(`the identify a category is handed reaches an expanded card's Requery (${entry})`, async () => {
    // Both list paths forward it: the unfiltered `DefaultList` and the
    // searched `FilteredList` each build their own `ItemList`.
    const db = await freshDb();
    await seed(db, [
      mediaItem({ id: 1, pluginId: 'tv', title: 'The Show', updatedAt: 10 }),
      {
        op: 'upsert',
        table: 'rss_item',
        id: 31,
        value: {
          id: 31,
          feedId: 1,
          filename: 'the.show.mkv',
          createdAt: 10,
          updatedAt: 10,
          downloadType: 'torrent',
          mediaItemId: 1,
          rankingScore: null,
          lookupState: 'resolved',
          lookupStateDetail: null,
          videoResolution: null,
          lookupJson: null,
          deliveredAt: null,
        },
      },
    ]);
    const requeried: [number, string][] = [];
    const identify: IdentifySubmit = {
      identify: (rssItemId, request) => {
        requeried.push([rssItemId, request.mode]);
        return Promise.resolve({ accepted: true });
      },
      suggest: () => Promise.resolve([]),
    };
    renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={identify} />, entry);

    await waitFor(() => {
      assert.deepEqual(titlesShown(), ['The Show']);
    });
    fireEvent.click(screen.getByRole('button', { name: 'The Show' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Requery/ }));

    await waitFor(() => {
      assert.deepEqual(requeried, [[31, 'requery']]);
    });
    db.close();
  });
}

function SearchProbe(): ReactElement {
  return <output data-testid="search">{useLocation().search}</output>;
}

test('view=grid lists through the catalog as tiles, and the toggle writes the URL both ways', async () => {
  const db = await freshDb();
  await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: 'Alpha Show', updatedAt: 10 })]);
  renderAt(
    <>
      <SearchProbe />
      <Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />
    </>,
    '/tv?view=grid',
  );
  await waitFor(() => { assert.ok(screen.getByRole('list')); });
  assert.equal(screen.getByRole('list').getAttribute('data-tile'), 'background', 'television browses by background');
  assert.ok(screen.getByRole('button', { name: /Alpha Show/ }));
  assert.ok(!screen.queryByRole('heading', { name: /Alpha Show/ }), 'no list card is rendered alongside the grid');

  fireEvent.click(screen.getByRole('radio', { name: 'List' }));
  await waitFor(() => { assert.ok(screen.getByRole('heading', { name: /Alpha Show/ })); });
  assert.ok(!screen.queryByRole('list'), 'the grid is gone');
  assert.equal(screen.getByTestId('search').textContent, '', 'List writes the URL without a view');

  fireEvent.click(screen.getByRole('radio', { name: 'Grid' }));
  await waitFor(() => { assert.ok(screen.getByRole('list')); });
  assert.ok(screen.getByRole('button', { name: /Alpha Show/ }), 'the tiles are back');
  assert.equal(screen.getByTestId('search').textContent, '?view=grid', 'Grid writes the URL with view=grid');
  db.close();
});

test('the grid honours the filter and the search, and a grid with nothing to show says what it is empty of', async () => {
  const db = await freshDb();
  await seedPickedAndNot(db);
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, '/tv?view=grid&filter=picked');
  await waitFor(() => { assert.equal(screen.getAllByRole('listitem').length, 2); });
  assert.ok(screen.getByRole('button', { name: /Gamma Show/ }));
  assert.ok(!screen.queryByRole('button', { name: /Beta Show/ }));
  cleanup();
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, '/tv?view=grid&filter=unpicked&q=zzz');
  await waitFor(() => { assert.ok(screen.getByText('Nothing matches "zzz" among unpicked items')); });
});

test('an item arriving while the page is scrolled is held behind an "N new" control until the operator is back at the top', async () => {
  const db = await freshDb();
  await seed(db, [
    mediaItem({ id: 1, pluginId: 'tv', title: 'Alpha Show', updatedAt: 10 }),
    mediaItem({ id: 2, pluginId: 'tv', title: 'Beta Show', updatedAt: 20 }),
  ]);
  // A fake window scroll: `scrollY` is what the hold reads, `scroll` is what
  // it listens for, and `scrollTo` is what the control calls.
  let y = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  const scrollTo = window.scrollTo;
  window.scrollTo = (): void => { y = 0; window.dispatchEvent(new Event('scroll')); };
  try {
    renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />);
    await waitFor(() => { assert.deepEqual(titlesShown(), ['Beta Show', 'Alpha Show']); });

    act(() => { y = 600; window.dispatchEvent(new Event('scroll')); });
    await seed(db, [mediaItem({ id: 3, pluginId: 'tv', title: 'Gamma Show', updatedAt: 30 })]);

    const control = await screen.findByRole('button', { name: '1 new' });
    assert.deepEqual(titlesShown(), ['Beta Show', 'Alpha Show'], 'nothing on screen moved');

    fireEvent.click(control);
    await waitFor(() => { assert.deepEqual(titlesShown(), ['Gamma Show', 'Beta Show', 'Alpha Show']); });
    assert.ok(!screen.queryByRole('button', { name: /new/ }), 'released, so the control is gone');
  } finally {
    window.scrollTo = scrollTo;
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0, writable: true });
  }
});
