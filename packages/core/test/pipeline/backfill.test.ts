import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.ts';
import { getBackfillPosition, saveBackfillPosition } from '../../src/db/feed-backfill.ts';
import { createBackfillRunner, type BackfillDeps } from '../../src/pipeline/backfill.ts';
import type { FeedConfig } from '../../src/config/schema.ts';
import type { FeedEntry } from '../../src/feeds/parse-rss.ts';
import type { IngestResult } from '../../src/ingest/ingest.ts';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

const WALKABLE: FeedConfig = {
  id: 'indexer',
  url: 'https://indexer.example/rss?apikey=secret',
  plugin: 'pkg',
  intervalSeconds: 900,
  backfill: { style: 'newznab', pageSize: 2, pagesPerPass: 2, maxPages: 10 },
};

/** A feed that has not opted in, which must never be fetched. */
const PLAIN: FeedConfig = {
  id: 'plain',
  url: 'https://plain.example/rss',
  plugin: 'pkg',
  intervalSeconds: 900,
};

function entry(guid: string): FeedEntry {
  return { guid, title: `${guid}|1080`, link: `https://x.invalid/${guid}`, publishedAt: 1000 };
}

function ingested(inserted: number): IngestResult {
  return {
    seen: inserted,
    inserted,
    parseErrors: 0,
    groupsCreated: inserted,
    releasesAdded: inserted,
    upgradesFlagged: 0,
    parseFailures: [],
    parseFailuresSuppressed: 0,
  };
}

interface Harness {
  run: () => Promise<void>;
  fetched: number[];
  ingestedPages: number[];
  logs: string[];
  db: DatabaseSync;
}

/**
 * A runner over `pages`, indexed by page number. A page that is absent answers
 * empty, which is how a real feed says "past the end".
 */
function harness(
  db: DatabaseSync,
  pages: Map<number, FeedEntry[]>,
  over: Partial<BackfillDeps> = {},
  feeds: readonly FeedConfig[] = [WALKABLE],
): Harness {
  const fetched: number[] = [];
  const ingestedPages: number[] = [];
  const logs: string[] = [];

  const deps: BackfillDeps = {
    db,
    feeds,
    fetchPage: async (_feed, page) => {
      fetched.push(page);
      return pages.get(page) ?? [];
    },
    ingestPage: async (_feed, entries) => {
      ingestedPages.push(entries.length);
      return ingested(entries.length);
    },
    now: () => 5000,
    log: (message) => logs.push(message),
    ...over,
  };

  return { run: createBackfillRunner(deps), fetched, ingestedPages, logs, db };
}

/** Pages 0..last, each full, then nothing — a feed with a real end. */
function finitePages(last: number): Map<number, FeedEntry[]> {
  const pages = new Map<number, FeedEntry[]>();
  for (let page = 0; page <= last; page += 1) {
    pages.set(page, [entry(`p${String(page)}a`), entry(`p${String(page)}b`)]);
  }
  return pages;
}

test('a feed that has not opted in is never fetched', async () => {
  const db = freshDb();
  const h = harness(db, finitePages(5), {}, [PLAIN]);

  await h.run();

  assert.deepEqual(h.fetched, []);
  assert.equal(getBackfillPosition(db, 'plain'), null);
  db.close();
});

test('the walk starts at page one, because page zero is what the poll already reads', async () => {
  // The live poll requests the feed's default page every interval, so walking
  // page 0 again would spend a fetch re-reading what is by construction the
  // freshest thing we have.
  const db = freshDb();
  const h = harness(db, finitePages(5));

  await h.run();

  assert.deepEqual(h.fetched, [1, 2]);
  db.close();
});

test('a pass walks at most pagesPerPass pages and stays running', async () => {
  const db = freshDb();
  const h = harness(db, finitePages(9));

  await h.run();

  assert.equal(h.fetched.length, 2);
  const position = getBackfillPosition(db, 'indexer');
  assert.equal(position?.state, 'running');
  assert.equal(position?.nextPage, 3);
  assert.equal(position?.pagesRead, 2);
  db.close();
});

test('the next pass resumes where the last one stopped', async () => {
  const db = freshDb();
  const pages = finitePages(9);

  await harness(db, pages).run();
  const second = harness(db, pages);
  await second.run();

  assert.deepEqual(second.fetched, [3, 4]);
  assert.equal(getBackfillPosition(db, 'indexer')?.nextPage, 5);
  db.close();
});

test('an empty page is the end of the history, and the walk is done', async () => {
  // Not "a page whose every item was already known" — page one of a feed the poll
  // has been reading is *always* entirely known, so that rule would end every
  // walk before it started. Running out of items is the only signal that means
  // what it says.
  const db = freshDb();
  const h = harness(db, finitePages(1));

  await h.run();

  assert.deepEqual(h.fetched, [1, 2]);
  // Page 2 came back empty, so it was never handed to ingest.
  assert.deepEqual(h.ingestedPages, [2]);
  const position = getBackfillPosition(db, 'indexer');
  assert.equal(position?.state, 'done');
  assert.match(position?.detail ?? '', /no items/i);
  db.close();
});

test('a page whose every item was already known does not stop the walk', async () => {
  // The corollary of the test above, stated on its own because it is the rule the
  // issue proposed and the one that had to be rejected.
  const db = freshDb();
  const h = harness(db, finitePages(9), { ingestPage: async () => ingested(0) });

  await h.run();

  assert.equal(h.fetched.length, 2);
  assert.equal(getBackfillPosition(db, 'indexer')?.state, 'running');
  db.close();
});

test('a walk that reaches maxPages stops as exhausted, not done', async () => {
  // The difference matters: `done` says the history is read, `exhausted` says
  // there is more and the cap stopped us. Collapsing them would make raising the
  // cap look pointless.
  const db = freshDb();
  saveBackfillPosition(
    db,
    { feedId: 'indexer', nextPage: 9, pagesRead: 9, state: 'running', detail: null },
    1000,
  );
  const h = harness(db, finitePages(99));

  await h.run();

  // One page left before the cap of 10, so one fetch and then the stop.
  assert.deepEqual(h.fetched, [9]);
  const position = getBackfillPosition(db, 'indexer');
  assert.equal(position?.state, 'exhausted');
  assert.match(position?.detail ?? '', /10/);
  db.close();
});

test('an indexer that serves the same page twice is broken, not done', async () => {
  // The silent failure the whole guard exists for. An indexer ignoring `offset`
  // answers page one forever; every item on it is already known, so without this
  // the walk would announce that the history is caught up having read one page
  // over and over.
  const db = freshDb();
  const repeated = [entry('same-a'), entry('same-b')];
  const pages = new Map<number, FeedEntry[]>([
    [1, repeated],
    [2, repeated],
  ]);
  const h = harness(db, pages);

  await h.run();

  const position = getBackfillPosition(db, 'indexer');
  assert.equal(position?.state, 'broken');
  assert.match(position?.detail ?? '', /offset/);
  // The repeat was detected before ingest, so the duplicate page was not even
  // handed over.
  assert.deepEqual(h.ingestedPages, [2]);
  db.close();
});

test('a page that is a subset of the one before it also counts as repeated', async () => {
  // Strict equality is too weak: a feed being written to while we walk can shift
  // an item between pages, but it cannot produce a page whose every item was on
  // the previous one.
  const db = freshDb();
  const pages = new Map<number, FeedEntry[]>([
    [1, [entry('a'), entry('b')]],
    [2, [entry('b')]],
  ]);
  const h = harness(db, pages);

  await h.run();

  assert.equal(getBackfillPosition(db, 'indexer')?.state, 'broken');
  db.close();
});

test('a feed in a terminal state is skipped without a fetch', async () => {
  const db = freshDb();
  saveBackfillPosition(
    db,
    { feedId: 'indexer', nextPage: 4, pagesRead: 4, state: 'done', detail: 'read it all' },
    1000,
  );
  const h = harness(db, finitePages(9));

  await h.run();

  assert.deepEqual(h.fetched, []);
  db.close();
});

test('a page that fails to fetch leaves the position alone for the next pass', async () => {
  const db = freshDb();
  const h = harness(db, finitePages(9), {
    fetchPage: async () => {
      throw new Error('Feed indexer returned HTTP 503');
    },
  });

  await h.run();

  // No position written at all, so the next pass starts from page one again
  // rather than skipping the page that failed.
  assert.equal(getBackfillPosition(db, 'indexer'), null);
  assert.ok(
    h.logs.some((line) => line.includes('503')),
    `expected the failure to be logged; saw ${JSON.stringify(h.logs)}`,
  );
  db.close();
});

test('one feed failing does not stop the pass for another', async () => {
  const db = freshDb();
  const other: FeedConfig = { ...WALKABLE, id: 'other' };
  const pages = finitePages(9);
  const h = harness(
    db,
    pages,
    {
      fetchPage: async (feed, page) => {
        if (feed.id === 'indexer') throw new Error('boom');
        return pages.get(page) ?? [];
      },
    },
    [WALKABLE, other],
  );

  await h.run();

  assert.equal(getBackfillPosition(db, 'indexer'), null);
  assert.equal(getBackfillPosition(db, 'other')?.pagesRead, 2);
  db.close();
});

test('pages are ingested as history, never as arrivals', async () => {
  // The ordering rule, checked at the seam rather than only in the ingest tests:
  // if this pass ever calls the live path, backfilled scenes take over the top of
  // the browse list and nothing downstream can tell.
  const db = freshDb();
  const sources: string[] = [];
  const h = harness(db, finitePages(9), {
    ingestPage: async (_feed, entries, source) => {
      sources.push(source);
      return ingested(entries.length);
    },
  });

  await h.run();

  assert.deepEqual(sources, ['backfill', 'backfill']);
  db.close();
});
