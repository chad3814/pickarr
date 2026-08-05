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

  const download = await pickRelease(db, fakeClient(), { groupId, releaseId }, 500);

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
  await pickRelease(db, fakeClient(), { groupId, releaseId }, 500);
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

  const download = await pickRelease(db, client, { groupId, releaseId }, 500);

  assert.equal(download.status, 'queued');
  assert.equal(download.clientRef, null);
  assert.match(download.error ?? '', /sab is down/);
  assert.equal(getGroup(db, groupId)?.state, 'picked');
  db.close();
});

test('a pick on an already-picked group is inferred as an upgrade and does not overwrite picked_release_id', async () => {
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

  // Neither call states its kind — pickRelease derives it from the group's
  // own state. The first call finds the group 'new' and infers 'initial';
  // by the time the second call runs, the group is already 'picked', so it
  // infers 'upgrade' with no way for the caller to force 'initial' again.
  const first = await pickRelease(db, fakeClient(), { groupId, releaseId: 1 }, 500);
  const second = await pickRelease(db, fakeClient(), { groupId, releaseId: 2 }, 600);

  assert.equal(first.kind, 'initial');
  assert.equal(second.kind, 'upgrade');
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, 1);
  assert.equal(getDownload(db, first.id)?.status, 'downloading');
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
    pickRelease(db, fakeClient(), { groupId: 2, releaseId: 1 }, 500),
    /does not belong/,
  );
  db.close();
});

test('picking an unknown release is rejected', async () => {
  const db = openTestDatabase();
  seed(db);
  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId: 1, releaseId: 999 }, 500),
    /999/,
  );
  db.close();
});

test('picking the same release twice while in flight is rejected', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  await pickRelease(db, fakeClient(), { groupId, releaseId }, 500);
  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId, releaseId }, 600),
    /already/i,
  );
  db.close();
});

test('the download row records the client id and timestamps', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  const download = await pickRelease(db, fakeClient(), { groupId, releaseId }, 500);
  const stored = getDownload(db, download.id)!;
  assert.equal(stored.clientId, 'sab');
  assert.equal(stored.createdAt, 500);
  db.close();
});

test('a persist failure after a successful addUrl is recorded distinctly from an addUrl failure', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  // addUrl (fakeClient's default) succeeds and returns 'nzo_1'; the trigger
  // makes the *persist* of that ref fail instead, simulating a DB error
  // between a successful submission and recording it.
  db.exec(`
    CREATE TRIGGER induced_persist_failure BEFORE UPDATE OF client_ref ON downloads
    BEGIN
      SELECT RAISE(ABORT, 'disk full');
    END;
  `);

  const download = await pickRelease(db, fakeClient(), { groupId, releaseId }, 500);

  // Still looks queued/untried at the status level (the ref never made it
  // in), but the error must name the ref that was already accepted so a
  // reconcile tick can tell this apart from "addUrl was never attempted"
  // and does not double-submit.
  assert.equal(download.status, 'queued');
  assert.equal(download.clientRef, null);
  assert.match(download.error ?? '', /nzo_1/);
  assert.match(download.error ?? '', /disk full/);
  assert.doesNotMatch(download.error ?? '', /^disk full$/);
  db.close();
});

test('a failure between marking picked and inserting the download rolls back the pick', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  // Forces insertDownload's INSERT to fail after markPicked's UPDATE has
  // already run inside the same transaction, without touching the SELECTs
  // pickRelease issues before the transaction starts.
  db.exec(`
    CREATE TRIGGER induced_insert_failure BEFORE INSERT ON downloads
    BEGIN
      SELECT RAISE(ABORT, 'induced failure for rollback test');
    END;
  `);

  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId, releaseId }, 500),
    /induced failure for rollback test/,
  );

  const group = getGroup(db, groupId)!;
  assert.equal(group.state, 'new');
  assert.equal(group.pickedReleaseId, null);
  db.close();
});
