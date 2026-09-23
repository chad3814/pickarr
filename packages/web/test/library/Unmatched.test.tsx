import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { LOOKUP_JSON_TOO_LARGE, type RssItemSyncRead } from '@pickarr/contract';
import { freshDb } from '../store/harness.ts';
import { gone } from '../dom.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribe, subscribeInserts, subscribeTable } from '../../src/store/notify.ts';
import { Unmatched, type UnmatchedSource } from '../../src/library/Unmatched.tsx';
import { PAGE_SIZE } from '../../src/library/useMediaItems.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that threw before its own call would leave a component mounted, still
 * subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch, the way `applyBatch`'s own tests do -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/**
 * One `rss_item` `upsert` op, with everything but the named fields
 * defaulted.
 *
 * **`upsert`, not `create`.** `sync/tail.ts`'s `tailSince` -- the loop a
 * running client actually receives live updates through -- never emits
 * `create` at all; only its backwards backfill walk does, for a row a
 * client may not hold yet. Building this with `create` would make a second
 * call for the same `id` a complete no-op (`store/apply.ts`: "`create` is a
 * no-op over a row already held"), silently refusing to apply the very
 * update the second test below drives.
 *
 * `resolution` defaults to `unresolved` -- `@pickarr/contract`'s
 * `Resolution` vocabulary, meaning "the name was not recognised", which is
 * the commonest reason a release is on this screen at all. An earlier
 * version of this helper defaulted it to `'1080p'`, a *video* resolution,
 * which is a different column on a different table; nothing rendered the
 * field then, so nothing noticed.
 */
function rssOp({
  id,
  filename,
  mediaItemId,
  updatedAt,
  feedId = 1,
  resolution = 'unresolved',
  resolutionDetail = null,
  lookupJson = null,
}: {
  id: number;
  filename: string;
  mediaItemId: number | null;
  updatedAt: number;
  feedId?: number;
  resolution?: string;
  resolutionDetail?: string | null;
  lookupJson?: string | null;
}): SyncOp {
  const value: RssItemSyncRead = {
    id,
    feedId,
    filename,
    createdAt: updatedAt,
    updatedAt,
    downloadType: 'torrent',
    mediaItemId,
    rankingScore: null,
    resolution,
    resolutionDetail,
    lookupJson,
    deliveredAt: null,
  };
  return { op: 'upsert', table: 'rss_item', id, value };
}

/** One `rss_feed` `upsert` op, matching `useFeedNames.test.tsx`'s own `feedOp`. */
function feedOp({ id, name }: { id: number; name: string }): SyncOp {
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
      url: 'https://tracker.example/rss',
    },
  };
}

/** The four reads/subscriptions `Unmatched` needs, bound straight to a raw database -- no `Store`, no sync loop, nothing this suite would have to stop afterwards. */
function sourceFor(db: IDBDatabase): UnmatchedSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribeInserts,
    subscribe,
    subscribeTable,
  };
}

/**
 * Every rendered release's filename, in the order the screen shows them.
 *
 * `queryAllByRole('article')`, not `getAllBy*`: the latter throws when
 * nothing matches, which is exactly the state the "drops off" test asserts
 * on.
 *
 * The filename is read off `h2 button span` rather than off the card's
 * text content, because a card that has a feed label announces and reads
 * as `<filename> <feed>` -- so text content alone could not tell a
 * filename from a filename with something appended to it. That is the same
 * element `CardHeading` documents web's stylesheet selecting.
 */
function filenamesShown(): string[] {
  return screen
    .queryAllByRole('article')
    .map((card) => card.querySelector('h2 button span')?.textContent ?? '');
}

/** Opens the one card on screen. Every expansion test below renders exactly one release. */
function expandTheOnlyCard(): void {
  fireEvent.click(screen.getByRole('button'));
}

test('lists releases whose mediaItemId is null, newest first', async () => {
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'older.mkv', mediaItemId: null, updatedAt: 10 }),
    rssOp({ id: 2, filename: 'matched.mkv', mediaItemId: 99, updatedAt: 20 }),
    rssOp({ id: 3, filename: 'newer.mkv', mediaItemId: null, updatedAt: 30 }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['newer.mkv', 'older.mkv'], 'matched.mkv is not here');
  });
});

test('a release renders as a card, with its filename as the title', async () => {
  // The screen was a bare `<ul>` of filenames. A card is what makes it
  // look like the rest of the application: `styles/library.css`'s bare
  // `article` rule gives it the same border, surface and padding a browse
  // card has, and `article h2 button` the same title treatment -- neither
  // of which a `<li>` could ever pick up.
  const db = await freshDb();
  await seed(db, [rssOp({ id: 1, filename: 'lonely.mkv', mediaItemId: null, updatedAt: 10 })]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.equal(screen.queryAllByRole('article').length, 1, 'one release, one card');
  });
  assert.ok(
    screen.getByRole('button', { name: 'lonely.mkv', expanded: false }),
    'the filename names the disclosure control, and the card starts closed',
  );
});

test('the feed that produced it is named at the right of the title', async () => {
  // The same `<small>` a browse card's trailing label uses, so web's
  // existing `article h2 button small` rule styles it -- asserted by
  // finding the element the stylesheet selects, not only the text.
  // Without that, appending the feed name to the headline would satisfy a
  // text query while rendering full-size undimmed text in the wrong place.
  const db = await freshDb();
  await seed(db, [
    feedOp({ id: 7, name: 'Nightly Tracker' }),
    rssOp({ id: 1, filename: 'from-a-feed.mkv', mediaItemId: null, updatedAt: 10, feedId: 7 }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['from-a-feed.mkv'], 'the card rendered');
  });
  // A second `waitFor`: `useFeedNames` reads `rss_feed` through its own
  // effect, so the label can land a tick after the card it hangs on.
  await waitFor(() => {
    const small = screen.getByRole('button').querySelector('small');
    assert.equal(small?.textContent, 'Nightly Tracker', 'the feed name is in its own <small>');
  });
  assert.ok(
    screen.getByRole('button', { name: 'from-a-feed.mkv Nightly Tracker' }),
    'and it is part of what the control announces, since it is visible text inside it',
  );
});

test('a release whose feed the replica has not got renders no trailing label', async () => {
  // `useFeedNames` answers `undefined` for an id no `rss_feed` row claims
  // -- a real state, not a hypothetical: the feeds table replicates
  // separately, so a release can land before its feed does. An empty
  // `<small>` here would be a flex item with no content, moving the title
  // line for nothing.
  const db = await freshDb();
  await seed(db, [rssOp({ id: 1, filename: 'orphan.mkv', mediaItemId: null, updatedAt: 10, feedId: 404 })]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['orphan.mkv']);
  });
  assert.ok(
    screen.getByRole('button').querySelector('small') === null,
    'no feed, no element',
  );
  assert.ok(screen.getByRole('button', { name: 'orphan.mkv' }), 'and the name is the filename alone');
});

test('a feed named with the empty string renders no trailing label', async () => {
  // Reachable, not defensive: `POST /api/feeds`'s body guard checks
  // `typeof name === 'string'` and `addFeed` refuses only on the plugin,
  // the transport, the poll interval and a duplicate url. The settings
  // form's `required` is a browser constraint an API caller does not go
  // through, so `''` really can reach the replica.
  //
  // `CardHeading`'s gate is `trailing !== undefined`, so an unfiltered
  // `''` renders an empty `<small>` -- a flex item with no content, which
  // moves the title line for nothing. Neither shared component makes this
  // call, so `feedLabel` does.
  const db = await freshDb();
  await seed(db, [
    feedOp({ id: 7, name: '' }),
    rssOp({ id: 1, filename: 'nameless-feed.mkv', mediaItemId: null, updatedAt: 10, feedId: 7 }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['nameless-feed.mkv']);
  });
  assert.ok(
    screen.getByRole('button').querySelector('small') === null,
    'an empty name is no name, and renders no element',
  );
  assert.ok(screen.getByRole('button', { name: 'nameless-feed.mkv' }), 'nor does it change what the control is called');
});

test('an empty detail sentence renders no label standing over nothing', async () => {
  // `resolutionDetail` is `string | null` on the wire and the host writes
  // `envelope.refusal` straight into it on the refused branch, gated on
  // `!== null` -- so a service answering with an empty refusal string
  // stores `''`. That is the state `textOf`'s empty-string exclusion is
  // for, and it is the one of its three guards that no other test reaches.
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'blank-detail.mkv', mediaItemId: null, updatedAt: 10, resolutionDetail: '' }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);
  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['blank-detail.mkv']);
  });

  expandTheOnlyCard();

  assert.ok(screen.getByText('unresolved'), 'the card did open');
  assert.ok(gone('Detail'), 'and the pair with nothing in it is absent entirely, not rendered empty');
});

test('collapsed, a card shows no detail and no JSON', async () => {
  // `useExpansion` starts closed, and the body is gated on it. Without
  // this, a card that rendered its body unconditionally would pass every
  // other test here.
  const db = await freshDb();
  await seed(db, [
    rssOp({
      id: 1,
      filename: 'closed.mkv',
      mediaItemId: null,
      updatedAt: 10,
      resolutionDetail: 'no title matched',
      lookupJson: '{"query":"closed"}',
    }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['closed.mkv']);
  });
  assert.ok(gone('no title matched'), 'the detail sentence is behind the disclosure');
  assert.ok(document.querySelector('pre') === null, 'and so is the answer');
});

test('expanded, a card says why the release is unmatched', async () => {
  // `resolution` and `resolutionDetail`, which the host has always sent
  // and nothing has ever rendered.
  const db = await freshDb();
  await seed(db, [
    rssOp({
      id: 1,
      filename: 'why.mkv',
      mediaItemId: null,
      updatedAt: 10,
      resolution: 'refused',
      resolutionDetail: 'identified as a subtitle, not a film',
    }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);
  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['why.mkv']);
  });

  expandTheOnlyCard();

  assert.ok(screen.getByText('refused'), 'the state the host recorded');
  assert.ok(screen.getByText('identified as a subtitle, not a film'), 'and the sentence it recorded with it');
});

test('expanded, a card shows the lookup answer', async () => {
  const db = await freshDb();
  const answer = '{"query":"Some.Release.2024","results":[]}';
  await seed(db, [
    rssOp({ id: 1, filename: 'answered.mkv', mediaItemId: null, updatedAt: 10, lookupJson: answer }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);
  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['answered.mkv']);
  });

  expandTheOnlyCard();

  const block = document.querySelector('pre');
  assert.ok(block !== null, 'the answer renders in the <pre> the stylesheet selects');
  assert.equal(block.textContent, answer, 'verbatim: it is what the service actually said');
});

test('a release with no stored answer expands without an empty block', async () => {
  // `lookupJson` is null for a release whose lookup never ran. An empty
  // `<pre>` is a bordered box containing nothing, which reads as a bug.
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'unasked.mkv', mediaItemId: null, updatedAt: 10, resolution: 'pending' }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);
  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['unasked.mkv']);
  });

  expandTheOnlyCard();

  assert.ok(screen.getByText('pending'), 'the card did open -- the state line is there');
  assert.ok(document.querySelector('pre') === null, 'and no empty block came with it');
  assert.ok(gone('Lookup answer'), 'nor a label standing over nothing');
});

/**
 * One `rss_item` `upsert` op in the shape the replica held **before**
 * `lookupJson` was on the wire: no `lookupJson` key at all, and no
 * `resolution` either.
 *
 * **Hand-built, and deliberately not typed `RssItemSyncRead`.** That is
 * the whole point of it existing. `CLAUDE.md`: "a test whose fixtures all
 * come from the code under test cannot see that code's history ... When
 * behaviour changes and stored data does not, hand-build a fixture in the
 * old shape." Every other fixture in this file goes through `rssOp`,
 * which satisfies the *current* interface and therefore always supplies
 * both fields -- so before this existed, `textOf`'s tolerance and the
 * `not recorded` fallback were unreachable by any test, and the longest
 * justification comment in `Unmatched.tsx` was unproven. Proved by
 * mutation: with only `rssOp` fixtures, reading those fields straight off
 * the narrowed type left the whole suite green.
 *
 * `SyncOp.value` is `unknown`, so this needs no cast and no partial type
 * -- the wire shape is exactly what a replica holds, and a replica
 * outlives the build that wrote it.
 *
 * `resolution` is the second omission rather than the only one because
 * the two are tolerated by different code: `textOf` for `lookupJson`,
 * and `?? 'not recorded'` at the render site for `resolution`.
 */
function legacyRssOp({ id, filename, updatedAt }: { id: number; filename: string; updatedAt: number }): SyncOp {
  return {
    op: 'upsert',
    table: 'rss_item',
    id,
    value: {
      id,
      feedId: 1,
      filename,
      createdAt: updatedAt,
      updatedAt,
      downloadType: 'torrent',
      mediaItemId: null,
      rankingScore: null,
      resolutionDetail: null,
      deliveredAt: null,
    },
  };
}

test('a release stored before the lookup answer existed still lists, and still opens', async () => {
  // The state `textOf` and the `not recorded` fallback were written for,
  // and until this test the only evidence for it was prose. A replica
  // persists across client builds and neither `SCHEMA_VERSION` nor the
  // generation token fires on a wire-shape change (`store/gather.ts`), so
  // a client that was running before `lookupJson` shipped holds rows
  // without it -- and the host does not rewrite a row that has not
  // otherwise changed, so the upgrade never refreshes them.
  //
  // The listing half is the more important of the two assertions. The
  // alternative design -- widening `isRssItem` to demand the new fields --
  // would make such a release *vanish* from the screen, which is the exact
  // failure this screen exists to prevent, and it would be invisible to
  // every other test in this file.
  const db = await freshDb();
  await seed(db, [legacyRssOp({ id: 1, filename: 'from-an-older-build.mkv', updatedAt: 10 })]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['from-an-older-build.mkv'], 'an older row is still an unmatched release');
  });

  expandTheOnlyCard();

  assert.ok(screen.getByText('not recorded'), 'the state line says what it does not have');
  assert.ok(document.querySelector('pre') === null, 'and no empty block stands in for the answer it never held');
  assert.ok(gone('Lookup answer'), 'nor a label over nothing');
});

test('an answer too large to store says so, rather than rendering the marker JSON', async () => {
  // The marker is an implementation detail of the column, not a sentence
  // for an operator.
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'huge.mkv', mediaItemId: null, updatedAt: 10, lookupJson: LOOKUP_JSON_TOO_LARGE }),
  ]);

  render(<Unmatched source={sourceFor(db)} />);
  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['huge.mkv']);
  });

  expandTheOnlyCard();

  assert.ok(gone(LOOKUP_JSON_TOO_LARGE), 'the marker itself is never shown');
  assert.ok(document.querySelector('pre') === null, 'and it is not dressed up as an answer either');
  assert.ok(screen.getByText(/too large to keep/i), 'the operator gets a sentence instead');
});

test('a release that has since been matched drops off the list', async () => {
  const db = await freshDb();
  await seed(db, [rssOp({ id: 1, filename: 'pending.mkv', mediaItemId: null, updatedAt: 10 })]);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['pending.mkv']);
  });

  // A lookup finished: the same row arrives again with a mediaItemId, as a
  // single in-place `upsert` -- exactly what `sync/tail.ts`'s `tailSince`
  // actually sends for a live match, and exactly the shape `subscribeInserts`
  // alone cannot see (`Unmatched.tsx`'s own docblock). This is provable now
  // that `Unmatched` also subscribes per-row through `source.subscribe`:
  // `store/notify.ts`'s `touched` channel fires on *any* change to a row it
  // already holds, `upsert` included, which is what wakes this screen to
  // re-read and drop the now-matched release.
  await seed(db, [rssOp({ id: 1, filename: 'pending.mkv', mediaItemId: 99, updatedAt: 20 })]);

  await waitFor(() => {
    assert.equal(filenamesShown().length, 0, 'a matched release leaves this screen');
  });
});

test('an empty list says nothing is unmatched, rather than rendering blank', async () => {
  const db = await freshDb();

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.ok(screen.getByText(/everything has been matched/i));
  });
});

test('a fresh unmatched release appears without a reload', async () => {
  const db = await freshDb();

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.ok(screen.getByText(/everything has been matched/i));
  });

  await seed(db, [rssOp({ id: 1, filename: 'arrived.mkv', mediaItemId: null, updatedAt: 10 })]);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['arrived.mkv'], 'subscribeInserts woke the screen and it re-read the table');
  });
});

test('no fetch is issued while listing', async () => {
  // Lists come from the replica only (Global Constraint). Assert on a call
  // count rather than on what rendered: a screen that quietly fetched and
  // got nothing back looks identical to one that correctly read an empty
  // replica.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('no fetch may be issued while listing');
  };
  try {
    const db = await freshDb();
    await seed(db, [
      feedOp({ id: 1, name: 'Nightly Tracker' }),
      rssOp({ id: 1, filename: 'local.mkv', mediaItemId: null, updatedAt: 10 }),
    ]);

    render(<Unmatched source={sourceFor(db)} />);

    await waitFor(() => {
      assert.deepEqual(filenamesShown(), ['local.mkv']);
    });
    // The feed name is part of this claim now: `useFeedNames` reads
    // `rss_feed` from the replica too, and a hook that resolved a feed id
    // over the network would be invisible to every other test here.
    await waitFor(() => {
      assert.equal(screen.getByRole('button').querySelector('small')?.textContent, 'Nightly Tracker');
    });
    assert.equal(calls, 0, 'the replica answered without the network');
  } finally {
    globalThis.fetch = original;
  }
});

/** The filename the cost test below gives release `id`. */
function costFixtureFilename(id: number): string {
  return `release-${String(id)}.mkv`;
}

/**
 * Polls until `read()` has stopped changing across `stable` consecutive
 * macrotasks, or `limit` of them have passed, and answers its final value. A
 * screen whose every wake starts another walk has no quiet point to
 * `waitFor`, so the number the test below asserts on is only knowable once
 * the screen has actually stopped reading.
 */
async function quiesce(read: () => number, stable = 60, limit = 4000): Promise<number> {
  let last = read();
  let unchanged = 0;
  for (let tick = 0; tick < limit && unchanged < stable; tick += 1) {
    // eslint-disable-next-line no-await-in-loop -- each tick has to land before the next is scheduled; that is the whole of what "has stopped" means here
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    const now = read();
    unchanged = now === last ? unchanged + 1 : 0;
    last = now;
  }
  return last;
}

test('a batch that matches every listed release costs one re-read, not one per listed row', async () => {
  // Cost, asserted directly. Every other test in this file checks what
  // finally rendered, and a screen that re-read the whole table once per
  // listed row renders exactly what one that re-read it once renders --
  // which is why the fan-out survived a fix round aimed at this very screen
  // (whole-branch review §1: 400 rows with 24 listed cost 408 full-table
  // page reads for a single batch, because `store/notify.ts`'s `emit` fires
  // `fireRow` once per touched row and each fire started its own walk).
  //
  // A walk is counted by its first read of `rss_item`, the one carrying no
  // `from`: every walk starts with exactly one of those and resumes with a
  // `from` thereafter, so counting them needs nothing of `readUnmatched`'s
  // internals. Scoped to `rss_item` because `useFeedNames` reads `rss_feed`
  // through this same `listByTable` and would otherwise be counted as a
  // walk of the table this test is measuring.
  const db = await freshDb();
  const total = 400;
  const listed = 24;
  const seedOps: SyncOp[] = [];
  for (let id = 1; id <= total; id += 1) {
    // The newest `listed` rows are the unmatched ones: the short tail this
    // screen exists to show, and exactly one screenful of it.
    seedOps.push(rssOp({
      id,
      filename: costFixtureFilename(id),
      mediaItemId: id > total - listed ? null : 7,
      updatedAt: id,
    }));
  }
  await seed(db, seedOps);

  const real = sourceFor(db);
  let walks = 0;
  let pageReads = 0;
  const source: UnmatchedSource = {
    ...real,
    listByTable: (table, opts) => {
      if (table === 'rss_item') {
        pageReads += 1;
        if (opts.from === undefined) walks += 1;
      }
      return real.listByTable(table, opts);
    },
  };

  render(<Unmatched source={source} />);
  await waitFor(() => {
    assert.equal(filenamesShown().length, listed, 'one screenful of unmatched releases');
  });
  const walksAfterFirstRender = walks;

  // A lookup batch matches every listed release at once -- the exact
  // transition this screen exists to show. `emit` runs all `listed` row
  // subscriptions synchronously before `applyBatch` resolves, so the
  // fan-out is already fully visible the moment this `await` returns.
  const matched: SyncOp[] = [];
  for (let id = total - listed + 1; id <= total; id += 1) {
    matched.push(rssOp({ id, filename: costFixtureFilename(id), mediaItemId: 7, updatedAt: id + total }));
  }
  await seed(db, matched);

  assert.equal(walks - walksAfterFirstRender, 1, 'the batch started one walk, not one per listed row');

  await waitFor(() => {
    assert.equal(filenamesShown().length, 0, 'every listed release left the screen');
  });
  const settled = await quiesce(() => walks) - walksAfterFirstRender;
  assert.ok(settled <= 2, `one batch settles in at most two walks, not ${String(settled)}`);
  assert.ok(pageReads > 0, 'and the screen really did read the replica');
});

test('a second page is read on demand, and the first page is kept', async () => {
  const db = await freshDb();
  const total = 30;
  const seedOps: SyncOp[] = [];
  for (let id = 1; id <= total; id += 1) {
    seedOps.push(rssOp({ id, filename: costFixtureFilename(id), mediaItemId: null, updatedAt: id }));
  }
  await seed(db, seedOps);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(
      filenamesShown(),
      Array.from({ length: PAGE_SIZE }, (_, i) => costFixtureFilename(total - i)),
      'one screenful, newest first',
    );
  });

  fireEvent.click(screen.getByRole('button', { name: /load more/i }));

  await waitFor(() => {
    assert.deepEqual(
      filenamesShown(),
      Array.from({ length: total }, (_, i) => costFixtureFilename(total - i)),
      'the second page is appended, and the first screenful is still exactly where it was',
    );
  });
});

test('the sentinel and the button both disappear once the table is exhausted', async () => {
  // Zero is an answer: appending a page of zero new rows still has to flip
  // `done`, and "no more to load" must not look like "not loaded yet" --
  // which is why this seeds exactly one screenful rather than fewer.
  // `readUnmatched`'s exhaustion signal is a raw page shorter than
  // `PAGE_SIZE`, not a row count, so a first page that exactly fills one
  // cannot yet tell there is nothing behind it, and both controls start out
  // offered here.
  const db = await freshDb();
  const seedOps: SyncOp[] = [];
  for (let id = 1; id <= PAGE_SIZE; id += 1) {
    seedOps.push(rssOp({ id, filename: costFixtureFilename(id), mediaItemId: null, updatedAt: id }));
  }
  await seed(db, seedOps);

  render(<Unmatched source={sourceFor(db)} />);

  await waitFor(() => {
    assert.equal(filenamesShown().length, PAGE_SIZE, 'one screenful, exactly filling the first raw page');
  });
  assert.ok(screen.getByTestId('load-more-sentinel'), 'more may exist, so the sentinel is offered');
  assert.ok(screen.getByRole('button', { name: /load more/i }), 'and so is the button');

  fireEvent.click(screen.getByRole('button', { name: /load more/i }));

  await waitFor(() => {
    assert.ok(!screen.queryByTestId('load-more-sentinel'), 'the next page came back empty, and now the sentinel is gone');
  });
  assert.ok(gone(/load more/i), 'the button too -- neither looks like "not loaded", both look like "no more"');
  assert.equal(filenamesShown().length, PAGE_SIZE, 'and nothing already shown was lost in the process');
});

test('a wake resets the walk rather than resuming a stale cursor', async () => {
  // **The trap this whole task walks into.** `cursorRef` names a position
  // in the raw table, taken from a page read before the batch seeded below
  // committed. `loadMore` resumes that cursor; a wake never does
  // (`makeRefresh`'s own docblock) -- it re-reads the whole screen from the
  // top instead. If a wake lands while `loadMore`'s own resumption is still
  // in flight and that resumption is allowed to land anyway, its page gets
  // appended to rows the wake already replaced -- which can skip a row the
  // fresh read never reached, or repeat one it already showed, and neither
  // failure looks like one.
  const db = await freshDb();
  const total = 26;
  const seedOps: SyncOp[] = [];
  for (let id = 1; id <= total; id += 1) {
    seedOps.push(rssOp({ id, filename: costFixtureFilename(id), mediaItemId: null, updatedAt: id }));
  }
  await seed(db, seedOps);

  const real = sourceFor(db);
  let releaseStalePage: (() => void) | undefined;
  let held = false;
  const source: UnmatchedSource = {
    ...real,
    // Only the paging call `loadMore` is about to issue names a `from` at
    // all -- the mount's own first read and the wake's own re-read both
    // omit it (`readUnmatched`'s own doc) -- so holding exactly the first
    // such call isolates the race without touching anything else this
    // screen reads. `held` lets every later paging call through normally,
    // so the walk this test provokes at its own end is not itself held.
    listByTable: (table, opts) => {
      if (table === 'rss_item' && opts.from !== undefined && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseStalePage = () => { resolve(real.listByTable(table, opts)); };
        });
      }
      return real.listByTable(table, opts);
    },
  };

  render(<Unmatched source={source} />);
  await waitFor(() => {
    assert.equal(filenamesShown().length, PAGE_SIZE, 'one screenful of the first 26 releases');
  });

  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.ok(releaseStalePage !== undefined, 'the second page was requested and is being held open');
  });

  // A fresh release lands while that page is still in flight -- the same
  // shape a live feed poll delivers, and exactly what wakes this screen
  // through `subscribeInserts`.
  await seed(db, [rssOp({ id: 27, filename: costFixtureFilename(27), mediaItemId: null, updatedAt: 100 })]);

  const freshWindow = Array.from({ length: PAGE_SIZE }, (_, i) => costFixtureFilename(27 - i));
  await waitFor(() => {
    assert.deepEqual(filenamesShown(), freshWindow, 'the wake re-read from the top and replaced the whole window');
  });

  // Now let the stale page resolve. Its cursor still names a real boundary
  // in the table -- IndexedDB does not invalidate it -- but `rows` is not
  // the array it was taken against any more.
  releaseStalePage?.();
  const settledLength = await quiesce(() => filenamesShown().length);

  assert.equal(settledLength, PAGE_SIZE, 'the stale page was discarded, not appended');
  assert.deepEqual(filenamesShown(), freshWindow, 'what is shown is exactly the fresh window, unchanged by the stale answer');
  assert.ok(
    screen.getByRole('button', { name: /load more/i }),
    'there is still more to load -- the stale page\'s exhaustion was discarded too',
  );

  // The walk still works correctly from here: the next `loadMore` resumes
  // from the *fresh* cursor and reaches every row the wake's window left
  // out, rather than the ones the discarded stale page would have.
  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.equal(filenamesShown().length, total + 1, 'every release, including the ones only the fresh cursor could reach');
  });
  assert.ok(!screen.queryByRole('button', { name: /load more/i }), 'and now the table really is exhausted');
});

test('paging does not re-walk the pages already read', async () => {
  // Counted as calls to `listByTable`, because the cost is the reason the
  // cursor exists at all (this file's own docblock: no index on
  // "mediaItemId is null", so every read walks the raw table). A design
  // that answered `loadMore` by growing a target count and re-reading the
  // whole accumulated window from the top -- a plausible-looking port of
  // `useMediaItems.ts`'s own `windowSizeRef` approach -- would pay for the
  // newest screenful's own raw page a second time on every `loadMore`; this
  // fixture makes that concrete rather than asymptotic.
  const db = await freshDb();
  const oldestUnmatched = PAGE_SIZE; // ids 1..24: reachable only by loadMore, past the gap below
  const matchedGap = PAGE_SIZE; // ids 25..48: a whole raw page every walk that reaches the oldest block must pass through
  const newestUnmatched = PAGE_SIZE; // ids 49..72: exactly the first screenful, needing no skip at all
  const total = oldestUnmatched + matchedGap + newestUnmatched;

  const seedOps: SyncOp[] = [];
  for (let id = 1; id <= total; id += 1) {
    const mediaItemId = id > oldestUnmatched && id <= oldestUnmatched + matchedGap ? 7 : null;
    seedOps.push(rssOp({ id, filename: costFixtureFilename(id), mediaItemId, updatedAt: id }));
  }
  await seed(db, seedOps);

  const real = sourceFor(db);
  let pageReads = 0;
  const source: UnmatchedSource = {
    ...real,
    listByTable: (table, opts) => {
      if (table === 'rss_item') pageReads += 1;
      return real.listByTable(table, opts);
    },
  };

  render(<Unmatched source={source} />);
  await waitFor(() => {
    assert.equal(filenamesShown().length, newestUnmatched, 'one screenful -- exactly the newest, unmatched block');
  });
  const readsForFirstPage = pageReads;
  assert.equal(readsForFirstPage, 1, 'the newest block alone fills a whole raw page, so one read is enough');

  fireEvent.click(screen.getByRole('button', { name: /load more/i }));
  await waitFor(() => {
    assert.equal(
      filenamesShown().length,
      oldestUnmatched + newestUnmatched,
      'the oldest block is now shown too, on top of the first screenful',
    );
  });

  // Reaching the oldest block costs exactly two more raw pages: one to
  // skip the matched gap, one to collect the oldest block itself. A design
  // that re-walked the newest block's own page to get there would make
  // this three instead of two -- the exact page this test's first read
  // already paid for.
  assert.equal(
    pageReads - readsForFirstPage,
    2,
    'loadMore paid for the gap and the next block, and nothing it already had',
  );
});
