import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.ts';
import {
  getBackfillPosition,
  saveBackfillPosition,
  type BackfillPosition,
} from '../../src/db/feed-backfill.ts';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

const AT_PAGE_THREE: BackfillPosition = {
  feedId: 'indexer',
  nextPage: 3,
  pagesRead: 3,
  state: 'running',
  detail: null,
};

test('a feed nobody has walked has no position', () => {
  const db = freshDb();
  assert.equal(getBackfillPosition(db, 'indexer'), null);
  db.close();
});

test('a saved position reads back as it was written', () => {
  const db = freshDb();
  saveBackfillPosition(db, AT_PAGE_THREE, 1000);
  assert.deepEqual(getBackfillPosition(db, 'indexer'), AT_PAGE_THREE);
  db.close();
});

test('saving again moves the same feed rather than adding a second row', () => {
  // The walk saves after every page, so this is the common path rather than an
  // edge case: a primary key on `feed_id` plus an upsert, not an insert that
  // would fail on the second page.
  const db = freshDb();
  saveBackfillPosition(db, AT_PAGE_THREE, 1000);
  saveBackfillPosition(db, { ...AT_PAGE_THREE, nextPage: 4, pagesRead: 4 }, 2000);

  const rows = db.prepare('SELECT COUNT(*) AS n FROM feed_backfill').get();
  assert.equal(Number(rows?.['n']), 1);
  assert.equal(getBackfillPosition(db, 'indexer')?.nextPage, 4);
  db.close();
});

test('a terminal state keeps the reason it stopped', () => {
  // The three ways of stopping are not interchangeable — a walk that ran out of
  // history and one that hit its cap and one that found the indexer ignoring the
  // parameter all need telling apart, and `detail` is what makes the difference
  // legible from the database instead of from logs that have rotated.
  const db = freshDb();
  saveBackfillPosition(
    db,
    {
      feedId: 'indexer',
      nextPage: 7,
      pagesRead: 7,
      state: 'broken',
      detail: 'page 7 repeated page 6 — the indexer ignored offset',
    },
    3000,
  );

  const position = getBackfillPosition(db, 'indexer');
  assert.equal(position?.state, 'broken');
  assert.match(position?.detail ?? '', /ignored offset/);
  db.close();
});

test('the write stamps updated_at from the caller clock, not the wall clock', () => {
  const db = freshDb();
  saveBackfillPosition(db, AT_PAGE_THREE, 4242);
  const row = db.prepare('SELECT updated_at AS u FROM feed_backfill WHERE feed_id = ?').get('indexer');
  assert.equal(Number(row?.['u']), 4242);
  db.close();
});

test('two feeds walk independently', () => {
  const db = freshDb();
  saveBackfillPosition(db, AT_PAGE_THREE, 1000);
  saveBackfillPosition(db, { ...AT_PAGE_THREE, feedId: 'other', nextPage: 0, state: 'done' }, 1000);

  assert.equal(getBackfillPosition(db, 'indexer')?.nextPage, 3);
  assert.equal(getBackfillPosition(db, 'other')?.state, 'done');
  db.close();
});
