import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { GroupIdentity, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { duePerformerQueue } from '../../src/db/performer-queue.ts';
import {
  enqueuePerformerSearch,
  performerQueryFor,
  type PerformerEnqueueDeps,
} from '../../src/pipeline/performers.ts';

/** One picked group, titled so the two-word rule has something to cut. */
function seedGroup(db: DatabaseSync, id: number, title: string): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(id, `g${id}`, title, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (?, 'test', ?, ?, ?, 'picked', 1, 1)`,
  ).run(id, `k${id}`, JSON.stringify({ title, subtitle: 'Some Site', fields: [] }), `g${id}`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, ?, ?, '{}', 100, 1)`,
  ).run(id, id, id);
}

/** Gives the group a cast, the way a confirmed scene answer does. */
function giveCast(db: DatabaseSync, groupId: number): void {
  db.prepare(
    `INSERT INTO performers (id, source, source_uuid, slug, name, kind, fetched_at)
     VALUES (?, 'theporndb', ?, 'someone', 'Someone', 'performer', 1)`,
  ).run(groupId, `uuid-${groupId}`);
  db.prepare(
    'INSERT INTO group_performers (group_id, performer_id, position) VALUES (?, ?, 0)',
  ).run(groupId, groupId);
}

/**
 * A plugin whose `performerQuery` behaves as told. `undefined` stands for a
 * plugin that does not implement the method at all, which is how a media type
 * with no notion of performers opts out.
 */
function pluginWith(
  performerQuery: ((identity: GroupIdentity) => string | null) | undefined,
): MediaTypePlugin {
  // A real minimal plugin, the shape `metadata.test.ts:577` uses — not a cast
  // through `unknown`. If `MediaTypePlugin` gains a required member this fails to
  // typecheck, which is the signal you want; a cast would hide it.
  const plugin: MediaTypePlugin = {
    id: 'test',
    displayName: 'Test',
    parse: () => null,
    score: () => 0,
    planImport: () => null,
  };
  return performerQuery === undefined ? plugin : { ...plugin, performerQuery };
}

function depsWith(db: DatabaseSync, plugin: MediaTypePlugin | null): PerformerEnqueueDeps {
  return { db, pluginFor: () => plugin, log: () => {} };
}

test('a castless group with a query is queued', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, pluginWith((identity) => identity.display.title.split(' ').slice(0, 2).join(' ')));

  assert.equal(performerQueryFor(deps, 1), 'Jessica Jaymes');
  assert.equal(enqueuePerformerSearch(deps, 1, 500), true);
  assert.deepEqual(duePerformerQueue(db, 500, 10).map((row) => row.groupId), [1]);
  db.close();
});

test('a group whose plugin offers no query is not queued', () => {
  // A one-word title is the real case: the plugin returns null rather than a
  // one-word query. Not queueing is a silent success — the caller is a pass
  // draining a queue, not a user action that can fail.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Solo');
  const deps = depsWith(db, pluginWith(() => null));

  assert.equal(performerQueryFor(deps, 1), null);
  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a plugin returning only whitespace is treated the same as no query', () => {
  // `performerQueryFor` guards on `query.trim().length === 0` before ever
  // returning; a plugin misbehaving by returning blank padding rather than
  // `null` must not queue a search for an empty string. A refactor to
  // `if (query === null) return null` would not go red without this test.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, pluginWith(() => '   '));

  assert.equal(performerQueryFor(deps, 1), null);
  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a plugin that does not implement performerQuery queues nothing', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, pluginWith(undefined));

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a group with a cast is not queued', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  giveCast(db, 1);
  const deps = depsWith(db, pluginWith(() => 'Jessica Jaymes'));

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a group whose plugin is no longer configured is not queued', () => {
  // `pluginFor` answering null is normal, not a bug: a plugin can be removed
  // from config after groups it created already exist.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, null);

  assert.equal(performerQueryFor(deps, 1), null);
  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  db.close();
});

test('a plugin that throws building the query does not take the caller down', () => {
  // The caller is a loop over settled rows inside `runMetadataPass`. A plugin
  // bug must cost this one group its search, not abort the metadata pass — the
  // same treatment `safeMetadataQuery` gives `metadataQuery` throwing.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const logged: string[] = [];
  const deps: PerformerEnqueueDeps = {
    db,
    pluginFor: () => pluginWith(() => { throw new Error('plugin bug'); }),
    log: (message) => logged.push(message),
  };

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  assert.ok(logged.some((line) => line.includes('plugin bug')));
  db.close();
});

test('a missing group is silence rather than a throw', () => {
  // The caller has already resolved the group from a queue row it just read; a
  // row for an id that is gone has nothing to say.
  const db = openTestDatabase();
  const deps = depsWith(db, pluginWith(() => 'Jessica Jaymes'));

  assert.equal(enqueuePerformerSearch(deps, 9999, 500), false);
  db.close();
});
