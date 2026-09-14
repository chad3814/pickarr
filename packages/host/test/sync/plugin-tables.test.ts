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
 * The fake table below reads and paginates a real SQLite table rather than
 * a literal map, because the property under test is what the *host* does
 * with what a plugin returns -- the three shipped plugins' own mapping is
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
        tagline: row.tagline === null ? null : String(row.tagline),
      };
    }
    return result;
  },
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] {
    if (mediaItemIds.length === 0) return [];
    return raw.prepare(
      `SELECT id FROM movie_detail WHERE media_item_id IN (${holes(mediaItemIds)})`,
    ).all(...mediaItemIds).map((row) => Number(row.id));
  },
};

function fakePlugin(synced: readonly SyncedTable<unknown>[]): MediaPlugin {
  return {
    id: 'movie',
    mediaType: 'movie',
    migrations: [],
    jobs: {},
    synced,
    onNewRssItems: async () => {},
    onDownloadedFile: async () => {},
    onDownloadRequest: async () => {},
  };
}

/**
 * A second table for the same plugin, whose read shape names a row in the
 * first -- the shape `tv_season`/`tv_series` have, reduced to what the host
 * needs to see. Declared second, because `detailId` is a `movie_detail.id`.
 *
 * Named `movie_brand` rather than anything sorting after `movie_detail`,
 * deliberately: declared order and alphabetical order then *disagree*, which
 * is what lets the test below tell "honours the plugin's order" apart from
 * "happens to sort the same way". Measured -- under the earlier name
 * `movie_studio` the test passed with a `.toSorted()` spliced into
 * `backfillBefore`'s plugin-table loop.
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
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] {
    if (mediaItemIds.length === 0) return [];
    return raw.prepare(`
      SELECT DISTINCT s.id FROM movie_brand s
      JOIN movie_detail d ON d.id = s.detail_id
      WHERE d.media_item_id IN (${holes(mediaItemIds)})
    `).all(...mediaItemIds).map((row) => Number(row.id));
  },
};

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

  const page = backfillBefore(raw, registry, null, 10);
  const walkCreate = page.ops.find((op) => op.table === 'movie_detail');
  assert.ok(walkCreate !== undefined, 'the backfill must carry the plugin row');
  assert.equal(walkCreate.op, 'create', 'the walk emits a create, the tail an upsert (§5.3)');
  assert.equal(walkCreate.id, 7, 'the backfill create must carry the same row id');

  // The payload itself stays id-free, which is the reason the op carries one.
  assert.deepEqual(walkCreate.value, {
    mediaItemId: 1, runtimeMinutes: 166, tagline: 'Long live the fighters.',
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

test('a shared plugin row re-sent once per group keys identically each time, so a client deduplicates', () => {
  // §3.3's shared parent, as the backfill actually emits it. With the key on
  // the op, the two ops for one row agree; with the key inside a payload
  // that has none, a client would accumulate one unlabelled copy per group.
  const { raw, registry } = open();
  seed(raw, 1, 7);
  seed(raw, 2, 8);

  const page = backfillBefore(raw, registry, null, 10);
  const keys = page.ops.filter((op) => op.table === 'movie_detail').map((op) => op.id);
  assert.deepEqual(keys.toSorted((a, b) => a - b), [7, 8], 'one key per plugin row, and they differ');
});

test("a plugin row above the watermark is left to the tail, like a host row", () => {
  // The disjointness `backfillBefore` establishes is not host-only: a
  // plugin table reaches it through `rowsFor`/`read`, and the skip is keyed
  // off `sync_log`, which the plugin's own triggers write.
  const { raw, registry } = open();
  seed(raw, 1, 7);
  seed(raw, 2, 8);

  const first = backfillBefore(raw, registry, null, 1);     // media item 2, detail 8
  raw.prepare('UPDATE movie_detail SET tagline = ? WHERE id = 7').run('edited');

  const rest = backfillBefore(raw, registry, first.cursor, 10);
  assert.deepEqual(rest.ops.filter((op) => op.table === 'movie_detail').map((op) => op.id), [],
    'detail 7 is above the watermark, so the walk must leave it to the tail');

  const tail = tailSince(raw, registry, first.watermark, 100);
  const delivered = tail.ops.filter((op) => op.table === 'movie_detail' && op.id === 7);
  assert.equal(delivered.length, 1);
  assert.equal((delivered[0]?.value as MovieRead | undefined)?.tagline, 'edited');
});

test('the backfill emits a plugin\'s tables in the order the plugin declared them', () => {
  // What makes `packages/plugin-tv/src/sync.ts`'s declaration order the
  // thing that decides whether a client sees `seriesId: 200` before or
  // after the `tv_series` op with id 200. The host has no schema knowledge
  // of a plugin table, so declaration order is the *only* handle a plugin
  // has on page order -- and this is the assertion that it is honoured
  // rather than sorted by name, under which `movie_brand` would precede
  // `movie_detail` and the reference the brand op carries would dangle.
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

  const page = backfillBefore(raw, registry, null, 10);
  const plugin = page.ops
    .filter((op) => op.table === 'movie_detail' || op.table === 'movie_brand')
    .map((op) => op.table);
  assert.deepEqual(plugin, ['movie_detail', 'movie_brand'],
    'declared order; by name this would be brand first, and its reference would dangle');

  // And the reference the second op carries really does name the row the
  // first one sent, so the ordering above is load-bearing rather than
  // cosmetic.
  const brandOp = page.ops.find((op) => op.table === 'movie_brand');
  assert.equal((brandOp?.value as BrandRead | undefined)?.detailId, 7);
  assert.equal(page.ops.find((op) => op.table === 'movie_detail')?.id, 7);
});
