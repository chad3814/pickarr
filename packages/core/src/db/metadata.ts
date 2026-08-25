import type { DatabaseSync } from 'node:sqlite';
import type { MetadataCandidate, MetadataRejection } from '@pickarr/plugin-api';
import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';
import { upsertPerformers, setGroupPerformers } from './performers.ts';

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
  /** Portrait artwork, ~2:3. See `classifyArtwork`: the column is decided by
   *  measured aspect, never by the provider's field name. */
  posterUrl: string | null;
  posterPath: string | null;
  /** Landscape artwork, ~16:9. Same rule. */
  backgroundUrl: string | null;
  backgroundPath: string | null;
  sceneSlug: string | null;
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
    backgroundUrl: maybeStr(row, 'background_url'),
    backgroundPath: maybeStr(row, 'background_path'),
    sceneSlug: maybeStr(row, 'scene_slug'),
    fetchedAt: num(row, 'fetched_at'),
  };
}

const COLUMNS = `group_id, state, source, source_uuid, title, performers, release_date,
                 duration_s, synopsis, poster_url, poster_path, background_url,
                 background_path, scene_slug, fetched_at`;

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
 * What `enqueueRefresh` did with the ids it was given. No `alreadyAnswered`,
 * unlike `EnqueueResult`: every id here is *known* to be already answered —
 * that is the precondition, not an outcome.
 */
export interface RefreshResult {
  queued: number;
  pending: number;
}

/**
 * Queues a re-ask for groups that already have an answer, without disturbing a
 * row the worker is already working through.
 *
 * The third corner of a 2x2 the other two functions here leave open. Whether an
 * existing *answer* blocks the enqueue, and whether an existing *queue row* is
 * reset, are independent questions:
 *
 *   `enqueueMetadata`  answer blocks    queue row blocks, no reset
 *   `requeueMetadata`  answer ignored   queue row reset (attempts 0, next_at now)
 *   `enqueueRefresh`   answer ignored   queue row respected, no reset
 *
 * `/api/metadata/request` needs this one when a `'none'` answer has gone stale
 * enough to be worth asking again. Neither of the others will do. `enqueueMetadata`
 * refuses on sight of the answer. `requeueMetadata` would take the id, but it
 * zeroes `attempts` and pulls `next_at` back to now — and this caller fires on
 * every page view, so a group the worker keeps failing on would be rewound to the
 * front of the queue by nothing more than a reader refreshing the tab, and its
 * backoff would never advance. `ON CONFLICT DO NOTHING` is the whole difference.
 *
 * The answer row is left exactly as it stands. The card keeps showing the last
 * thing the provider said until a better answer replaces it, which is the same
 * rule `requeueMetadata` follows and the reason `GET /api/metadata` can never
 * report a group as less settled than it already was.
 */
export function enqueueRefresh(
  db: DatabaseSync,
  groupIds: readonly number[],
  now: number,
): RefreshResult {
  const result: RefreshResult = { queued: 0, pending: 0 };
  if (groupIds.length === 0) return result;

  const waiting = db.prepare('SELECT 1 AS hit FROM metadata_queue WHERE group_id = ?');
  const insert = db.prepare(
    `INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
     VALUES (?, ?, 0, ?) ON CONFLICT (group_id) DO NOTHING`,
  );

  db.exec('BEGIN');
  try {
    for (const groupId of groupIds) {
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
 * Re-asks groups whose metadata has already settled — the case
 * `enqueueMetadata`'s `answered` guard exists to refuse. That guard stays on
 * `enqueueMetadata` untouched, because the lazy, browse-driven trigger it
 * serves still needs it: nothing about a button existing changes what browse
 * should do on its own. This function serves a different trigger — a user
 * pressing "ask again" on one card already knows the group has an answer and
 * wants it superseded, so being answered is this function's precondition
 * rather than a reason to refuse.
 *
 * The insert is `ON CONFLICT (group_id) DO UPDATE`, not `DO NOTHING`: a row
 * already in the queue — sitting in backoff, or with attempts accumulated
 * toward `MAX_METADATA_ATTEMPTS` — is not the request the button just made.
 * Resetting `attempts` to 0 and `next_at` to `now` makes the press take effect
 * immediately, rather than queueing behind whatever failing schedule the
 * worker had already given that row.
 *
 * `last_error` is cleared in the same clause, for the same reason `attempts`
 * is: `dueMetadataQueue` reads it into `MetadataQueueRow.lastError`, so
 * leaving a stale `ECONNRESET` beside `attempts = 0` would hand every reader
 * a row that contradicts itself — a request that has never been tried and
 * has already failed. The error belonged to the schedule this press just
 * discarded.
 *
 * Callers must pass only ids that already have a `media_groups` row:
 * `metadata_queue.group_id` is a foreign key against it, and one missing id
 * fails the insert — and with it the whole batch, since all of this runs in
 * one transaction. Task 2's endpoint already loads groups by id before it can
 * reach this function, so checking existence here too would just be a second
 * copy of that check for the two to eventually disagree about.
 *
 * Callers must also pass no duplicate ids. The return value is
 * `groupIds.length`, not a count of rows the upsert actually touched — a
 * repeated id would upsert the same row twice and be counted twice, so the
 * number reported back would claim more groups were requeued than exist.
 * `POST /api/metadata/requery` dedups its request body before calling this
 * for exactly that reason.
 *
 * Touches only `metadata_queue`. It does not read or write `group_metadata` —
 * the standing answer is exactly what a requery must leave alone until a new
 * one arrives — and it does not touch `group_performers`, which only an
 * actual answer via `recordMetadataAnswer` ever changes.
 */
export function requeueMetadata(
  db: DatabaseSync,
  groupIds: readonly number[],
  now: number,
): number {
  if (groupIds.length === 0) return 0;

  const insert = db.prepare(
    `INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT (group_id) DO UPDATE SET
       requested_at = excluded.requested_at, attempts = 0, next_at = excluded.next_at,
       last_error = NULL`,
  );

  db.exec('BEGIN');
  try {
    for (const groupId of groupIds) {
      insert.run(groupId, now, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return groupIds.length;
}

/**
 * Each of these groups' `metadata_queue.next_at`, in one query for the whole
 * batch — the same reasoning `metadataForGroups` documents, applied to the
 * other table `GET /api/metadata` has to consult to tell `pending` from
 * `absent`, and now also to say *when* a pending row will next be tried.
 *
 * A group absent from the returned map has no queue row at all — never
 * enqueued, or already answered and removed from the queue by
 * `recordMetadataAnswer` — which is exactly the "never asked" case
 * `metadataViewOf` reports as `'absent'`.
 */
export function queuedMetadataNextAt(
  db: DatabaseSync,
  groupIds: readonly number[],
): Map<number, number> {
  const found = new Map<number, number>();
  if (groupIds.length === 0) return found;
  const holes = groupIds.map(() => '?').join(', ');
  for (const row of db
    .prepare(`SELECT group_id, next_at FROM metadata_queue WHERE group_id IN (${holes})`)
    .all(...groupIds)) {
    const sqlRow = row as SqlRow;
    found.set(num(sqlRow, 'group_id'), num(sqlRow, 'next_at'));
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
 * Writes the answer, its rejected candidates, its cast, and the removal of
 * the queue row as one transaction. A group is answered at most once per
 * queue entry, but the migration that introduced performers re-queues every
 * group already answered, so re-answering is routine, not a retry to guard
 * against: each answer replaces the last — except that it never downgrades a
 * standing confirmation, for which see the upsert's WHERE below.
 */
export function recordMetadataAnswer(db: DatabaseSync, input: MetadataAnswerInput): void {
  const { confirmed } = input;
  db.exec('BEGIN');
  try {
    // poster_path is deliberately absent from the DO UPDATE SET list below:
    // it names a file already fetched to disk, not something a provider
    // answer carries (the INSERT writes it as a literal NULL), and only
    // setPosterPath and setArtworkPair ever write it.
    // Updating it here from excluded would blank a cached poster on every
    // refetch — which migration 7 is about to run for every already-confirmed
    // group in the database.
    //
    // background_path is absent for the same reason, and just as literally:
    // it too names a file already fetched to disk rather than anything a
    // provider answer carries, only setBackgroundPath and setArtworkPair ever
    // write it, and updating it from excluded would blank a cached background
    // on every refetch precisely as it would a poster.
    //
    // The WHERE on the upsert generalises that same protection to the whole
    // row, and the asymmetry is worth recording: blanking a cached *poster*
    // was judged unacceptable and given a regression test, while losing the
    // entire answer — title, date, synopsis, slug and cast — had no guard at
    // all. It is strictly the worse loss.
    //
    // A confirmed answer only ever yields to another confirmed answer. A
    // refetch that comes back `confirmed: null` is an absence of evidence,
    // not evidence of absence, and there are ordinary ways to get one:
    // `answerUnaskable` when the group's plugin no longer produces a query
    // (a user edited the display and dropped the site), `deferOrGiveUp` at
    // MAX_METADATA_ATTEMPTS, or `confirmSceneMetadata` going ambiguous
    // because one new same-site scene landed inside the ±2-day window with a
    // matching title key. Migration 7 re-queues every confirmed group, so
    // without this clause each of those runs library-wide on first boot after
    // the upgrade — and there is no recovery: `enqueueMetadata` counts the
    // resulting `state: 'none'` as `alreadyAnswered`, so the group is never
    // asked again and no manual refresh exists.
    //
    // The second disjunct is what still lets an ordinary answer through: a
    // row that is not currently confirmed can be rewritten by anything,
    // including another 'none' that only refreshes `fetched_at`.
    const written = db.prepare(
      `INSERT INTO group_metadata (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
       ON CONFLICT (group_id) DO UPDATE SET
         state = excluded.state, source = excluded.source,
         source_uuid = excluded.source_uuid, title = excluded.title,
         performers = excluded.performers, release_date = excluded.release_date,
         duration_s = excluded.duration_s, synopsis = excluded.synopsis,
         poster_url = excluded.poster_url, background_url = excluded.background_url,
         scene_slug = excluded.scene_slug, fetched_at = excluded.fetched_at
       WHERE excluded.state = 'confirmed' OR group_metadata.state <> 'confirmed'`,
    ).run(
      input.groupId,
      confirmed === null ? 'none' : 'confirmed',
      input.source,
      confirmed?.sourceUuid ?? null,
      confirmed?.title ?? null,
      // The legacy name array stays written: it is the fallback the view
      // uses for groups whose refetch has not landed, and keeping it
      // current costs one JSON.stringify.
      confirmed === null ? null : JSON.stringify(confirmed.performers.map((p) => p.name)),
      confirmed?.date ?? null,
      confirmed?.durationSeconds ?? null,
      confirmed?.synopsis ?? null,
      confirmed?.posterUrl ?? null,
      confirmed?.backgroundUrl ?? null,
      confirmed?.slug ?? null,
      input.now,
    );

    // Candidates are cleared and rewritten rather than gated on "this is the
    // first answer". That gate was `changes > 0`, which meant something under
    // ON CONFLICT DO NOTHING and means nothing under DO UPDATE. Same
    // guarantee — near misses never accumulate — by a mechanism that
    // survives a group being answered more than once, which the migration's
    // refetch now makes routine.
    //
    // Unconditional, unlike the cast below, even when the upsert above
    // declined to overwrite a standing confirmation. Nothing reads this table
    // back; it is a forensic record of the most recent run, and the run whose
    // near misses are most worth having is exactly the one that failed to
    // re-confirm and left the old answer in place.
    db.prepare('DELETE FROM metadata_candidates WHERE group_id = ?').run(input.groupId);
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

    // The cast, replaced wholesale for the same reason — but only when the
    // answer above was actually written. `changes` is the single source of
    // truth for that: re-deriving the upsert's WHERE in JavaScript would be
    // two conditions that can drift apart, and this one is read straight off
    // the statement that made the decision. An update the WHERE declined
    // reports 0; a fresh insert and a real overwrite both report 1.
    //
    // Skipping matters as much as the row itself. `setGroupPerformers` with
    // an empty list is a DELETE, so running it here would leave the standing
    // confirmation intact on screen with its cast stripped off — the same
    // loss the WHERE exists to prevent, arriving by the back door.
    if (written.changes > 0) {
      const performerIds =
        confirmed === null
          ? []
          : upsertPerformers(db, input.source, confirmed.performers, input.now);
      setGroupPerformers(db, input.groupId, performerIds);
    }

    // Unconditional, and deliberately so even when the answer was declined: a
    // group whose queue row survived a refetch that changed nothing is a
    // group the worker picks up again on the next pass, forever. The question
    // was asked and answered; that the answer was worse than the one already
    // held is not a reason to keep asking it.
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
 * queue entry, the candidates rejected on the way to that answer, the links
 * to its cast, and its queued performer search — gone.
 *
 * Called from the merge path in `manual/operations.ts` right before the
 * source's `media_groups` row is deleted, so that delete does not meet a
 * foreign key none of these five tables' `ON DELETE` clauses (there are
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
 * fetched, imported, is sitting on disk under the source's name — and until
 * the 2026-08-16 identity-edit design, `groupHistory` used the foreign key
 * that would otherwise fire as the deliberate backstop that refused the merge
 * outright rather than silently discard that record. That branch replaced the
 * refusal with the shown decision in that design's §5: the rows now move to
 * the survivor instead. Metadata is different regardless — it records no
 * event at all, only a cached, disposable answer to "what does a remote
 * service call this" — which is why clearing it here, rather than moving it
 * the way `downloads` and `imported_files` now are, is still the right call:
 * there was never anything here worth carrying forward, refusal or no.
 */
export function clearGroupMetadata(db: DatabaseSync, groupId: number): void {
  db.prepare('DELETE FROM group_metadata WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM metadata_queue WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM metadata_candidates WHERE group_id = ?').run(groupId);
  // `group_performers` is the fourth such table and the newest, and it fails
  // the same way the other three would: `group_id REFERENCES media_groups
  // (id)` with no ON DELETE, so a merge of a group whose refetch has landed
  // meets `FOREIGN KEY constraint failed` at `deleteGroup` and returns a 500.
  // Latent rather than immediate at deploy — no group has a row here until
  // its own refetch lands — which is precisely why it has to be covered by a
  // test rather than by the first merge anyone tries.
  //
  // The links go; the `performers` rows they point at stay. Those are shared
  // across groups and keyed on the provider's uuid, not on any one group, so
  // deleting them here would strip another card's cast and orphan cached
  // avatar files. An unreferenced performer row is a few hundred bytes of
  // cache, on exactly the terms the artwork directory is already kept.
  db.prepare('DELETE FROM group_performers WHERE group_id = ?').run(groupId);
  // `performer_queue` is the fifth such table, for the same no-cascade reason:
  // `group_id REFERENCES media_groups (id)` with no ON DELETE means a group
  // whose scene lookup settled castless and got queued for a performer search
  // fails `deleteGroup` with the identical FOREIGN KEY 500 the four tables
  // above were added here to prevent. docs/known-issues.md records that defect
  // shipping twice already; the fix each time was "remember every table that
  // points at media_groups", which is exactly the class of fix that keeps
  // recurring until it lives in one function every caller already goes
  // through.
  db.prepare('DELETE FROM performer_queue WHERE group_id = ?').run(groupId);
}

export function setPosterPath(db: DatabaseSync, groupId: number, posterPath: string): void {
  db.prepare('UPDATE group_metadata SET poster_path = ? WHERE group_id = ?').run(
    posterPath,
    groupId,
  );
}

export function setBackgroundPath(db: DatabaseSync, groupId: number, backgroundPath: string): void {
  db.prepare('UPDATE group_metadata SET background_path = ? WHERE group_id = ?').run(
    backgroundPath,
    groupId,
  );
}

/** Whichever of the poster/background pair a row currently holds, for `reclassifyArtwork`. */
export interface ArtworkRow {
  groupId: number;
  posterUrl: string | null;
  posterPath: string | null;
  backgroundUrl: string | null;
  backgroundPath: string | null;
}

/**
 * Every row holding at least one cached image — a migration 15 leftover with
 * only one side filled, as much as a fully-split row with both — in id order.
 *
 * `reclassifyArtwork` is the only caller: it measures whatever file each path
 * names and decides whether the column it is in still matches.
 */
export function rowsWithArtwork(db: DatabaseSync): ArtworkRow[] {
  const rows = db
    .prepare(
      `SELECT group_id, poster_url, poster_path, background_url, background_path
         FROM group_metadata
        WHERE poster_path IS NOT NULL OR background_path IS NOT NULL
        ORDER BY group_id`,
    )
    .all();
  return rows.map((row) => {
    const sqlRow = row as SqlRow;
    return {
      groupId: num(sqlRow, 'group_id'),
      posterUrl: maybeStr(sqlRow, 'poster_url'),
      posterPath: maybeStr(sqlRow, 'poster_path'),
      backgroundUrl: maybeStr(sqlRow, 'background_url'),
      backgroundPath: maybeStr(sqlRow, 'background_path'),
    };
  });
}

/** The poster/background pair `setArtworkPair` should write for one row. */
export interface ArtworkPair {
  posterUrl: string | null;
  posterPath: string | null;
  backgroundUrl: string | null;
  backgroundPath: string | null;
}

/**
 * Writes both slots of the poster/background pair at once.
 *
 * `reclassifyArtwork`'s only write. A mismatch always moves an image from one
 * slot to the other, which changes both sides of the pair — the slot being
 * vacated and the one being filled — in the same instant; a setter that
 * touched one side at a time could be read from in between, or crash between
 * the two, and leave a row with a url on one side and a path on the other
 * that no longer name the same image.
 */
export function setArtworkPair(db: DatabaseSync, groupId: number, pair: ArtworkPair): void {
  db.prepare(
    `UPDATE group_metadata
        SET poster_url = ?, poster_path = ?, background_url = ?, background_path = ?
      WHERE group_id = ?`,
  ).run(pair.posterUrl, pair.posterPath, pair.backgroundUrl, pair.backgroundPath, groupId);
}
