import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createMediaWriter } from '../../src/media/writer.ts';

/** A row read back from `media_item`, narrowed the same way `migrate.test.ts` does. */
function readMediaItem(raw: DatabaseSync, id: number) {
  const row = raw.prepare(
    'SELECT provider, provider_ref, title, updated_at, created_at FROM media_item WHERE id = ?',
  ).get(id);
  return row as
    | { provider: unknown; provider_ref: unknown; title: unknown; updated_at: unknown; created_at: unknown }
    | undefined;
}

/** A row read back from `rss_item`. */
function readRssItem(raw: DatabaseSync, id: number) {
  const row = raw.prepare(
    'SELECT media_item_id, resolution, resolution_detail, updated_at FROM rss_item WHERE id = ?',
  ).get(id);
  return row as
    | { media_item_id: unknown; resolution: unknown; resolution_detail: unknown; updated_at: unknown }
    | undefined;
}

/** A row read back from `person`. */
function readPerson(raw: DatabaseSync, id: number) {
  const row = raw.prepare('SELECT name, provider_ref, updated_at FROM person WHERE id = ?').get(id);
  return row as { name: unknown; provider_ref: unknown; updated_at: unknown } | undefined;
}

/** An rss feed, inserted directly: nothing in `MediaWriter` writes this table. */
function insertFeed(raw: DatabaseSync, url: string): number {
  const result = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `).run('alpha', 'a feed', url, 0, 0);
  return Number(result.lastInsertRowid);
}

/** An rss item pointed at nothing yet, so a test can `relinkRssItem` it. */
function insertRssItem(raw: DatabaseSync, feedId: number, at: number): number {
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, 'x.mkv', 'https://example.test/x', ?, ?, 'nzb', 'pending')
  `).run(feedId, at, at);
  return Number(result.lastInsertRowid);
}

test('claiming an unheld provider ref keeps the caller and drops nothing', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  const id = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  const claim = await writer.claimProviderRef(id, 'tmdb', 'ref-1');

  assert.deepEqual(claim, { kept: id, dropped: null });
  const row = readMediaItem(raw, id);
  assert.ok(row, 'claimed row must still exist');
  assert.equal(row.provider, 'tmdb');
  assert.equal(row.provider_ref, 'ref-1');
});

test('claiming a held provider ref keeps the holder and reports the caller as dropped', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  const holderId = await writer.createMediaItem({ pluginId: 'alpha', title: 'first', releaseDate: null, description: null });
  const first = await writer.claimProviderRef(holderId, 'tmdb', 'shared-ref');
  assert.deepEqual(first, { kept: holderId, dropped: null });

  const loserId = await writer.createMediaItem({ pluginId: 'alpha', title: 'second', releaseDate: null, description: null });
  const second = await writer.claimProviderRef(loserId, 'tmdb', 'shared-ref');

  // The caller must be told which id survived so it can relink.
  assert.deepEqual(second, { kept: holderId, dropped: loserId });

  const holderRow = readMediaItem(raw, holderId);
  assert.ok(holderRow);
  assert.equal(holderRow.provider_ref, 'shared-ref');

  const loserRow = readMediaItem(raw, loserId);
  assert.ok(loserRow, 'the losing row is still there -- dropMediaItem is a separate step');
  assert.equal(loserRow.provider, null, 'the losing UPDATE was rolled back whole, not partially applied');
  assert.equal(loserRow.provider_ref, null);
});

test('a non-unique sqlite failure is not mistaken for a lost race', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  // A legitimate holder for (tmdb, ref-1) -- so that if the mutation this
  // test targets (catching every ERR_SQLITE_ERROR, not just 2067) were
  // present, the code's fallback lookup would find *this* row and report a
  // normal-looking dropped claim instead of letting the real failure out.
  const holderId = await writer.createMediaItem({ pluginId: 'alpha', title: 'holder', releaseDate: null, description: null });
  await writer.claimProviderRef(holderId, 'tmdb', 'ref-1');

  const targetId = await writer.createMediaItem({ pluginId: 'alpha', title: 'target', releaseDate: null, description: null });

  // A trigger that aborts any update to this one row, so the UPDATE inside
  // claimProviderRef fails with SQLITE_CONSTRAINT_TRIGGER (errcode 1811) --
  // a real constraint, but a different one from the UNIQUE index's 2067,
  // and raised before that index is ever checked.
  raw.exec(`
    CREATE TRIGGER guard_target BEFORE UPDATE ON media_item WHEN NEW.id = ${targetId}
    BEGIN
      SELECT RAISE(ABORT, 'synthetic failure for this test');
    END;
  `);

  await assert.rejects(() => writer.claimProviderRef(targetId, 'tmdb', 'ref-1'));
});

test('two unclaimed items do not collide, because NULL refs are distinct in SQLite', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  const first = await writer.createMediaItem({ pluginId: 'alpha', title: 'one', releaseDate: null, description: null });
  const second = await writer.createMediaItem({ pluginId: 'alpha', title: 'two', releaseDate: null, description: null });

  assert.notEqual(first, second);
  const firstRow = readMediaItem(raw, first);
  const secondRow = readMediaItem(raw, second);
  assert.ok(firstRow && secondRow);
  assert.equal(firstRow.provider, null);
  assert.equal(secondRow.provider, null);
});

test('relinkRssItem repoints the item and bumps updated_at', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);

  const feedId = insertFeed(raw, 'https://example.test/feed');
  const itemId = insertRssItem(raw, feedId, 500);
  const before = readRssItem(raw, itemId);
  assert.ok(before);
  assert.equal(before.updated_at, 500);

  const writer = createMediaWriter(db, () => 999);
  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });

  await writer.relinkRssItem(itemId, mediaItemId);

  const after = readRssItem(raw, itemId);
  assert.ok(after);
  assert.equal(after.media_item_id, mediaItemId);
  // updated_at is what the client's "what changed since" flow reads -- a
  // relink that does not bump it makes the row invisible to sync.
  assert.equal(after.updated_at, 999);
});

test('setResolution records refused and unresolved as different states', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const feedId = insertFeed(raw, 'https://example.test/feed');
  const itemId = insertRssItem(raw, feedId, 0);
  const writer = createMediaWriter(db, () => 1000);

  await writer.setResolution(itemId, 'refused', null);
  const refused = readRssItem(raw, itemId);
  assert.ok(refused);
  assert.equal(refused.resolution, 'refused');
  assert.equal(refused.resolution_detail, null);

  await writer.setResolution(itemId, 'unresolved', 'unrecognised filename');
  const unresolved = readRssItem(raw, itemId);
  assert.ok(unresolved);
  assert.equal(unresolved.resolution, 'unresolved');
  assert.equal(unresolved.resolution_detail, 'unrecognised filename');
  assert.notEqual(refused.resolution, unresolved.resolution, 'refused and unresolved must not collapse to the same state');
});

test('upsertPerson returns the same id for a repeated providerRef', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  const firstId = await writer.upsertPerson({ name: 'Ada', providerRef: 'p-1' });
  const secondId = await writer.upsertPerson({ name: 'Ada Lovelace', providerRef: 'p-1' });

  assert.equal(firstId, secondId, 'the same providerRef must dedup to the same person row');
  const row = readPerson(raw, firstId);
  assert.ok(row);
  assert.equal(row.name, 'Ada Lovelace', 'the second call updates the name, not just returns the old id');
  assert.equal(row.provider_ref, 'p-1');
});

test('dropMediaItem removes the loser and leaves the keeper', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  const keeperId = await writer.createMediaItem({ pluginId: 'alpha', title: 'keeper', releaseDate: null, description: null });
  await writer.claimProviderRef(keeperId, 'tmdb', 'shared-ref');
  const loserId = await writer.createMediaItem({ pluginId: 'alpha', title: 'loser', releaseDate: null, description: null });
  const claim = await writer.claimProviderRef(loserId, 'tmdb', 'shared-ref');
  assert.equal(claim.dropped, loserId);

  await writer.dropMediaItem(loserId);

  assert.equal(readMediaItem(raw, loserId), undefined, 'the loser must be gone');
  assert.ok(readMediaItem(raw, keeperId), 'the keeper must be untouched');
});
