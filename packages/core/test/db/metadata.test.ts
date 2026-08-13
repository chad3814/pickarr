import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MetadataCandidate } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  dueMetadataQueue, enqueueMetadata, getGroupMetadata, metadataForGroups,
  queuedMetadataNextAt, recordMetadataAnswer, deferMetadata, setPosterPath,
} from '../../src/db/metadata.ts';
import { performersForGroups } from '../../src/db/performers.ts';

function withGroups(count: number) {
  const db = openTestDatabase();
  const insert = db.prepare(
    `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES ('@pickarr/plugin-scenes', ?, '{}', '', 0, 0)`,
  );
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    insert.run(`key-${i}`);
    ids.push(Number(db.prepare('SELECT last_insert_rowid() AS id').get()?.['id']));
  }
  return { db, ids };
}

function seedGroup(db: DatabaseSync, id: number): void {
  db.prepare(
    `INSERT INTO media_groups
       (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (?, '@pickarr/plugin-scenes', ?, '{}', '', 0, 0)`,
  ).run(id, `key-${id}`);
}

function candidate(over: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return {
    sourceUuid: 'scene-uuid',
    title: 'A Scene',
    siteUuid: 'site-uuid',
    siteId: 1,
    siteName: 'Naughty Office',
    date: '2021-11-15',
    performers: [],
    durationSeconds: 1000,
    synopsis: 'A synopsis',
    posterUrl: 'https://example.test/p.jpg',
    slug: 'a-scene',
    ...over,
  };
}

test('enqueueing is idempotent and never re-asks an answered group', () => {
  const { db, ids } = withGroups(3);

  const first = enqueueMetadata(db, ids, 1_000);
  assert.deepEqual(first, { queued: 3, alreadyAnswered: 0, pending: 0 });

  // Same ids again: all three are already queued, none re-inserted.
  const second = enqueueMetadata(db, ids, 2_000);
  assert.deepEqual(second, { queued: 0, alreadyAnswered: 0, pending: 3 });

  // A negative answer is still an answer.
  recordMetadataAnswer(db, {
    groupId: ids[0]!, source: 'theporndb', confirmed: null, nearMisses: [], now: 3_000,
  });
  const third = enqueueMetadata(db, [ids[0]!], 4_000);
  assert.deepEqual(third, { queued: 0, alreadyAnswered: 1, pending: 0 });
  // The counts alone don't prove nothing landed in the queue table — check it directly.
  // ids[1] and ids[2] are still legitimately pending, so check the answered one by name.
  const due = dueMetadataQueue(db, 4_000, 10).map((row) => row.groupId);
  assert.equal(due.includes(ids[0]!), false, 'an answered group must never be queued');
});

test('an answer replaces the queue row in one transaction', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  enqueueMetadata(db, [groupId], 1_000);

  recordMetadataAnswer(db, {
    groupId,
    source: 'theporndb',
    confirmed: {
      sourceUuid: 'scene-uuid', title: 'A Scene', siteUuid: 'site-uuid', siteId: 1,
      siteName: 'Naughty Office', date: '2021-11-15', performers: [],
      durationSeconds: 1000, synopsis: 'A synopsis', posterUrl: 'https://example.test/p.jpg',
      slug: 'a-scene',
    },
    nearMisses: [],
    now: 2_000,
  });

  assert.equal(dueMetadataQueue(db, 9_999, 10).length, 0);
  const stored = getGroupMetadata(db, groupId);
  assert.equal(stored?.state, 'confirmed');
  assert.deepEqual(stored?.performers, []);
  assert.equal(stored?.durationSeconds, 1000);
});

test('near-misses are written with the answer and are not the answer', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  enqueueMetadata(db, [groupId], 1_000);

  recordMetadataAnswer(db, {
    groupId,
    source: 'theporndb',
    confirmed: null,
    nearMisses: [
      {
        candidate: {
          sourceUuid: 'other', title: 'Another Scene', siteUuid: null, siteId: null,
          siteName: 'Elsewhere', date: '2021-11-20', performers: [], durationSeconds: null,
          synopsis: null, posterUrl: null, slug: null,
        },
        reason: 'date outside window',
      },
    ],
    now: 2_000,
  });

  assert.equal(getGroupMetadata(db, groupId)?.state, 'none');
  const rows = db
    .prepare('SELECT reason, title FROM metadata_candidates WHERE group_id = ?')
    .all(groupId);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0]?.['reason']), 'date outside window');
});

test('a retried answer for the same group does not duplicate its candidate rows', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  enqueueMetadata(db, [groupId], 1_000);

  const nearMiss = {
    candidate: {
      sourceUuid: 'other', title: 'Another Scene', siteUuid: null, siteId: null,
      siteName: 'Elsewhere', date: '2021-11-20', performers: [], durationSeconds: null,
      synopsis: null, posterUrl: null, slug: null,
    },
    reason: 'date outside window',
  };

  recordMetadataAnswer(db, {
    groupId, source: 'theporndb', confirmed: null, nearMisses: [nearMiss], now: 2_000,
  });
  // A second call for a group already answered — a retry racing the first, or a
  // caller that didn't check first — must be a no-op, not a second set of rows.
  recordMetadataAnswer(db, {
    groupId, source: 'theporndb', confirmed: null, nearMisses: [nearMiss], now: 3_000,
  });

  const rows = db
    .prepare('SELECT reason FROM metadata_candidates WHERE group_id = ?')
    .all(groupId);
  assert.equal(rows.length, 1, 'candidate rows must not accumulate across retries');
});

test('a deferral keeps the queue row, counts the attempt, and moves next_at', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  enqueueMetadata(db, [groupId], 1_000);

  deferMetadata(db, groupId, 'ECONNRESET', 60_000);

  assert.equal(dueMetadataQueue(db, 30_000, 10).length, 0, 'not due yet');
  const due = dueMetadataQueue(db, 60_000, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.attempts, 1);
  assert.equal(due[0]?.lastError, 'ECONNRESET');
  assert.equal(getGroupMetadata(db, groupId), undefined, 'a failure is not an answer');
});

test('metadataForGroups reads a page in one query', () => {
  const { db, ids } = withGroups(3);
  for (const id of ids) {
    recordMetadataAnswer(db, {
      groupId: id, source: 'theporndb', confirmed: null, nearMisses: [], now: 1_000,
    });
  }
  const found = metadataForGroups(db, ids);
  assert.equal(found.size, 3);
  assert.equal(metadataForGroups(db, []).size, 0, 'no ids must not build an empty IN ()');
});

test('queuedMetadataNextAt reads a page of queue rows in one query, and reports a deferral\'s moved next_at', () => {
  const { db, ids } = withGroups(3);
  const [waiting, deferred, answered] = ids as [number, number, number];
  enqueueMetadata(db, [waiting, deferred], 1_000);
  deferMetadata(db, deferred, 'ECONNRESET', 60_000);
  recordMetadataAnswer(db, {
    groupId: answered, source: 'theporndb', confirmed: null, nearMisses: [], now: 1_000,
  });

  const found = queuedMetadataNextAt(db, ids);
  assert.equal(found.size, 2, 'the answered group has no queue row left');
  assert.equal(found.get(waiting), 1_000, 'still waiting its turn, next_at unchanged');
  assert.equal(found.get(deferred), 60_000, 'deferred: next_at moved to the retry time');
  assert.equal(found.has(answered), false);
  assert.equal(queuedMetadataNextAt(db, []).size, 0, 'no ids must not build an empty IN ()');
});

test('a poster path is set independently of the answer', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  recordMetadataAnswer(db, {
    groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: 1_000,
  });
  setPosterPath(db, groupId, '7.jpg');
  assert.equal(getGroupMetadata(db, groupId)?.posterPath, '7.jpg');
});

test('a second answer replaces the first instead of being dropped', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 1, nearMisses: [],
    confirmed: candidate({ title: 'Old', performers: [], slug: 'old' }) });
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 2, nearMisses: [],
    confirmed: candidate({ title: 'New', performers: [], slug: 'new' }) });

  // The migration re-queues answered groups; ON CONFLICT DO NOTHING would
  // spend the API call and write nothing, leaving the group looking
  // refetched while holding its old data.
  const row = getGroupMetadata(db, 1)!;
  assert.equal(row.title, 'New');
  assert.equal(row.sceneSlug, 'new');
  assert.equal(row.fetchedAt, 2);
});

test('near misses do not accumulate across answers', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  const miss = { candidate: candidate({ title: 'X' }), reason: 'wrong date' };
  for (const now of [1, 2, 3]) {
    recordMetadataAnswer(db, { groupId: 1, source: 's', now, nearMisses: [miss],
      confirmed: candidate({ title: 'T' }) });
  }
  assert.equal(
    db.prepare('SELECT count(*) c FROM metadata_candidates WHERE group_id = 1').get()?.['c'],
    1,
  );
});

test('the answer writes the cast, and a later answer replaces it', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 'theporndb', now: 1, nearMisses: [],
    confirmed: candidate({ performers: [
      { sourceUuid: 'a', slug: 'a', name: 'A', kind: 'performer', faceUrl: null, imageUrl: null },
    ] }) });
  recordMetadataAnswer(db, { groupId: 1, source: 'theporndb', now: 2, nearMisses: [],
    confirmed: candidate({ performers: [
      { sourceUuid: 'b', slug: 'b', name: 'B', kind: 'performer', faceUrl: null, imageUrl: null },
    ] }) });

  assert.deepEqual(performersForGroups(db, [1]).get(1)?.map((p) => p.name), ['B']);
  assert.deepEqual(getGroupMetadata(db, 1)?.performers, ['B'],
    'the legacy name column is the pre-refetch fallback and must stay populated');
});

test('a none answer writes no cast', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 1, nearMisses: [], confirmed: null });

  // A 'none' state and a cast are contradictory: the card would render
  // performers under an answer that says the provider found nothing.
  assert.equal(getGroupMetadata(db, 1)?.state, 'none');
  assert.equal(performersForGroups(db, [1]).get(1), undefined);
});

test('a refetch that fails to re-confirm leaves the previous confirmed answer and its cast standing', () => {
  // This test replaces one that asserted the opposite — that a 'none' answer
  // arriving over a confirmed one *cleared* its cast. That reading treated a
  // failed refetch as news, and it is not: `confirmed: null` means the
  // provider was asked and could not say, which is an absence of evidence.
  // Under it a year-old confirmation was silently reduced to `state: 'none'`
  // with title, date, synopsis, slug and cast all nulled — permanently, since
  // `enqueueMetadata` counts 'none' as already answered and there is no
  // manual refresh. Migration 7 re-queues every confirmed group in the
  // library, so it was one bad candidate list away from running at scale.
  //
  // The scenario the old test described is now unreachable rather than
  // merely unasserted: nothing else in the schema can put a cast on a row
  // that is not confirmed, so there is no remaining path by which a 'none'
  // answer has one to clear. The test above pins the half that survives.
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 1, nearMisses: [],
    confirmed: candidate({ title: 'Standing', slug: 'standing', performers: [
      { sourceUuid: 'a', slug: 'a', name: 'A', kind: 'performer', faceUrl: null, imageUrl: null },
    ] }) });
  setPosterPath(db, 1, '1.jpg');

  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 2, nearMisses: [], confirmed: null });

  const row = getGroupMetadata(db, 1)!;
  assert.equal(row.state, 'confirmed');
  assert.equal(row.title, 'Standing');
  assert.equal(row.sceneSlug, 'standing');
  assert.equal(row.posterPath, '1.jpg');
  assert.deepEqual(row.performers, ['A']);
  assert.equal(row.fetchedAt, 1, 'the row still describes the answer it actually holds');
  // The cast is the half a WHERE on the upsert alone would not have saved:
  // `setGroupPerformers` with an empty list is a DELETE, so the row would
  // have survived with its performers stripped off.
  assert.deepEqual(performersForGroups(db, [1]).get(1)?.map((p) => p.name), ['A']);

  // The queue row still goes. Keeping it would put the group back in front of
  // the worker on the next pass and every pass after it.
  assert.equal(db.prepare('SELECT 1 FROM metadata_queue WHERE group_id = 1').get(), undefined);
});

test('a re-confirmation still overwrites a standing confirmed answer', () => {
  // The other side of the WHERE: refusing the downgrade must not freeze the
  // row. A provider that corrects a scene — a retitle, a re-billing — has to
  // land, or migration 7's whole refetch buys nothing for the groups that
  // needed it most.
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 1, nearMisses: [],
    confirmed: candidate({ title: 'Old', slug: 'old', performers: [
      { sourceUuid: 'a', slug: 'a', name: 'A', kind: 'performer', faceUrl: null, imageUrl: null },
    ] }) });
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 2, nearMisses: [],
    confirmed: candidate({ title: 'New', slug: 'new', performers: [
      { sourceUuid: 'b', slug: 'b', name: 'B', kind: 'performer', faceUrl: null, imageUrl: null },
    ] }) });

  assert.equal(getGroupMetadata(db, 1)?.title, 'New');
  assert.deepEqual(performersForGroups(db, [1]).get(1)?.map((p) => p.name), ['B']);
});

test('a none answer over a none answer still writes', () => {
  // The WHERE's second disjunct. A row that is not confirmed has nothing
  // worth protecting, so an ordinary re-answer of it — here only refreshing
  // `fetched_at` — must not be mistaken for a downgrade and declined.
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 1, nearMisses: [], confirmed: null });
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 2, nearMisses: [], confirmed: null });

  assert.equal(getGroupMetadata(db, 1)?.fetchedAt, 2);
});

test('a refetch keeps the poster already cached for the group', () => {
  // `poster_path` is deliberately absent from the upsert's DO UPDATE list:
  // the INSERT writes it as a literal NULL, and only `setPosterPath` ever
  // fills it in, so including it here would blank a cached poster on every
  // refetch — and migration 7 queues every confirmed group for exactly that.
  // Nothing would throw and nothing else would notice, which is why this
  // test exists rather than a comment alone.
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 1, nearMisses: [],
    confirmed: candidate({ title: 'First' }) });
  setPosterPath(db, 1, '1.jpg');

  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 2, nearMisses: [],
    confirmed: candidate({ title: 'Second' }) });

  const row = getGroupMetadata(db, 1)!;
  assert.equal(row.posterPath, '1.jpg');
  assert.equal(row.title, 'Second', 'the rest of the answer did update');
});
