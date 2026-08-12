import type { DatabaseSync } from 'node:sqlite';
import type { MetadataCandidate, MetadataRejection } from '@pickarr/plugin-api';
import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';

export interface GroupMetadata {
  groupId: number;
  state: 'confirmed' | 'none';
  source: string;
  sourceUuid: string | null;
  title: string | null;
  performers: string[];
  releaseDate: string | null;
  durationSeconds: number | null;
  synopsis: string | null;
  posterUrl: string | null;
  posterPath: string | null;
  fetchedAt: number;
}

export interface MetadataQueueRow {
  groupId: number;
  requestedAt: number;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}

export interface EnqueueResult {
  queued: number;
  alreadyAnswered: number;
  pending: number;
}

export interface MetadataAnswerInput {
  readonly groupId: number;
  readonly source: string;
  readonly confirmed: MetadataCandidate | null;
  readonly nearMisses: readonly MetadataRejection[];
  readonly now: number;
}

/**
 * Performers round-trip as JSON rather than a delimited string because a
 * performer's name may contain any separator worth choosing.
 */
function readPerformers(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    // A row we cannot read is not a reason to fail a page of browse.
    return [];
  }
}

function toMetadata(row: SqlRow): GroupMetadata {
  const state = str(row, 'state');
  return {
    groupId: num(row, 'group_id'),
    state: state === 'confirmed' ? 'confirmed' : 'none',
    source: str(row, 'source'),
    sourceUuid: maybeStr(row, 'source_uuid'),
    title: maybeStr(row, 'title'),
    performers: readPerformers(maybeStr(row, 'performers')),
    releaseDate: maybeStr(row, 'release_date'),
    durationSeconds: maybeNum(row, 'duration_s'),
    synopsis: maybeStr(row, 'synopsis'),
    posterUrl: maybeStr(row, 'poster_url'),
    posterPath: maybeStr(row, 'poster_path'),
    fetchedAt: num(row, 'fetched_at'),
  };
}

const COLUMNS = `group_id, state, source, source_uuid, title, performers, release_date,
                 duration_s, synopsis, poster_url, poster_path, fetched_at`;

export function getGroupMetadata(db: DatabaseSync, groupId: number): GroupMetadata | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM group_metadata WHERE group_id = ?`).get(groupId);
  return row === undefined ? undefined : toMetadata(row as SqlRow);
}

/**
 * One query for a whole page. Issue #31 records `/api/downloads` issuing a
 * query per row and polling it every three seconds; browse must not acquire
 * the same defect while gaining this field.
 */
export function metadataForGroups(
  db: DatabaseSync,
  groupIds: readonly number[],
): Map<number, GroupMetadata> {
  const found = new Map<number, GroupMetadata>();
  if (groupIds.length === 0) return found;
  const holes = groupIds.map(() => '?').join(', ');
  for (const row of db
    .prepare(`SELECT ${COLUMNS} FROM group_metadata WHERE group_id IN (${holes})`)
    .all(...groupIds)) {
    const metadata = toMetadata(row as SqlRow);
    found.set(metadata.groupId, metadata);
  }
  return found;
}

/**
 * Queues only what has never been answered and is not already waiting.
 *
 * `alreadyAnswered` covers `state = 'none'` as much as a confirmation: the
 * service was asked and said no, and asking again on the next browse is
 * exactly the loop a lazy trigger invites.
 */
export function enqueueMetadata(
  db: DatabaseSync,
  groupIds: readonly number[],
  now: number,
): EnqueueResult {
  const result: EnqueueResult = { queued: 0, alreadyAnswered: 0, pending: 0 };
  if (groupIds.length === 0) return result;

  const answered = db.prepare('SELECT 1 AS hit FROM group_metadata WHERE group_id = ?');
  const waiting = db.prepare('SELECT 1 AS hit FROM metadata_queue WHERE group_id = ?');
  const insert = db.prepare(
    `INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
     VALUES (?, ?, 0, ?) ON CONFLICT (group_id) DO NOTHING`,
  );

  db.exec('BEGIN');
  try {
    for (const groupId of groupIds) {
      if (answered.get(groupId) !== undefined) {
        result.alreadyAnswered += 1;
        continue;
      }
      if (waiting.get(groupId) !== undefined) {
        result.pending += 1;
        continue;
      }
      insert.run(groupId, now, now);
      result.queued += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return result;
}

/**
 * Which of these groups have a `metadata_queue` row, in one query for the
 * whole batch — the same reasoning `metadataForGroups` documents, applied to
 * the other table `GET /api/metadata` has to consult to tell `pending` from
 * `absent`.
 */
export function queuedGroupIds(db: DatabaseSync, groupIds: readonly number[]): Set<number> {
  const found = new Set<number>();
  if (groupIds.length === 0) return found;
  const holes = groupIds.map(() => '?').join(', ');
  for (const row of db
    .prepare(`SELECT group_id FROM metadata_queue WHERE group_id IN (${holes})`)
    .all(...groupIds)) {
    found.add(num(row as SqlRow, 'group_id'));
  }
  return found;
}

export function dueMetadataQueue(
  db: DatabaseSync,
  now: number,
  limit: number,
): MetadataQueueRow[] {
  return db
    .prepare(
      `SELECT group_id, requested_at, attempts, next_at, last_error
       FROM metadata_queue WHERE next_at <= ? ORDER BY requested_at, group_id LIMIT ?`,
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

/**
 * Writes the answer, its rejected candidates, and the removal of the queue row
 * as one transaction. A group is answered exactly once, so the candidate rows
 * cannot accumulate across retries.
 */
export function recordMetadataAnswer(db: DatabaseSync, input: MetadataAnswerInput): void {
  const { confirmed } = input;
  db.exec('BEGIN');
  try {
    const answer = db
      .prepare(
        `INSERT INTO group_metadata (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (group_id) DO NOTHING`,
      )
      .run(
        input.groupId,
        confirmed === null ? 'none' : 'confirmed',
        input.source,
        confirmed?.sourceUuid ?? null,
        confirmed?.title ?? null,
        confirmed === null ? null : JSON.stringify(confirmed.performers),
        confirmed?.date ?? null,
        confirmed?.durationSeconds ?? null,
        confirmed?.synopsis ?? null,
        confirmed?.posterUrl ?? null,
        input.now,
      );

    // The ON CONFLICT above makes a second call for the same group a no-op:
    // `changes` is 0 when a row already existed. Candidate rows must be
    // gated on that, or a retried answer duplicates every near-miss it
    // already recorded — the accumulation this function's contract forbids.
    if (Number(answer.changes) > 0) {
      const candidate = db.prepare(
        `INSERT INTO metadata_candidates
           (group_id, source, source_uuid, title, scene_date, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const miss of input.nearMisses) {
        candidate.run(
          input.groupId,
          input.source,
          miss.candidate.sourceUuid,
          miss.candidate.title,
          miss.candidate.date,
          miss.reason,
          input.now,
        );
      }
    }

    db.prepare('DELETE FROM metadata_queue WHERE group_id = ?').run(input.groupId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * A lookup that could not be made learned nothing, so no answer is written —
 * only the attempt counted and the retry pushed out. Caching a failure as a
 * negative would make an outage permanent, which is the rule
 * `resolveSitesForBatch` already follows for site lookups.
 */
export function deferMetadata(
  db: DatabaseSync,
  groupId: number,
  error: string,
  nextAt: number,
): void {
  db.prepare(
    `UPDATE metadata_queue SET attempts = attempts + 1, last_error = ?, next_at = ?
     WHERE group_id = ?`,
  ).run(error, nextAt, groupId);
}

/**
 * Every row this schema keeps about one group's metadata — its answer, its
 * queue entry, and the candidates rejected on the way to that answer — gone.
 *
 * Called from the merge path in `manual/operations.ts` right before the
 * source's `media_groups` row is deleted, so that delete does not meet a
 * foreign key none of these three tables' `ON DELETE` clauses (there are
 * none) would otherwise satisfy. It has to run in the same transaction as
 * that delete: an eviction that committed while the delete rolled back — or
 * the reverse — would leave a group either gone-but-still-answered-for or
 * present-but-forgotten, and every read here uses `group_id` as its only key.
 *
 * Deletion, not relocation, and deliberately so:
 *
 * - `group_metadata.group_id` is that table's primary key, so moving the
 *   source's row onto the target's id would collide the moment the target
 *   already has an answer of its own.
 * - Even where it wouldn't collide, a merge is a human correcting the
 *   system's belief that the source ever needed answering on its own — its
 *   `group_metadata` row is an answer *about the source's identity*, which is
 *   precisely the thing the merge just concluded was wrong. Carrying it onto
 *   the target would attach it to a scene it never described.
 *
 * The target keeps whatever it already has, or has none and gets asked again
 * next time browse renders it — cheap, since asking is exactly what a lazy,
 * browse-driven trigger already does for any group it has never answered.
 *
 * This does not weaken the no-cascade choice for `downloads` and
 * `imported_files`. Those tables record something that happened — a file was
 * fetched, imported, is sitting on disk under the source's name — and
 * `groupHistory` uses the foreign key that would otherwise fire as the
 * deliberate backstop that refuses the merge outright rather than silently
 * discard that record. Metadata records no event at all, only a cached,
 * disposable answer to "what does a remote service call this", so there is
 * nothing here worth refusing a merge to protect.
 */
export function clearGroupMetadata(db: DatabaseSync, groupId: number): void {
  db.prepare('DELETE FROM group_metadata WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM metadata_queue WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM metadata_candidates WHERE group_id = ?').run(groupId);
}

export function setPosterPath(db: DatabaseSync, groupId: number, posterPath: string): void {
  db.prepare('UPDATE group_metadata SET poster_path = ? WHERE group_id = ?').run(
    posterPath,
    groupId,
  );
}
