import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import type { MetadataPerformer } from '@pickarr/plugin-api';
import {
  upsertPerformers, setGroupPerformers, performersForGroups, getPerformer, setPerformerArtwork,
} from '../../src/db/performers.ts';

function seedGroup(db: DatabaseSync, id: number): void {
  db.prepare(
    `INSERT INTO media_groups
       (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (?, '@pickarr/plugin-scenes', ?, '{}', '', 0, 0)`,
  ).run(id, `key-${id}`);
}

function countingDatabase(db: DatabaseSync, onPrepare: () => void): DatabaseSync {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === 'prepare' && typeof value === 'function') {
        return (sql: string) => {
          onPrepare();
          return (value as (s: string) => unknown).call(target, sql);
        };
      }
      return value;
    },
  }) as DatabaseSync;
}

test('upserting the same performer twice yields one row and one id', () => {
  const db = openTestDatabase();
  const performer: MetadataPerformer = {
    sourceUuid: 'u', slug: 'alice-maze', name: 'Alice Maze',
    kind: 'performer', faceUrl: 'f', imageUrl: 'i',
  };
  const [first] = upsertPerformers(db, 'theporndb', [performer], 1);
  const [second] = upsertPerformers(db, 'theporndb', [performer], 2);
  assert.equal(first, second);
  assert.equal(db.prepare('SELECT count(*) c FROM performers').get()?.['c'], 1);
});

test('a renamed slug updates the row it already had, keeping its id and artwork', () => {
  const db = openTestDatabase();
  const [id] = upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'u', slug: 'old', name: 'N', kind: 'performer', faceUrl: 'f', imageUrl: 'i' },
  ], 1);
  setPerformerArtwork(db, id!, 'face', `${id}.jpg`);
  upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'u', slug: 'new', name: 'N', kind: 'performer', faceUrl: 'f', imageUrl: 'i' },
  ], 2);

  const row = getPerformer(db, id!)!;
  // The uuid is the identity and the slug is presentation, so a rename is an
  // update, not a new performer — and the cached file it already fetched is
  // still its file.
  assert.equal(row.slug, 'new');
  assert.equal(row.facePath, `${id}.jpg`);
});

test('a group\'s performers come back in billing order', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  const ids = upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'b', slug: 'b', name: 'Second', kind: 'performer', faceUrl: null, imageUrl: null },
    { sourceUuid: 'a', slug: 'a', name: 'First',  kind: 'performer', faceUrl: null, imageUrl: null },
  ], 1);
  setGroupPerformers(db, 1, ids);

  // The order TPDb gave, not id order and not alphabetical: 'Second' was
  // billed first and has the higher-sorting uuid, so any accidental sort
  // shows up here.
  assert.deepEqual(
    performersForGroups(db, [1]).get(1)?.map((p) => p.name),
    ['Second', 'First'],
  );
});

test('setGroupPerformers replaces the previous cast rather than adding to it', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  const first = upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'a', slug: 'a', name: 'A', kind: 'performer', faceUrl: null, imageUrl: null },
  ], 1);
  setGroupPerformers(db, 1, first);
  const second = upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'b', slug: 'b', name: 'B', kind: 'performer', faceUrl: null, imageUrl: null },
  ], 2);
  setGroupPerformers(db, 1, second);

  // A refetch that corrected the cast must not leave the old cast attached:
  // the whole point of the backfill is that the answer is replaced.
  assert.deepEqual(performersForGroups(db, [1]).get(1)?.map((p) => p.name), ['B']);
});

test('performersForGroups reads a whole page in one query', () => {
  // Issue #31: /api/downloads issues a query per row and polls it every three
  // seconds. Browse must not reacquire that defect.
  const db = openTestDatabase();
  for (const id of [1, 2, 3]) seedGroup(db, id);
  let queries = 0;
  const counted = countingDatabase(db, () => { queries += 1; });
  performersForGroups(counted, [1, 2, 3]);
  assert.equal(queries, 1);
});

test('an empty id list touches the database not at all', () => {
  const db = openTestDatabase();
  assert.equal(performersForGroups(db, []).size, 0);
});
