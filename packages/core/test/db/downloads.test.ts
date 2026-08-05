import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  bumpAttempts,
  bumpMissingPolls,
  failDownload,
  getDownload,
  insertDownload,
  recordError,
  resetMissingPolls,
  setClientRef,
  setStatus,
  setStoragePath,
} from '../../src/db/downloads.ts';

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
