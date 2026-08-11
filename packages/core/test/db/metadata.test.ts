import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  dueMetadataQueue, enqueueMetadata, getGroupMetadata, metadataForGroups,
  recordMetadataAnswer, deferMetadata, setPosterPath,
} from '../../src/db/metadata.ts';

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
      siteName: 'Naughty Office', date: '2021-11-15', performers: ['Silvia Saige'],
      durationSeconds: 1000, synopsis: 'A synopsis', posterUrl: 'https://example.test/p.jpg',
    },
    nearMisses: [],
    now: 2_000,
  });

  assert.equal(dueMetadataQueue(db, 9_999, 10).length, 0);
  const stored = getGroupMetadata(db, groupId);
  assert.equal(stored?.state, 'confirmed');
  assert.deepEqual(stored?.performers, ['Silvia Saige']);
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
          synopsis: null, posterUrl: null,
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

test('a poster path is set independently of the answer', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  recordMetadataAnswer(db, {
    groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: 1_000,
  });
  setPosterPath(db, groupId, '7.jpg');
  assert.equal(getGroupMetadata(db, groupId)?.posterPath, '7.jpg');
});
