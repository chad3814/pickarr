import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  bumpAttempts,
  bumpMissingPolls,
  clearAbsent,
  downloadLabel,
  failDownload,
  getDownload,
  indexDownloadsForClient,
  insertDownload,
  markAbsent,
  recordError,
  resetForRetry,
  resetMissingPolls,
  setClientRef,
  setStatus,
  setStoragePath,
} from '../../src/db/downloads.ts';
import { getGroup } from '../../src/db/groups.ts';

const BAD_ID = 9999;

function seed(db: DatabaseSync): number {
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
  return insertDownload(db, {
    releaseId: 1,
    groupId: 1,
    clientId: 'sab',
    kind: 'initial',
    createdAt: 1,
  });
}

test('setClientRef throws by name and id rather than silently no-opping on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => setClientRef(db, BAD_ID, 'nzo_1', 2), /setClientRef.*9999/);
  db.close();
});

test('setStatus throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => setStatus(db, BAD_ID, 'imported', 2), /setStatus.*9999/);
  db.close();
});

test('setStoragePath throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => setStoragePath(db, BAD_ID, '/tmp/x', 2), /setStoragePath.*9999/);
  db.close();
});

test('failDownload throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => failDownload(db, BAD_ID, 'boom', 2), /failDownload.*9999/);
  db.close();
});

test('failDownload also re-derives the group upgrade flag, so a failed release stops being advertised', () => {
  const db = openTestDatabase();
  const id = seed(db);
  // A second, better release, flagged as the upgrade on offer.
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (2, 'f', 'g2', 'Better', 'https://indexer.invalid/2.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (2, 1, 2, '{}', 200, 1)`,
  ).run();
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = 1, upgrade_release_id = 2 WHERE id = 1",
  ).run();
  const upgrade = insertDownload(db, {
    releaseId: 2,
    groupId: 1,
    clientId: 'sab',
    kind: 'upgrade',
    createdAt: 2,
  });

  failDownload(db, upgrade, 'Repair failed, not enough repair blocks (92 short)', 3);

  // Not at some later unrelated write: at the moment of failure. Advertising
  // "Upgrade available" for a release that has just proved undownloadable is
  // the loop this closes.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, null);
  assert.equal(getDownload(db, id)?.status, 'queued', 'the unrelated download is untouched');
  db.close();
});

test('failDownload moves the group to the top of the list by stamping list_rank_at', () => {
  const db = openTestDatabase();
  const id = seed(db);
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = 1 WHERE id = 1",
  ).run();

  failDownload(db, id, 'Repair failed, not enough repair blocks (92 short)', 3);

  // The failure's own timestamp, not a sentinel and not left alone. This is how
  // the group becomes findable on Picks — the list orders on this column and
  // nothing else, so a failure that did not write it would leave the group
  // wherever it already was, which for a group picked weeks ago is nowhere the
  // user will look. And because it is a timestamp rather than a flag, every
  // later event that stamps another group moves this one down; see
  // `test/db/picks-order.test.ts` for that half.
  assert.equal(getGroup(db, 1)?.listRankAt, 3);
  db.close();
});

test('failDownload is atomic: a failure re-deriving the flag rolls the status write back', () => {
  // The status write and the re-derivation are two statements, and the comment
  // on `failDownload` claims they are one instant. Without a transaction that
  // is false for a crash landing between them, which is exactly the stale-flag
  // state the re-derivation exists to prevent — the download reads `failed`
  // while the group still advertises the release that failed.
  //
  // The abort is injected at the database rather than by stubbing, because the
  // second statement is reached through an import that no seam exposes. A
  // trigger that raises on the `media_groups` update is the same shape of
  // failure a crash produces: the first statement has run, the second cannot.
  const db = openTestDatabase();
  const id = seed(db);
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = 1 WHERE id = 1",
  ).run();
  db.exec(`CREATE TRIGGER no_flag BEFORE UPDATE ON media_groups
           BEGIN SELECT RAISE(ABORT, 'flag write refused'); END`);

  assert.throws(() => failDownload(db, id, 'Repair failed', 3), /flag write refused/);

  // Rolled back whole. Left un-transacted this reads 'failed'.
  assert.equal(getDownload(db, id)?.status, 'queued');
  assert.equal(getDownload(db, id)?.error, null);
  db.close();
});

test('recordError throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => recordError(db, BAD_ID, 'boom', 2), /recordError.*9999/);
  db.close();
});

test('bumpAttempts throws on a bad id instead of returning 0', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => bumpAttempts(db, BAD_ID, 2), /bumpAttempts.*9999/);
  db.close();
});

test('bumpMissingPolls throws on a bad id instead of returning 0', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => bumpMissingPolls(db, BAD_ID, 2), /bumpMissingPolls.*9999/);
  db.close();
});

test('resetMissingPolls throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => resetMissingPolls(db, BAD_ID), /resetMissingPolls.*9999/);
  db.close();
});

test('resetMissingPolls on a real row whose missing_polls is already 0 is a legitimate no-op, not an error', () => {
  const db = openTestDatabase();
  const id = seed(db);
  assert.doesNotThrow(() => resetMissingPolls(db, id));
  assert.equal(getDownload(db, id)?.missingPolls, 0);
  db.close();
});

test('bumpAttempts and bumpMissingPolls increment and return the new count for a real row', () => {
  const db = openTestDatabase();
  const id = seed(db);
  assert.equal(bumpAttempts(db, id, 2), 1);
  assert.equal(bumpAttempts(db, id, 3), 2);
  assert.equal(bumpMissingPolls(db, id, 4), 1);
  db.close();
});

// --- absent_since: absence as an observation, not a verdict ----------------

/**
 * A second download on the same group, for tests that need more than one
 * row. A separate feed item and release because `releases.feed_item_id` is
 * NOT NULL UNIQUE, same as `seed`'s.
 */
function seedSecond(db: DatabaseSync, id: number): number {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, 'Title', ?, 1)`,
  ).run(id, `g${id}`, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, 1, ?, '{}', 100, 1)`,
  ).run(id, id);
  return insertDownload(db, {
    releaseId: id,
    groupId: 1,
    clientId: 'sab',
    kind: 'initial',
    createdAt: 1,
  });
}

test('markAbsent sets absent_since, and a second call with a later now leaves the original value', () => {
  const db = openTestDatabase();
  const id = seed(db);
  markAbsent(db, id, 5);
  assert.equal(getDownload(db, id)?.absentSince, 5);

  // The `WHERE absent_since IS NULL` guard is the entire point of this
  // function: without it, every tick a job stays missing would push the
  // timestamp forward, and "how long has this been gone" would always read
  // "just now".
  markAbsent(db, id, 9);
  assert.equal(getDownload(db, id)?.absentSince, 5, 'the original absence time is preserved');
  db.close();
});

test('clearAbsent clears absent_since and is a no-op when already null', () => {
  const db = openTestDatabase();
  const id = seed(db);

  assert.doesNotThrow(() => clearAbsent(db, id));
  assert.equal(getDownload(db, id)?.absentSince, null);

  markAbsent(db, id, 5);
  clearAbsent(db, id);
  assert.equal(getDownload(db, id)?.absentSince, null);
  db.close();
});

test('absentSince round-trips through getDownload as null and as a number', () => {
  const db = openTestDatabase();
  const id = seed(db);
  assert.equal(getDownload(db, id)?.absentSince, null);
  markAbsent(db, id, 42);
  assert.equal(getDownload(db, id)?.absentSince, 42);
  db.close();
});

test('resetForRetry clears absent_since so a retry does not inherit a stale absence mark', () => {
  const db = openTestDatabase();
  const id = seed(db);
  markAbsent(db, id, 5);
  resetForRetry(db, id, 10);
  assert.equal(getDownload(db, id)?.absentSince, null);
  db.close();
});

test('indexDownloadsForClient.byRef includes failed rows and excludes imported rows, keyed on client_ref', () => {
  const db = openTestDatabase();
  const kept = seed(db); // will be 'downloading'
  const failed = seedSecond(db, 2);
  const imported = seedSecond(db, 3);

  setClientRef(db, kept, 'nzo_kept', 1);
  setClientRef(db, failed, 'nzo_failed', 1);
  failDownload(db, failed, 'disappeared-from-client', 2);
  setClientRef(db, imported, 'nzo_imported', 1);
  setStatus(db, imported, 'imported', 2);

  const { byRef } = indexDownloadsForClient(db, 'sab');
  assert.deepEqual([...byRef.keys()].toSorted(), ['nzo_failed', 'nzo_kept']);
  assert.equal(byRef.get('nzo_kept')?.id, kept);
  assert.equal(byRef.get('nzo_failed')?.id, failed);
  assert.equal(byRef.has('nzo_imported'), false);
  db.close();
});

test('indexDownloadsForClient.byLabel keys on pickarr-<id> for the same row set as byRef', () => {
  const db = openTestDatabase();
  const kept = seed(db);
  const imported = seedSecond(db, 2);

  setClientRef(db, kept, 'nzo_kept', 1);
  setClientRef(db, imported, 'nzo_imported', 1);
  setStatus(db, imported, 'imported', 2);

  const { byLabel } = indexDownloadsForClient(db, 'sab');
  assert.deepEqual([...byLabel.keys()], [downloadLabel(kept)]);
  assert.equal(byLabel.get(downloadLabel(kept))?.id, kept);
  db.close();
});

test('indexDownloadsForClient builds both maps from one query: a kept row is the same object in byRef and byLabel', () => {
  const db = openTestDatabase();
  const kept = seed(db);
  setClientRef(db, kept, 'nzo_kept', 1);

  const { byRef, byLabel } = indexDownloadsForClient(db, 'sab');
  // Strict identity, not just equal values: this is what a single query
  // building both maps from one row array actually guarantees, and what a
  // second, separately-run query could not — two queries would give two
  // distinct row objects with the same field values, and this assertion
  // would still pass on that broken version if it only checked deepEqual.
  assert.equal(byRef.get('nzo_kept'), byLabel.get(downloadLabel(kept)));
  db.close();
});
