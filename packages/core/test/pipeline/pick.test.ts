import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportPlan, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase, TEST_LABEL_TOKEN } from '../../src/db/open.ts';
import { pickRelease } from '../../src/pipeline/pick.ts';
import { importDownload } from '../../src/pipeline/import.ts';
import { browsableGroup, getGroup } from '../../src/db/groups.ts';
import {
  extractLabel,
  failDownload,
  getDownload,
  downloadLabel,
  setStatus,
  setStoragePath,
} from '../../src/db/downloads.ts';
import { insertImportedFile, markTrashed } from '../../src/db/imported-files.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';
import type { DownloadClient, ClientSnapshot } from '../../src/clients/types.ts';

function fakeClient(overrides: Partial<DownloadClient> = {}): DownloadClient {
  return {
    id: 'sab',
    importMode: 'move',
    category: 'pickarr',
    addUrl: async () => 'nzo_1',
    snapshot: async (): Promise<ClientSnapshot> => ({ queue: [], history: [], complete: true }),
    remove: async (): Promise<void> => {},
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

/**
 * A second release for the seeded group, so a test can pick twice. `score` is
 * stated by the caller because which of the two is *better* is the only thing
 * that varies between the upgrade cases below.
 */
function addRelease(db: DatabaseSync, id: number, score: number): number {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(id, `g${id}`, `Title ${id}`, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, 1, ?, '{}', ?, 1)`,
  ).run(id, id, score);
  return id;
}

/** A file on disk under the group's name, attributed to `downloadId`. */
function addLiveFile(db: DatabaseSync, downloadId: number): number {
  return insertImportedFile(db, {
    downloadId,
    groupId: 1,
    sourcePath: '/downloads/scene.mp4',
    destPath: '/library/Site/scene.mp4',
    sizeBytes: 1,
    createdAt: 1,
  });
}

test('picking marks the group picked and starts a download', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);

  const download = await pickRelease(db, () => fakeClient(), { groupId, releaseId }, 500);

  const group = getGroup(db, groupId)!;
  assert.equal(group.state, 'picked');
  assert.equal(group.pickedReleaseId, releaseId);
  assert.equal(download.status, 'downloading');
  assert.equal(download.clientRef, 'nzo_1');
  assert.equal(download.kind, 'initial');
  db.close();
});

// The job name sent to the client is the release's own raw title (readable
// in SABnzbd's UI) with the download's recovery marker appended, not the
// bare marker alone — a bare 'pickarr-7' is what made every job in the real
// SABnzbd UI unreadable. The marker must still be recoverable by
// extractLabel regardless of what the title looks like.
test('addUrl is sent a name carrying the release title, with the label recoverable as a marker', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  let seenName: string | undefined;
  const client = fakeClient({
    addUrl: async (_url: string, name: string) => {
      seenName = name;
      return 'nzo_1';
    },
  });

  const download = await pickRelease(db, () => client, { groupId, releaseId }, 500);

  assert.match(seenName ?? '', /^Title /);
  assert.equal(extractLabel(seenName ?? ''), downloadLabel(TEST_LABEL_TOKEN, download.id));
  db.close();
});

// The marker also travels to addUrl as its own argument, not only embedded in
// the name — a client that wants the marker in a field of its own (the
// qBittorrent tag, task 7) gets it here instead of re-deriving it with its own
// copy of the marker pattern. `label` must be exactly `downloadLabel`, and
// `name` must still carry that same label as its bracketed marker.
test('the marker reaches addUrl separately from the name it is embedded in', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  const calls: { name: string; label: string }[] = [];
  const client = fakeClient({
    addUrl: async (_url: string, name: string, label: string) => {
      calls.push({ name, label });
      return 'nzo_1';
    },
  });

  const download = await pickRelease(db, () => client, { groupId, releaseId }, 500);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.label, downloadLabel(TEST_LABEL_TOKEN, download.id));
  assert.ok(calls[0]!.name.endsWith(`[${calls[0]!.label}]`));
  db.close();
});

test('picking sets picked_release_id immediately, before any download finishes', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  await pickRelease(db, () => fakeClient(), { groupId, releaseId }, 500);
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

  const download = await pickRelease(db, () => client, { groupId, releaseId }, 500);

  assert.equal(download.status, 'queued');
  assert.equal(download.clientRef, null);
  assert.match(download.error ?? '', /sab is down/);
  assert.equal(getGroup(db, groupId)?.state, 'picked');
  db.close();
});

// --- What makes a pick an upgrade ------------------------------------
//
// An upgrade means "replace the file you have": it defers moving the pick
// until the replacement imports, and on import it trashes what it supersedes.
// Both behaviours are about a file, so `kind` turns on whether the group holds
// one — not on the group being in state 'picked', which is also true of a
// group whose only download failed and left nothing behind.

test('a pick on a group holding a live file is an upgrade and leaves the pick until import', async () => {
  const db = openTestDatabase();
  const { groupId } = seed(db);
  addRelease(db, 2, 200);

  const first = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 1 }, 500);
  addLiveFile(db, first.id);
  const second = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 2 }, 600);

  assert.equal(second.kind, 'upgrade');
  // The file on disk is still release 1's, so that is still what the group
  // has; the pointer moves when the replacement actually lands.
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, 1);
  db.close();
});

test('picking an upgrade takes the group out of the browse list', async () => {
  const db = openTestDatabase();
  const { groupId } = seed(db);
  addRelease(db, 2, 200);

  const first = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 1 }, 500);
  addLiveFile(db, first.id);
  // Holding release 1, release 2 is the better one on offer — which is exactly
  // what puts this picked group in the browse list at all (`BROWSABLE` is
  // "unpicked, or something better available").
  assert.equal(browsableGroup(db, groupId)?.upgradeReleaseId, 2);

  await pickRelease(db, () => fakeClient(), { groupId, releaseId: 2 }, 600);

  // The reported bug. An upgrade deliberately leaves `picked_release_id` on
  // release 1 until the replacement imports, and that was mistaken for having
  // nothing to write — so `upgrade_release_id` went on naming release 2 and
  // the card stayed put, advertising the release the user had just asked for.
  // Clicking its Pick button again could only return `already has download`.
  //
  // Asserted through `browsableGroup` rather than the column, because that is
  // the function the route answers the SPA with: a null here is what makes
  // Browse drop the card.
  assert.equal(browsableGroup(db, groupId), null);
  assert.equal(getGroup(db, groupId)?.upgradeReleaseId, null);
  // ...and the pick is still deferred, which is the behaviour that made this
  // path skip the write in the first place. Both facts at once, or the fix
  // could be "move the pick early", which would trash the wrong file on
  // import.
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, 1);
  db.close();
});

test('a pick on a picked group whose download failed is an initial pick and moves the pick at once', async () => {
  const db = openTestDatabase();
  const { groupId } = seed(db);
  addRelease(db, 2, 200);

  // The reported case: the better release is picked, the download fails, and
  // the user goes with the other one. Nothing is on disk, so there is nothing
  // to replace and nothing to trash — an ordinary acquisition.
  const failed = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 2 }, 500);
  failDownload(db, failed.id, 'Repair failed, not enough repair blocks (92 short)', 600);

  const second = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 1 }, 700);

  assert.equal(second.kind, 'initial');
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, 1);
  db.close();
});

test('a file that has been trashed is not a file: the next pick is initial again', async () => {
  const db = openTestDatabase();
  const { groupId } = seed(db);
  addRelease(db, 2, 200);

  const first = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 1 }, 500);
  // Imported, then superseded by an upgrade that has already taken it away.
  // The row is history; the file is gone, so there is nothing left to replace.
  markTrashed(db, addLiveFile(db, first.id), '/trash/scene.mp4', 600);

  const second = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 2 }, 700);

  assert.equal(second.kind, 'initial');
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, 2);
  db.close();
});

// Deliberately changed behaviour, recorded here rather than left to be
// discovered: a second pick while the first is still downloading used to be an
// upgrade, on the strength of the group's state alone. Nothing is on disk, so
// it is now an initial pick and the pointer moves immediately. Both orderings
// are odd states; this one at least matches what the user just asked for.
test('a second pick while the first is still downloading moves the pick, because nothing is on disk yet', async () => {
  const db = openTestDatabase();
  const { groupId } = seed(db);
  addRelease(db, 2, 200);

  const first = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 1 }, 500);
  const second = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 2 }, 600);

  assert.equal(first.kind, 'initial');
  assert.equal(second.kind, 'initial');
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, 2);
  // The abandoned download is left exactly as it was — nothing here cancels it.
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
    pickRelease(db, () => fakeClient(), { groupId: 2, releaseId: 1 }, 500),
    /does not belong/,
  );
  db.close();
});

test('picking an unknown release is rejected', async () => {
  const db = openTestDatabase();
  seed(db);
  await assert.rejects(
    pickRelease(db, () => fakeClient(), { groupId: 1, releaseId: 999 }, 500),
    /999/,
  );
  db.close();
});

test('picking the same release twice while in flight is rejected', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  await pickRelease(db, () => fakeClient(), { groupId, releaseId }, 500);
  await assert.rejects(
    pickRelease(db, () => fakeClient(), { groupId, releaseId }, 600),
    /already/i,
  );
  db.close();
});

test('the download row records the client id and timestamps', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  const download = await pickRelease(db, () => fakeClient(), { groupId, releaseId }, 500);
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

  const download = await pickRelease(db, () => fakeClient(), { groupId, releaseId }, 500);

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
    pickRelease(db, () => fakeClient(), { groupId, releaseId }, 500),
    /induced failure for rollback test/,
  );

  const group = getGroup(db, groupId)!;
  assert.equal(group.state, 'new');
  assert.equal(group.pickedReleaseId, null);
  db.close();
});

// --- Going with a different version, end to end -----------------------
//
// The case this task exists for, played out through the real pipeline: own
// nothing, pick the 2160p, it fails with "not enough repair blocks", pick the
// 1080p instead, let it import. Two separate defects had to be fixed for this
// to terminate, and each is asserted at the point it acts — the second pick's
// `kind` and the pointer it moves (3a), and the flag the group is left holding
// (3b). Asserting only the end state would let either fix alone carry the
// test: with 3a reverted the second pick becomes an upgrade, and
// `completeUpgrade` repoints picked_release_id at import anyway, arriving at
// the same final row by a route that trashes files and defers the pointer.

function importPlugin(source: string): MediaTypePlugin {
  return {
    id: 'test',
    displayName: 'Test',
    parse: () => null,
    score: () => 0,
    planImport: (): ImportPlan => ({ files: [{ source, destination: 'Site/scene.mp4' }] }),
  };
}

function registryFor(plugin: MediaTypePlugin, libraryRoot: string): PluginRegistry {
  return {
    byPackage: () => plugin,
    byId: () => plugin,
    libraryRoot: () => libraryRoot,
    libraryRootById: () => libraryRoot,
    all: () => [plugin],
  };
}

test('after a failed pick, the alternative imports and the failed release is not offered back as an upgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickarr-pick-'));
  try {
    const db = openTestDatabase();
    const { groupId } = seed(db);
    // Release 1 is the 1080p (score 100, from seed); release 2 is the 2160p.
    const better = addRelease(db, 2, 200);

    const failed = await pickRelease(db, () => fakeClient(), { groupId, releaseId: better }, 500);
    failDownload(db, failed.id, 'Repair failed, not enough repair blocks (92 short)', 600);

    const lesser = await pickRelease(db, () => fakeClient(), { groupId, releaseId: 1 }, 700);
    // 3a, at the moment it acts: no file on disk, so this is an acquisition
    // and the group is pointed at the 1080p straight away.
    assert.equal(lesser.kind, 'initial');
    assert.equal(getGroup(db, groupId)?.pickedReleaseId, 1);

    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    const source = join(downloadDir, 'scene.mp4');
    await writeFile(source, 'video-bytes');
    setStoragePath(db, lesser.id, downloadDir, 800);
    setStatus(db, lesser.id, 'completed', 800);

    await importDownload(
      {
        db,
        registry: registryFor(importPlugin(source), join(root, 'library')),
        importMode: 'move',
        trashDir: join(root, 'trash'),
        now: () => 900,
      },
      getDownload(db, lesser.id)!,
    );

    const group = getGroup(db, groupId)!;
    assert.equal(getDownload(db, lesser.id)?.status, 'imported');
    assert.equal(group.state, 'picked');
    assert.equal(group.pickedReleaseId, 1);
    // 3b: the 2160p scores higher and would otherwise be flagged, putting the
    // group back on Browse advertising a download that cannot succeed. Its
    // most recent attempt failed, so it is not advertised — it stays on the
    // card with a Pick button for anyone who wants to retry it.
    assert.equal(group.upgradeReleaseId, null);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The routing the whole of #34 is about: `seed` puts the release's feed item on
// feed 'f', and a second client is configured for it. Before this change
// `pickRelease` took one client and the server always handed it
// `downloadClients[0]`, so this same scenario wrote 'a' and called a's addUrl.
test('a pick is submitted to the client its feed names, not the first one', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  const called: string[] = [];
  const a = fakeClient({ id: 'a', addUrl: async () => { called.push('a'); return 'nzo_a'; } });
  const b = fakeClient({ id: 'b', addUrl: async () => { called.push('b'); return 'nzo_b'; } });

  const download = await pickRelease(
    db,
    (feedId) => (feedId === 'f' ? b : a),
    { groupId, releaseId },
    500,
  );

  assert.equal(getDownload(db, download.id)?.clientId, 'b');
  assert.deepEqual(called, ['b']);
  db.close();
});

// A feed that has left configuration between the poll that ingested the item
// and the click that picks it. The message names the feed because that is the
// thing the operator has to go and look at, and no row may survive: a queued
// download nothing can ever submit is worse than a refused pick.
test('a release whose feed has no download client is refused, leaving no row', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);

  await assert.rejects(pickRelease(db, () => null, { groupId, releaseId }, 500), /feed f/);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get()!['n'], 0);
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, null);
  db.close();
});
