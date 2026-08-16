import type { DatabaseSync } from 'node:sqlite';
import { maybeStr, num, type SqlRow } from './row.ts';

export interface PerformerQueueRow {
  groupId: number;
  requestedAt: number;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}

/**
 * Whether the group already has performers attached.
 *
 * The whole reason this queue exists is groups a scene lookup left castless, so
 * this is the eligibility test — asked before queueing, and asked *again* inside
 * the transaction that writes a result, because a metadata refetch can attach a
 * real cast in between and `setGroupPerformers` deletes before it inserts.
 */
export function groupHasCast(db: DatabaseSync, groupId: number): boolean {
  return db.prepare('SELECT 1 AS hit FROM group_performers WHERE group_id = ? LIMIT 1')
    .get(groupId) !== undefined;
}

/**
 * Queues one group, answering whether it actually queued.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert, and that is the interesting
 * half: a group can settle repeatedly (a metadata refetch that confirms nothing,
 * again), and an upsert refreshing `requested_at` would move it to the back of
 * its own queue every time. `duePerformerQueue` drains in
 * `(requested_at, group_id)` order, so a row whose stamp kept moving forward
 * would let a repeatedly-settling group starve every row behind it. The first
 * request is the one that counts.
 *
 * The castless check is here rather than left to the caller because it is the
 * definition of eligibility and the caller is a loop; a check the caller
 * remembers is a check that holds on some paths. Whether the *plugin* has a
 * query to offer is a separate question, and it lives in `pipeline/performers.ts`
 * where the plugin registry is in hand — mirroring `metadataAnswerability`,
 * which likewise sits in the pipeline layer rather than in `db/`.
 */
export function insertPerformerSearch(db: DatabaseSync, groupId: number, now: number): boolean {
  if (groupHasCast(db, groupId)) return false;
  const result = db
    .prepare(
      `INSERT INTO performer_queue (group_id, requested_at, attempts, next_at)
       VALUES (?, ?, 0, ?) ON CONFLICT (group_id) DO NOTHING`,
    )
    .run(groupId, now, now);
  return Number(result.changes) > 0;
}

/**
 * Due rows, oldest request first — the same `(requested_at, group_id)` order
 * `dueMetadataQueue` uses, so a row cannot be permanently first in line while
 * its attempts never move. `pipeline/performers.ts` relies on that: a row whose
 * own write throws is deferred outside the failed transaction precisely so the
 * row behind it is reached on the next pass.
 */
export function duePerformerQueue(
  db: DatabaseSync,
  now: number,
  limit: number,
): PerformerQueueRow[] {
  return db
    .prepare(
      `SELECT group_id, requested_at, attempts, next_at, last_error
       FROM performer_queue WHERE next_at <= ? ORDER BY requested_at, group_id LIMIT ?`,
    )
    .all(now, limit)
    .map((raw) => {
      const row = raw as SqlRow;
      return {
        groupId: num(row, 'group_id'),
        requestedAt: num(row, 'requested_at'),
        attempts: num(row, 'attempts'),
        nextAt: num(row, 'next_at'),
        lastError: maybeStr(row, 'last_error'),
      };
    });
}

/** A search that could not be made. Attempts bump; the row stays. */
export function deferPerformerSearch(
  db: DatabaseSync,
  groupId: number,
  error: string,
  nextAt: number,
): void {
  db.prepare(
    `UPDATE performer_queue SET attempts = attempts + 1, last_error = ?, next_at = ?
     WHERE group_id = ?`,
  ).run(error, nextAt, groupId);
}

/**
 * A search that ran. The row goes, whether or not anything was linked.
 *
 * A search that ran and matched nothing **is** an answer — the rule
 * `resolve-sites.ts` and `runMetadataPass` both state — so leaving the row
 * queued would spend one provider request per pass, forever, rediscovering the
 * same silence.
 */
export function removePerformerSearch(db: DatabaseSync, groupId: number): void {
  db.prepare('DELETE FROM performer_queue WHERE group_id = ?').run(groupId);
}
