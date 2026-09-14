/**
 * The backwards walk over `sync_log`, and the two cursors together.
 *
 * Every test here fixes the pivot itself rather than reading one back off a
 * page: the walk no longer returns a watermark, because it no longer needs
 * one. `sync/bootstrap.ts` is what computes a real client's pivot, and
 * `test/sync/bootstrap.test.ts` covers that computation; what belongs here is
 * what the walk does given a pivot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { HOST_MIGRATIONS, migrateHost, migrateHostWith } from '../../src/db/migrate.ts';
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
const addFeed = (raw: ReturnType<typeof open>['raw']) =>
  raw.prepare('INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run('tv', 'a feed', 'https://example.test/feed', 100, 100);
const addRelease = (raw: ReturnType<typeof open>['raw'], id: number, mediaItemId: number, createdAt: number) =>
  raw.prepare(`INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution)
               VALUES (?, 1, ?, ?, ?, ?, 'torrent', ?, '1080p')`)
    .run(id, `f${id}`, `l${id}`, createdAt, createdAt, mediaItemId);

/**
 * The log's high-water mark: the pivot a client bootstrapping right now would
 * be handed, give or take the floor `sync/bootstrap.ts` picks. `+ 1` is what
 * makes the walk's `< pivot` include the newest entry, the same relation
 * `bootstrap.ts` establishes between its two cursors.
 */
const pivotAboveEverything = (raw: ReturnType<typeof open>['raw']): number =>
  Number((raw.prepare('SELECT coalesce(max(id), 0) m FROM sync_log').get() as { m: unknown }).m) + 1;

/** The row ids one cursor served for a table, in the order it served them. */
const idsFor = (ops: readonly SyncOp[], table: string): number[] =>
  ops.filter((op) => op.table === table).map((op) => op.id);

/** One op as a row identity, for comparing what two cursors delivered. */
const keyOf = (op: SyncOp): string => `${op.table}/${String(op.id)}`;

test('the walk serves the newest log entry first, one op per entry', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 100); addItem(raw, 2, 300); addItem(raw, 3, 200);

  const page = backfillBefore(raw, registry, pivotAboveEverything(raw), 10);
  assert.deepEqual(idsFor(page.ops, 'media_item'), [3, 2, 1],
    'log order, newest entry first -- and log order is insertion order, not created_at order');
});

test('a page is `limit` rows, not `limit` hydrated groups', () => {
  // What the walk buys by paging the log rather than current state: the old
  // walk took `limit` *media items* and emitted every dependent row of each,
  // so a response's size was whatever those groups happened to weigh. A
  // response is now bounded by `limit` directly.
  const { raw, registry } = open();
  addFeed(raw);
  addItem(raw, 1, 100);
  for (let id = 10; id < 20; id += 1) addRelease(raw, id, 1, 100);

  const page = backfillBefore(raw, registry, pivotAboveEverything(raw), 4);
  assert.equal(page.ops.length, 4, 'four rows, whatever they belong to');
  assert.deepEqual(idsFor(page.ops, 'rss_item'), [19, 18, 17, 16],
    'and they are the four newest entries, which all happen to be releases of one group');
});

test('a delete entry in the walk path does not cost the page a row', () => {
  // `op != 'delete'` in the walk's predicate, and what it is worth. Without
  // it a deleted row's entry occupies a slot in the page and resolves to
  // nothing, so `limit` would mean "rows looked at" rather than "rows
  // served" -- and a library with a long deletion history would serve
  // progressively emptier pages.
  //
  // Building a delete entry *below* the pivot takes a write after it: the
  // collapse gives a deleted row's entry a fresh, higher id, so a deletion is
  // above the pivot at the instant it happens and only falls below a later
  // one.
  const { raw, registry } = open();
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, id * 10);
  raw.prepare('DELETE FROM media_item WHERE id = 2').run();
  addItem(raw, 9, 900);
  const pivot = pivotAboveEverything(raw);

  const entries = raw.prepare('SELECT row_id, op FROM sync_log WHERE id < ? ORDER BY id DESC').all(pivot)
    .map((row) => {
      const entry = row as { row_id: unknown; op: unknown };
      return `${String(entry.op)}:${Number(entry.row_id)}`;
    });
  assert.deepEqual(entries, ['upsert:9', 'delete:2', 'upsert:4', 'upsert:3', 'upsert:1'],
    'fixture: a delete entry sits second in the walk path');

  const page = backfillBefore(raw, registry, pivot, 2);
  assert.deepEqual(idsFor(page.ops, 'media_item'), [9, 4],
    'two rows served, so the delete entry was never one of the two the page spent');
});

test('paging resumes exactly where it stopped, skipping nothing and repeating nothing', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);

  const first = backfillBefore(raw, registry, pivotAboveEverything(raw), 2);
  assert.ok(first.cursor !== null);
  const second = backfillBefore(raw, registry, first.cursor, 2);
  assert.deepEqual(idsFor([...first.ops, ...second.ops], 'media_item'), [6, 5, 4, 3]);
});

test('an exhausted walk returns a null cursor', () => {
  // A short page is a permanent exhaustion, not a momentary one: every entry
  // the log gains takes a *higher* id, and a re-logged row's old entry is
  // deleted, so nothing ever appears below a point the walk has passed.
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  const page = backfillBefore(raw, registry, pivotAboveEverything(raw), 10);
  assert.equal(page.cursor, null);
  assert.equal(backfillBefore(raw, registry, pivotAboveEverything(raw), 1).cursor, 1,
    'and a full page does return one, so the null above is not unconditional');
});

test('no before at all walks from the newest entry, which is the whole log', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 3; id += 1) addItem(raw, id, id * 10);
  const page = backfillBefore(raw, registry, null, 10);
  assert.deepEqual(idsFor(page.ops, 'media_item'), [3, 2, 1]);
});

test('the cursor advances past an entry whose table the registry does not know', () => {
  // The mirror of `tail.test.ts`'s own version, and it matters for the same
  // reason: the cursor is the last *entry* the page read, not the last op it
  // served. Returning the lowest served op's id instead would hand the
  // skipped entry back on every following page, and a page made entirely of
  // skipped entries would stall the walk outright.
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  raw.prepare('INSERT INTO sync_log (table_name, row_id, op, at) VALUES (?, ?, ?, ?)')
    .run('secret', 7, 'upsert', 1);
  const pivot = pivotAboveEverything(raw);

  const page = backfillBefore(raw, registry, pivot, 1);
  assert.deepEqual(page.ops, [], 'the newest entry names a table nobody declares, so nothing is served');
  assert.ok(page.cursor !== null && page.cursor < pivot, 'and the cursor still moved past it');

  const next = backfillBefore(raw, registry, page.cursor, 10);
  assert.deepEqual(idsFor(next.ops, 'media_item'), [1], 'so the walk reaches the row below it');
});

test('a row written before sync_log existed is served, because migration 15 seeded it', () => {
  // The one correctness hole a log walk has and a current-state walk did not.
  // Without `migration15`'s seed these rows have no log entry at all, so the
  // walk serves none of them -- not late, never.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 14));
  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, created_at, updated_at, title)
    VALUES (1, 'tv', 1, 1, 'old'), (2, 'tv', 2, 2, 'older')
  `).run();
  migrateHostWith(raw, HOST_MIGRATIONS);

  const registry = createSyncRegistry(raw, []);
  const page = backfillBefore(raw, registry, pivotAboveEverything(raw), 10);
  assert.deepEqual(idsFor(page.ops, 'media_item').toSorted((a, b) => a - b), [1, 2],
    'both rows that predate the log must be reachable');
});

test('the walk and the tail partition the log at the pivot, with no row in both', () => {
  // Disjointness is now arithmetic rather than a per-page query: the tail
  // takes `id > pivot - 1` and the walk takes `id < pivot`, which meet exactly
  // and overlap nowhere. `sync/bootstrap.ts` is what hands a client that pair.
  const { raw, registry } = open();
  addFeed(raw);
  for (let id = 1; id <= 5; id += 1) { addItem(raw, id, id * 10); addRelease(raw, id + 20, id, id * 10); }
  const pivot = 6;

  const walked: SyncOp[] = [];
  let cursor: number | null = pivot;
  while (cursor !== null) {
    const page = backfillBefore(raw, registry, cursor, 3);
    walked.push(...page.ops);
    cursor = page.cursor;
  }
  const tailed = tailSince(raw, registry, pivot - 1, 100).ops;

  const fromWalk = new Set(walked.map(keyOf));
  const fromTail = new Set(tailed.map(keyOf));
  const both = [...fromWalk].filter((entry) => fromTail.has(entry));
  assert.deepEqual(both, [], 'no row may be delivered by both cursors');

  // And together they cover everything, so the partition loses nothing. A
  // walk that overlapped the tail would pass the assertion above only by
  // losing rows, which this rules out.
  const live = raw.prepare("SELECT 'media_item' t, id FROM media_item UNION ALL SELECT 'rss_item' t, id FROM rss_item")
    .all().map((row) => {
      const entry = row as { t: unknown; id: unknown };
      return `${String(entry.t)}/${String(Number(entry.id))}`;
    });
  assert.deepEqual([...new Set([...fromWalk, ...fromTail])].toSorted(), live.toSorted(),
    'every live row reaches the client through exactly one of the two');
});

test('a row changed after the pivot is the tail\'s, and the walk never mentions it', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, id * 10);
  const pivot = pivotAboveEverything(raw);
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run('touched');

  const walked: number[] = [];
  let cursor: number | null = pivot;
  while (cursor !== null) {
    const page = backfillBefore(raw, registry, cursor, 2);
    walked.push(...idsFor(page.ops, 'media_item'));
    cursor = page.cursor;
  }
  assert.deepEqual(walked, [4, 3, 2],
    "item 1's entry moved above the pivot when it changed, so the walk cannot reach it");

  const tail = tailSince(raw, registry, pivot - 1, 100);
  const delivered = tail.ops.filter((op) => op.table === 'media_item' && op.id === 1);
  assert.equal(delivered.length, 1, 'the tail is the one stream that carries it');
  assert.equal((delivered[0]?.value as { title: string } | undefined)?.title, 'touched');
});

test('a row created after the pivot is never reached by the walk, and arrives on the tail', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 3; id += 1) addItem(raw, id, id * 10);
  const pivot = pivotAboveEverything(raw);
  addItem(raw, 9, 999);

  const page = backfillBefore(raw, registry, pivot, 10);
  assert.ok(!idsFor(page.ops, 'media_item').includes(9), 'its entry is above the pivot');
  assert.ok(tailSince(raw, registry, pivot - 1, 100).ops.some((op) => op.table === 'media_item' && op.id === 9),
    'the tail delivers it');
});

test('a row deleted before the walk reaches it is never sent as a create', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 3; id += 1) addItem(raw, id, id * 10);
  const pivot = pivotAboveEverything(raw);
  raw.prepare('DELETE FROM media_item WHERE id = 1').run();

  const page = backfillBefore(raw, registry, pivot, 10);
  assert.ok(!idsFor(page.ops, 'media_item').includes(1));
});

test('a row deleted between the entry query and the hydration resolves to nothing, not to a tombstone', () => {
  // The one case `op != 'delete'` cannot cover, and why the walk skips an
  // unresolved row as well as filtering the predicate: the entry says
  // `upsert` and the row is gone by the time it is read. A client that never
  // held the row needs no tombstone, so the walk says nothing at all -- and
  // if the client *did* hold it, the deletion re-logged the row above the
  // pivot and the tail carries the tombstone.
  //
  // Injected through the handle the function already takes, the way
  // `tail.test.ts` and this file's predecessor both do: nothing stops a
  // caller's `prepare` from doing something besides preparing a statement.
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  addItem(raw, 2, 200);
  const pivot = pivotAboveEverything(raw);

  let injected = false;
  const spyRaw = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        // The first statement naming `media_item` is the hydration, run
        // strictly after the entry page has already been read. Deleting here
        // through the *real* handle -- never the proxy, which would recurse --
        // lands the write in exactly that window.
        if (!injected && sql.includes('FROM media_item')) {
          injected = true;
          raw.prepare('DELETE FROM media_item WHERE id = 2').run();
        }
        return target.prepare(sql);
      };
    },
  });

  const page = backfillBefore(spyRaw, registry, pivot, 10);
  assert.ok(injected, 'the interception must actually have fired, or this test proves nothing');
  assert.deepEqual(idsFor(page.ops, 'media_item'), [1], 'row 2 resolved to nothing and was dropped');
  assert.ok(!page.ops.some((op) => op.op === 'delete'), 'and the walk emitted no delete of any kind');
});

test('the walk emits in log order, so an op may name a synced row that arrives later in the walk', () => {
  // A property the group-hydrated walk had and this one does not, accepted
  // rather than papered over. The old walk emitted a `media_item` before its
  // own `rss_item` rows; log order is insertion order, and production inserts
  // the release first (`relinkRssItem`), so the reference points at a row the
  // client has not received yet.
  //
  // It arrives elsewhere in the same walk, and the client already tolerates a
  // reference it cannot resolve: `rss_item.feed_id` and
  // `torrent_download.download_client_id` name tables that are never synced
  // at all (`sync/tables.ts`).
  const { raw, registry } = open();
  addFeed(raw);
  addRelease(raw, 10, null as unknown as number, 100);
  addItem(raw, 1, 100);
  raw.prepare('UPDATE rss_item SET media_item_id = 1 WHERE id = 10').run();
  const pivot = pivotAboveEverything(raw);

  const page = backfillBefore(raw, registry, pivot, 10);
  const order = page.ops.map((op) => op.table);
  assert.deepEqual(order, ['rss_item', 'media_item'],
    'the release was written last, so it is emitted first -- ahead of the item it names');
  assert.equal((page.ops[0]?.value as { media_item_id: number } | undefined)?.media_item_id, 1,
    'and it does carry the forward reference');
  assert.ok(idsFor(page.ops, 'media_item').includes(1), 'which the same walk resolves, further down');
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
  const pivot = pivotAboveEverything(raw);

  const page = backfillBefore(raw, registry, pivot, 10);
  assert.ok(page.ops.length > 0, 'fixture sanity: the walk must have sent something');
  assert.deepEqual([...new Set(page.ops.map((op) => op.op))], ['create'],
    'the walk says "here is a row you may not have", which is the only op kind a client may drop');

  raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run('EDITED');
  raw.prepare('DELETE FROM media_item WHERE id = 2').run();
  const tail = tailSince(raw, registry, pivot - 1, 100);
  const kinds = new Map(tail.ops.filter((op) => op.table === 'media_item').map((op) => [op.id, op.op]));
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
  const pivot = pivotAboveEverything(raw);

  const replica = new Map<number, Held>();
  const page1 = backfillBefore(raw, registry, pivot, 2);
  applyOps(replica, page1.ops);
  let tailCursor = pivot - 1;

  const page2 = backfillBefore(raw, registry, page1.cursor, 2);   // read, now in flight
  assert.ok(page2.ops.some((op) => op.table === 'media_item' && op.id === 4),
    'page 2 really does carry item 4, or this proves nothing');

  raw.prepare('UPDATE media_item SET title = ? WHERE id = 4').run('EDITED');
  const tail = tailSince(raw, registry, tailCursor, 100);
  applyOps(replica, tail.ops);
  tailCursor = tail.cursor;
  assert.deepEqual(replica.get(4), { title: 'EDITED' }, 'the tail delivered the new value first');

  // The page lands, late. No `asOf` to check and nothing to refetch: the op
  // kind is the whole rule.
  applyOps(replica, page2.ops);
  assert.deepEqual(replica.get(4), { title: 'EDITED' },
    "the stale create must be dropped, not written over the tail's value");

  // And the counterfactual, so the assertion above is not vacuous: an
  // overwriting client ends up holding the value the page was read at.
  const naive = new Map<number, Held>(replica);
  applyOpsOverwriting(naive, page2.ops);
  assert.deepEqual(naive.get(4), { title: 't4' },
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
  const pivot = pivotAboveEverything(raw);

  const replica = new Map<number, Held>();
  const page1 = backfillBefore(raw, registry, pivot, 2);
  applyOps(replica, page1.ops);
  let tailCursor = pivot - 1;

  const page2 = backfillBefore(raw, registry, page1.cursor, 2);   // read, now in flight
  assert.ok(page2.ops.some((op) => op.table === 'media_item' && op.id === 4),
    'page 2 really does carry item 4, or this proves nothing');

  raw.prepare('DELETE FROM media_item WHERE id = 4').run();
  const tail = tailSince(raw, registry, tailCursor, 100);
  applyOps(replica, tail.ops);
  tailCursor = tail.cursor;
  assert.equal(replica.get(4), 'TOMBSTONE', 'the tail delivered the deletion first');

  applyOps(replica, page2.ops);
  assert.equal(replica.get(4), 'TOMBSTONE', 'the stale create must not resurrect the row');

  // The counterfactual that rules out obligation 1 alone: with a delete that
  // removes rather than tombstones, the row is absent when the page lands,
  // so the create applies and the row comes back.
  const removing = new Map<number, Held>();
  applyOpsRemoving(removing, page1.ops);
  applyOpsRemoving(removing, tail.ops);
  assert.ok(!removing.has(4), 'fixture sanity: a removing client has no record of the row at all');
  applyOpsRemoving(removing, page2.ops);
  assert.deepEqual(removing.get(4), { title: 't4' },
    'fixture sanity: without obligation 2 the stale page resurrects it');

  let cursor = page2.cursor;
  while (cursor !== null) {
    const page = backfillBefore(raw, registry, cursor, 2);
    applyOps(replica, page.ops);
    cursor = page.cursor;
  }
  applyOps(replica, tailSince(raw, registry, tailCursor, 100).ops);
  assert.deepEqual(liveOf(replica), truthOf(raw), 'no tombstoned row may appear among the live ones');
  assert.equal(replica.get(4), 'TOMBSTONE', 'and the deleted row stays tombstoned');
});

test("the ordinary order -- page first, tail op second -- still ends on the tail's value", () => {
  // The third case, and the one that would break if `create` were read as
  // "insert only, ever": the tail's `upsert` must overwrite what a page put
  // there, or a client would hold the backfill's value forever.
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);
  const pivot = pivotAboveEverything(raw);

  const replica = new Map<number, Held>();
  const page1 = backfillBefore(raw, registry, pivot, 2);
  applyOps(replica, page1.ops);
  const page2 = backfillBefore(raw, registry, page1.cursor, 2);
  applyOps(replica, page2.ops);
  assert.deepEqual(replica.get(4), { title: 't4' }, 'the page landed first this time');

  raw.prepare('UPDATE media_item SET title = ? WHERE id = 4').run('EDITED');
  applyOps(replica, tailSince(raw, registry, pivot - 1, 100).ops);
  assert.deepEqual(replica.get(4), { title: 'EDITED' }, 'an upsert overwrites, unlike a create');
});
