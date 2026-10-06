import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import { LOOKUP_JSON_TOO_LARGE, type RssItemSyncRead } from '@pickarr/contract';
import { freshDb } from '../store/harness.ts';
import { gone } from '../dom.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { byRssItem, listByTable } from '../../src/store/rows.ts';
import { subscribe, subscribeInserts, subscribeTable } from '../../src/store/notify.ts';
import { Unmatched, type UnmatchedSource } from '../../src/library/Unmatched.tsx';
import type { IdentifySubmit, PickSubmit } from '@pickarr/plugin-ui';
import type { RetrySubmit } from '../../src/library/postRetry.ts';
import { RETRY_ALL_REFUSAL_MESSAGES, type RetryAllSubmit } from '../../src/library/postRetryAll.ts';
import { PAGE_SIZE } from '../../src/library/useMediaItems.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that threw before its own call would leave a component mounted, still
 * subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/**
 * A `retry` that fails the test if it is ever called. Spelled out at every
 * render rather than defaulted inside the component, which is the whole
 * reason the prop is required: a default that performed network I/O would
 * give a test that forgot it a real `fetch` under happy-dom, which hangs
 * rather than failing. The retry tests at the end of this file pass their
 * own.
 */
/** A `pick` that fails the test if it is ever used, for the same reason `neverRetries` does. */
const neverPicks: PickSubmit = () => {
  assert.fail('this test must not pick');
};

const neverRetriesAll: RetryAllSubmit = () => {
  throw new Error('retryAll: not used by this test');
};

const neverRetries: RetrySubmit = () => {
  assert.fail('this test must not retry');
};

/** An `identify` that fails the test if it is ever used, for the same reason `neverRetries` does. */
const neverIdentifies: IdentifySubmit = {
  identify: () => {
    assert.fail('this test must not identify');
  },
  suggest: () => {
    assert.fail('this test must not suggest');
  },
};

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
 * `lookupState` defaults to `unresolved` -- `@pickarr/contract`'s
 * `LookupState` vocabulary, meaning "the name was not recognised", which is
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
  lookupState = 'unresolved',
  lookupStateDetail = null,
  lookupJson = null,
}: {
  id: number;
  filename: string;
  mediaItemId: number | null;
  updatedAt: number;
  feedId?: number;
  lookupState?: string;
  lookupStateDetail?: string | null;
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
    lookupState,
    lookupStateDetail,
    videoResolution: null,
    lookupJson,
    deliveredAt: null,
  };
  return { op: 'upsert', table: 'rss_item', id, value };
}

/** One `rss_feed` `upsert` op, matching `useFeedNames.test.tsx`'s own `feedOp`. */
function feedOp({ id, name, pluginId = 'tv' }: { id: number; name: string; pluginId?: string }): SyncOp {
  return {
    op: 'upsert',
    table: 'rss_feed',
    id,
    value: {
      id,
      pluginId,
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
    byRssItem: (rssItemId) => byRssItem(db, rssItemId),
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
/** The one card's heading button -- not its Pick button, which sits beside it since the pick slice. */
function headingButton(): HTMLElement {
  return within(screen.getByRole('heading', { level: 2 })).getByRole('button');
}

function expandTheOnlyCard(): void {
  fireEvent.click(headingButton());
}

/** The one card's heading button once the card has rendered. A filename regex would now also match `Pick <filename>`. */
async function findHeadingButton(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2 });
  return within(heading).getByRole('button');
}

test('lists releases whose mediaItemId is null, newest first', async () => {
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'older.mkv', mediaItemId: null, updatedAt: 10 }),
    rssOp({ id: 2, filename: 'matched.mkv', mediaItemId: 99, updatedAt: 20 }),
    rssOp({ id: 3, filename: 'newer.mkv', mediaItemId: null, updatedAt: 30 }),
  ]);

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['from-a-feed.mkv'], 'the card rendered');
  });
  // A second `waitFor`: `useFeedNames` reads `rss_feed` through its own
  // effect, so the label can land a tick after the card it hangs on.
  await waitFor(() => {
    const small = headingButton().querySelector('small');
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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['orphan.mkv']);
  });
  assert.ok(
    headingButton().querySelector('small') === null,
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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['nameless-feed.mkv']);
  });
  assert.ok(
    headingButton().querySelector('small') === null,
    'an empty name is no name, and renders no element',
  );
  assert.ok(screen.getByRole('button', { name: 'nameless-feed.mkv' }), 'nor does it change what the control is called');
});

test('an empty detail sentence renders no label standing over nothing', async () => {
  // `lookupStateDetail` is `string | null` on the wire and the host writes
  // `envelope.refusal` straight into it on the refused branch, gated on
  // `!== null` -- so a service answering with an empty refusal string
  // stores `''`. That is the state `textOf`'s empty-string exclusion is
  // for, and it is the one of its three guards that no other test reaches.
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'blank-detail.mkv', mediaItemId: null, updatedAt: 10, lookupStateDetail: '' }),
  ]);

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
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
      lookupStateDetail: 'no title matched',
      lookupJson: '{"query":"closed"}',
    }),
  ]);

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

  await waitFor(() => {
    assert.deepEqual(filenamesShown(), ['closed.mkv']);
  });
  assert.ok(gone('no title matched'), 'the detail sentence is behind the disclosure');
  assert.ok(document.querySelector('pre') === null, 'and so is the answer');
});

test('expanded, a card says why the release is unmatched', async () => {
  // `lookupState` and `lookupStateDetail`, which the host has always sent
  // and nothing has ever rendered.
  const db = await freshDb();
  await seed(db, [
    rssOp({
      id: 1,
      filename: 'why.mkv',
      mediaItemId: null,
      updatedAt: 10,
      lookupState: 'refused',
      lookupStateDetail: 'identified as a subtitle, not a film',
    }),
  ]);

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
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
    rssOp({ id: 1, filename: 'unasked.mkv', mediaItemId: null, updatedAt: 10, lookupState: 'pending' }),
  ]);

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
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
 * `lookupState` either.
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
 * `lookupState` is the second omission rather than the only one because
 * the two are tolerated by different code: `textOf` for `lookupJson`,
 * and `?? 'not recorded'` at the render site for `lookupState`.
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
      lookupStateDetail: null,
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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

  await waitFor(() => {
    assert.ok(screen.getByText(/everything has been matched/i));
  });
});

test('a fresh unmatched release appears without a reload', async () => {
  const db = await freshDb();

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

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

    render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

    await waitFor(() => {
      assert.deepEqual(filenamesShown(), ['local.mkv']);
    });
    // The feed name is part of this claim now: `useFeedNames` reads
    // `rss_feed` from the replica too, and a hook that resolved a feed id
    // over the network would be invisible to every other test here.
    await waitFor(() => {
      assert.equal(headingButton().querySelector('small')?.textContent, 'Nightly Tracker');
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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={source} />);
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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={source} />);
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

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={source} />);
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

/** Opens the one card on screen and returns its Retry button. */
async function openAndFindRetry(): Promise<HTMLButtonElement> {
  const heading = await findHeadingButton();
  fireEvent.click(heading);
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' });
}

test('an expanded card offers a retry, and asks for that release by id', async () => {
  const db = await freshDb();
  await seed(db, [rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 10 })]);
  const asked: number[] = [];
  const retry: RetrySubmit = (rssItemId) => {
    asked.push(rssItemId);
    return Promise.resolve({ accepted: true });
  };

  render(<Unmatched pick={neverPicks} retry={retry} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  fireEvent.click(await openAndFindRetry());

  // Spelled literally rather than read back off the seeded row: a card
  // that passed the wrong release's id would still look right on screen.
  await waitFor(() => {
    assert.deepEqual(asked, [7]);
  });
});

test('a collapsed card offers no retry', async () => {
  // The control lives in the body, so the body gate is what hides it.
  // Without this, a retry rendered unconditionally would put one button
  // per release on a screen that may list two dozen.
  const db = await freshDb();
  await seed(db, [rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 10 })]);

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);

  await findHeadingButton();
  assert.ok(!screen.queryByRole('button', { name: 'Retry' }), 'nothing to retry until the card is open');
});

test('an accepted retry stays pending until the row actually changes', async () => {
  // **The property this button exists to get right.** The host answers 202
  // as soon as it has enqueued a job -- the lookup service has not been
  // asked yet -- so clearing on the response re-enables the control within
  // milliseconds of a click whose work has not started. `ReleaseList`
  // measured exactly that: enabled again at 33ms, the answer arriving at
  // 2934ms.
  //
  // **The submit is resolved on demand, and that is not ceremony.** The
  // obvious version of this test -- resolve immediately, `waitFor` the
  // disabled button, then push a newer row -- passes against a component
  // that clears on the 202, and it was written that way first and
  // measured surviving that exact mutant. `setAwaitingSince` runs before
  // the `await`, so even the broken version renders `Retrying...` for one
  // tick and a polling `waitFor` can catch it. The assertion has to land
  // *after* the submit has settled and *before* the row moves, which
  // means the test has to own when the submit settles.
  const db = await freshDb();
  await seed(db, [rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 10 })]);
  let accept = (): void => {};
  const settled = new Promise<void>((resolve) => { accept = resolve; });
  const retry: RetrySubmit = () => settled.then(() => ({ accepted: true as const }));

  render(<Unmatched pick={neverPicks} retry={retry} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  fireEvent.click(await openAndFindRetry());

  await waitFor(() => {
    assert.ok(screen.getByRole<HTMLButtonElement>('button', { name: 'Retrying…' }).disabled);
  });

  // The 202 lands here, and nothing else does. `act` flushes the
  // continuation and every render it schedules, so what is asserted next
  // is the settled state after the response rather than a race with it.
  await act(async () => {
    accept();
    await settled;
  });
  assert.ok(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Retrying…' }).disabled,
    'still pending after the host said yes -- the work has not started yet',
  );

  // The same release, written again by the lookup path -- a *later*
  // `updatedAt` and, deliberately, the very same lookup state. Watching
  // `lookupState` instead would miss this, and a retry that lands on the
  // same answer is the commonest outcome of all.
  await seed(db, [rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 20 })]);

  await waitFor(() => {
    assert.ok(!screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' }).disabled);
  });
});

test('a refused retry says why, in this page’s own words, and re-enables', async () => {
  const db = await freshDb();
  await seed(db, [rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 10 })]);
  const retry: RetrySubmit = () => Promise.resolve({ refusal: 'already-matched' });

  render(<Unmatched pick={neverPicks} retry={retry} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  fireEvent.click(await openAndFindRetry());

  // The literal sentence, not `RETRY_REFUSAL_MESSAGES['already-matched']`:
  // an expectation read out of the map under test cannot see that map
  // change (`CLAUDE.md`).
  await screen.findByText('That release has already been identified — reload to see what it matched.');
  assert.ok(
    !screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' }).disabled,
    'a refusal re-enables, because nothing is in flight',
  );
});

test('a refusal is announced, not merely printed', async () => {
  // The sentence is the whole point of the control failing, so it has to
  // reach a screen reader too -- real text in a real `role="alert"`, never
  // an `aria-label` on an empty element (`CLAUDE.md`'s longest hazard).
  const db = await freshDb();
  await seed(db, [rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 10 })]);
  const retry: RetrySubmit = () => Promise.resolve({ refusal: 'offline' });

  render(<Unmatched pick={neverPicks} retry={retry} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  fireEvent.click(await openAndFindRetry());

  const alert = await screen.findByRole('alert');
  assert.equal(
    alert.textContent,
    'Could not reach Pickarr. Check your connection and try again.',
    'the announced string and the visible one are the same string',
  );
});

test('Edit appears beside Retry only once the feed row is known', async () => {
  // The release is seeded first and its feed second: the feeds table
  // replicates separately, and the form needs the feed's plugin id, so
  // offering Edit before the feed arrives would open a form for no plugin.
  const db = await freshDb();
  await seed(db, [rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 10, feedId: 3 })]);

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  await openAndFindRetry();
  assert.ok(!screen.queryByRole('button', { name: 'Edit' }), 'no feed row, so no Edit');

  await seed(db, [feedOp({ id: 3, name: 'Nightly Tracker' })]);

  await screen.findByRole('button', { name: 'Edit' });
  assert.ok(screen.getByRole('button', { name: 'Retry' }), 'Retry is still there');
});

test('Edit opens the combobox for the feed’s plugin, and Cancel puts the buttons back', async () => {
  const db = await freshDb();
  await seed(db, [
    feedOp({ id: 3, name: 'Nightly Tracker', pluginId: 'movies' }),
    rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 10, feedId: 3 }),
  ]);
  const suggested: [string, string][] = [];
  const identify: IdentifySubmit = {
    identify: () => Promise.resolve({ accepted: true }),
    suggest: (pluginId, term) => {
      suggested.push([pluginId, term]);
      return Promise.resolve([]);
    },
  };

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={identify} source={sourceFor(db)} />);
  fireEvent.click(await screen.findByRole('button', { name: /^unknown\.mkv/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

  const combobox = screen.getByRole('combobox', { name: 'Title' });
  assert.ok(!screen.queryByRole('button', { name: 'Retry' }), 'the form replaces the pair');
  fireEvent.change(combobox, { target: { value: 'Dune' } });
  await waitFor(() => {
    assert.deepEqual(suggested, [['movies', 'Dune']]);
  });

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.ok(screen.getByRole('button', { name: 'Retry' }));
  assert.ok(screen.getByRole('button', { name: 'Edit' }));
});

test('saving an edit posts it for that release and holds Edit disabled until the row moves', async () => {
  const db = await freshDb();
  await seed(db, [
    feedOp({ id: 3, name: 'Nightly Tracker' }),
    rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 10, feedId: 3 }),
  ]);
  const posted: [number, string][] = [];
  const identify: IdentifySubmit = {
    identify: (rssItemId, request) => {
      posted.push([rssItemId, request.mode]);
      return Promise.resolve({ accepted: true });
    },
    suggest: () => Promise.resolve([]),
  };

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={identify} source={sourceFor(db)} />);
  fireEvent.click(await screen.findByRole('button', { name: /^unknown\.mkv/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Title' }), { target: { value: 'Dune' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    assert.deepEqual(posted, [[7, 'name']]);
  });
  await waitFor(() => {
    assert.ok(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit' }).disabled, 'the form closed and Edit waits');
  });

  await seed(db, [rssOp({ id: 7, filename: 'unknown.mkv', mediaItemId: null, updatedAt: 20, feedId: 3 })]);
  await waitFor(() => {
    assert.ok(!screen.getByRole<HTMLButtonElement>('button', { name: 'Edit' }).disabled);
  });
});

const SUSPECTS = JSON.stringify({
  media: { title: 'Good News About Hell', parents: [{ title: 'Severance' }], people: [{ name: 'Adam Scott' }] },
  suggestions: { site: { name: 'Some Site' }, performers: [{ name: 'Jane Doe' }] },
  parsed: { title: 'Good News' },
});

test('a term narrows the list by filename and by what the lookup service suspected: a performer, a series, a site', async () => {
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'unrelated.mkv', mediaItemId: null, updatedAt: 10 }),
    rssOp({ id: 2, filename: 'cryptic.name.mkv', mediaItemId: null, updatedAt: 20, lookupJson: SUSPECTS }),
    rssOp({ id: 3, filename: 'severance.s01e01.mkv', mediaItemId: null, updatedAt: 30 }),
    // Matched: never listed, whatever the term.
    rssOp({ id: 4, filename: 'jane.doe.matched.mkv', mediaItemId: 9, updatedAt: 40 }),
  ]);

  const { rerender } = render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} term="jane doe" />);
  await waitFor(() => { assert.deepEqual(filenamesShown(), ['cryptic.name.mkv']); }, { timeout: 4000 });

  rerender(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} term="severance" />);
  await waitFor(() => { assert.deepEqual(filenamesShown(), ['severance.s01e01.mkv', 'cryptic.name.mkv']); }, { timeout: 4000 });

  rerender(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} term="" />);
  await waitFor(() => { assert.deepEqual(filenamesShown(), ['severance.s01e01.mkv', 'cryptic.name.mkv', 'unrelated.mkv']); }, { timeout: 4000 });
});

test('the search box renders when wired, reports typing, and a miss says what it missed', async () => {
  const db = await freshDb();
  await seed(db, [rssOp({ id: 1, filename: 'only.mkv', mediaItemId: null, updatedAt: 10 })]);
  const typed: string[] = [];
  render(
    <Unmatched
      pick={neverPicks}
      retry={neverRetries} retryAll={neverRetriesAll}
      identify={neverIdentifies}
      source={sourceFor(db)}
      term="zzz"
      search={{ input: 'zzz', q: 'zzz', onInput: (value) => { typed.push(value); } }}
    />,
  );
  const box = screen.getByRole('searchbox', { name: 'Search' });
  assert.equal(box instanceof HTMLInputElement && box.value, 'zzz');
  fireEvent.change(box, { target: { value: 'zzzy' } });
  assert.deepEqual(typed, ['zzzy']);
  await waitFor(() => { assert.ok(screen.getByText('Nothing matches "zzz"')); }, { timeout: 4000 });
  assert.ok(screen.getByRole('search', { name: 'Search unmatched' }), 'a landmark of its own, so it is found the way the category controls are');
});

test('without a search wired, no box renders and the empty state is the plain sentence', async () => {
  const db = await freshDb();
  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  await waitFor(() => { assert.ok(screen.getByText('Everything has been matched.')); });
  assert.ok(!screen.queryByRole('searchbox'));
});

test('a release arriving while the page is scrolled is held behind "N new" until the operator is back at the top', async () => {
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'first.mkv', mediaItemId: null, updatedAt: 10 }),
    rssOp({ id: 2, filename: 'second.mkv', mediaItemId: null, updatedAt: 20 }),
  ]);
  // The same fake window scroll `Category.test.tsx` uses: `scrollY` is what
  // the hold reads, `scroll` is what it listens for, `scrollTo` is what the
  // control calls.
  let y = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  const scrollTo = window.scrollTo;
  window.scrollTo = (): void => { y = 0; window.dispatchEvent(new Event('scroll')); };
  try {
    render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
    await waitFor(() => { assert.deepEqual(filenamesShown(), ['second.mkv', 'first.mkv']); });

    act(() => { y = 600; window.dispatchEvent(new Event('scroll')); });
    await seed(db, [rssOp({ id: 3, filename: 'third.mkv', mediaItemId: null, updatedAt: 30 })]);

    const control = await screen.findByRole('button', { name: '1 new' });
    assert.deepEqual(filenamesShown(), ['second.mkv', 'first.mkv'], 'nothing on screen moved');

    fireEvent.click(control);
    await waitFor(() => { assert.deepEqual(filenamesShown(), ['third.mkv', 'second.mkv', 'first.mkv']); });
    assert.ok(!screen.queryByRole('button', { name: /new/ }), 'released, so the control is gone');
  } finally {
    window.scrollTo = scrollTo;
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0, writable: true });
  }
});

/** One `torrent_download` upsert op for a release, in the shape the host replicates. */
function torrentOp({ id, rssItemId, status, percentage = null }: { id: number; rssItemId: number; status: string; percentage?: number | null }): SyncOp {
  return {
    op: 'upsert', table: 'torrent_download', id,
    value: { id, rssItemId, downloadClientId: 1, infohash: null, clientRef: null, status, attempts: 1, createdAt: 1, updatedAt: 1, percentage, absentSince: null, deliveredAt: null, reclaimedAt: null },
  };
}

test('each unmatched card offers Pick, named with its filename; an accepted pick stays Picking… until the download row replicates, which replaces it with the status', async () => {
  const db = await freshDb();
  await seed(db, [rssOp({ id: 7, filename: 'pick.me.mkv', mediaItemId: null, updatedAt: 10 })]);
  const picked: number[] = [];
  const accepts: PickSubmit = (rssItemId) => { picked.push(rssItemId); return Promise.resolve({ accepted: true }); };

  render(<Unmatched pick={accepts} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Pick pick.me.mkv' });
  assert.equal(button.textContent, 'Pick', 'the visible half is just the verb; the filename comes from the heading');

  fireEvent.click(button);
  await waitFor(() => { assert.equal(button.textContent, 'Picking…'); });
  assert.deepEqual(picked, [7], 'the release id reached the submit');
  assert.ok(button.disabled);

  await seed(db, [torrentOp({ id: 70, rssItemId: 7, status: 'submitted' })]);
  await waitFor(() => { assert.ok(screen.getByText('Status: submitted')); }, { timeout: 4000 });
  assert.ok(!screen.queryByRole('button', { name: /^Pick/ }), 'a release with a download offers no Pick');
});

test('a refused pick says why and offers the button again; a release already downloading shows its progress and no Pick', async () => {
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'refused.mkv', mediaItemId: null, updatedAt: 10 }),
    rssOp({ id: 2, filename: 'running.mkv', mediaItemId: null, updatedAt: 20 }),
    torrentOp({ id: 20, rssItemId: 2, status: 'downloading', percentage: 42 }),
  ]);
  const refuses: PickSubmit = () => Promise.resolve({ refusal: 'no-client-of-type' });
  render(<Unmatched pick={refuses} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  await waitFor(() => { assert.deepEqual(filenamesShown(), ['running.mkv', 'refused.mkv']); });

  assert.ok(screen.getByText('Status: downloading (42%)'));
  assert.equal(screen.getAllByRole('button', { name: /^Pick/ }).length, 1, 'only the release with no download is pickable');

  fireEvent.click(screen.getByRole('button', { name: 'Pick refused.mkv' }));
  const alert = await screen.findByRole('alert');
  assert.equal(alert.textContent, 'No download client that can take this kind of release is set up. Add one under Settings.');
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Pick refused.mkv' });
  assert.ok(!button.disabled, 'a refusal hands the button back');
});

test('Retry all names how many unresolved releases the page holds, and asks for them all in one call', async () => {
  const db = await freshDb();
  await seed(db, [
    rssOp({ id: 1, filename: 'a.mkv', mediaItemId: null, updatedAt: 10 }),
    rssOp({ id: 2, filename: 'b.mkv', mediaItemId: null, updatedAt: 11, lookupState: 'refused' }),
    rssOp({ id: 3, filename: 'c.mkv', mediaItemId: null, updatedAt: 12 }),
  ]);
  let calls = 0;
  const retryAll: RetryAllSubmit = async () => { calls += 1; return { accepted: 2 }; };

  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={retryAll} identify={neverIdentifies} source={sourceFor(db)} />);

  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Retry all unresolved (2)' });
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Retrying 2\u2026' }).disabled, true);

  await waitFor(() => { assert.equal(calls, 1); });
  assert.equal((await screen.findByRole('status', { name: 'Retry all outcome' })).textContent, 'Requeued 2 releases');
  assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry all unresolved (2)' }).disabled, false, 'ready for another round');
});

test('Retry all is disabled when nothing is unresolved, and a refusal is an alert', async () => {
  const db = await freshDb();
  await seed(db, [rssOp({ id: 2, filename: 'b.mkv', mediaItemId: null, updatedAt: 11, lookupState: 'refused' })]);
  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={neverRetriesAll} identify={neverIdentifies} source={sourceFor(db)} />);
  await findHeadingButton();
  assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry all unresolved (0)' }).disabled, true);
  cleanup();

  const db2 = await freshDb();
  await seed(db2, [rssOp({ id: 1, filename: 'a.mkv', mediaItemId: null, updatedAt: 10 })]);
  const refusing: RetryAllSubmit = async () => ({ refusal: 'offline' });
  render(<Unmatched pick={neverPicks} retry={neverRetries} retryAll={refusing} identify={neverIdentifies} source={sourceFor(db2)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry all unresolved (1)' }));
  assert.equal((await screen.findByRole('alert')).textContent, RETRY_ALL_REFUSAL_MESSAGES.offline);
});
