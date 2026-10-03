import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { gatherMediaItem } from '../../src/store/gather.ts';

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

test('one media item is gathered from a single byMediaItem query', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    { op: 'upsert', table: 'rss_item', id: 1, value: { mediaItemId: 7, feedId: 40, filename: 'a' } },
    { op: 'upsert', table: 'role', id: 2, value: { mediaItemId: 7, personId: 9, role: 'actor' } },
    // A plugin's own detail row for this item. gather.ts must not know this
    // table's name -- it neither surfaces this row nor breaks on it.
    { op: 'upsert', table: 'widget_detail', id: 3, value: { mediaItemId: 7, kind: 'episode' } },
    // Noise: a release belonging to a different media item entirely.
    { op: 'upsert', table: 'rss_item', id: 4, value: { mediaItemId: 8, feedId: 41, filename: 'b' } },
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  assert.deepEqual(gathered.mediaItem, { pluginId: 'demo', title: 'A Show' });
  assert.equal(gathered.releases.length, 1);
  assert.equal(gathered.releases[0]?.id, 1);
  assert.equal(gathered.roles.length, 1);
  assert.equal(gathered.roles[0]?.id, 2);
  db.close();
});

test('gatherMediaItem answers undefined for a media item never replicated', async () => {
  const db = await freshDb();

  assert.equal(await gatherMediaItem(db, 999), undefined);
  db.close();
});

test('downloads are attached to the release that owns them, not to the item', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    { op: 'upsert', table: 'rss_item', id: 1, value: { mediaItemId: 7, feedId: 40, filename: 'a' } },
    { op: 'upsert', table: 'rss_item', id: 2, value: { mediaItemId: 7, feedId: 40, filename: 'b' } },
    { op: 'upsert', table: 'torrent_download', id: 10, value: { rssItemId: 1, downloadClientId: 5, status: 'downloading' } },
    { op: 'upsert', table: 'nzb_download', id: 11, value: { rssItemId: 2, downloadClientId: 5, status: 'queued' } },
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  const releaseOne = gathered.releases.find((release) => release.id === 1);
  const releaseTwo = gathered.releases.find((release) => release.id === 2);
  assert.ok(releaseOne !== undefined && releaseTwo !== undefined);
  assert.deepEqual(
    releaseOne.downloads.map((download) => [download.table, download.id]),
    [['torrent_download', 10]],
  );
  assert.deepEqual(
    releaseTwo.downloads.map((download) => [download.table, download.id]),
    [['nzb_download', 11]],
  );
  // Nothing on GatheredItem itself carries a flat download list -- a
  // download belongs to the release it was submitted for, never to the item.
  assert.ok(!('downloads' in gathered));
  db.close();
});

test('a role is paired with its person, and a role whose person has not arrived yet is kept', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    { op: 'upsert', table: 'role', id: 1, value: { mediaItemId: 7, personId: 100, role: 'actor', name: 'Has Arrived' } },
    { op: 'upsert', table: 'person', id: 100, value: { name: 'Here' } },
    // Mid-backfill this is normal (sync spec §5.2): the role for this person
    // was written to the log before the person was. Dropping it would make
    // the cast silently short.
    { op: 'upsert', table: 'role', id: 2, value: { mediaItemId: 7, personId: 200, role: 'actor', name: 'Not Yet Arrived' } },
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  assert.equal(gathered.roles.length, 2);
  const arrived = gathered.roles.find((role) => role.id === 1);
  const notYetArrived = gathered.roles.find((role) => role.id === 2);
  assert.ok(arrived !== undefined && notYetArrived !== undefined);
  assert.deepEqual(arrived.person, { name: 'Here' });
  assert.equal(notYetArrived.person, undefined);
  db.close();
});

/** A `poster`, `background` or `logo` row as the host replicates it -- no `url`, no `path`. */
function artworkRow(table: 'poster' | 'background' | 'logo', id: number, mediaItemId: number, rank: number): SyncOp {
  return { op: 'upsert', table, id, value: { id, mediaItemId, width: 10, height: 15, language: null, rank, createdAt: 1 } };
}

function personImageRow(id: number, personId: number, rank: number): SyncOp {
  return { op: 'upsert', table: 'person_image', id, value: { id, personId, width: 10, height: 15, language: null, rank, createdAt: 1 } };
}

test("artwork is the item's poster, background and logo rows, each list by rank then id, with per-row urls", async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    artworkRow('poster', 20, 7, 1),
    artworkRow('poster', 21, 7, 0),
    artworkRow('poster', 22, 7, 0),
    artworkRow('background', 30, 7, 0),
    // Another item's poster must not leak in.
    artworkRow('poster', 23, 8, 0),
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  assert.deepEqual(
    gathered.artwork.posters.map((p) => [p.id, p.rank, p.url]),
    [[21, 0, '/api/artwork/poster/21'], [22, 0, '/api/artwork/poster/22'], [20, 1, '/api/artwork/poster/20']],
  );
  assert.deepEqual(
    gathered.artwork.backgrounds.map((p) => [p.id, p.url]),
    [[30, '/api/artwork/background/30']],
  );
  assert.deepEqual(gathered.artwork.logos, []);
  assert.deepEqual(gathered.artwork.posters[0], {
    id: 21, url: '/api/artwork/poster/21', width: 10, height: 15, language: null, rank: 0,
  });
  db.close();
});

test("a role carries its person's pictures by rank, and none when the person has no rows", async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    { op: 'upsert', table: 'person', id: 9, value: { name: 'Pictured' } },
    { op: 'upsert', table: 'person', id: 10, value: { name: 'Plain' } },
    { op: 'upsert', table: 'role', id: 1, value: { mediaItemId: 7, personId: 9, role: 'actor' } },
    { op: 'upsert', table: 'role', id: 2, value: { mediaItemId: 7, personId: 10, role: 'actor' } },
    personImageRow(50, 9, 1),
    personImageRow(51, 9, 0),
    personImageRow(52, 11, 0),
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  const pictured = gathered.roles.find((role) => role.id === 1);
  const plain = gathered.roles.find((role) => role.id === 2);
  assert.ok(pictured !== undefined && plain !== undefined);
  assert.deepEqual(
    pictured.images.map((image) => [image.id, image.url]),
    [[51, '/api/artwork/person/51'], [50, '/api/artwork/person/50']],
  );
  assert.deepEqual(plain.images, []);
  db.close();
});

test('a poster row missing rank, or with a string width, is skipped while the others still list', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    artworkRow('poster', 20, 7, 0),
    { op: 'upsert', table: 'poster', id: 21, value: { mediaItemId: 7, width: 10, height: 15, language: null } },
    { op: 'upsert', table: 'poster', id: 22, value: { mediaItemId: 7, width: '10', height: 15, language: null, rank: 1 } },
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  assert.deepEqual(gathered.artwork.posters.map((p) => p.id), [20]);
  db.close();
});

test('a poster row for an item not yet replicated does not break gathering of another item', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    artworkRow('poster', 20, 7, 0),
    artworkRow('poster', 90, 99, 0),
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  assert.deepEqual(gathered.artwork.posters.map((p) => p.id), [20]);
  assert.equal(await gatherMediaItem(db, 99), undefined);
  db.close();
});

test('feedId and downloadClientId are surfaced as ids, because the replica cannot resolve them', async () => {
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    { op: 'upsert', table: 'rss_item', id: 1, value: { mediaItemId: 7, feedId: 42, filename: 'a' } },
    { op: 'upsert', table: 'torrent_download', id: 10, value: { rssItemId: 1, downloadClientId: 77, status: 'downloading' } },
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  // Pinned deliberately: both tables are synced now (`rss_feed` in the feed
  // settings slice, `download_client` in the download clients one), so both
  // ids *could* be resolved -- but not by this gatherer, which names six
  // tables and neither of those two. Its whole obligation here is to pass
  // the bare id through unchanged, and a later change to that is meant to
  // be visible in this test rather than silent. (This comment used to say
  // neither table was synced, which was true when it was written and is
  // not now.)
  assert.equal(gathered.releases[0]?.row.feedId, 42);
  assert.equal(gathered.releases[0]?.downloads[0]?.row.downloadClientId, 77);
  db.close();
});

test('a row that does not match its contract shape is declined, not asserted into place', async () => {
  // The blocking finding from task 7's review: this module used to cast
  // `unknown` to each contract type. A replica persists across client builds,
  // and neither SCHEMA_VERSION nor the generation token fires when a *wire
  // shape* changes -- so a row written by an older build reaches a newer one
  // with a field renamed away. A cast turns that into a crash somewhere
  // downstream; a check turns it into a row this gatherer declines.
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    // A release from a build that had not named `feedId` yet.
    { op: 'upsert', table: 'rss_item', id: 1, value: { mediaItemId: 7, filename: 'old-shape' } },
    { op: 'upsert', table: 'rss_item', id: 2, value: { mediaItemId: 7, feedId: 40, filename: 'current' } },
    // A role from a build that spelled the person link differently.
    { op: 'upsert', table: 'role', id: 3, value: { mediaItemId: 7, role: 'actor' } },
    { op: 'upsert', table: 'role', id: 4, value: { mediaItemId: 7, personId: 9, role: 'actor' } },
  ]);

  const gathered = await gatherMediaItem(db, 7);
  assert.ok(gathered !== undefined, 'the item itself still matches, so it is still assembled');
  assert.deepEqual(gathered.releases.map((release) => release.id), [2], 'the unshaped release is left out');
  assert.deepEqual(gathered.roles.map((role) => role.id), [4], 'and so is the unshaped role');
  db.close();
});

test('a media item that does not match its shape reads as absent', async () => {
  // Answered the same way as a tombstone or a row that has not arrived. The
  // alternative is handing a caller an object whose `pluginId` is undefined,
  // which fails somewhere with no connection to the cause.
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { title: 'no pluginId' } },
  ]);
  assert.equal(await gatherMediaItem(db, 7), undefined);
  db.close();
});

