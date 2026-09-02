import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { pageOfBrowseItems, type BrowseCursor } from '../../src/db/browse-page.ts';

// The merged list interleaves two tables this codebase already has fixture
// idioms for: a browsable group (`BROWSABLE` in db/groups.ts) and a feed item
// the parser refused (`parse_error IS NOT NULL` in db/feed-items.ts). These
// helpers seed one row at a time, varying only the column a given test cares
// about, following `seedGroup` in groups.test.ts and `seedFeedItems` in
// manual.test.ts. `identity_key`/`guid` just need to be unique within one
// test's database, so a per-file counter stands in for them.

let groupSeq = 0;
let itemSeq = 0;

function seedBrowsableGroup(db: DatabaseSync, opts: { listRankAt: number; searchText?: string }): number {
  groupSeq += 1;
  const result = db
    .prepare(
      `INSERT INTO media_groups (plugin, identity_key, display, search_text, state, created_at, list_rank_at)
       VALUES ('test', ?, ?, ?, 'new', ?, ?)`,
    )
    .run(`k${groupSeq}`, `G${groupSeq}`, opts.searchText ?? `g${groupSeq}`, opts.listRankAt, opts.listRankAt);
  return Number(result.lastInsertRowid);
}

/** Picked, and with nothing better on offer — `BROWSABLE` excludes this one. */
function seedPickedGroupWithNoUpgrade(db: DatabaseSync, opts: { listRankAt: number }): number {
  groupSeq += 1;
  const result = db
    .prepare(
      `INSERT INTO media_groups (plugin, identity_key, display, search_text, state, created_at, list_rank_at)
       VALUES ('test', ?, ?, ?, 'picked', ?, ?)`,
    )
    .run(`k${groupSeq}`, `G${groupSeq}`, `g${groupSeq}`, opts.listRankAt, opts.listRankAt);
  return Number(result.lastInsertRowid);
}

function seedFailedItem(
  db: DatabaseSync,
  opts: { firstSeenAt: number; rawTitle?: string; dismissedAt?: number },
): number {
  itemSeq += 1;
  const result = db
    .prepare(
      `INSERT INTO feed_items (feed_id, guid, raw_title, link, first_seen_at, parse_error, dismissed_at)
       VALUES ('f', ?, ?, ?, ?, 'unparseable', ?)`,
    )
    .run(
      `g${itemSeq}`,
      opts.rawTitle ?? `T${itemSeq}`,
      `https://indexer.invalid/${itemSeq}.nzb`,
      opts.firstSeenAt,
      opts.dismissedAt ?? null,
    );
  return Number(result.lastInsertRowid);
}

test('a page interleaves both kinds by recency, newest first', () => {
  const db = openTestDatabase();
  // Deliberately alternating stamps, so a merge that simply concatenated the
  // two lists would come back in a visibly different order.
  const g1 = seedBrowsableGroup(db, { listRankAt: 500 });
  const f1 = seedFailedItem(db, { firstSeenAt: 400 });
  const g2 = seedBrowsableGroup(db, { listRankAt: 300 });
  const f2 = seedFailedItem(db, { firstSeenAt: 200 });

  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: null });
  assert.deepEqual(
    page.map((row) => `${row.kind}:${row.id}`),
    [`group:${g1}`, `failed:${f1}`, `group:${g2}`, `failed:${f2}`],
  );
  db.close();
});

test('a group and a failed item sharing a stamp come back failed-first, always', () => {
  const db = openTestDatabase();
  const g = seedBrowsableGroup(db, { listRankAt: 100 });
  const f = seedFailedItem(db, { firstSeenAt: 100 });
  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: null });
  // `'failed' < 'group'`, and this order has to be the same one the cursor
  // comparison assumes — a tiebreak that differs between the two is how a row
  // gets served twice or skipped.
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`failed:${f}`, `group:${g}`]);
  db.close();
});

test('paging never repeats or skips a row, whichever kind the boundary is', () => {
  const db = openTestDatabase();
  // Six rows, three of each kind, with two ties so both boundary kinds occur.
  const ids: string[] = [];
  ids.push(`group:${seedBrowsableGroup(db, { listRankAt: 600 })}`);
  ids.push(`failed:${seedFailedItem(db, { firstSeenAt: 600 })}`);
  ids.push(`group:${seedBrowsableGroup(db, { listRankAt: 500 })}`);
  ids.push(`failed:${seedFailedItem(db, { firstSeenAt: 400 })}`);
  ids.push(`group:${seedBrowsableGroup(db, { listRankAt: 400 })}`);
  ids.push(`failed:${seedFailedItem(db, { firstSeenAt: 300 })}`);
  const expected = [ids[1], ids[0], ids[2], ids[3], ids[4], ids[5]];

  // Walk it one row at a time: a limit of 1 makes every row in turn the
  // boundary, which is the only way to exercise all four keyset cases.
  const seen: string[] = [];
  let cursor: BrowseCursor | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = pageOfBrowseItems(db, { cursor, limit: 1, search: null });
    if (page.length === 0) break;
    const row = page[0];
    if (row === undefined) break;
    seen.push(`${row.kind}:${row.id}`);
    cursor = { sortKey: row.sortKey, kind: row.kind, id: row.id };
  }
  assert.deepEqual(seen, expected);
  db.close();
});

test('the search term matches a group by its search text and a failed item by its raw title', () => {
  const db = openTestDatabase();
  const g = seedBrowsableGroup(db, { listRankAt: 300, searchText: 'alpha scene' });
  const f = seedFailedItem(db, { firstSeenAt: 200, rawTitle: 'Alpha Unparseable' });
  seedBrowsableGroup(db, { listRankAt: 100, searchText: 'beta' });

  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: 'alpha' });
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`group:${g}`, `failed:${f}`]);
  db.close();
});

test('the search term is case-insensitive on both sides', () => {
  const db = openTestDatabase();
  // `search_text` is stored already lowercased by `searchTextFor`, but
  // `raw_title` is stored as it arrived — so the failed branch has to fold case
  // at query time and this test is what says so.
  const f = seedFailedItem(db, { firstSeenAt: 200, rawTitle: 'MiXeD Case Title' });
  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: 'mixed case' });
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`failed:${f}`]);
  db.close();
});

test('a dismissed failed item never appears', () => {
  const db = openTestDatabase();
  seedFailedItem(db, { firstSeenAt: 200, dismissedAt: 1_000 });
  const g = seedBrowsableGroup(db, { listRankAt: 100 });
  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: null });
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`group:${g}`]);
  db.close();
});

test('a non-browsable group never appears', () => {
  const db = openTestDatabase();
  // Picked with nothing better on offer — `BROWSABLE` excludes it, and this
  // query must not widen that rule.
  seedPickedGroupWithNoUpgrade(db, { listRankAt: 200 });
  const f = seedFailedItem(db, { firstSeenAt: 100 });
  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: null });
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`failed:${f}`]);
  db.close();
});
