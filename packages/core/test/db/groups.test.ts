import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { completeUpgrade, flagUpgrade, getGroup, markPicked } from '../../src/db/groups.ts';

// `upgrade_release_id` is an invariant, not an event log: it names the
// highest-scoring release in the group that is strictly better than
// `picked_release_id`, or NULL when there is none. Every write that can change
// either side of that comparison has to re-derive it — otherwise the flag
// records only whichever *arrival* happened to notice, and a pick or a
// completed upgrade silently leaves it describing a comparison that no longer
// holds. `list_rank_at` is deliberately not part of the invariant: only a
// newly arriving better release moves a group up the browse list, so
// re-deriving must never bump it.

/**
 * A picked group with four releases scoring 100/200/300/400 (ids 1..4), so
 * every test can point `picked_release_id` at any rung and state exactly what
 * the derived flag must be.
 */
function seedGroup(db: DatabaseSync, pickedReleaseId: number): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 1),
            (3, 'f', 'g3', 'T3', 'https://indexer.invalid/3.nzb', 1),
            (4, 'f', 'g4', 'T4', 'https://indexer.invalid/4.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{"title":"T","fields":[]}', 't', 'picked', ?, 100, 100)`,
  ).run(pickedReleaseId);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1), (2, 1, 2, '{}', 200, 1),
            (3, 1, 3, '{}', 300, 1), (4, 1, 4, '{}', 400, 1)`,
  ).run();
}

test('completeUpgrade keeps a better release flagged instead of clearing it', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  // Release 3 was flagged while the download of release 2 was in flight.
  db.prepare('UPDATE media_groups SET upgrade_release_id = 3 WHERE id = 1').run();

  completeUpgrade(db, 1, 2);

  const group = getGroup(db, 1)!;
  assert.equal(group.pickedReleaseId, 2);
  // Clearing here would lose release 4 as well as 3 — the flag is re-derived
  // from what the group actually holds, not from what this download replaced.
  assert.equal(group.upgradeReleaseId, 4);
  assert.equal(group.listRankAt, 100);
  db.close();
});

test('completeUpgrade onto the best release clears the flag', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  db.prepare('UPDATE media_groups SET upgrade_release_id = 4 WHERE id = 1').run();

  completeUpgrade(db, 1, 4);

  const group = getGroup(db, 1)!;
  assert.equal(group.pickedReleaseId, 4);
  assert.equal(group.upgradeReleaseId, null);
  assert.equal(group.listRankAt, 100);
  db.close();
});

test('picking the worse of two known releases flags the better one', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  db.prepare(
    "UPDATE media_groups SET state = 'new', picked_release_id = NULL WHERE id = 1",
  ).run();

  markPicked(db, 1, 2);

  const group = getGroup(db, 1)!;
  assert.equal(group.state, 'picked');
  assert.equal(group.pickedReleaseId, 2);
  // Without this the group leaves browse entirely and the better releases it
  // already holds become unreachable.
  assert.equal(group.upgradeReleaseId, 4);
  // Nothing new arrived, so the group must not jump to the top of the list.
  assert.equal(group.listRankAt, 100);
  db.close();
});

test('picking the best known release leaves nothing flagged', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  db.prepare(
    "UPDATE media_groups SET state = 'new', picked_release_id = NULL WHERE id = 1",
  ).run();

  markPicked(db, 1, 4);

  const group = getGroup(db, 1)!;
  assert.equal(group.upgradeReleaseId, null);
  db.close();
});

test('an equal-scoring release is not an upgrade', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  db.prepare('DELETE FROM releases WHERE id IN (3, 4)').run();
  db.prepare('UPDATE releases SET score = 100 WHERE id = 2').run();

  markPicked(db, 1, 1);

  assert.equal(getGroup(db, 1)?.upgradeReleaseId, null);
  db.close();
});

test('flagUpgrade re-derives the same invariant and is the only write that moves list_rank_at', () => {
  const db = openTestDatabase();
  seedGroup(db, 2);

  flagUpgrade(db, 1, 7000);

  const group = getGroup(db, 1)!;
  assert.equal(group.upgradeReleaseId, 4);
  assert.equal(group.listRankAt, 7000);
  db.close();
});
