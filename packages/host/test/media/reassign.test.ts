import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaWriter, PluginContext } from '@pickarr/contract';
import type { ArtworkStore } from '../../src/artwork/store.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createMediaWriter } from '../../src/media/writer.ts';
import { reassignRelease, type ReassignDeps } from '../../src/media/reassign.ts';
import { createTvPlugin } from '@pickarr/plugin-tv';
import { insertFeed, withArtworkStore } from './support.ts';
import { gifBytes } from '../support/gif.ts';

const NOW = 1_700_000_000_000;

/** No test here attaches artwork, so a drop never has a file to remove. */
const unusedArtwork: ArtworkStore = {
  put: async () => { throw new Error('artwork.put: not used by this test'); },
  putPerson: async () => { throw new Error('artwork.putPerson: not used by this test'); },
  remove: async () => { throw new Error('artwork.remove: not used by this test'); },
};

function seedItem(raw: DatabaseSync, id: number, pluginId = 'tv'): void {
  raw.prepare('INSERT INTO media_item (id, plugin_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, pluginId, `Title ${String(id)}`, 1, 1);
}
function seedRelease(raw: DatabaseSync, id: number, feedId: number, mediaItemId: number | null): void {
  raw.prepare(`INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, media_item_id, lookup_state, lookup_json)
    VALUES (?, ?, ?, '', 1, 1, 'torrent', ?, 'unresolved', '{"old":"answer"}')`).run(id, feedId, `f${String(id)}.mkv`, mediaItemId);
}
function seedRole(raw: DatabaseSync, mediaItemId: number): void {
  raw.prepare("INSERT INTO person (id, name, provider_ref, created_at, updated_at) VALUES (1, 'Someone', 'p1', 1, 1) ON CONFLICT DO NOTHING").run();
  raw.prepare("INSERT INTO role (media_item_id, person_id, role, created_at) VALUES (?, 1, 'actor', 1)").run(mediaItemId);
}
function item(raw: DatabaseSync, id: number): Record<string, unknown> | undefined {
  return raw.prepare('SELECT * FROM media_item WHERE id = ?').get(id);
}
function release(raw: DatabaseSync, id: number): Record<string, unknown> | undefined {
  return raw.prepare('SELECT * FROM rss_item WHERE id = ?').get(id);
}

function fixture(dropRows: ReassignDeps['dropRows'] = async () => {}) {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => NOW, unusedArtwork, { dropRows });
  const deps: ReassignDeps = {
    raw,
    relink: writer.relinkRssItem,
    drop: writer.dropMediaItemRows,
    unlink: unusedArtwork.remove,
    now: () => NOW,
    dropRows,
  };
  const feedId = insertFeed(raw, 'http://feed.invalid/a');
  return { raw, deps, feedId, writer };
}

test('moving a release relinks it, marks it resolved, clears its stored answer, and bumps the target', async () => {
  const { raw, deps, feedId } = fixture();
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1); seedRelease(raw, 11, feedId, 1);
  await reassignRelease(deps, 10, 2);
  const moved = release(raw, 10);
  assert.equal(moved?.['media_item_id'], 2);
  assert.equal(moved?.['lookup_state'], 'resolved');
  assert.equal(moved?.['lookup_state_detail'], null);
  assert.equal(moved?.['lookup_json'], null);
  assert.equal(item(raw, 2)?.['updated_at'], NOW, 'the target is bumped so its card re-gathers');
  assert.ok(item(raw, 1), 'the previous item still has release 11 and stays');
  assert.equal(item(raw, 1)?.['updated_at'], NOW, 'and is bumped so its card re-gathers without release 10');
});

test('an orphaned previous item is dropped: plugin rows first, then roles, then the item with a tombstone', async () => {
  const order: string[] = [];
  const { raw, deps, feedId } = fixture(async (pluginId, id) => {
    order.push(`dropRows:${pluginId}:${String(id)}`);
    assert.ok(item(raw, id), 'the item still exists when the plugin is asked, so its FK rows can be found');
  });
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1); seedRole(raw, 1);
  await reassignRelease(deps, 10, 2);
  assert.deepEqual(order, ['dropRows:tv:1']);
  assert.equal(item(raw, 1), undefined);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM role WHERE media_item_id = 1').get()?.['n'], 0);
  assert.equal(raw.prepare('SELECT media_item_id FROM deleted_media_item WHERE media_item_id = 1').get()?.['media_item_id'], 1);
});

test('a throwing plugin hook rolls the whole move back, relink included', async () => {
  const { raw, deps, feedId } = fixture(async () => { throw new Error('plugin refused'); });
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1);
  await assert.rejects(reassignRelease(deps, 10, 2), /plugin refused/);
  assert.equal(release(raw, 10)?.['media_item_id'], 1);
  assert.equal(release(raw, 10)?.['lookup_json'], '{"old":"answer"}');
  assert.ok(item(raw, 1));
});

test('a release with no previous item is linked and nothing is dropped; the same item twice is a bump', async () => {
  const calls: number[] = [];
  const { raw, deps, feedId } = fixture(async (_p, id) => { calls.push(id); });
  seedItem(raw, 2); seedRelease(raw, 10, feedId, null);
  await reassignRelease(deps, 10, 2);
  assert.equal(release(raw, 10)?.['media_item_id'], 2);
  await reassignRelease(deps, 10, 2);
  assert.deepEqual(calls, []);
  assert.ok(item(raw, 2));
});

test('the writer exposes reassignRelease and it reaches the same rule', async () => {
  const { raw, feedId, writer } = fixture();
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1);
  await writer.reassignRelease(10, 2);
  assert.equal(release(raw, 10)?.['media_item_id'], 2);
  assert.equal(item(raw, 1), undefined, 'orphan dropped through the writer path too');
});

test('moving the last release off an item succeeds with the engine lookup table and plugin rows naming it, foreign keys on', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const plugin = createTvPlugin({ now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'unused' });
  for (const migration of plugin.migrations) migration.up(raw);
  const unused = async (): Promise<never> => { throw new Error('not used by this test'); };
  const writer: MediaWriter = createMediaWriter(db, () => NOW, unusedArtwork, {
    dropRows: async (_pluginId, id) => {
      const ctx: PluginContext = {
        db: raw,
        media: writer,
        read: { mediaItem: unused, mediaItemByProviderRef: unused, rssItemsFor: unused, downloadsFor: unused },
        jobs: { enqueue: unused },
        fetch: { json: unused, bytes: unused },
        downloads: { submit: unused },
        library: { list: unused, place: unused },
        log: () => {},
      };
      await plugin.onMediaItemDropped(id, ctx);
    },
  });
  const feedId = insertFeed(raw, 'http://feed.invalid/a');
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1);
  raw.prepare('INSERT INTO tv_series (id, provider, provider_ref, title, created_at, updated_at) VALUES (1, ?, ?, ?, 1, 1)').run('tmdb', 'tmdb:series:1', 'A Series');
  raw.prepare("INSERT INTO tv_release (media_item_id, kind, series_id, created_at, updated_at) VALUES (1, 'episode', 1, 1, 1)").run();
  raw.prepare('INSERT INTO tv_lookup (rss_item_id, media_item_id, created_at, updated_at) VALUES (10, 1, 1, 1)').run();
  assert.equal(raw.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'], 1);

  await writer.reassignRelease(10, 2);

  assert.equal(item(raw, 1), undefined);
  assert.equal(raw.prepare('SELECT media_item_id FROM tv_lookup WHERE rss_item_id = 10').get()?.['media_item_id'], null);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM tv_release').get()?.['n'], 0);
});

/**
 * The dropped item's cached poster file is unlinked once, after the move has
 * committed, and never when the move rolled back. Real store, so the row and
 * the file are the real ones; `remove` is wrapped only to count calls.
 */
async function reassignWithPoster(dropRows: ReassignDeps['dropRows']): Promise<{
  raw: DatabaseSync;
  removed: string[];
  inTransactionAtUnlink: boolean[];
  posterPath: string;
}> {
  let captured: { raw: DatabaseSync; removed: string[]; inTransactionAtUnlink: boolean[]; posterPath: string } | undefined;
  await withArtworkStore(async (artwork) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const removed: string[] = [];
    const inTransactionAtUnlink: boolean[] = [];
    const counting: ArtworkStore = {
      ...artwork,
      remove: async (path) => {
        removed.push(path);
        inTransactionAtUnlink.push(raw.isTransaction);
        await artwork.remove(path);
      },
    };
    const writer = createMediaWriter(db, () => NOW, counting, { dropRows });
    const feedId = insertFeed(raw, 'http://feed.invalid/a');
    seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1);
    await writer.attachPoster(1, { title: null, language: null, url: 'https://images.test/p.gif', bytes: gifBytes(300, 450) });
    const row = raw.prepare('SELECT path FROM poster WHERE media_item_id = 1').get();
    const posterPath = String(row?.['path']);
    captured = { raw, removed, inTransactionAtUnlink, posterPath };
    // A throwing hook rejects; the caller asserts on the state the move left.
    await writer.reassignRelease(10, 2).catch(() => {});
  });
  if (captured === undefined) throw new Error('withArtworkStore did not run');
  return captured;
}

test('a successful move unlinks the dropped item\'s poster file once, after the commit, and its row is gone', async () => {
  const { raw, removed, inTransactionAtUnlink, posterPath } = await reassignWithPoster(async () => {});
  assert.deepEqual(removed, [posterPath]);
  assert.deepEqual(inTransactionAtUnlink, [false], 'the savepoint was released before any file I/O');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM poster WHERE media_item_id = 1').get()?.['n'], 0);
});

test('a move whose plugin hook throws unlinks nothing and keeps the poster row', async () => {
  const { raw, removed } = await reassignWithPoster(async () => { throw new Error('plugin refused'); });
  assert.deepEqual(removed, []);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM poster WHERE media_item_id = 1').get()?.['n'], 1);
  assert.equal(release(raw, 10)?.['media_item_id'], 1);
});
