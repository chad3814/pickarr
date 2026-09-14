import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StatementSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { backfillBefore } from '../../src/sync/backfill.ts';
import { tailSince } from '../../src/sync/tail.ts';
import type { SyncOp } from '../../src/sync/tail.ts';

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

test('the walk is ordered by created_at, not by the updated_at a write moves', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, id * 10);
  // Bump `updated_at` past every `created_at` above, the way a real write
  // would: a plain `SET title = ?` leaves it untouched, which would make
  // this indistinguishable from a walk ordered by the mutable column too.
  // Done *before* the walk starts, so item 1's log entry sits at or below
  // the walk's watermark and the walk is the stream that owns it -- the
  // ordering is what this test is about, and a row the tail owns is skipped
  // by the walk for reasons that have nothing to do with ordering (see the
  // test below).
  raw.prepare('UPDATE media_item SET title = ?, updated_at = ? WHERE id = 1').run('touched', 999);

  const first = backfillBefore(raw, registry, null, 2);      // sees 4 and 3
  const rest = backfillBefore(raw, registry, first.cursor, 10);
  const walked = [...first.ops, ...rest.ops].filter((o) => o.table === 'media_item').map((o) => o.id);
  assert.deepEqual(walked, [4, 3, 2, 1], 'ordered by created_at; had it been updated_at, 1 would come first');
});

test('a row changed during the walk is left to the tail, and the walk says nothing about it', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 2);      // sees 4 and 3
  raw.prepare('UPDATE media_item SET title = ?, updated_at = ? WHERE id = 1').run('touched', 999);

  const rest = backfillBefore(raw, registry, first.cursor, 10);
  const walked = [...first.ops, ...rest.ops].filter((o) => o.table === 'media_item').map((o) => o.id);
  assert.deepEqual(walked, [4, 3, 2], 'item 1 is above the watermark, so the walk must not send it at all');

  const tail = tailSince(raw, registry, first.watermark, 100);
  const delivered = tail.ops.filter((o) => o.table === 'media_item' && o.id === 1);
  assert.equal(delivered.length, 1, 'the tail is the one stream that carries it');
  assert.equal((delivered[0]?.value as { title: string } | undefined)?.title, 'touched');
});

test('the walk carries a group forward even when the group row itself is left to the tail', () => {
  // Why skipping is per row and not per group. Item 1's own row changed
  // after the walk began, so the tail owns it -- but its release did not,
  // and the tail will never mention the release. Dropping the whole group
  // would lose that release for good: the keyset cursor moves past item 1
  // either way and never comes back.
  const { raw, registry } = open();
  raw.prepare('INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run('tv', 'a feed', 'https://example.test/feed', 100, 100);
  addItem(raw, 1, 100);
  addRelease(raw, 10, 1, 100);
  addItem(raw, 2, 200);

  const first = backfillBefore(raw, registry, null, 1);       // sees item 2 only
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run('touched');

  const rest = backfillBefore(raw, registry, first.cursor, 10);
  assert.deepEqual(rest.ops.filter((o) => o.table === 'media_item').map((o) => o.id), [],
    'the group row is above the watermark, so the tail owns it');
  assert.deepEqual(rest.ops.filter((o) => o.table === 'rss_item').map((o) => o.id), [10],
    'its release is below the watermark, so only the walk can ever deliver it');

  // The reference the page leaves forward is closed by the tail, from the
  // same watermark the client adopted -- never dangling for good.
  const tail = tailSince(raw, registry, first.watermark, 100);
  assert.ok(tail.ops.some((o) => o.table === 'media_item' && o.id === 1),
    'the tail must deliver the group row the page referenced but did not send');
});

test('a backfill page that lands after a tail op for one of its rows is detectably stale', () => {
  // The interleaving design spec §5.3's table missed. Page 2 is *read*, its
  // response is in flight, the row changes, the tail delivers the change,
  // and only then does the page land. Applying it would overwrite newer
  // state with older, permanently -- the row's log entry is already
  // consumed, so nothing re-sends it. `asOf` is what makes that detectable
  // without a per-row version: the client's tail cursor has passed it.
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);

  const replica = new Map<number, string>();
  const apply = (ops: readonly SyncOp[]): void => {
    for (const op of ops) {
      if (op.table !== 'media_item') continue;
      if (op.op === 'delete') replica.delete(op.id);
      else replica.set(op.id, (op.value as { title: string }).title);
    }
  };

  const page1 = backfillBefore(raw, registry, null, 2);
  apply(page1.ops);
  let tailCursor = page1.watermark;

  const page2 = backfillBefore(raw, registry, page1.cursor, 2);   // read, now in flight
  assert.ok(page2.ops.some((o) => o.table === 'media_item' && o.id === 3),
    'page 2 really does carry item 3, or this proves nothing');

  raw.prepare('UPDATE media_item SET title = ? WHERE id = 3').run('EDITED');
  const tail = tailSince(raw, registry, tailCursor, 100);
  apply(tail.ops);
  tailCursor = tail.cursor;

  // The page lands. The client's own tail cursor is now past the page's
  // `asOf`, which is the whole signal: discard and refetch the same cursor.
  assert.ok(tailCursor > page2.asOf,
    `the tail cursor (${tailCursor}) must have passed the page's asOf (${page2.asOf})`);
  const refetched = backfillBefore(raw, registry, page1.cursor, 2);
  apply(refetched.ops);

  let cursor = refetched.cursor;
  while (cursor !== null) {
    const page = backfillBefore(raw, registry, cursor, 2);
    assert.ok(tailCursor <= page.asOf, 'a page read after the tail caught up is fresh');
    apply(page.ops);
    cursor = page.cursor;
  }
  apply(tailSince(raw, registry, tailCursor, 100).ops);

  const truth = raw.prepare('SELECT id, title FROM media_item').all()
    .map((row) => [Number((row as { id: unknown }).id), String((row as { title: unknown }).title)] as const);
  assert.deepEqual([...replica.entries()].toSorted((a, b) => a[0] - b[0]),
    truth.toSorted((a, b) => a[0] - b[0]).map((pair) => [pair[0], pair[1]]),
    'the replica must converge on current state');
  assert.equal(replica.get(3), 'EDITED');
});

test('a stale page would resurrect a row the tail deleted, which asOf is what catches', () => {
  // The same interleaving with a `DELETE`, which is why the apply rule is
  // "do not apply a page your tail has passed" and not "a backfill op must
  // not overwrite a row the client already holds": insert-if-absent finds
  // the row absent, because the tail removed it, and puts it straight back.
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);

  const page1 = backfillBefore(raw, registry, null, 2);
  const replica = new Set(page1.ops.filter((o) => o.table === 'media_item').map((o) => o.id));
  let tailCursor = page1.watermark;

  const page2 = backfillBefore(raw, registry, page1.cursor, 2);   // read, now in flight
  raw.prepare('DELETE FROM media_item WHERE id = 3').run();

  const tail = tailSince(raw, registry, tailCursor, 100);
  for (const op of tail.ops) {
    if (op.table !== 'media_item') continue;
    if (op.op === 'delete') replica.delete(op.id); else replica.add(op.id);
  }
  tailCursor = tail.cursor;

  assert.ok(tailCursor > page2.asOf, "the client's tail has passed the page, so the page is stale");
  // Honouring that, the page is discarded rather than applied, and the
  // refetch no longer mentions the deleted row at all.
  const refetched = backfillBefore(raw, registry, page1.cursor, 2);
  for (const op of refetched.ops) if (op.table === 'media_item') replica.add(op.id);
  assert.ok(!replica.has(3), 'a row the tail deleted must not come back');

  // And the assertion that would fail had the page been applied regardless.
  const resurrected = new Set(replica);
  for (const op of page2.ops) if (op.table === 'media_item') resurrected.add(op.id);
  assert.ok(resurrected.has(3), 'fixture sanity: applying the stale page is what resurrects it');
});

test('the watermark is constant across a walk while asOf dates each page', () => {
  // §5.2 promises the watermark only for the cursorless first call, and a
  // client that adopted a later page's rising watermark would skip every op
  // between the two. Carrying it in the cursor makes that harmless: it is
  // the same number on every page. `asOf` is the number that moves.
  const { raw, registry } = open();
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, id * 10);

  const first = backfillBefore(raw, registry, null, 2);
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 4').run('later');
  const second = backfillBefore(raw, registry, first.cursor, 2);

  assert.equal(second.watermark, first.watermark, 'the walk keeps the watermark it started from');
  assert.ok(second.asOf > first.asOf, `asOf must move with the log, got ${second.asOf} after ${first.asOf}`);
  assert.equal(first.asOf, first.watermark, 'on the first page they are one read');
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

test('the watermark is read before the page, not after: a row created while a page is being hydrated is still delivered by the tail', () => {
  // Design spec §5.2/§5.3: the watermark must be the log's high-water mark
  // *before* the page's dependent rows are fetched, so anything that changes
  // during that fetch lands above it and reaches the client through the tail.
  // Mutation B (task-6-brief.md step 6) moves that read to the end of the
  // function; the brief predicted no test could tell the two apart because a
  // single synchronous statement sequence leaves no window for a concurrent
  // writer. That is wrong about the mechanism, not the conclusion it was
  // reaching for: there is no *thread* that can land a write mid-function, but
  // `backfillBefore` takes `raw` as a parameter, and nothing stops a caller's
  // `prepare` from doing something besides preparing a statement. Wrapping the
  // handle in a `Proxy` that inserts a row the moment the page's `rss_item`
  // lookup runs reproduces "changed while the page is being hydrated" with no
  // concurrency machinery at all -- ordinary dependency injection on a
  // parameter the function already takes.
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  addItem(raw, 2, 200);

  let injected = false;
  const spyRaw = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql: string): StatementSync => {
        const statement = target.prepare(sql);
        // The first statement that reads `rss_item` is the page's
        // dependent-row lookup (`backfillBefore`'s releases query), run
        // strictly after both the watermark and the item page are already
        // read. Injecting here, through the *real* handle -- never the
        // proxy, which would recurse -- lands the write inside exactly the
        // window the correctness of §5.3's table depends on.
        if (!injected && sql.includes('FROM rss_item')) {
          injected = true;
          addItem(raw, 9, 999);
        }
        return statement;
      };
    },
  });

  const page = backfillBefore(spyRaw, registry, null, 10);
  assert.ok(injected, 'the interception must actually have fired, or this test proves nothing');

  const concurrentLogRow = raw.prepare(
    "SELECT id FROM sync_log WHERE table_name = 'media_item' AND row_id = 9",
  ).get() as { id: unknown };
  const concurrentLogId = Number(concurrentLogRow.id);

  // First half: the watermark itself must sit below the concurrent write's
  // log entry. Asserting only the second half (below) would pass for the
  // wrong reason if the walk happened to pick the row up on its own.
  assert.ok(
    page.watermark < concurrentLogId,
    `watermark (${page.watermark}) must be captured before the concurrent write (log id ${concurrentLogId}), not after`,
  );

  // Second half: the tail, from that watermark, actually delivers it -- the
  // walk itself never can, since row 9 (created_at 999) is newer than every
  // item the walk started from.
  const tail = tailSince(raw, registry, page.watermark, 100);
  assert.ok(
    tail.ops.some((o) => (o.value as { id: number } | undefined)?.id === 9),
    'the tail, from that watermark, must deliver the row the walk could never have seen',
  );
});
