/**
 * A *plugin*-declared table through both cursors.
 *
 * Its own file because that is the seam no other test in this package
 * reaches: every other host-level sync test builds its registry as
 * `createSyncRegistry(raw, [])`, so `tailSince` and `backfillBefore` have
 * only ever been exercised over the host's six tables -- and the host's six
 * project `id` into the row they return (`sync/tables.ts`), which hid the
 * fact that nothing put the row id on the op itself. No plugin read shape
 * carries an id (`packages/contract/src/sync.ts` says why it must not), so
 * every plugin upsert was unkeyable and every plugin delete named a row the
 * client had never been able to label.
 *
 * The fake tables below read a real SQLite table rather than a literal map,
 * because the property under test is what the *host* does with what a plugin
 * returns -- the three shipped plugins' own mapping is
 * `packages/plugin-{tv,movie,xxx}/test/sync.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaPlugin, MovieRead, SyncedTable } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { installSyncTriggers } from '../../src/sync/log.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { backfillBefore } from '../../src/sync/backfill.ts';
import { tailSince } from '../../src/sync/tail.ts';

/** `?, ?, ...`, one per id -- the ids themselves stay bound parameters. */
const holes = (ids: readonly number[]): string => ids.map(() => '?').join(', ');

/**
 * `movie_detail`'s real shape and real projection, declared here rather
 * than imported: `packages/host` does not depend on a plugin package, and
 * the point is the host's handling of a shape that carries no id.
 */
const detail: SyncedTable<MovieRead> = {
  table: 'movie_detail',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, MovieRead> {
    if (ids.length === 0) return {};
    const rows = raw.prepare(
      `SELECT id, media_item_id, runtime_minutes, tagline FROM movie_detail WHERE id IN (${holes(ids)})`,
    ).all(...ids);
    const result: Record<number, MovieRead> = {};
    for (const row of rows) {
      result[Number(row.id)] = {
        mediaItemId: Number(row.media_item_id),
        runtimeMinutes: row.runtime_minutes === null ? null : Number(row.runtime_minutes),
        // Not selected above, deliberately: this test's fake projection
        // exercises the host's id-keying seam, not imdb_id -- null is the
        // honest value for a row this fixture never populates the column
        // for, same as a film the lookup service gave no IMDb id.
        imdbId: null,
        tagline: row.tagline === null ? null : String(row.tagline),
      };
    }
    return result;
  },
};

function fakePlugin(synced: readonly SyncedTable<unknown>[]): MediaPlugin {
  return {
    id: 'movie',
    mediaType: 'movie',
    migrations: [],
    jobs: {},
    synced,
    tokens: {},
    onNewRssItems: async () => {},
    onDownloadedFile: async () => {},
    onDownloadRequest: async () => {},
    onMediaItemDropped: async () => {},
    onLookupRequest: async () => {},
  };
}

/**
 * A second table for the same plugin, whose read shape names a row in the
 * first -- the shape `tv_season`/`tv_series` have, reduced to what the host
 * needs to see.
 *
 * **Declaration order used to decide emission order and no longer does.**
 * The walk paged current state and emitted a group's plugin tables in the
 * order the plugin listed them, so declaring `movie_brand` second was what
 * kept its `detailId` reference behind the row it names. The walk reads
 * `sync_log` now, so emission order is write order and a plugin has no handle
 * on it: `backfillBefore`'s doc records that as one of the two properties the
 * flip gives up. The name is kept because it still sorts *before*
 * `movie_detail`, which is what lets the test below tell log order apart from
 * alphabetical order.
 */
interface BrandRead { detailId: number; name: string }

const brand: SyncedTable<BrandRead> = {
  table: 'movie_brand',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, BrandRead> {
    if (ids.length === 0) return {};
    const rows = raw.prepare(
      `SELECT id, detail_id, name FROM movie_brand WHERE id IN (${holes(ids)})`,
    ).all(...ids);
    const result: Record<number, BrandRead> = {};
    for (const row of rows) {
      result[Number(row.id)] = { detailId: Number(row.detail_id), name: String(row.name) };
    }
    return result;
  },
};

/**
 * A pivot above every entry in the log -- what a client bootstrapping right
 * now would be handed, give or take the floor `sync/bootstrap.ts` picks. The
 * walk takes `id < pivot`, so `+ 1` is what includes the newest entry.
 */
const pivotAboveEverything = (raw: DatabaseSync): number =>
  Number((raw.prepare('SELECT coalesce(max(id), 0) m FROM sync_log').get() as { m: unknown }).m) + 1;

/** A host schema plus the film plugin's one table, triggers installed, registry built. */
function open() {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec(`
    CREATE TABLE movie_detail (
      id              INTEGER PRIMARY KEY,
      media_item_id   INTEGER NOT NULL REFERENCES media_item (id),
      runtime_minutes INTEGER,
      tagline         TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);
  installSyncTriggers(raw, ['movie_detail']);
  return { raw, registry: createSyncRegistry(raw, [fakePlugin([detail])]) };
}

function seed(raw: DatabaseSync, mediaItemId: number, detailId: number): void {
  raw.prepare('INSERT INTO media_item (id, plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?)')
    .run(mediaItemId, 'movie', mediaItemId * 10, mediaItemId * 10, `t${mediaItemId}`);
  raw.prepare(`INSERT INTO movie_detail (id, media_item_id, runtime_minutes, tagline, created_at, updated_at)
               VALUES (?, ?, 166, ?, 1, 1)`).run(detailId, mediaItemId, 'Long live the fighters.');
}

test('a plugin row is keyed by its row id on both cursors, and its delete names the same key', () => {
  const { raw, registry } = open();
  seed(raw, 1, 7);

  const tail = tailSince(raw, registry, 0, 100);
  const tailUpsert = tail.ops.find((op) => op.table === 'movie_detail');
  assert.ok(tailUpsert !== undefined, 'the tail must carry the plugin row');
  assert.equal(tailUpsert.op, 'upsert');
  assert.equal(tailUpsert.id, 7, 'the tail upsert must carry the row id, not only the row');

  const page = backfillBefore(raw, registry, pivotAboveEverything(raw), 10);
  const walkCreate = page.ops.find((op) => op.table === 'movie_detail');
  assert.ok(walkCreate !== undefined, 'the backfill must carry the plugin row');
  assert.equal(walkCreate.op, 'create', 'the walk emits a create, the tail an upsert (§5.3)');
  assert.equal(walkCreate.id, 7, 'the backfill create must carry the same row id');

  // The payload itself stays id-free, which is the reason the op carries one.
  assert.deepEqual(walkCreate.value, {
    mediaItemId: 1, runtimeMinutes: 166, imdbId: null, tagline: 'Long live the fighters.',
  });

  raw.prepare('DELETE FROM movie_detail WHERE id = 7').run();
  const after = tailSince(raw, registry, tail.cursor, 100);
  const remove = after.ops.find((op) => op.table === 'movie_detail');
  assert.ok(remove !== undefined, 'the deletion must reach the client');
  assert.equal(remove.op, 'delete');
  assert.equal(remove.id, tailUpsert.id,
    'the delete must name the key the upsert was stored under, or it can never be applied');
  assert.equal(remove.value, undefined, 'a delete carries no row');
});

test('a plugin row is sent once and keyed by its own id, whatever it belongs to', () => {
  // §3.3's shared parent, and its cost is gone. The group-hydrated walk
  // re-sent a parent once per group and relied on the op-level key to make
  // those copies deduplicate; the log holds one entry per *row*, so the walk
  // sends each row exactly once and there is nothing to deduplicate. The key
  // still matters, for the reason the test above gives -- a client stores the
  // row under it, and the delete that later names it has to agree.
  const { raw, registry } = open();
  seed(raw, 1, 7);
  seed(raw, 2, 8);

  const page = backfillBefore(raw, registry, pivotAboveEverything(raw), 10);
  const keys = page.ops.filter((op) => op.table === 'movie_detail').map((op) => op.id);
  assert.deepEqual(keys.toSorted((a, b) => a - b), [7, 8], 'one op per plugin row, each with its own key');
});

test('a plugin row above the pivot is the tail\'s, like a host row', () => {
  // The disjointness the two cursors establish is not host-only: a plugin
  // table reaches both of them through `read`, and the partition is keyed off
  // `sync_log`, which the plugin's own triggers write.
  const { raw, registry } = open();
  seed(raw, 1, 7);
  seed(raw, 2, 8);
  const pivot = pivotAboveEverything(raw);
  raw.prepare('UPDATE movie_detail SET tagline = ? WHERE id = 7').run('edited');

  const walked: number[] = [];
  let cursor: number | null = pivot;
  while (cursor !== null) {
    const page = backfillBefore(raw, registry, cursor, 2);
    walked.push(...page.ops.filter((op) => op.table === 'movie_detail').map((op) => op.id));
    cursor = page.cursor;
  }
  assert.deepEqual(walked, [8], "detail 7's entry moved above the pivot when it changed");

  const tail = tailSince(raw, registry, pivot - 1, 100);
  const delivered = tail.ops.filter((op) => op.table === 'movie_detail' && op.id === 7);
  assert.equal(delivered.length, 1);
  assert.equal((delivered[0]?.value as MovieRead | undefined)?.tagline, 'edited');
});

test('the backfill emits a plugin\'s rows in log order, whatever order they were declared in', () => {
  // Declaration order used to decide whether a client saw a `movie_brand`
  // op before or after the `movie_detail` row it names, because the walk
  // emitted a group's plugin tables in the order the plugin listed them.
  // The walk reads the log now, so emission order is write order and a
  // plugin has no handle on it at all. That is the ordering property
  // `backfillBefore`'s doc records as lost: the reference points forward,
  // and the same walk resolves it further down.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec(`
    CREATE TABLE movie_detail (
      id              INTEGER PRIMARY KEY,
      media_item_id   INTEGER NOT NULL REFERENCES media_item (id),
      runtime_minutes INTEGER,
      tagline         TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE TABLE movie_brand (
      id         INTEGER PRIMARY KEY,
      detail_id  INTEGER NOT NULL REFERENCES movie_detail (id),
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  installSyncTriggers(raw, ['movie_detail', 'movie_brand']);
  const registry = createSyncRegistry(raw, [fakePlugin([detail, brand])]);

  seed(raw, 1, 7);
  raw.prepare('INSERT INTO movie_brand (id, detail_id, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(50, 7, 'a brand');

  const page = backfillBefore(raw, registry, pivotAboveEverything(raw), 10);
  const plugin = page.ops
    .filter((op) => op.table === 'movie_detail' || op.table === 'movie_brand')
    .map((op) => op.table);
  assert.deepEqual(plugin, ['movie_brand', 'movie_detail'],
    'the brand was written last, so it is emitted first -- ahead of the detail row it names');

  // The forward reference, and the op that resolves it, both in one page. The
  // client applies them in the order given and holds an unresolvable
  // `detailId` for the length of that page, which is the accepted cost.
  const brandOp = page.ops.find((op) => op.table === 'movie_brand');
  assert.equal((brandOp?.value as BrandRead | undefined)?.detailId, 7);
  assert.equal(page.ops.find((op) => op.table === 'movie_detail')?.id, 7);
});
