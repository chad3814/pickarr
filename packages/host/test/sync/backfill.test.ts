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

/**
 * The client design spec §5.3 describes, with nothing in it but the two
 * obligations that section puts on slice 2. A row is absent, held with a
 * value, or held as a tombstone.
 *
 * Deliberately a model of the *client*, not of the server: every op it
 * applies comes out of the real `backfillBefore` and the real `tailSince`,
 * so what these tests measure is whether the wire format the host actually
 * produces is enough to make the two cursors commute.
 */
type Held = { readonly title: string } | 'TOMBSTONE';

function applyOps(replica: Map<number, Held>, ops: readonly SyncOp[]): void {
  for (const op of ops) {
    if (op.table !== 'media_item') continue;
    // Obligation 2: a delete tombstones the row, it does not remove it.
    if (op.op === 'delete') { replica.set(op.id, 'TOMBSTONE'); continue; }
    // Obligation 1: a create never overwrites -- and a tombstone counts as
    // held, which is what obligation 2 is for.
    if (op.op === 'create' && replica.has(op.id)) continue;
    replica.set(op.id, { title: String((op.value as { title: unknown }).title) });
  }
}

/** The same apply, with obligation 1 dropped: a create overwrites. */
function applyOpsOverwriting(replica: Map<number, Held>, ops: readonly SyncOp[]): void {
  for (const op of ops) {
    if (op.table !== 'media_item') continue;
    if (op.op === 'delete') { replica.set(op.id, 'TOMBSTONE'); continue; }
    replica.set(op.id, { title: String((op.value as { title: unknown }).title) });
  }
}

/** The same apply, with obligation 2 dropped: a delete removes the row. */
function applyOpsRemoving(replica: Map<number, Held>, ops: readonly SyncOp[]): void {
  for (const op of ops) {
    if (op.table !== 'media_item') continue;
    if (op.op === 'delete') { replica.delete(op.id); continue; }
    if (op.op === 'create' && replica.has(op.id)) continue;
    replica.set(op.id, { title: String((op.value as { title: unknown }).title) });
  }
}

/** Current state as the model would hold it, for comparing a replica against. */
function truthOf(raw: ReturnType<typeof open>['raw']): readonly (readonly [number, string])[] {
  return raw.prepare('SELECT id, title FROM media_item ORDER BY id').all()
    .map((row) => [Number((row as { id: unknown }).id), String((row as { title: unknown }).title)] as const);
}

/** The live rows a replica holds, tombstones excluded, sorted by id. */
function liveOf(replica: Map<number, Held>): readonly (readonly [number, string])[] {
  return [...replica.entries()]
    .flatMap(([id, held]) => (held === 'TOMBSTONE' ? [] : [[id, held.title] as const]))
    .toSorted((a, b) => a[0] - b[0]);
}

test('every backfill op is a create and every tail op is an upsert or a delete', () => {
  // §5.3's split, on the wire. Widening either cursor's vocabulary is what
  // the two tests below then measure the consequences of.
  const { raw, registry } = open();
  for (let id = 1; id <= 3; id += 1) addItem(raw, id, id * 10);

  const page = backfillBefore(raw, registry, null, 10);
  assert.ok(page.ops.length > 0, 'fixture sanity: the walk must have sent something');
  assert.deepEqual([...new Set(page.ops.map((o) => o.op))], ['create'],
    'the walk says "here is a row you may not have", which is the only op kind a client may drop');

  const tailCursor = page.watermark;
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run('EDITED');
  raw.prepare('DELETE FROM media_item WHERE id = 2').run();
  const tail = tailSince(raw, registry, tailCursor, 100);
  const kinds = new Map(tail.ops.filter((o) => o.table === 'media_item').map((o) => [o.id, o.op]));
  assert.equal(kinds.get(1), 'upsert', 'a row that still exists is an upsert, which overwrites');
  assert.equal(kinds.get(2), 'delete');
  assert.ok(![...kinds.values()].includes('create'), 'the tail must never emit a create');
});

test('a stale page applied after a tail UPDATE leaves the newer value standing', () => {
  // The interleaving design spec §5.3's table missed, and the case the
  // op-kind split exists for. Page 2 is *read*, its response is in flight,
  // the row changes, the tail delivers the change, and only then does the
  // page land. The page carries the older value; obligation 1 is what stops
  // it being written, and nothing else can -- that row's log entry is
  // already consumed, so nothing ever re-sends it.
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);

  const replica = new Map<number, Held>();
  const page1 = backfillBefore(raw, registry, null, 2);
  applyOps(replica, page1.ops);
  let tailCursor = page1.watermark;

  const page2 = backfillBefore(raw, registry, page1.cursor, 2);   // read, now in flight
  assert.ok(page2.ops.some((o) => o.table === 'media_item' && o.id === 3),
    'page 2 really does carry item 3, or this proves nothing');

  raw.prepare('UPDATE media_item SET title = ? WHERE id = 3').run('EDITED');
  const tail = tailSince(raw, registry, tailCursor, 100);
  applyOps(replica, tail.ops);
  tailCursor = tail.cursor;
  assert.deepEqual(replica.get(3), { title: 'EDITED' }, 'the tail delivered the new value first');

  // The page lands, late. No `asOf` to check and nothing to refetch: the op
  // kind is the whole rule.
  applyOps(replica, page2.ops);
  assert.deepEqual(replica.get(3), { title: 'EDITED' },
    "the stale create must be dropped, not written over the tail's value");

  // And the counterfactual, so the assertion above is not vacuous: an
  // overwriting client ends up holding the value the page was read at.
  const naive = new Map<number, Held>(replica);
  applyOpsOverwriting(naive, page2.ops);
  assert.deepEqual(naive.get(3), { title: 't3' },
    'fixture sanity: without obligation 1 the stale page wins');

  // Finish both cursors, and the whole replica must be current state.
  let cursor = page2.cursor;
  while (cursor !== null) {
    const page = backfillBefore(raw, registry, cursor, 2);
    applyOps(replica, page.ops);
    cursor = page.cursor;
  }
  applyOps(replica, tailSince(raw, registry, tailCursor, 100).ops);
  assert.deepEqual(liveOf(replica), truthOf(raw), 'the replica must converge on current state');
});

test('a stale page applied after a tail DELETE leaves a tombstone, not a resurrected row', () => {
  // The same interleaving with a `DELETE`, which is why obligation 2 exists:
  // a create-never-overwrites rule on its own finds the row absent, because
  // the tail removed it, and puts it straight back. Permanent zombie.
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);

  const replica = new Map<number, Held>();
  const page1 = backfillBefore(raw, registry, null, 2);
  applyOps(replica, page1.ops);
  let tailCursor = page1.watermark;

  const page2 = backfillBefore(raw, registry, page1.cursor, 2);   // read, now in flight
  assert.ok(page2.ops.some((o) => o.table === 'media_item' && o.id === 3),
    'page 2 really does carry item 3, or this proves nothing');

  raw.prepare('DELETE FROM media_item WHERE id = 3').run();
  const tail = tailSince(raw, registry, tailCursor, 100);
  applyOps(replica, tail.ops);
  tailCursor = tail.cursor;
  assert.equal(replica.get(3), 'TOMBSTONE', 'the tail delivered the deletion first');

  applyOps(replica, page2.ops);
  assert.equal(replica.get(3), 'TOMBSTONE', 'the stale create must not resurrect the row');

  // The counterfactual that rules out obligation 1 alone: with a delete that
  // removes rather than tombstones, the row is absent when the page lands,
  // so the create applies and the row comes back.
  const removing = new Map<number, Held>();
  applyOpsRemoving(removing, page1.ops);
  applyOpsRemoving(removing, tail.ops);
  assert.ok(!removing.has(3), 'fixture sanity: a removing client has no record of the row at all');
  applyOpsRemoving(removing, page2.ops);
  assert.deepEqual(removing.get(3), { title: 't3' },
    'fixture sanity: without obligation 2 the stale page resurrects it');

  let cursor = page2.cursor;
  while (cursor !== null) {
    const page = backfillBefore(raw, registry, cursor, 2);
    applyOps(replica, page.ops);
    cursor = page.cursor;
  }
  applyOps(replica, tailSince(raw, registry, tailCursor, 100).ops);
  assert.deepEqual(liveOf(replica), truthOf(raw), 'no tombstoned row may appear among the live ones');
  assert.equal(replica.get(3), 'TOMBSTONE', 'and the deleted row stays tombstoned');
});

test("the ordinary order -- page first, tail op second -- still ends on the tail's value", () => {
  // The third case, and the one that would break if `create` were read as
  // "insert only, ever": the tail's `upsert` must overwrite what a page put
  // there, or a client would hold the backfill's value forever.
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);

  const replica = new Map<number, Held>();
  const page1 = backfillBefore(raw, registry, null, 2);
  applyOps(replica, page1.ops);
  const page2 = backfillBefore(raw, registry, page1.cursor, 2);
  applyOps(replica, page2.ops);
  assert.deepEqual(replica.get(3), { title: 't3' }, 'the page landed first this time');

  raw.prepare('UPDATE media_item SET title = ? WHERE id = 3').run('EDITED');
  applyOps(replica, tailSince(raw, registry, page1.watermark, 100).ops);
  assert.deepEqual(replica.get(3), { title: 'EDITED' }, 'an upsert overwrites, unlike a create');
});

test('the watermark is constant across a walk, however far the log moves under it', () => {
  // §5.2 promises the watermark only for the cursorless first call, and a
  // client that adopted a later page's rising watermark would skip every op
  // between the two. Carrying it in the cursor makes that harmless: it is
  // the same number on every page.
  const { raw, registry } = open();
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, id * 10);

  const first = backfillBefore(raw, registry, null, 2);
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 4').run('later');
  const second = backfillBefore(raw, registry, first.cursor, 2);

  // The log really did move between the two pages, or the equality below
  // would hold for the uninteresting reason that nothing happened.
  const mark = Number((raw.prepare('SELECT max(id) m FROM sync_log').get() as { m: unknown }).m);
  assert.ok(mark > first.watermark,
    `the log must have moved past the watermark, got ${mark} vs ${first.watermark}`);
  assert.equal(second.watermark, first.watermark, 'the walk keeps the watermark it started from');
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
