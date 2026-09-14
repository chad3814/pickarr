import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { backfillBefore } from '../../src/sync/backfill.ts';
import { tailSince } from '../../src/sync/tail.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return { raw, registry: createSyncRegistry(raw, []) };
};
const addItem = (raw: ReturnType<typeof open>['raw'], id: number, createdAt: number) =>
  raw.prepare('INSERT INTO media_item (id, plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'tv', createdAt, createdAt, `t${id}`);
const addRelease = (raw: ReturnType<typeof open>['raw'], id: number, mediaItemId: number, createdAt: number) =>
  raw.prepare(`INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution)
               VALUES (?, 1, ?, ?, ?, ?, 'torrent', ?, '1080p')`)
    .run(id, `f${id}`, `l${id}`, createdAt, createdAt, mediaItemId);

test('the newest media item comes first', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 100); addItem(raw, 2, 300); addItem(raw, 3, 200);
  const page = backfillBefore(raw, registry, null, 10);
  const items = page.ops.filter((o) => o.table === 'media_item')
    .map((o) => (o.value as { id: number }).id);
  assert.deepEqual(items, [2, 3, 1], 'newest created_at first');
});

test('a group arrives with its releases, and the group before them', () => {
  const { raw, registry } = open();
  // `rss_item.feed_id` is `NOT NULL REFERENCES rss_feed (id)`, enforced --
  // `db/open.ts` turns `PRAGMA foreign_keys` on -- so a release needs a real
  // feed row to point at before it can be inserted at all.
  raw.prepare('INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run('tv', 'a feed', 'https://example.test/feed', 100, 100);
  addItem(raw, 1, 100);
  addRelease(raw, 10, 1, 100); addRelease(raw, 11, 1, 100);
  const page = backfillBefore(raw, registry, null, 10);
  const order = page.ops.map((o) => o.table);
  assert.equal(order[0], 'media_item', 'the group must precede anything referencing it');
  assert.equal(order.filter((t) => t === 'rss_item').length, 2);
});

test('paging is stable, and resuming skips nothing and repeats nothing', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 2);
  assert.ok(first.cursor !== null);
  const second = backfillBefore(raw, registry, first.cursor, 2);
  const seen = [...first.ops, ...second.ops]
    .filter((o) => o.table === 'media_item').map((o) => (o.value as { id: number }).id);
  assert.deepEqual(seen, [6, 5, 4, 3]);
});

test('an exhausted walk returns a null cursor', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  const page = backfillBefore(raw, registry, null, 10);
  assert.equal(page.cursor, null);
});

test('the first page carries the watermark, so the tail can start without a round trip', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  const page = backfillBefore(raw, registry, null, 10);
  assert.ok(page.watermark > 0);
  assert.deepEqual(tailSince(raw, registry, page.watermark, 10).ops, [], 'the tail at the watermark is empty');
});

test('a row changed during the walk reaches the client on the tail, not the walk', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 2);      // sees 4 and 3
  // Bump `updated_at` past every `created_at` above, the way a real write
  // would: a plain `SET title = ?` leaves it untouched, which would make
  // this indistinguishable from a walk ordered by the mutable column too.
  raw.prepare('UPDATE media_item SET title = ?, updated_at = ? WHERE id = 1').run('touched', 999);
  const rest = backfillBefore(raw, registry, first.cursor, 10);
  const tail = tailSince(raw, registry, first.watermark, 100);
  const walked = [...first.ops, ...rest.ops].filter((o) => o.table === 'media_item')
    .map((o) => (o.value as { id: number }).id);
  assert.deepEqual(walked, [4, 3, 2, 1], 'the walk is ordered by created_at, which the update did not change');
  assert.ok(tail.ops.some((o) => (o.value as { id: number } | undefined)?.id === 1),
    'and the tail carries the change regardless');
});

test('a row created during the walk is never reached by it, and arrives on the tail', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 3; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 2);      // sees 3 and 2
  addItem(raw, 9, 999);                                       // newer than the walk's start
  const rest = backfillBefore(raw, registry, first.cursor, 10);
  const walked = [...first.ops, ...rest.ops].filter((o) => o.table === 'media_item')
    .map((o) => (o.value as { id: number }).id);
  assert.ok(!walked.includes(9), 'the backwards walk can never reach a row newer than its start');
  assert.ok(tailSince(raw, registry, first.watermark, 100).ops
    .some((o) => (o.value as { id: number } | undefined)?.id === 9), 'the tail delivers it');
});

test('a row deleted before the walk reaches it is never sent as a create', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 3; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 1);       // sees 3
  raw.prepare('DELETE FROM media_item WHERE id = 1').run();
  const rest = backfillBefore(raw, registry, first.cursor, 10);
  const walked = [...first.ops, ...rest.ops].filter((o) => o.table === 'media_item')
    .map((o) => (o.value as { id: number }).id);
  assert.ok(!walked.includes(1));
});
