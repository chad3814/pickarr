import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtworkStore } from '../../src/artwork/store.ts';
import { readdir } from 'node:fs/promises';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createMediaWriter } from '../../src/media/writer.ts';
import { gifBytes } from '../support/gif.ts';
import { insertFeed, noHooks, withArtworkStore } from './support.ts';

/** An `ArtworkStore` that fails loudly if a test that attaches no artwork somehow reaches it. */
const unusedArtwork: ArtworkStore = {
  put: async () => { throw new Error('artwork.put: not used by this test'); },
  putPerson: async () => { throw new Error('artwork.putPerson: not used by this test'); },
  remove: async () => { throw new Error('artwork.remove: not used by this test'); },
};

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
    'SELECT media_item_id, lookup_state, lookup_state_detail, lookup_json, updated_at FROM rss_item WHERE id = ?',
  ).get(id);
  return row as
    | {
      media_item_id: unknown;
      lookup_state: unknown;
      lookup_state_detail: unknown;
      lookup_json: unknown;
      updated_at: unknown;
    }
    | undefined;
}

function storedVideoResolution(raw: DatabaseSync, id: number): unknown {
  const row = raw.prepare('SELECT video_resolution FROM rss_item WHERE id = ?').get(id);
  return row === undefined ? undefined : row['video_resolution'];
}

/** A row read back from `person`. */
function readPerson(raw: DatabaseSync, id: number) {
  const row = raw.prepare('SELECT name, provider_ref, updated_at FROM person WHERE id = ?').get(id);
  return row as { name: unknown; provider_ref: unknown; updated_at: unknown } | undefined;
}

/** An rss item pointed at nothing yet, so a test can `relinkRssItem` it. */
function insertRssItem(raw: DatabaseSync, feedId: number, at: number): number {
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, lookup_state)
    VALUES (?, 'x.mkv', 'https://example.test/x', ?, ?, 'nzb', 'pending')
  `).run(feedId, at, at);
  return Number(result.lastInsertRowid);
}

test('claiming an unheld provider ref keeps the caller and drops nothing', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

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
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

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
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

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
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

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

  const writer = createMediaWriter(db, () => 999, unusedArtwork, noHooks);
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

  const writer = createMediaWriter(db, () => 999, unusedArtwork, noHooks);
  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  await writer.relinkRssItem(itemId, mediaItemId);

  await writer.relinkRssItem(itemId, null);

  const after = readRssItem(raw, itemId);
  assert.ok(after);
  assert.equal(after.media_item_id, null);
  assert.equal(after.updated_at, 999);
});

test('linking a release to a media item clears its stored lookup answer', async () => {
  // **The invariant, enforced in the statement that breaks it.** A stored
  // lookup answer exists only while a release is unmatched -- `lookup_json`
  // non-null implies `media_item_id IS NULL`, because `/unmatched` is the
  // only screen that reads it and a linked release has left that screen.
  //
  // It used to be two statements several `await`s apart in
  // `openmetadata/src/engine.ts`: the link, then the plugin's own `apply`
  // and `attachPeople`, then the clear. A throw in either of the middle two
  // left the row linked with its answer retained, and the lookup job
  // retries and then **dead-letters** -- so a persistently failing `apply`
  // stranded up to `LOOKUP_JSON_CAP_BYTES` on a row no screen shows and
  // nothing would ever clear. One statement has no window to lose.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);

  const feedId = insertFeed(raw, 'https://example.test/feed');
  const itemId = insertRssItem(raw, feedId, 500);
  const writer = createMediaWriter(db, () => 999, unusedArtwork, noHooks);
  await writer.setLookupState(itemId, 'unresolved', 'nothing recognised', '{"state":"unresolved"}');
  const stranded = readRssItem(raw, itemId);
  assert.ok(stranded);
  assert.equal(stranded.lookup_json, '{"state":"unresolved"}', 'the answer is there to begin with');

  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  await writer.relinkRssItem(itemId, mediaItemId);

  const after = readRssItem(raw, itemId);
  assert.ok(after);
  assert.equal(after.media_item_id, mediaItemId);
  assert.equal(after.lookup_json, null, 'and is gone the instant the release is linked');
});

test('unlinking a release leaves its stored lookup answer alone', async () => {
  // The other direction, and it must NOT clear. `relinkRssItem(id, null)` is
  // the refusal path: the media item created before the answer arrived is
  // being dropped, and the release goes back to being unmatched -- which is
  // exactly the state an answer belongs to. `applyEnvelope` writes a fresh
  // one immediately afterwards, so clearing here would be a write the next
  // statement undoes; but the reason it is wrong is the invariant, not the
  // redundancy.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);

  const feedId = insertFeed(raw, 'https://example.test/feed');
  const itemId = insertRssItem(raw, feedId, 500);
  const writer = createMediaWriter(db, () => 999, unusedArtwork, noHooks);
  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  await writer.relinkRssItem(itemId, mediaItemId);
  await writer.setLookupState(itemId, 'unresolved', 'nothing recognised', '{"state":"unresolved"}');

  await writer.relinkRssItem(itemId, null);

  const after = readRssItem(raw, itemId);
  assert.ok(after);
  assert.equal(after.media_item_id, null);
  assert.equal(after.lookup_json, '{"state":"unresolved"}', 'an unmatched release keeps its answer');
});

test('relinkRssItem on an rss item that does not exist throws', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

  await assert.rejects(() => writer.relinkRssItem(999_999, null));
});

test('updateMediaItem replaces title, release date and description, and bumps updated_at', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  let at = 1000;
  const writer = createMediaWriter(db, () => at, unusedArtwork, noHooks);

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
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

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
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

  await assert.rejects(() => writer.updateMediaItem(999_999, {
    title: 'nope',
    releaseDate: null,
    description: null,
  }));
});

test('creating an item, linking, unlinking with null, then dropping it succeeds', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

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

test('setLookupState records refused and unresolved as different states', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const feedId = insertFeed(raw, 'https://example.test/feed');
  const itemId = insertRssItem(raw, feedId, 0);
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

  await writer.setLookupState(itemId, 'refused', null, '{"lookupId":"lk_1"}');
  const refused = readRssItem(raw, itemId);
  assert.ok(refused);
  assert.equal(refused.lookup_state, 'refused');
  assert.equal(refused.lookup_state_detail, null);
  assert.equal(refused.lookup_json, '{"lookupId":"lk_1"}');

  await writer.setLookupState(itemId, 'unresolved', 'unrecognised filename', '{"lookupId":"lk_2"}');
  const unresolved = readRssItem(raw, itemId);
  assert.ok(unresolved);
  assert.equal(unresolved.lookup_state, 'unresolved');
  assert.equal(unresolved.lookup_state_detail, 'unrecognised filename');
  assert.equal(unresolved.lookup_json, '{"lookupId":"lk_2"}');
  // The two `assert.equal`s above are already what stops the two states
  // collapsing into one; a third assertion that the two differ restates them
  // rather than adding a way for this test to fail.
});

test('setLookupState clears lookup_json a failed attempt left, when the retry resolves', async () => {
  // The half a happy-path test misses: a release that failed, was retried
  // and matched must not keep the answer that explained the earlier
  // failure. `rss_item.lookup_json` is what `/unmatched` reads, so a
  // resolved row that still carried it would show a stale refusal for an
  // item that has since been identified.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const feedId = insertFeed(raw, 'https://example.test/feed');
  const itemId = insertRssItem(raw, feedId, 0);
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

  await writer.setLookupState(itemId, 'unresolved', 'unrecognised filename', '{"lookupId":"lk_3"}');
  assert.equal(readRssItem(raw, itemId)?.lookup_json, '{"lookupId":"lk_3"}', 'the failed attempt left an envelope');

  await writer.setLookupState(itemId, 'resolved', null, null);
  const resolved = readRssItem(raw, itemId);
  assert.equal(resolved?.lookup_state, 'resolved');
  assert.equal(resolved?.lookup_json, null, 'the resolved retry clears the earlier envelope');
});

test('setVideoResolution stores a normalized value or null, and moves updated_at', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const itemId = insertRssItem(raw, insertFeed(raw, 'https://example.test/feed'), 500);
  const writer = createMediaWriter(db, () => 999, unusedArtwork, noHooks);

  await writer.setVideoResolution(itemId, '2160p');
  assert.equal(storedVideoResolution(raw, itemId), '2160p');
  assert.equal(readRssItem(raw, itemId)?.updated_at, 999, 'a write the sync log sees');

  await writer.setVideoResolution(itemId, null);
  assert.equal(storedVideoResolution(raw, itemId), null, 'null clears it');
});

test('setVideoResolution writes nothing when the stored value already matches', async () => {
  // A poll or retry that re-reads the same parse must not move `updated_at`:
  // `/unmatched`'s Retry button reads an advance as "the retry landed", and
  // every rewrite is another row in the sync log for nothing.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const itemId = insertRssItem(raw, insertFeed(raw, 'https://example.test/feed'), 500);
  let clock = 1000;
  const writer = createMediaWriter(db, () => clock, unusedArtwork, noHooks);

  await writer.setVideoResolution(itemId, '1080p');
  assert.equal(readRssItem(raw, itemId)?.updated_at, 1000);
  clock = 2000;
  await writer.setVideoResolution(itemId, '1080p');
  assert.equal(readRssItem(raw, itemId)?.updated_at, 1000, 'the unchanged value left updated_at at the first write');
  await writer.setVideoResolution(itemId, '720p');
  assert.equal(readRssItem(raw, itemId)?.updated_at, 2000, 'a changed value still moves it');
});

test('setVideoResolution refuses a value the contract would not normalize to itself', async () => {
  // The writer is shared by every plugin and closes over no plugin id, so it
  // is the one place a caller that skipped `normalizeVideoResolution` is caught.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const itemId = insertRssItem(raw, insertFeed(raw, 'https://example.test/feed'), 500);
  const writer = createMediaWriter(db, () => 999, unusedArtwork, noHooks);
  for (const bad of ['1080P', '4K', '1080p/', '']) {
    await assert.rejects(writer.setVideoResolution(itemId, bad), /video resolution/, `refused ${bad}`);
  }
  assert.equal(storedVideoResolution(raw, itemId), null, 'and nothing was written');
});

test('upsertPerson returns the same id for a repeated providerRef', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

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
  const writer = createMediaWriter(db, () => 1000, unusedArtwork, noHooks);

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
  const writer = createMediaWriter(db, () => at, unusedArtwork, noHooks);

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

test('attaching a poster stores the row with the measured width and height', async () => {
  await withArtworkStore(async (artwork) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });

    // The caller supplies no width or height at all -- `ImageInit` has none
    // to give. Whatever lands in the row must be what the bytes measure to.
    await writer.attachPoster(mediaItemId, {
      title: 'front', language: 'en', url: 'https://images.test/poster.gif', bytes: gifBytes(300, 450), rank: 0,
    });

    const row = raw.prepare('SELECT title, language, url, width, height, path FROM poster WHERE media_item_id = ?')
      .get(mediaItemId) as { title: unknown; language: unknown; url: unknown; width: unknown; height: unknown; path: unknown };
    assert.ok(row);
    assert.equal(row.title, 'front');
    assert.equal(row.language, 'en');
    assert.equal(row.width, 300);
    assert.equal(row.height, 450);
    assert.equal(typeof row.path, 'string', 'a cached file path must be recorded');
  });
});

test('attaching a logo stores a row, which slice A had no way to do', async () => {
  await withArtworkStore(async (artwork) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });

    await writer.attachLogo(mediaItemId, {
      title: null, language: null, url: 'https://images.test/logo.gif', bytes: gifBytes(512, 128), rank: 0,
    });

    const row = raw.prepare('SELECT url, width, height, path FROM logo WHERE media_item_id = ?')
      .get(mediaItemId) as { url: unknown; width: unknown; height: unknown; path: unknown };
    assert.ok(row, 'attachLogo must have written a row -- slice A left this table with no writer at all');
    assert.equal(row.url, 'https://images.test/logo.gif');
    assert.equal(row.width, 512);
    assert.equal(row.height, 128);
    assert.equal(typeof row.path, 'string');
  });
});

test('attaching a person\'s picture stores the row with the measured width and height', async () => {
  await withArtworkStore(async (artwork) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const personId = await writer.upsertPerson({ name: 'An Actor', providerRef: 'tmdb:person:1' });

    await writer.attachPersonImage(personId, {
      title: null, language: null, url: 'https://images.test/headshot.gif', bytes: gifBytes(300, 450), rank: 0,
    });

    const row = raw.prepare('SELECT url, width, height, path FROM person_image WHERE person_id = ?')
      .get(personId) as { url: unknown; width: unknown; height: unknown; path: unknown };
    assert.ok(row, 'attachPersonImage must write a row to person_image, not to any media-item artwork table');
    assert.equal(row.url, 'https://images.test/headshot.gif');
    assert.equal(row.width, 300);
    assert.equal(row.height, 450);
    assert.equal(typeof row.path, 'string');
  });
});

test('attaching a person\'s picture twice leaves one row and one file', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const personId = await writer.upsertPerson({ name: 'An Actor', providerRef: 'tmdb:person:1' });
    const url = 'https://images.test/headshot.gif';

    await writer.attachPersonImage(personId, { title: null, language: null, url, bytes: gifBytes(300, 450), rank: 0 });
    // Crash recovery re-runs a handler that already ran once, the same
    // reason `attachPoster` has to be idempotent.
    await writer.attachPersonImage(personId, { title: 'front', language: 'en', url, bytes: gifBytes(300, 450), rank: 0 });

    const rows = raw.prepare('SELECT title FROM person_image WHERE person_id = ?')
      .all(personId) as { title: unknown }[];
    assert.equal(rows.length, 1, 'a re-attach of the same url must be the same row, not a second one');
    assert.equal(rows[0]?.title, 'front', 'the second attach must correct the row, not be discarded');

    const files = await readdir(dir);
    assert.equal(files.length, 1, 'a re-attach of the same url must be the same cached file, not a second one');
  });
});

/** An image init whose url and bytes are fixed by `name`, so a test can name its survivors. */
function imageNamed(name: string, rank: number) {
  return { title: null, language: null, url: `https://images.test/${name}.gif`, bytes: gifBytes(300, 450), rank };
}

test('attaching several posters keeps them all until keepArtwork names the survivors', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'movie', title: 'A Film', releaseDate: null, description: null });

    await writer.attachPoster(mediaItemId, imageNamed('a', 0));
    await writer.attachPoster(mediaItemId, imageNamed('b', 1));
    await writer.attachPoster(mediaItemId, imageNamed('c', 2));

    const read = () => raw.prepare('SELECT url, rank FROM poster WHERE media_item_id = ? ORDER BY rank ASC')
      .all(mediaItemId) as { url: unknown; rank: unknown }[];
    assert.deepEqual(read().map((row) => [row.url, row.rank]), [
      ['https://images.test/a.gif', 0],
      ['https://images.test/b.gif', 1],
      ['https://images.test/c.gif', 2],
    ]);
    assert.equal((await readdir(dir)).length, 3, 'attaching prunes nothing');

    await writer.keepArtwork('poster', mediaItemId, ['https://images.test/a.gif', 'https://images.test/b.gif']);

    assert.deepEqual(read().map((row) => [row.url, row.rank]), [
      ['https://images.test/a.gif', 0],
      ['https://images.test/b.gif', 1],
    ]);
    assert.equal((await readdir(dir)).length, 2, 'the dropped row\'s file is unlinked, the others\' are not');
  });
});

test('keepArtwork prunes background and logo too, and only for the named media item', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const first = await writer.createMediaItem({ pluginId: 'movie', title: 'One', releaseDate: null, description: null });
    const second = await writer.createMediaItem({ pluginId: 'movie', title: 'Two', releaseDate: null, description: null });

    for (const id of [first, second]) {
      await writer.attachBackground(id, imageNamed('b1', 0));
      await writer.attachBackground(id, imageNamed('b2', 1));
      await writer.attachLogo(id, imageNamed('l1', 0));
      await writer.attachLogo(id, imageNamed('l2', 1));
    }
    await writer.keepArtwork('background', first, ['https://images.test/b1.gif']);
    await writer.keepArtwork('logo', first, ['https://images.test/l2.gif']);

    const urls = (table: 'background' | 'logo', id: number) =>
      (raw.prepare(`SELECT url FROM ${table} WHERE media_item_id = ? ORDER BY id ASC`).all(id) as { url: unknown }[]).map((row) => row.url);
    assert.deepEqual(urls('background', first), ['https://images.test/b1.gif']);
    assert.deepEqual(urls('logo', first), ['https://images.test/l2.gif']);
    assert.deepEqual(urls('background', second), ['https://images.test/b1.gif', 'https://images.test/b2.gif'], 'another item is untouched');
    assert.deepEqual(urls('logo', second), ['https://images.test/l1.gif', 'https://images.test/l2.gif']);
    assert.equal((await readdir(dir)).length, 6, 'eight files attached, the first item\'s two superseded ones unlinked');
  });
});

test('re-attaching a url rewrites its rank in place and keeps its id', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'movie', title: 'A Film', releaseDate: null, description: null });
    await writer.attachPoster(mediaItemId, imageNamed('a', 0));
    await writer.attachPoster(mediaItemId, imageNamed('b', 1));
    const idOf = (name: string): unknown =>
      (raw.prepare('SELECT id FROM poster WHERE url = ?').get(`https://images.test/${name}.gif`) as { id: unknown }).id;
    const before = [idOf('a'), idOf('b')];

    // The provider's order changed: b is now the best.
    await writer.attachPoster(mediaItemId, imageNamed('b', 0));
    await writer.attachPoster(mediaItemId, imageNamed('a', 1));

    const rows = raw.prepare('SELECT id, url, rank FROM poster ORDER BY rank ASC').all() as { id: unknown; url: unknown; rank: unknown }[];
    assert.deepEqual(rows.map((row) => [row.url, row.rank]), [['https://images.test/b.gif', 0], ['https://images.test/a.gif', 1]]);
    assert.deepEqual([idOf('a'), idOf('b')], before, 'ids are stable across a re-rank');
    assert.equal((await readdir(dir)).length, 2);
  });
});

test('keepArtwork with an unchanged set deletes nothing and unlinks nothing', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const removed: string[] = [];
    const spied: ArtworkStore = {
      ...artwork,
      remove: async (path) => { removed.push(path); await artwork.remove(path); },
    };
    const writer = createMediaWriter(db, () => 1000, spied, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'movie', title: 'A Film', releaseDate: null, description: null });
    await writer.attachPoster(mediaItemId, imageNamed('a', 0));
    await writer.attachPoster(mediaItemId, imageNamed('b', 1));

    await writer.keepArtwork('poster', mediaItemId, ['https://images.test/b.gif', 'https://images.test/a.gif']);

    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM poster').get() as { n: unknown }).n, 2);
    assert.deepEqual(removed, []);
    assert.equal((await readdir(dir)).length, 2);
  });
});

test('keepPersonImages prunes person_image the same way', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const personId = await writer.upsertPerson({ name: 'An Actor', providerRef: 'tmdb:person:1' });
    const other = await writer.upsertPerson({ name: 'Another', providerRef: 'tmdb:person:2' });
    await writer.attachPersonImage(personId, imageNamed('a', 0));
    await writer.attachPersonImage(personId, imageNamed('b', 1));
    await writer.attachPersonImage(other, imageNamed('a', 0));
    await writer.attachPersonImage(other, imageNamed('b', 1));

    await writer.keepPersonImages(personId, ['https://images.test/a.gif']);

    const urls = (id: number) =>
      (raw.prepare('SELECT url FROM person_image WHERE person_id = ? ORDER BY id ASC').all(id) as { url: unknown }[]).map((row) => row.url);
    assert.deepEqual(urls(personId), ['https://images.test/a.gif']);
    assert.deepEqual(urls(other), ['https://images.test/a.gif', 'https://images.test/b.gif'], 'another person is untouched');
    assert.equal((await readdir(dir)).length, 3);
  });
});

test('attaching the same url twice is one row, which keepArtwork keeps', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'movie', title: 'A Film', releaseDate: null, description: null });
    await writer.attachPoster(mediaItemId, imageNamed('a', 0));
    await writer.attachPoster(mediaItemId, imageNamed('a', 0));

    await writer.keepArtwork('poster', mediaItemId, ['https://images.test/a.gif', 'https://images.test/a.gif']);

    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM poster').get() as { n: unknown }).n, 1);
    assert.equal((await readdir(dir)).length, 1);
  });
});

test('keepArtwork with no urls drops every row and file the owner has', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'movie', title: 'A Film', releaseDate: null, description: null });
    await writer.attachPoster(mediaItemId, imageNamed('a', 0));

    await writer.keepArtwork('poster', mediaItemId, []);

    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM poster').get() as { n: unknown }).n, 0);
    assert.equal((await readdir(dir)).length, 0);
  });
});

test('a person and a media item that share an id and a url get two files, not one', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    // `person.id` and `media_item.id` are two different tables' primary
    // keys, so the first row each table ever gets is id 1 in both -- exactly
    // the coincidence `ArtworkStore.putPerson`'s docblock describes. Sharing
    // the url too is what actually exercises the collision `put` alone
    // would have: the same `(id, url)` pair, if `putPerson` reused `put`'s
    // hash namespace, would resolve to the very same path.
    const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
    const personId = await writer.upsertPerson({ name: 'An Actor', providerRef: 'tmdb:person:1' });
    assert.equal(personId, mediaItemId, 'the fixture only proves the point if the two ids coincide');

    const url = 'https://images.test/shared.gif';
    await writer.attachPoster(mediaItemId, { title: null, language: null, url, bytes: gifBytes(300, 450), rank: 0 });
    await writer.attachPersonImage(personId, { title: null, language: null, url, bytes: gifBytes(300, 450), rank: 0 });

    const posterPath = (raw.prepare('SELECT path FROM poster WHERE media_item_id = ?').get(mediaItemId) as { path: unknown }).path;
    const personPath = (raw.prepare('SELECT path FROM person_image WHERE person_id = ?').get(personId) as { path: unknown }).path;
    assert.notEqual(posterPath, personPath, 'a shared id and url must not resolve to the same cached file');

    const files = await readdir(dir);
    assert.equal(files.length, 2, 'a shared id and url must produce two files, not one overwriting the other');
  });
});

test('attaching the same url twice leaves one row and one file', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
    const url = 'https://images.test/poster.gif';

    await writer.attachPoster(mediaItemId, { title: null, language: null, url, bytes: gifBytes(300, 450), rank: 0 });
    // Crash recovery re-runs a handler that already ran once; a second
    // attach of the same url must be the same row and the same file, not a
    // second of either.
    await writer.attachPoster(mediaItemId, { title: 'front', language: 'en', url, bytes: gifBytes(300, 450), rank: 0 });

    const rows = raw.prepare('SELECT title, language FROM poster WHERE media_item_id = ?')
      .all(mediaItemId) as { title: unknown; language: unknown }[];
    assert.equal(rows.length, 1, 'a re-attach of the same url must be the same row, not a second one');
    assert.equal(rows[0]?.title, 'front', 'the second attach must correct the row, not be discarded');

    const files = await readdir(dir);
    assert.equal(files.length, 1, 'a re-attach of the same url must be the same cached file, not a second one');
  });
});

test('every attach writes the image\'s rank, and a re-attach corrects it', async () => {
  await withArtworkStore(async (artwork) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
    const personId = await writer.upsertPerson({ name: 'An Actor', providerRef: 'tmdb:person:rank' });
    const init = (name: string, rank: number) => ({ title: null, language: null, url: `https://images.test/${name}.gif`, bytes: gifBytes(300, 450), rank });

    await writer.attachPoster(mediaItemId, init('p', 3));
    await writer.attachBackground(mediaItemId, init('b', 2));
    await writer.attachLogo(mediaItemId, init('l', 1));
    await writer.attachPersonImage(personId, init('i', 4));
    const rankOf = (table: 'poster' | 'background' | 'logo' | 'person_image'): unknown =>
      (raw.prepare(`SELECT rank FROM ${table}`).get() as { rank: unknown }).rank;
    assert.deepEqual(
      [rankOf('poster'), rankOf('background'), rankOf('logo'), rankOf('person_image')],
      [3, 2, 1, 4],
    );

    await writer.attachPoster(mediaItemId, init('p', 0));
    await writer.attachBackground(mediaItemId, init('b', 0));
    await writer.attachLogo(mediaItemId, init('l', 0));
    await writer.attachPersonImage(personId, init('i', 0));
    assert.deepEqual(
      [rankOf('poster'), rankOf('background'), rankOf('logo'), rankOf('person_image')],
      [0, 0, 0, 0],
      'the conflict update rewrites rank',
    );
  });
});

test('dropping a media item deletes its artwork rows and their files', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });

    await writer.attachPoster(mediaItemId, { title: null, language: null, url: 'https://images.test/poster.gif', bytes: gifBytes(300, 450), rank: 0 });
    await writer.attachBackground(mediaItemId, { title: null, language: null, url: 'https://images.test/bg.gif', bytes: gifBytes(1920, 1080), rank: 0 });
    await writer.attachLogo(mediaItemId, { title: null, language: null, url: 'https://images.test/logo.gif', bytes: gifBytes(512, 128), rank: 0 });
    assert.equal((await readdir(dir)).length, 3, 'three cached files must exist before the drop');

    await writer.dropMediaItem(mediaItemId);

    assert.equal(raw.prepare('SELECT id FROM poster WHERE media_item_id = ?').all(mediaItemId).length, 0);
    assert.equal(raw.prepare('SELECT id FROM background WHERE media_item_id = ?').all(mediaItemId).length, 0);
    assert.equal(raw.prepare('SELECT id FROM logo WHERE media_item_id = ?').all(mediaItemId).length, 0);
    assert.equal(readMediaItem(raw, mediaItemId), undefined, 'the media item itself must be gone');

    // An orphaned file leaks; an orphaned row is worse, because something
    // will try to serve it. This is the leak-avoiding half of that trade.
    assert.equal((await readdir(dir)).length, 0, 'the cached files must be unlinked along with their rows');
  });
});

test('the same url on two different media items gets two files, and dropping one leaves the other intact', async () => {
  await withArtworkStore(async (artwork, dir) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const itemA = await writer.createMediaItem({ pluginId: 'alpha', title: 'a', releaseDate: null, description: null });
    const itemB = await writer.createMediaItem({ pluginId: 'alpha', title: 'b', releaseDate: null, description: null });

    // A series poster, or a studio placeholder, can legitimately back two
    // media items at once. The path must key on (mediaItemId, url), matching
    // the (media_item_id, url) unique index exactly -- keying on the url
    // alone would collide the two items onto one file, and dropping either
    // one would unlink the file the other's row still names.
    const url = 'https://images.test/shared-poster.gif';
    await writer.attachPoster(itemA, { title: null, language: null, url, bytes: gifBytes(300, 450), rank: 0 });
    await writer.attachPoster(itemB, { title: null, language: null, url, bytes: gifBytes(300, 450), rank: 0 });
    assert.equal((await readdir(dir)).length, 2, 'two media items sharing a url must produce two files');

    const pathOf = (mediaItemId: number) => (
      raw.prepare('SELECT path FROM poster WHERE media_item_id = ?').get(mediaItemId) as { path: unknown }
    ).path;
    const pathA = pathOf(itemA);
    const pathB = pathOf(itemB);
    assert.notEqual(pathA, pathB, 'two different media items sharing a url must not share a path');

    await writer.dropMediaItem(itemA);

    assert.equal(raw.prepare('SELECT id FROM poster WHERE media_item_id = ?').all(itemA).length, 0);
    assert.ok(readMediaItem(raw, itemB), 'item B\'s row must be untouched by dropping item A');
    const stillPosterB = raw.prepare('SELECT path FROM poster WHERE media_item_id = ?').get(itemB) as { path: unknown };
    assert.equal(stillPosterB.path, pathB, 'item B\'s poster row must be untouched');

    const filesAfter = await readdir(dir);
    assert.equal(filesAfter.length, 1, 'only item A\'s file must be gone');
    assert.ok(typeof pathB === 'string' && filesAfter.includes(pathB.slice(dir.length + 1)),
      'item B\'s file must still exist on disk after dropping item A');
  });
});

test('a portrait image and a landscape image are stored as given, not reclassified', async () => {
  await withArtworkStore(async (artwork) => {
    const { raw, db } = openTestDatabase();
    migrateHost(raw);
    const writer = createMediaWriter(db, () => 1000, artwork, noHooks);
    const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });

    // A landscape image attached as a poster, and a portrait image attached
    // as a background. The caller chose the method; measuring only supplies
    // dimensions, it never moves an image between tables the way
    // packages/core/src/media/classify.ts's classifyArtwork does.
    await writer.attachPoster(mediaItemId, { title: null, language: null, url: 'https://images.test/wide.gif', bytes: gifBytes(1920, 1080), rank: 0 });
    await writer.attachBackground(mediaItemId, { title: null, language: null, url: 'https://images.test/tall.gif', bytes: gifBytes(300, 450), rank: 0 });

    const poster = raw.prepare('SELECT width, height FROM poster WHERE media_item_id = ?')
      .get(mediaItemId) as { width: unknown; height: unknown };
    assert.equal(poster.width, 1920);
    assert.equal(poster.height, 1080);

    const background = raw.prepare('SELECT width, height FROM background WHERE media_item_id = ?')
      .get(mediaItemId) as { width: unknown; height: unknown };
    assert.equal(background.width, 300);
    assert.equal(background.height, 450);
  });
});

/** The tombstone row for one media item, column by column. */
function readTombstone(raw: DatabaseSync, mediaItemId: number) {
  const row = raw.prepare(
    'SELECT media_item_id, plugin_id, deleted_at FROM deleted_media_item WHERE media_item_id = ?',
  ).get(mediaItemId);
  return row as { media_item_id: unknown; plugin_id: unknown; deleted_at: unknown } | undefined;
}

/**
 * A poster row with no cached file, inserted directly so a test can watch the
 * artwork deletes roll back. `path` is null on purpose: `artworkPaths` skips
 * null paths, so nothing here ever reaches `artwork.remove` and the loud
 * `unusedArtwork` store stays appropriate.
 */
function insertPathlessPoster(raw: DatabaseSync, mediaItemId: number, url: string): number {
  const result = raw.prepare(`
    INSERT INTO poster (media_item_id, title, language, url, width, height, path, created_at)
    VALUES (?, NULL, NULL, ?, 300, 450, NULL, 0)
  `).run(mediaItemId, url);
  return Number(result.lastInsertRowid);
}

/**
 * A trigger that aborts every delete of one media item row, so the DELETE
 * inside `dropMediaItem`'s savepoint fails with SQLITE_CONSTRAINT_TRIGGER
 * (1811) after the tombstone has already been written. The same device
 * `claimProviderRef`'s non-unique-failure test uses, on the other verb.
 */
function guardAgainstDeleting(raw: DatabaseSync, mediaItemId: number): void {
  raw.exec(`
    CREATE TRIGGER guard_drop BEFORE DELETE ON media_item WHEN OLD.id = ${mediaItemId}
    BEGIN
      SELECT RAISE(ABORT, 'synthetic delete failure for this test');
    END;
  `);
}

test('dropping a media item writes a tombstone naming its plugin', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 4321, unusedArtwork, noHooks);
  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });

  await writer.dropMediaItem(mediaItemId);

  assert.equal(readMediaItem(raw, mediaItemId), undefined, 'the media item must be gone');
  const tombstone = readTombstone(raw, mediaItemId);
  assert.ok(tombstone, 'a deletion no live row can express must leave a tombstone');
  assert.equal(tombstone.media_item_id, mediaItemId);
  // Copied off the row before it was deleted: there is nothing left to join
  // to afterwards, which is why the tombstone carries its own copy.
  assert.equal(tombstone.plugin_id, 'alpha');
  assert.equal(tombstone.deleted_at, 4321, 'deleted_at comes from the injected clock, like every other write here');
});

test('a drop that fails leaves neither the deletion nor the tombstone', async () => {
  // Force a failure inside the savepoint and assert both the media item and
  // the tombstone are absent. This is what putting it in the savepoint buys.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 4321, unusedArtwork, noHooks);
  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  const posterId = insertPathlessPoster(raw, mediaItemId, 'https://images.test/poster.gif');
  guardAgainstDeleting(raw, mediaItemId);

  await assert.rejects(() => writer.dropMediaItem(mediaItemId));

  assert.ok(readMediaItem(raw, mediaItemId), 'the media item must survive a drop that failed');
  assert.ok(
    raw.prepare('SELECT id FROM poster WHERE id = ?').get(posterId),
    'the artwork delete must have rolled back too -- one savepoint covers all four',
  );
  assert.equal(
    readTombstone(raw, mediaItemId),
    undefined,
    'a tombstone that outlived the rollback would tell every client an item was deleted that is still there',
  );
});

test('a drop whose tombstone cannot be written deletes nothing', async () => {
  // The other half of "together or not at all": the tombstone insert is
  // inside the savepoint, so a tombstone that cannot be written takes the
  // deletion down with it rather than leaving a deleted row nothing records.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const writer = createMediaWriter(db, () => 4321, unusedArtwork, noHooks);
  const mediaItemId = await writer.createMediaItem({ pluginId: 'alpha', title: 't', releaseDate: null, description: null });
  raw.exec(`
    CREATE TRIGGER guard_tombstone BEFORE INSERT ON deleted_media_item
    BEGIN
      SELECT RAISE(ABORT, 'synthetic tombstone failure for this test');
    END;
  `);

  await assert.rejects(() => writer.dropMediaItem(mediaItemId));

  assert.ok(readMediaItem(raw, mediaItemId), 'the media item must survive a tombstone that could not be written');
});

test('a media item id reused after a drop is tombstoned again, not collided with', async () => {
  // SQLite reuses the highest rowid once its row is deleted -- measured, not
  // assumed -- and the dedup path drops exactly the newest row, so the very
  // next createMediaItem takes the dropped id back. A plain INSERT would hit
  // `deleted_media_item`'s primary key and abort the whole second drop,
  // leaving the loser of that claim alive.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  let clock = 1000;
  const writer = createMediaWriter(db, () => clock, unusedArtwork, noHooks);

  const first = await writer.createMediaItem({ pluginId: 'alpha', title: 'first', releaseDate: null, description: null });
  await writer.dropMediaItem(first);

  clock = 2000;
  const second = await writer.createMediaItem({ pluginId: 'beta', title: 'second', releaseDate: null, description: null });
  assert.equal(second, first, 'this test is only meaningful while SQLite hands the dropped rowid back');
  await writer.dropMediaItem(second);

  assert.equal(readMediaItem(raw, second), undefined, 'the second drop must have deleted the row');
  const tombstone = readTombstone(raw, second);
  assert.ok(tombstone, 'the reused id must be tombstoned again');
  assert.equal(tombstone.plugin_id, 'beta', 'the tombstone must name the second owner, not the first');
  assert.equal(tombstone.deleted_at, 2000, 'and carry the second deletion\'s time, so a client sees it move');
});
