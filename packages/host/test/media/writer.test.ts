import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createMediaWriter } from '../../src/media/writer.ts';

/** A row read back from `media_item`, narrowed the same way `migrate.test.ts` does. */
function readMediaItem(raw: DatabaseSync, id: number) {
  const row = raw.prepare(
    `SELECT plugin_id, provider, provider_ref, title, release_date, description, updated_at, created_at
     FROM media_item WHERE id = ?`,
  ).get(id);
  return row as
    | {
      plugin_id: unknown;
      provider: unknown;
      provider_ref: unknown;
      title: unknown;
      release_date: unknown;
      description: unknown;
      updated_at: unknown;
      created_at: unknown;
    }
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

test('relinkRssItem(id, null) unlinks and bumps updated_at', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);

  const feedId = insertFeed(raw, 'https://example.test/feed');
  const itemId = insertRssItem(raw, feedId, 500);

  const writer = createMediaWriter(db, () => 999);
  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  await writer.relinkRssItem(itemId, mediaItemId);

  await writer.relinkRssItem(itemId, null);

  const after = readRssItem(raw, itemId);
  assert.ok(after);
  assert.equal(after.media_item_id, null);
  assert.equal(after.updated_at, 999);
});

test('relinkRssItem on an rss item that does not exist throws', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  await assert.rejects(() => writer.relinkRssItem(999_999, null));
});

test('updateMediaItem replaces title, release date and description, and bumps updated_at', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  let at = 1000;
  const writer = createMediaWriter(db, () => at);

  const mediaItemId = await writer.createMediaItem({
    pluginId: 'alpha',
    title: 'placeholder',
    releaseDate: null,
    description: null,
  });

  at = 2000;
  await writer.updateMediaItem(mediaItemId, {
    title: 'The Real Title',
    releaseDate: '2024-01-01',
    description: 'a description from the lookup',
  });

  const row = readMediaItem(raw, mediaItemId);
  assert.ok(row);
  assert.equal(row.title, 'The Real Title');
  assert.equal(row.release_date, '2024-01-01');
  assert.equal(row.description, 'a description from the lookup');
  // updated_at must come from the injected clock at the time of this write,
  // not the row's original created_at.
  assert.equal(row.updated_at, 2000);
});

test('updateMediaItem leaves plugin_id, provider and provider_ref untouched', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  const mediaItemId = await writer.createMediaItem({
    pluginId: 'alpha',
    title: 'placeholder',
    releaseDate: null,
    description: null,
  });
  await writer.claimProviderRef(mediaItemId, 'tmdb', 'ref-1');

  await writer.updateMediaItem(mediaItemId, {
    title: 'The Real Title',
    releaseDate: '2024-01-01',
    description: 'a description',
  });

  const row = readMediaItem(raw, mediaItemId);
  assert.ok(row);
  // Ownership does not change here, and provider/provider_ref are
  // claimProviderRef's alone to write -- a second writer for them would race
  // with the unique index that method relies on.
  assert.equal(row.plugin_id, 'alpha');
  assert.equal(row.provider, 'tmdb');
  assert.equal(row.provider_ref, 'ref-1');
});

test('updateMediaItem on an id that does not exist throws rather than silently doing nothing', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  await assert.rejects(() => writer.updateMediaItem(999_999, {
    title: 'nope',
    releaseDate: null,
    description: null,
  }));
});

test('creating an item, linking, unlinking with null, then dropping it succeeds', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  const feedId = insertFeed(raw, 'https://example.test/feed');
  const itemId = insertRssItem(raw, feedId, 0);

  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  await writer.relinkRssItem(itemId, mediaItemId);

  // The refusal path: a lookup refuses, so the rss item is unlinked before
  // the row it never got to complete is dropped. Without the unlink, this
  // dropMediaItem would fail with SQLITE_CONSTRAINT_FOREIGNKEY (787), because
  // the rss item still points at the row.
  await writer.relinkRssItem(itemId, null);
  await writer.dropMediaItem(mediaItemId);

  assert.equal(readMediaItem(raw, mediaItemId), undefined, 'the media item must be gone');
  const after = readRssItem(raw, itemId);
  assert.ok(after);
  assert.equal(after.media_item_id, null, 'the rss item stays unlinked');
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
  // The two `assert.equal`s above are already what stops the two states
  // collapsing into one; a third assertion that the two differ restates them
  // rather than adding a way for this test to fail.
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

/**
 * Rows read back from `role`, column by column: node:sqlite hands back
 * null-prototype rows, which `deepEqual` will not match against a literal.
 */
function readRoles(raw: DatabaseSync) {
  return raw.prepare(
    'SELECT media_item_id, person_id, role, name, billing_order, created_at FROM role ORDER BY id',
  ).all().map((row) => ({
    mediaItemId: row['media_item_id'],
    personId: row['person_id'],
    role: row['role'],
    name: row['name'],
    billingOrder: row['billing_order'],
    createdAt: row['created_at'],
  }));
}

test('attachRole is idempotent: the same part attached twice is one row, with the later details', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  let at = 1000;
  const writer = createMediaWriter(db, () => at);

  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  const personId = await writer.upsertPerson({ name: 'Ada', providerRef: 'p-1' });

  await writer.attachRole(mediaItemId, { personId, role: 'cast', name: 'The Countess', billingOrder: 3 });
  at = 2000;
  // Every job handler must be safe to run twice, because crash recovery
  // re-runs a job that was already claimed. A second identical attach is what
  // that re-run looks like from here.
  await writer.attachRole(mediaItemId, { personId, role: 'cast', name: 'The Countess', billingOrder: 3 });

  assert.deepEqual(readRoles(raw), [
    { mediaItemId, personId, role: 'cast', name: 'The Countess', billingOrder: 3, createdAt: 1000 },
  ]);

  // A different part for the same person in the same item is a different row,
  // so the dedup key is the part and not just the person.
  await writer.attachRole(mediaItemId, { personId, role: 'director', name: null, billingOrder: null });
  assert.equal(readRoles(raw).length, 2, 'a second role for one person is a second row');

  // The upsert corrects the row rather than ignoring the write: a provider
  // that revises a billing order has to be able to land it.
  await writer.attachRole(mediaItemId, { personId, role: 'cast', name: 'The Countess', billingOrder: 0 });
  const roles = readRoles(raw);
  assert.equal(roles.length, 2, 'a revised part is still one row');
  const cast = roles.at(0);
  assert.ok(cast);
  assert.equal(cast.billingOrder, 0, 'the second attach must correct the row, not be discarded');
  assert.equal(cast.createdAt, 1000, 'created_at belongs to the first write: this is the same row seen again');
});

test('attachPoster and attachBackground are idempotent on their url', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000);

  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  const url = 'https://images.test/poster.jpg';

  await writer.attachPoster(mediaItemId, { title: null, language: null, url, width: 300, height: 450 });
  await writer.attachPoster(mediaItemId, { title: 'front', language: 'en', url, width: 600, height: 900 });
  const posters = raw.prepare('SELECT title, language, url, width, height FROM poster ORDER BY id')
    .all().map((row) => ({
      title: row['title'], language: row['language'], url: row['url'],
      width: row['width'], height: row['height'],
    }));
  assert.deepEqual(posters, [{ title: 'front', language: 'en', url, width: 600, height: 900 }]);

  // A second image for the same item is a second row: the key is the url, not
  // the item, or an item could only ever hold one poster.
  await writer.attachPoster(mediaItemId, { title: null, language: null, url: `${url}?v=2`, width: 300, height: 450 });
  assert.equal(raw.prepare('SELECT id FROM poster').all().length, 2);

  const bgUrl = 'https://images.test/bg.jpg';
  await writer.attachBackground(mediaItemId, { title: null, description: null, language: null, url: bgUrl, width: 1920, height: 1080 });
  await writer.attachBackground(mediaItemId, { title: 'wide', description: 'a grid', language: 'en', url: bgUrl, width: 3840, height: 2160 });
  const backgrounds = raw.prepare('SELECT title, description, language, url, width, height FROM background ORDER BY id')
    .all().map((row) => ({
      title: row['title'], description: row['description'], language: row['language'],
      url: row['url'], width: row['width'], height: row['height'],
    }));
  assert.deepEqual(backgrounds, [
    { title: 'wide', description: 'a grid', language: 'en', url: bgUrl, width: 3840, height: 2160 },
  ]);
});
