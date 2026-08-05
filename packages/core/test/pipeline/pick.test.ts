import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { pickRelease } from '../../src/pipeline/pick.ts';
import { getGroup } from '../../src/db/groups.ts';
import { getDownload } from '../../src/db/downloads.ts';
import type { DownloadClient, ClientSnapshot } from '../../src/clients/types.ts';

function fakeClient(overrides: Partial<DownloadClient> = {}): DownloadClient {
  return {
    id: 'sab',
    importMode: 'move',
    addUrl: async () => 'nzo_1',
    snapshot: async (): Promise<ClientSnapshot> => ({ queue: [], history: [] }),
    mapPath: (path) => path,
    ...overrides,
  };
}

function seed(db: DatabaseSync): { groupId: number; releaseId: number } {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'Title', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{}', 't', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1)`,
  ).run();
  return { groupId: 1, releaseId: 1 };
}

test('picking marks the group picked and starts a download', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);

  const download = await pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 500);

  const group = getGroup(db, groupId)!;
  assert.equal(group.state, 'picked');
  assert.equal(group.pickedReleaseId, releaseId);
  assert.equal(download.status, 'downloading');
  assert.equal(download.clientRef, 'nzo_1');
  assert.equal(download.kind, 'initial');
  db.close();
});

test('picking sets picked_release_id immediately, before any download finishes', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  await pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 500);
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, releaseId);
  db.close();
});

test('an addUrl failure leaves the download queued and the pick intact', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  const client = fakeClient({
    addUrl: async () => {
      throw new Error('sab is down');
    },
  });

  const download = await pickRelease(db, client, { groupId, releaseId, kind: 'initial' }, 500);

  assert.equal(download.status, 'queued');
  assert.equal(download.clientRef, null);
  assert.match(download.error ?? '', /sab is down/);
  assert.equal(getGroup(db, groupId)?.state, 'picked');
  db.close();
});

test('an upgrade pick does not overwrite picked_release_id', async () => {
  const db = openTestDatabase();
  const { groupId } = seed(db);
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (2, 'f', 'g2', 'Title 2', 'https://indexer.invalid/2.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (2, 1, 2, '{}', 200, 1)`,
  ).run();
  await pickRelease(db, fakeClient(), { groupId, releaseId: 1, kind: 'initial' }, 500);
  await pickRelease(db, fakeClient(), { groupId, releaseId: 2, kind: 'upgrade' }, 600);

  assert.equal(getGroup(db, groupId)?.pickedReleaseId, 1);
  db.close();
});

test('picking a release that belongs to another group is rejected', async () => {
  const db = openTestDatabase();
  seed(db);
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (2, 'test', 'k2', '{}', 't', 1, 1)`,
  ).run();

  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId: 2, releaseId: 1, kind: 'initial' }, 500),
    /does not belong/,
  );
  db.close();
});

test('picking an unknown release is rejected', async () => {
  const db = openTestDatabase();
  seed(db);
  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId: 1, releaseId: 999, kind: 'initial' }, 500),
    /999/,
  );
  db.close();
});

test('picking the same release twice while in flight is rejected', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  await pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 500);
  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 600),
    /already/i,
  );
  db.close();
});

test('the download row records the client id and timestamps', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  const download = await pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 500);
  const stored = getDownload(db, download.id)!;
  assert.equal(stored.clientId, 'sab');
  assert.equal(stored.createdAt, 500);
  db.close();
});
