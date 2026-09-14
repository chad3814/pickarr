/**
 * The pivot an empty client starts both cursors from.
 *
 * Every test here passes its own `targetItems` rather than the shipped
 * `BOOTSTRAP_ITEMS`: at 40, no fixture small enough to read would ever reach
 * the per-category `OFFSET` branch, so the whole computation would be
 * exercised through its fallback and nothing would pin the offset at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { BOOTSTRAP_ITEMS, bootstrapCursors } from '../../src/sync/bootstrap.ts';
import { backfillBefore } from '../../src/sync/backfill.ts';
import { tailSince } from '../../src/sync/tail.ts';
import type { SyncOp } from '../../src/sync/tail.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.prepare('INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run('tv', 'a feed', 'https://example.test/feed', 1, 1);
  return raw;
};

const addItem = (raw: DatabaseSync, id: number, pluginId: string, updatedAt: number) =>
  raw.prepare('INSERT INTO media_item (id, plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?)')
    .run(id, pluginId, updatedAt, updatedAt, `t${id}`);

const addRelease = (raw: DatabaseSync, id: number, mediaItemId: number | null) =>
  raw.prepare(`INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution)
               VALUES (?, 1, ?, ?, 1, 1, 'torrent', ?, '1080p')`)
    .run(id, `f${id}`, `l${id}`, mediaItemId);

/** The log, as `<id>:<table>/<row>`, which is how the brief's measurements read. */
const logOf = (raw: DatabaseSync): string[] =>
  raw.prepare('SELECT id, table_name, row_id FROM sync_log ORDER BY id').all().map((row) => {
    const entry = row as { id: unknown; table_name: unknown; row_id: unknown };
    return `${String(Number(entry.id))}:${String(entry.table_name)}/${String(Number(entry.row_id))}`;
  });

/** One op as a row identity, for comparing what the two cursors delivered. */
const keyOf = (op: SyncOp): string => `${op.table}/${String(op.id)}`;

/** Where one row sits in the log. */
const logIdOf = (raw: DatabaseSync, table: string, rowId: number): number =>
  Number((raw.prepare('SELECT id FROM sync_log WHERE table_name = ? AND row_id = ?').get(table, rowId) as
    { id: unknown }).id);

test('the two cursors meet at the pivot and overlap nowhere', () => {
  // `since` is `W - 1` rather than the tail being made `>=` at bootstrap:
  // `since` means "I have through here" on every other call, and one
  // parameter with two meanings is what a client mis-handles later.
  const raw = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, 'tv', id * 10);

  const cursors = bootstrapCursors(raw, 2);
  assert.equal(cursors.since, cursors.before - 1,
    'the tail takes ids above `since` and the walk ids below `before`, so they must differ by exactly one');
});

test('a client starting from the pivot receives every live row exactly once', () => {
  const raw = open();
  for (let id = 1; id <= 6; id += 1) { addItem(raw, id, 'tv', id * 10); addRelease(raw, id + 20, id); }
  const registry = createSyncRegistry(raw, []);

  const cursors = bootstrapCursors(raw, 2);
  const walked: SyncOp[] = [];
  let cursor: number | null = cursors.before;
  while (cursor !== null) {
    const page = backfillBefore(raw, registry, cursor, 3);
    walked.push(...page.ops);
    cursor = page.cursor;
  }
  const tailed = tailSince(raw, registry, cursors.since, 100).ops;

  const delivered = [...walked, ...tailed].map(keyOf);
  assert.equal(new Set(delivered).size, delivered.length, 'no row may be delivered twice');

  const live = raw.prepare("SELECT 'media_item' t, id FROM media_item UNION ALL SELECT 'rss_item' t, id FROM rss_item")
    .all().map((row) => {
      const entry = row as { t: unknown; id: unknown };
      return `${String(entry.t)}/${String(Number(entry.id))}`;
    });
  assert.deepEqual(delivered.toSorted(), live.toSorted(), 'and every live row must be delivered by one of them');

  // Both cursors productive from their first request, which is the point of
  // choosing a floor part-way down rather than the top of the log.
  assert.ok(walked.length > 0, 'the walk has rows below the pivot');
  assert.ok(tailed.length > 0, 'and the tail has rows above it');
});

test('the pivot leaves roughly the newest `targetItems` above itself, per category', () => {
  // The offset is `targetItems / categories`, so each category contributes
  // its own share and the oldest of those candidates wins.
  const raw = open();
  // Two categories, four items each, ascending `updated_at` by id.
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, 'tv', id * 10);
  for (let id = 5; id <= 8; id += 1) addItem(raw, id, 'movie', id * 10);

  // `targetItems` 4 over 2 categories is an offset of 2: the third-newest of
  // each, so tv item 2 and movie item 6. Item 2 is the older of the two.
  const cursors = bootstrapCursors(raw, 4);
  assert.equal(cursors.before, logIdOf(raw, 'media_item', 2),
    'the walk starts below item 2, so items 3, 4, 7 and 8 -- and 5, 6 -- are the tail\'s');
});

test('a category with too few items falls back to its oldest, rather than dropping out', () => {
  const raw = open();
  addItem(raw, 1, 'tv', 100);
  addItem(raw, 2, 'tv', 200);
  addItem(raw, 3, 'tv', 300);
  // One item only, so an offset of 2 lands past the end of this category --
  // and it is older than every `tv` item, so it is the answer *only* if the
  // fallback runs. Without it the short category contributes nothing and
  // `tv`'s own candidate, item 1, would be the floor instead.
  addItem(raw, 9, 'movie', 5);

  const cursors = bootstrapCursors(raw, 4);
  assert.equal(cursors.before, logIdOf(raw, 'media_item', 9),
    "the short category's oldest item is the oldest candidate, so it is the floor");
});

test('the oldest candidate across categories wins, not the first one asked', () => {
  const raw = open();
  // `movie`'s candidate is newer than `tv`'s, and `movie` sorts first by
  // name -- so a computation that took the first category's answer, or the
  // newest, would pick the wrong one.
  addItem(raw, 1, 'tv', 10);
  addItem(raw, 2, 'tv', 20);
  addItem(raw, 3, 'movie', 500);
  addItem(raw, 4, 'movie', 600);

  const cursors = bootstrapCursors(raw, 2);   // offset 1: tv item 1, movie item 3
  assert.equal(cursors.before, logIdOf(raw, 'media_item', 1), 'tv item 1 at updated_at 10 is the oldest candidate');
});

test('the pivot is the lower of the group row and its latest release, with the media_item written first', () => {
  // Production's order, measured: the rss_item is inserted, then
  // `createMediaItem` runs, then `relinkRssItem` *updates* the rss_item --
  // which re-logs it above the media_item. So the media_item is normally the
  // group's floor.
  const raw = open();
  addItem(raw, 1, 'tv', 10);
  addRelease(raw, 21, 1);
  addRelease(raw, 22, 1);
  assert.deepEqual(logOf(raw), ['1:media_item/1', '2:rss_item/21', '3:rss_item/22'], 'fixture: media_item first');

  const cursors = bootstrapCursors(raw, 1);
  assert.equal(cursors.before, 1, "the media_item's own entry is the lower of the two");
});

test('the pivot is the lower of the two with a later media_item update inverting them', () => {
  // The other way round, and why taking the MIN matters: a `media_item`
  // update after its releases puts the group row *above* them. Taking the
  // group row alone would then leave the card's newest release below the
  // pivot, on the walk's side, while the card itself came from the tail.
  const raw = open();
  addRelease(raw, 21, null);
  addRelease(raw, 22, null);
  addItem(raw, 1, 'tv', 10);
  raw.prepare('UPDATE rss_item SET media_item_id = 1 WHERE id IN (21, 22)').run();
  // And a later touch on the group row, which is what inverts the order.
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run('renamed');
  assert.deepEqual(logOf(raw), ['4:rss_item/21', '5:rss_item/22', '6:media_item/1'],
    'fixture: the group row now sits above both of its releases');

  const cursors = bootstrapCursors(raw, 1);
  assert.equal(cursors.before, 5, "the latest release's entry is the lower of the two, so it is the pivot");

  // The property that arithmetic buys: the card's newest release reaches the
  // client through the tail, beside the card itself, rather than waiting for
  // the walk to come round to it.
  const registry = createSyncRegistry(raw, []);
  const tailed = tailSince(raw, registry, cursors.since, 100).ops;
  assert.ok(tailed.some((op) => op.table === 'rss_item' && op.id === 22), 'the newest release is on the tail side');
  assert.ok(tailed.some((op) => op.table === 'media_item' && op.id === 1), 'and so is the card');
});

test('a media item with no releases uses its own entry', () => {
  const raw = open();
  addItem(raw, 1, 'tv', 10);
  const cursors = bootstrapCursors(raw, 1);
  assert.equal(cursors.before, logIdOf(raw, 'media_item', 1),
    'a null `max(rss_item.id)` must leave the media_item clause answering alone');
});

test('an empty library answers a pivot above the whole log, so the walk can still find everything', () => {
  const raw = open();
  // `rss_feed` is not synced, so this library has a log with nothing in it.
  assert.deepEqual(logOf(raw), []);
  assert.deepEqual(bootstrapCursors(raw, 4), { since: 0, before: 1 },
    'a tail from 0 and a walk below 1 over an empty log are both empty, and neither is wrong');

  // An unattached release with no media item at all: there is no category to
  // ask, so the pivot goes above the log and the walk owns everything. N11.
  addRelease(raw, 21, null);
  const cursors = bootstrapCursors(raw, 4);
  const registry = createSyncRegistry(raw, []);
  assert.deepEqual(backfillBefore(raw, registry, cursors.before, 10).ops.map((op) => op.id), [21],
    'the walk must reach a row no media item names');
});

test('the shipped target is a number, and the per-category queries seek rather than scan', () => {
  // `EXPLAIN QUERY PLAN` over the statements this module actually runs, the
  // way `api/reads.test.ts` pins its own: the candidate query is the one
  // called once per category, so a scan here would be a scan per category on
  // every bootstrap.
  assert.ok(Number.isInteger(BOOTSTRAP_ITEMS) && BOOTSTRAP_ITEMS > 0, 'the shipped target must be a positive integer');

  const raw = open();
  const plan = (sql: string): string => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
    .map((row) => String((row as { detail: unknown }).detail)).join(' | ');

  assert.equal(
    plan('SELECT id, updated_at AS updatedAt FROM media_item WHERE plugin_id = ?'
      + ' ORDER BY updated_at DESC, id DESC LIMIT 1 OFFSET ?'),
    'SEARCH media_item USING COVERING INDEX media_item_sync (plugin_id=?)',
  );
  assert.equal(
    plan('SELECT id, updated_at AS updatedAt FROM media_item WHERE plugin_id = ?'
      + ' ORDER BY updated_at ASC, id ASC LIMIT 1'),
    'SEARCH media_item USING COVERING INDEX media_item_sync (plugin_id=?)',
  );
  assert.equal(
    plan('SELECT max(id) AS latest FROM rss_item WHERE media_item_id = ?'),
    'SEARCH rss_item USING COVERING INDEX rss_item_media_item (media_item_id=?)',
  );
  assert.match(
    plan("SELECT min(id) AS entry FROM sync_log WHERE (table_name = 'media_item' AND row_id = ?)"
      + " OR (table_name = 'rss_item' AND row_id = ?)"),
    /MULTI-INDEX OR/,
    'both arms of the OR must seek `sync_log_row` rather than scanning the log',
  );

  // The two forms this computation is deliberately *not* written in, and the
  // measurements that rejected them. A window function plans a full scan plus
  // a sort where the per-category form seeks:
  const windowed = plan('SELECT id, ROW_NUMBER() OVER (PARTITION BY plugin_id ORDER BY updated_at DESC, id DESC) rn'
    + ' FROM media_item');
  assert.match(windowed, /SCAN media_item USING COVERING INDEX media_item_sync/);
  assert.match(windowed, /USE TEMP B-TREE/);
});

test('GROUP BY plugin_id would index categories rather than items, which is why it is not used', () => {
  // The second rejected form, measured as behaviour rather than as a plan:
  // it collapses to one row per category, so an OFFSET indexes categories,
  // and `max(id)` is the highest rowid rather than the newest by
  // `updated_at`.
  const raw = open();
  addItem(raw, 1, 'tv', 900);      // newest by updated_at, lowest id
  addItem(raw, 2, 'tv', 10);
  addItem(raw, 3, 'tv', 20);

  const grouped = raw.prepare('SELECT plugin_id, max(id) m FROM media_item GROUP BY plugin_id').all();
  assert.equal(grouped.length, 1, 'one row per category, so an offset over this indexes categories');
  assert.equal(Number((grouped[0] as { m: unknown }).m), 3,
    'and `max(id)` is the highest rowid, which is item 3 -- not item 1, the newest by updated_at');

  // What this module answers instead: the newest by `updated_at` really is
  // item 1, which is the row the offset counts down from.
  assert.equal(bootstrapCursors(raw, 1).before, logIdOf(raw, 'media_item', 3),
    'offset 1 from the newest by updated_at (item 1) reaches item 3 at updated_at 20');
});
