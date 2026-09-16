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

test('artwork is three urls, not rows', async () => {
  const db = await freshDb();
  await seed(db, [{ op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } }]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  assert.deepEqual(gathered.artwork, {
    poster: '/api/artwork/poster/7',
    background: '/api/artwork/background/7',
    logo: '/api/artwork/logo/7',
  });
  for (const url of Object.values(gathered.artwork)) {
    assert.equal(typeof url, 'string');
  }
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
  // Pinned deliberately (design spec §2.4): neither id resolves to a name
  // from the replica alone -- `rss_feed` and `download_client` are not
  // synced -- so the gatherer's whole obligation here is to pass the bare
  // id through unchanged, and a later change to that is meant to be visible
  // in this test rather than silent.
  assert.equal(gathered.releases[0]?.row.feedId, 42);
  assert.equal(gathered.releases[0]?.downloads[0]?.row.downloadClientId, 77);
  db.close();
});
