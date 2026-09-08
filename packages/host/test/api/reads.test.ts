import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { migrateHost } from '../../src/db/migrate.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import type { Cursor } from '../../src/api/cursor.ts';
import { PAGE_SIZE, decodeCursor, encodeCursor } from '../../src/api/cursor.ts';
import {
  SYNC_QUERIES,
  deletionsSince,
  downloadsForRssItem,
  downloadsSince,
  mediaItemById,
  mediaItemByReference,
  mediaItemsSince,
  rssItemsForMediaItem,
  rssItemsSince,
} from '../../src/api/reads.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/**
 * The round trip a real client makes: a returned cursor goes out as a string
 * and comes back as one, so every paging assertion below exercises
 * `encodeCursor`/`decodeCursor` rather than passing an internal `Cursor`
 * straight back in. A test that skipped the wire form would pass against an
 * implementation whose cursor no client could actually resume from.
 */
function resume(cursor: string | null): Cursor | null {
  return decodeCursor(cursor ?? undefined);
}

function seedMediaItem(raw: DatabaseSync, pluginId: string, updatedAt: number, title: string): number {
  const info = raw.prepare(
    'INSERT INTO media_item (plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?)',
  ).run(pluginId, updatedAt, updatedAt, title);
  return Number(info.lastInsertRowid);
}

/** `rss_feed_url` is unique, so every feed a test seeds needs its own url. */
function seedFeed(raw: DatabaseSync, url: string): number {
  const info = raw.prepare(
    "INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('alpha', 'Feed', ?, 1, 1)",
  ).run(url);
  return Number(info.lastInsertRowid);
}

/**
 * `rss_item_feed_guid` is unique on `(feed_id, guid)`, so the guid is derived
 * from the filename rather than fixed -- two items on one feed with the same
 * guid collide, and a fixture that collided would look like a query bug.
 */
function seedRssItem(
  raw: DatabaseSync,
  feedId: number,
  updatedAt: number,
  filename: string,
  mediaItemId: number | null = null,
): number {
  const info = raw.prepare(`
    INSERT INTO rss_item
      (feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution, resolution_detail, guid)
    VALUES (?, ?, ?, ?, ?, 'torrent', ?, '1080p', 'x264', ?)
  `).run(feedId, filename, `https://example.com/${filename}`, updatedAt, updatedAt, mediaItemId, `guid-${filename}`);
  return Number(info.lastInsertRowid);
}

/** `download_client_name` is unique, so every client a test seeds needs its own name. */
function seedClient(raw: DatabaseSync, name: string): number {
  const info = raw.prepare(`
    INSERT INTO download_client (name, type, url, category, import_mode, created_at, updated_at)
    VALUES (?, 'torrent', ?, 'movies', 'copy', 1, 1)
  `).run(name, `https://example.com/${name}`);
  return Number(info.lastInsertRowid);
}

/**
 * `torrent_download_client_ref` is unique on `(download_client_id,
 * client_ref)`, so `clientRef` is a parameter rather than a fixed literal:
 * two rows on one client with the same ref collide, and a fixture that
 * collided would look exactly like a query bug.
 */
function seedTorrentDownload(
  raw: DatabaseSync,
  rssItemId: number,
  clientId: number,
  updatedAt: number,
  clientRef: string,
  infohash: string | null = null,
): number {
  const info = raw.prepare(`
    INSERT INTO torrent_download
      (rss_item_id, download_client_id, infohash, client_ref, status, last_error, created_at, updated_at, percentage, absent_since, delivered_at)
    VALUES (?, ?, ?, ?, 'downloading', NULL, ?, ?, 40, NULL, NULL)
  `).run(rssItemId, clientId, infohash, clientRef, updatedAt, updatedAt);
  return Number(info.lastInsertRowid);
}

/** See `seedTorrentDownload` for why `clientRef` is a parameter. */
function seedNzbDownload(
  raw: DatabaseSync,
  rssItemId: number,
  clientId: number,
  updatedAt: number,
  clientRef: string,
): number {
  const info = raw.prepare(`
    INSERT INTO nzb_download
      (rss_item_id, download_client_id, client_ref, status, last_error, created_at, updated_at, percentage, absent_since, delivered_at)
    VALUES (?, ?, ?, 'completed', 'a failure', ?, ?, 100, 900, 950)
  `).run(rssItemId, clientId, clientRef, updatedAt, updatedAt);
  return Number(info.lastInsertRowid);
}

function seedTombstone(raw: DatabaseSync, mediaItemId: number, pluginId: string, deletedAt: number): void {
  raw.prepare(
    'INSERT INTO deleted_media_item (media_item_id, plugin_id, deleted_at) VALUES (?, ?, ?)',
  ).run(mediaItemId, pluginId, deletedAt);
}

/** The ascending run of ids a page of `count` rows seeded in order must return. */
function ascending(from: number, count: number): number[] {
  return Array.from({ length: count }, (_unused, offset) => from + offset);
}

test('a page sees a row updated behind an existing cursor', () => {
  // The reason the cursor is not id-only. An id cursor at id 2 can never
  // return id 1 again, however much later id 1 is written -- so the client
  // would never learn about the edit at all.
  const raw = setup();
  seedMediaItem(raw, 'alpha', 100, 'First');
  seedMediaItem(raw, 'alpha', 200, 'Second');

  const first = mediaItemsSince(raw, 'alpha', null);
  assert.deepEqual(first.items.map((item) => item.id), [1, 2]);
  assert.equal(first.cursor, encodeCursor({ updatedAt: 200, id: 2 }));
  assert.equal(first.done, true);

  // Id 1 is *behind* the cursor's id, and now ahead of its updated_at.
  raw.prepare('UPDATE media_item SET updated_at = ? WHERE id = ?').run(300, 1);

  const next = mediaItemsSince(raw, 'alpha', resume(first.cursor));
  assert.deepEqual(next.items.map((item) => ({ id: item.id, title: item.title })), [
    { id: 1, title: 'First' },
  ]);
  assert.equal(next.cursor, encodeCursor({ updatedAt: 300, id: 1 }));
});

test('rows sharing one updated_at each appear exactly once across pages', () => {
  // Five rows on one millisecond, resumed from a cursor *inside* the group.
  // This is the case that separates all three candidate predicates, and it
  // does it in literals:
  //   `(updated_at > ?) OR (updated_at = ? AND id > ?)` -> [3, 4, 5]
  //   `updated_at > ?` alone                            -> []        (omits)
  //   `updated_at >= ?` in the first clause             -> [1..5]    (repeats)
  const raw = setup();
  for (const title of ['a', 'b', 'c', 'd', 'e']) {
    seedMediaItem(raw, 'alpha', 1000, title);
  }

  const insideTheGroup = mediaItemsSince(raw, 'alpha', { updatedAt: 1000, id: 2 });
  assert.deepEqual(insideTheGroup.items.map((item) => item.id), [3, 4, 5]);

  // And the same property across real page boundaries. `PAGE_SIZE` is fixed
  // and not injectable, so the fixture is sized to it rather than the other
  // way round: 401 rows on one millisecond puts a page boundary inside the
  // group twice, at ids 200/201 and 400/401.
  assert.equal(PAGE_SIZE, 200, 'the page-length literals below are written for a page size of 200');
  const wide = setup();
  for (const id of ascending(1, 401)) {
    seedMediaItem(wide, 'alpha', 5000, `t${id}`);
  }

  const one = mediaItemsSince(wide, 'alpha', null);
  const two = mediaItemsSince(wide, 'alpha', resume(one.cursor));
  const three = mediaItemsSince(wide, 'alpha', resume(two.cursor));

  assert.deepEqual([one.items.length, two.items.length, three.items.length], [200, 200, 1]);
  assert.deepEqual([one.items.at(0)?.id, one.items.at(-1)?.id], [1, 200]);
  assert.deepEqual([two.items.at(0)?.id, two.items.at(-1)?.id], [201, 400]);
  assert.deepEqual(three.items.map((item) => item.id), [401]);
  assert.deepEqual([one.done, two.done, three.done], [false, false, true]);

  const seen = [...one.items, ...two.items, ...three.items].map((item) => item.id);
  assert.equal(new Set(seen).size, 401, 'no id may be served twice');
  assert.deepEqual(seen, ascending(1, 401), 'no id may be skipped, and the order is ascending');
});

test('an empty page after a real cursor returns that cursor, not null', () => {
  // Otherwise a caught-up client restarts from the beginning on every poll:
  // it would re-read the whole library once a minute forever, and never
  // notice, because the rows it re-reads are the rows it already has.
  const raw = setup();
  seedMediaItem(raw, 'alpha', 100, 'Only');
  seedTombstone(raw, 7, 'alpha', 100);

  const first = mediaItemsSince(raw, 'alpha', null);
  assert.deepEqual(first.items.map((item) => item.id), [1]);
  assert.equal(first.cursor, encodeCursor({ updatedAt: 100, id: 1 }));

  const caughtUp = mediaItemsSince(raw, 'alpha', resume(first.cursor));
  assert.deepEqual(caughtUp.items, []);
  assert.equal(caughtUp.cursor, first.cursor, 'the caller\'s own cursor, echoed back');
  assert.equal(caughtUp.done, true);

  // Polling again while nothing changes must not drift either.
  const stillCaughtUp = mediaItemsSince(raw, 'alpha', resume(caughtUp.cursor));
  assert.equal(stillCaughtUp.cursor, first.cursor);

  // Every paged read shares the rule, so the tombstone page echoes too.
  const deletions = deletionsSince(raw, 'alpha', null);
  assert.deepEqual(deletions.items, [7]);
  const noMoreDeletions = deletionsSince(raw, 'alpha', resume(deletions.cursor));
  assert.deepEqual(noMoreDeletions.items, []);
  assert.equal(noMoreDeletions.cursor, deletions.cursor);

  // The one case where null *is* the truth: a first page with nothing in it.
  // There is no cursor of the caller's to echo, and "the beginning" is
  // already where the caller is.
  assert.deepEqual(mediaItemsSince(setup(), 'alpha', null), { items: [], cursor: null, done: true });
});

test('done is false while a full page is returned and true on a short one', () => {
  assert.equal(PAGE_SIZE, 200, 'the row counts below are written for a page size of 200');

  // Exactly one page, and nothing after it: `done` is still false. A page of
  // PAGE_SIZE is indistinguishable from one with more behind it without
  // asking again, and one extra poll is cheaper than stopping a row early.
  const exact = setup();
  for (const id of ascending(1, 200)) {
    seedMediaItem(exact, 'alpha', id, `t${id}`);
  }
  const full = mediaItemsSince(exact, 'alpha', null);
  assert.equal(full.items.length, 200);
  assert.equal(full.done, false);
  assert.deepEqual([full.items.at(0)?.id, full.items.at(-1)?.id], [1, 200]);

  const beyond = mediaItemsSince(exact, 'alpha', resume(full.cursor));
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.done, true);

  // One row short of a page is short on the first ask.
  const short = setup();
  for (const id of ascending(1, 199)) {
    seedMediaItem(short, 'alpha', id, `t${id}`);
  }
  const onlyPage = mediaItemsSince(short, 'alpha', null);
  assert.equal(onlyPage.items.length, 199);
  assert.equal(onlyPage.done, true);
});

test('a plugin sees only its own media items', () => {
  const raw = setup();
  seedMediaItem(raw, 'alpha', 100, 'Alpha one');
  seedMediaItem(raw, 'beta', 150, 'Beta one');
  seedMediaItem(raw, 'alpha', 200, 'Alpha two');
  raw.prepare('UPDATE media_item SET provider = ?, provider_ref = ? WHERE id = ?').run('tmdb', '99', 2);

  const page = mediaItemsSince(raw, 'alpha', null);
  assert.deepEqual(page.items.map((item) => ({ id: item.id, title: item.title })), [
    { id: 1, title: 'Alpha one' },
    { id: 3, title: 'Alpha two' },
  ]);
  assert.equal(page.cursor, encodeCursor({ updatedAt: 200, id: 3 }));

  // Null, not a throw: "not yours" and "not there" are one answer, because
  // distinguishing them would report the other plugin's contents.
  assert.equal(mediaItemById(raw, 'alpha', 2), null);
  assert.equal(mediaItemByReference(raw, 'alpha', 'tmdb', '99'), null);
  assert.equal(mediaItemById(raw, 'beta', 2)?.title, 'Beta one');
  assert.equal(mediaItemByReference(raw, 'beta', 'tmdb', '99')?.id, 2);
});

test('a deletion page carries only this plugin\'s tombstones', () => {
  const raw = setup();
  seedTombstone(raw, 7, 'alpha', 100);
  seedTombstone(raw, 8, 'beta', 150);
  seedTombstone(raw, 9, 'alpha', 200);

  const page = deletionsSince(raw, 'alpha', null);
  assert.deepEqual(page.items, [7, 9]);
  assert.equal(page.cursor, encodeCursor({ updatedAt: 200, id: 9 }));
  assert.equal(page.done, true);

  assert.deepEqual(deletionsSince(raw, 'beta', null).items, [8]);

  // The tombstone cursor walks `deleted_at`, so a page resumed past the
  // first tombstone still carries the later one.
  const later = deletionsSince(raw, 'alpha', { updatedAt: 100, id: 7 });
  assert.deepEqual(later.items, [9]);
});

test('downloads from both tables interleave by updated_at, not by table', () => {
  const raw = setup();
  const feedId = seedFeed(raw, 'https://example.com/feed');
  const itemId = seedRssItem(raw, feedId, 10, 'a.mkv');
  const clientId = seedClient(raw, 'Client');
  // The nzb row is the older one, and it is in the second table. Anything
  // that pages one table and then the other puts the torrent row first.
  seedTorrentDownload(raw, itemId, clientId, 200, 'ref-t', 'abc123');
  seedNzbDownload(raw, itemId, clientId, 100, 'ref-n');

  const page = downloadsSince(raw, null);
  assert.deepEqual(page.items.map((row) => ({ id: row.id, transport: row.transport })), [
    { id: 1, transport: 'nzb' },
    { id: 1, transport: 'torrent' },
  ]);
  assert.equal(page.cursor, encodeCursor({ updatedAt: 200, id: 1 }));
  assert.equal(page.done, true);

  // `infohash` exists on `torrent_download` alone, so the nzb row reads null
  // rather than the column being absent from the shape.
  assert.deepEqual(page.items.map((row) => row.infohash), [null, 'abc123']);

  // The per-item read spans both tables in the same order.
  assert.deepEqual(downloadsForRssItem(raw, itemId).map((row) => row.transport), ['nzb', 'torrent']);
});

test('every sync query uses its index', () => {
  // `EXPLAIN QUERY PLAN` over the exported SQL, never a copy of it. Slice D
  // shipped two indexes no query used, and a plan assertion against a
  // restated lookalike would have passed just as happily -- it proves what
  // SQLite does with the test's string, not with the module's.
  const raw = setup();

  // Every exported query is checked, including the two that reach no index:
  // a query with no entry here fails the key comparison below rather than
  // being quietly skipped, which is how a future read would otherwise slip
  // in unmeasured.
  interface PlanCheck {
    /** Bindings in placeholder order -- an EXPLAIN still needs the statement to bind. */
    readonly args: readonly (string | number)[];
    /** Substrings the plan must contain. */
    readonly mustMatch: readonly string[];
    /** Substrings the plan must not contain. */
    readonly mustNotMatch: readonly string[];
    /** Why the expectations above are what they are. */
    readonly why: string;
  }

  const checks: Readonly<Record<string, PlanCheck>> = {
    mediaItemsSince: {
      args: ['alpha', 0, 0, 0, PAGE_SIZE],
      mustMatch: ['USING INDEX media_item_sync'],
      mustNotMatch: ['USE TEMP B-TREE', 'SCAN media_item'],
      why: '`media_item_sync` leads with plugin_id, so it both narrows and supplies the (updated_at, id) order',
    },
    rssItemsSince: {
      args: [0, 0, 0, PAGE_SIZE],
      // `rss_item_updated` has existed since migration 1 and is the index
      // this query uses. Migration 9 deliberately adds no second one.
      mustMatch: ['USING INDEX rss_item_updated'],
      mustNotMatch: ['USE TEMP B-TREE'],
      why: 'no plugin filter, so the index is walked in order rather than searched -- but it is walked, not sorted',
    },
    deletionsSince: {
      args: ['alpha', 0, 0, 0, PAGE_SIZE],
      mustMatch: ['USING INDEX deleted_media_item_at'],
      mustNotMatch: ['USE TEMP B-TREE'],
      why: 'the index leads with deleted_at, so it supplies the order; plugin_id is filtered as rows come off it',
    },
    downloadsSince: {
      args: [0, 0, 0, 0, 0, 0, PAGE_SIZE],
      mustMatch: ['torrent_download', 'nzb_download'],
      mustNotMatch: [],
      why: 'no index can order across two tables, so this one sorts. Both tables must at least be reached.',
    },
    mediaItemById: {
      args: ['alpha', 1],
      mustMatch: ['USING INTEGER PRIMARY KEY'],
      mustNotMatch: ['SCAN media_item'],
      why: 'the rowid is the id, so this is a single-row seek and needs no secondary index',
    },
    mediaItemByReference: {
      args: ['alpha', 'tmdb', '99'],
      // Which index SQLite picks between `media_item_provider_ref` and
      // `media_item_sync` depends on row counts, and both are correct. What
      // must never happen is a table scan.
      mustMatch: ['USING INDEX media_item_'],
      mustNotMatch: ['SCAN media_item'],
      why: 'either index on media_item answers this; a scan does not',
    },
    rssItemsForMediaItem: {
      args: [1],
      mustMatch: ['SCAN rss_item'],
      mustNotMatch: ['USE TEMP B-TREE'],
      why: 'rss_item has no index on media_item_id, so this scans -- pinned as the measured fact it is, not as an approval',
    },
    downloadsForRssItem: {
      args: [1, 1],
      mustMatch: ['USING INDEX torrent_download_item', 'USING INDEX nzb_download_item'],
      mustNotMatch: [],
      why: 'both per-item indexes exist and are used; the union still sorts, as downloadsSince does',
    },
  };

  assert.deepEqual(
    Object.keys(checks).toSorted(),
    Object.keys(SYNC_QUERIES).toSorted(),
    'every exported query needs a plan expectation, and every expectation an exported query',
  );

  for (const [name, check] of Object.entries(checks)) {
    const sql = SYNC_QUERIES[name];
    assert.ok(sql !== undefined, `SYNC_QUERIES has no entry for ${name}`);
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...check.args)
      .map((step) => String((step as { detail: unknown }).detail))
      .join('\n');

    for (const fragment of check.mustMatch) {
      assert.ok(plan.includes(fragment), `${name} plan must contain ${fragment} (${check.why})\n${plan}`);
    }
    for (const fragment of check.mustNotMatch) {
      assert.ok(!plan.includes(fragment), `${name} plan must not contain ${fragment} (${check.why})\n${plan}`);
    }
  }
});

test('a media item reads back every column the read shape names', () => {
  const raw = setup();
  raw.prepare(`
    INSERT INTO media_item (plugin_id, created_at, updated_at, provider, provider_ref, title, release_date, description)
    VALUES ('alpha', 10, 20, 'tmdb', '550', 'Fight Club', '1999-10-15', 'A description')
  `).run();
  // A second row with every nullable column left null, so the nulls are
  // proven to survive as null rather than as 'null' or 0.
  seedMediaItem(raw, 'alpha', 30, 'Bare');

  assert.deepEqual(mediaItemById(raw, 'alpha', 1), {
    id: 1,
    title: 'Fight Club',
    releaseDate: '1999-10-15',
    description: 'A description',
    provider: 'tmdb',
    providerRef: '550',
    createdAt: 10,
    updatedAt: 20,
  });
  assert.deepEqual(mediaItemById(raw, 'alpha', 2), {
    id: 2,
    title: 'Bare',
    releaseDate: null,
    description: null,
    provider: null,
    providerRef: null,
    createdAt: 30,
    updatedAt: 30,
  });
  assert.equal(mediaItemById(raw, 'alpha', 404), null);
  assert.deepEqual(mediaItemByReference(raw, 'alpha', 'tmdb', '550')?.title, 'Fight Club');
  assert.equal(mediaItemByReference(raw, 'alpha', 'tmdb', 'nothing'), null);
});

test('an rss item page reads back its shape and pages by updated_at', () => {
  const raw = setup();
  const feedId = seedFeed(raw, 'https://example.com/feed');
  const mediaId = seedMediaItem(raw, 'alpha', 5, 'Item');
  seedRssItem(raw, feedId, 100, 'a.mkv', mediaId);
  seedRssItem(raw, feedId, 200, 'b.mkv');
  raw.prepare('UPDATE rss_item SET delivered_at = ? WHERE id = ?').run(150, 1);

  const page = rssItemsSince(raw, null);
  assert.deepEqual(page.items, [
    {
      id: 1,
      feedId: 1,
      filename: 'a.mkv',
      link: 'https://example.com/a.mkv',
      mediaItemId: 1,
      resolution: '1080p',
      resolutionDetail: 'x264',
      downloadType: 'torrent',
      deliveredAt: 150,
    },
    {
      id: 2,
      feedId: 1,
      filename: 'b.mkv',
      link: 'https://example.com/b.mkv',
      mediaItemId: null,
      resolution: '1080p',
      resolutionDetail: 'x264',
      downloadType: 'torrent',
      deliveredAt: null,
    },
  ]);
  assert.equal(page.cursor, encodeCursor({ updatedAt: 200, id: 2 }));
  assert.equal(page.done, true);

  // `rssItemsSince` is not plugin-scoped -- rss items belong to feeds, not to
  // plugins -- so a second feed's items page alongside the first's.
  const secondFeed = seedFeed(raw, 'https://example.com/other');
  seedRssItem(raw, secondFeed, 300, 'c.mkv');
  assert.deepEqual(rssItemsSince(raw, resume(page.cursor)).items.map((item) => item.id), [3]);

  // Only this media item's rss items, and only when asked for it.
  assert.deepEqual(rssItemsForMediaItem(raw, mediaId).map((item) => item.id), [1]);
  assert.deepEqual(rssItemsForMediaItem(raw, 404), []);
});

test('an rss item whose download_type is neither transport is refused rather than guessed', () => {
  // `download_type` is TEXT, so nothing in the schema stops a third value,
  // and `'usenet'` is a reachable one rather than a made-up one: migration 5
  // renamed it to `'nzb'` on `rss_feed` and only there, while the feed reader
  // copies a feed's value onto every item, so an item written before that
  // migration still holds it. Coercing it to 'torrent' would hand a plugin a
  // fact the row does not hold; the message names the row's id and the
  // offending value, and nothing else off the row.
  const raw = setup();
  const feedId = seedFeed(raw, 'https://example.com/feed');
  seedRssItem(raw, feedId, 100, 'a.mkv');
  raw.prepare('UPDATE rss_item SET download_type = ? WHERE id = ?').run('usenet', 1);

  assert.throws(() => rssItemsSince(raw, null), /rss item 1 has unknown download type "usenet"/);
});

test('a download page carries only the columns the read shape names, both transports', () => {
  const raw = setup();
  const feedId = seedFeed(raw, 'https://example.com/feed');
  const itemId = seedRssItem(raw, feedId, 10, 'a.mkv');
  const otherItemId = seedRssItem(raw, feedId, 10, 'b.mkv');
  const clientId = seedClient(raw, 'Client');
  seedTorrentDownload(raw, itemId, clientId, 100, 'ref-t1', 'abc123');
  seedNzbDownload(raw, itemId, clientId, 200, 'ref-n1');
  seedTorrentDownload(raw, otherItemId, clientId, 300, 'ref-t2', 'def456');

  assert.deepEqual(downloadsForRssItem(raw, itemId), [
    {
      id: 1,
      rssItemId: 1,
      downloadClientId: 1,
      transport: 'torrent',
      status: 'downloading',
      clientRef: 'ref-t1',
      infohash: 'abc123',
      percentage: 40,
      absentSince: null,
      deliveredAt: null,
      lastError: null,
    },
    {
      id: 1,
      rssItemId: 1,
      downloadClientId: 1,
      transport: 'nzb',
      status: 'completed',
      clientRef: 'ref-n1',
      infohash: null,
      percentage: 100,
      absentSince: 900,
      deliveredAt: 950,
      lastError: 'a failure',
    },
  ]);

  // The sync page spans both tables and both items, oldest first.
  const page = downloadsSince(raw, null);
  assert.deepEqual(page.items.map((row) => ({ id: row.id, transport: row.transport, rssItemId: row.rssItemId })), [
    { id: 1, transport: 'torrent', rssItemId: 1 },
    { id: 1, transport: 'nzb', rssItemId: 1 },
    { id: 2, transport: 'torrent', rssItemId: 2 },
  ]);
  assert.equal(page.cursor, encodeCursor({ updatedAt: 300, id: 2 }));

  // And it resumes across the union, not within one table.
  assert.deepEqual(
    downloadsSince(raw, { updatedAt: 100, id: 1 }).items.map((row) => row.transport),
    ['nzb', 'torrent'],
  );
});
