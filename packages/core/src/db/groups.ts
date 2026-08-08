import type { DatabaseSync } from 'node:sqlite';
import { maybeNum, num, str, type SqlRow } from './row.ts';

export type GroupState = 'new' | 'picked';

export interface GroupRow {
  id: number;
  plugin: string;
  identityKey: string;
  display: string;
  searchText: string;
  state: GroupState;
  pickedReleaseId: number | null;
  upgradeReleaseId: number | null;
  createdAt: number;
  listRankAt: number;
  editedAt: number | null;
}

const SELECT = `
  SELECT id, plugin, identity_key, display, search_text, state,
         picked_release_id, upgrade_release_id, created_at, list_rank_at,
         edited_at
  FROM media_groups
`;

export function toGroupRow(row: SqlRow): GroupRow {
  const state = str(row, 'state');
  return {
    id: num(row, 'id'),
    plugin: str(row, 'plugin'),
    identityKey: str(row, 'identity_key'),
    display: str(row, 'display'),
    searchText: str(row, 'search_text'),
    state: state === 'picked' ? 'picked' : 'new',
    pickedReleaseId: maybeNum(row, 'picked_release_id'),
    upgradeReleaseId: maybeNum(row, 'upgrade_release_id'),
    createdAt: num(row, 'created_at'),
    listRankAt: num(row, 'list_rank_at'),
    editedAt: maybeNum(row, 'edited_at'),
  };
}

export function findGroup(
  db: DatabaseSync,
  plugin: string,
  identityKey: string,
): GroupRow | null {
  const row = db.prepare(`${SELECT} WHERE plugin = ? AND identity_key = ?`).get(plugin, identityKey);
  return row === undefined ? null : toGroupRow(row as SqlRow);
}

export function getGroup(db: DatabaseSync, id: number): GroupRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toGroupRow(row as SqlRow);
}

export interface NewGroup {
  plugin: string;
  identityKey: string;
  display: string;
  searchText: string;
  createdAt: number;
}

export function insertGroup(db: DatabaseSync, group: NewGroup): number {
  const result = db
    .prepare(
      `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      group.plugin,
      group.identityKey,
      group.display,
      group.searchText,
      group.createdAt,
      group.createdAt,
    );
  return Number(result.lastInsertRowid);
}

/**
 * The invariant `upgrade_release_id` is supposed to express: the
 * highest-scoring release in the group that is strictly better than
 * `picked_release_id`, or NULL when there is none.
 *
 * Deriving it, rather than remembering whichever arrival last noticed
 * something better, is what makes the flag survive the two writes that change
 * the *other* side of the comparison. `completeUpgrade` used to clear it
 * unconditionally, discarding a different, better release flagged while the
 * download was in flight; `markPicked` never set it at all, so picking the
 * worse of two releases a group already held left the better one unflagged and
 * dropped the group out of browse entirely (browse shows `state = 'new' OR
 * upgrade_release_id IS NOT NULL`), with nothing left that could ever surface
 * it again. Both are the same defect — a fact treated as an event — and one
 * rule replaces both mechanisms.
 *
 * Ties do not count: `score > picked` is strict, so an equal-scoring
 * alternative is not an upgrade. A picked release that no longer exists makes
 * the subquery NULL, and `score > NULL` is NULL, so the result is correctly
 * "nothing flagged" rather than "everything is better".
 */
function deriveUpgradeReleaseId(
  db: DatabaseSync,
  groupId: number,
  pickedReleaseId: number | null,
): number | null {
  if (pickedReleaseId === null) return null;
  const row = db
    .prepare(
      `SELECT id FROM releases
       WHERE group_id = ? AND score > (SELECT score FROM releases WHERE id = ?)
       ORDER BY score DESC, id DESC LIMIT 1`,
    )
    .get(groupId, pickedReleaseId);
  return row === undefined ? null : num(row as SqlRow, 'id');
}

/**
 * Re-derives the flag *and* moves list_rank_at — the only write in the system
 * that does the latter. Ingest calls this when a newly arrived release beats
 * both the pick and anything already flagged, which is the sole event the spec
 * says should lift a group back to the top of the browse list. The flag itself
 * is recomputed from the same rule every other write uses, so this is that
 * rule plus a bump, not a second mechanism that could disagree with it.
 */
export function flagUpgrade(db: DatabaseSync, groupId: number, now: number): void {
  const group = getGroup(db, groupId);
  const upgrade =
    group === null ? null : deriveUpgradeReleaseId(db, groupId, group.pickedReleaseId);
  db.prepare('UPDATE media_groups SET upgrade_release_id = ?, list_rank_at = ? WHERE id = ?').run(
    upgrade,
    now,
    groupId,
  );
}

/**
 * Re-derives the flag and nothing else. `flagUpgrade` cannot be reused here:
 * it also moves `list_rank_at`, and only a new release arriving earns a group
 * a place at the top of the list. Correcting a release's quality is not an
 * arrival.
 *
 * A missing group is silence rather than an error: the callers that reach here
 * — a release edit, a merge — have already resolved the group, and re-deriving
 * a flag for a row that is gone has nothing to say.
 */
export function refreshUpgradeFlag(db: DatabaseSync, groupId: number): void {
  const group = getGroup(db, groupId);
  if (group === null) return;
  db.prepare('UPDATE media_groups SET upgrade_release_id = ? WHERE id = ?').run(
    deriveUpgradeReleaseId(db, groupId, group.pickedReleaseId),
    groupId,
  );
}

/**
 * Deliberately leaves list_rank_at alone: re-deriving a flag is not a new
 * release arriving, and only a new arrival earns a group a place at the top of
 * the list.
 */
export function markPicked(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = ?, upgrade_release_id = ? WHERE id = ?",
  ).run(releaseId, deriveUpgradeReleaseId(db, groupId, releaseId), groupId);
}

/** Same rule, same silence on list_rank_at, as markPicked above. */
export function completeUpgrade(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    'UPDATE media_groups SET picked_release_id = ?, upgrade_release_id = ? WHERE id = ?',
  ).run(releaseId, deriveUpgradeReleaseId(db, groupId, releaseId), groupId);
}

/**
 * What it means for a group to belong in the browse list: nothing picked yet,
 * or something better than what was picked. Written once and shared by the
 * list query and the single-group lookup below, because the two must never
 * disagree — a client that patched a card into a list the server would not
 * have returned, or dropped one it would have, is a list that quietly stops
 * matching the database.
 */
const BROWSABLE = "(state = 'new' OR upgrade_release_id IS NOT NULL)";

/**
 * The group, but only if it still belongs in the browse list.
 *
 * `null` here means "not in browse", not "no such group" — the caller
 * (`/api/groups/:id/pick`) has already established the group exists. Picking
 * changes exactly one group's membership, and this is how the server states
 * the new answer rather than making the client re-derive it from a view.
 */
export function browsableGroup(db: DatabaseSync, id: number): GroupRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ? AND ${BROWSABLE}`).get(id);
  return row === undefined ? null : toGroupRow(row as SqlRow);
}

export interface BrowseQuery {
  cursor: { listRankAt: number; id: number } | null;
  limit: number;
  search: string | null;
}

/**
 * One query serves both cases from the spec: unpicked groups, and picked
 * groups with something better available. Keyset pagination on
 * (list_rank_at, id) keeps paging stable while ingest is writing.
 *
 * The tiebreak on `id` is ascending, not descending. Every group created in
 * one ingest batch shares that batch's `list_rank_at`, and RSS feeds serve
 * newest-first, so ingest processes the newest item first and it gets the
 * lowest id in the batch. Ascending id order within a tie therefore already
 * is newest-first — the id column is not a proxy for "arrival order" here,
 * it *is* recency, inherited from the order ingest walked the feed in.
 * Descending, the previous ordering, put the batch's oldest item on top.
 *
 * `feed_items.published_at` was the other candidate for this tiebreak — it
 * is the feed's own claim about recency rather than an assumption about feed
 * order — but a group has many releases across many feed items, "whose
 * published_at" is not well-defined without an aggregate, and the column is
 * nullable, so it would still need this same id fallback behind it. That
 * turns a single-table keyset query into a join-and-aggregate for a case
 * this codebase has not observed (a feed serving out of date order); id is
 * kept.
 *
 * The cursor comparison's tiebreak direction has to mirror the ORDER BY's:
 * with `id` ascending inside a tie, the next page holds ids *greater* than
 * the cursor's, not smaller.
 */
export function browseGroups(db: DatabaseSync, query: BrowseQuery): GroupRow[] {
  const conditions = [BROWSABLE];
  const params: (string | number)[] = [];

  if (query.search !== null) {
    conditions.push('search_text LIKE ?');
    params.push(`%${query.search.toLowerCase()}%`);
  }
  if (query.cursor !== null) {
    conditions.push('(list_rank_at < ? OR (list_rank_at = ? AND id > ?))');
    params.push(query.cursor.listRankAt, query.cursor.listRankAt, query.cursor.id);
  }
  params.push(query.limit);

  return db
    .prepare(
      `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY list_rank_at DESC, id ASC LIMIT ?`,
    )
    .all(...params)
    .map((row) => toGroupRow(row as SqlRow));
}

/**
 * Same tiebreak as `browseGroups`, for the same reason: within one
 * `list_rank_at` tie, ascending `id` is newest-first, because ingest walks
 * an RSS batch newest-first and the newest item gets the lowest id. This has
 * no cursor, so there is no paired comparison to keep in step — but it must
 * still agree with `browseGroups` on order, or the same tied groups render
 * in opposite order on the Picks page versus Browse.
 */
export function pickedGroups(db: DatabaseSync): GroupRow[] {
  return db
    .prepare(`${SELECT} WHERE state = 'picked' ORDER BY list_rank_at DESC, id ASC`)
    .all()
    .map((row) => toGroupRow(row as SqlRow));
}

/**
 * The three columns a corrected identity rewrites, and no others — notably not
 * `list_rank_at`: renaming a group is not a release arriving.
 *
 * `search_text` travels with `display` because it is derived from it; letting
 * a caller update one without the other is how a group becomes unsearchable
 * under the name it now shows.
 */
export function updateGroupIdentity(
  db: DatabaseSync,
  group: { id: number; identityKey: string; display: string; searchText: string },
): void {
  db.prepare(
    'UPDATE media_groups SET identity_key = ?, display = ?, search_text = ? WHERE id = ?',
  ).run(group.identityKey, group.display, group.searchText, group.id);
}

/**
 * Separate from `updateGroupIdentity` because a resolve stamps a group it
 * created without otherwise rewriting it, and a merge stamps the *target*,
 * whose own identity columns deliberately stand.
 */
export function markGroupEdited(db: DatabaseSync, groupId: number, editedAt: number): void {
  db.prepare('UPDATE media_groups SET edited_at = ? WHERE id = ?').run(editedAt, groupId);
}

/**
 * The first half of a merge. `PRAGMA foreign_keys = ON` and
 * `releases.group_id REFERENCES media_groups (id)`, so this must run before
 * `deleteGroup` — deleting first fails outright rather than orphaning rows,
 * which is the behaviour we want but not a sequence worth relying on.
 *
 * **This and the `deleteGroup` that follows it belong in one transaction.**
 * The move leaves the source's `picked_release_id` and `upgrade_release_id`
 * pointing at releases the target now owns, and neither column has a foreign
 * key to catch that. Nothing notices, because the source row is deleted a
 * statement later — but that delete is precisely the statement that can throw
 * (see above), and a merge that half-committed would leave a group claiming
 * releases it no longer holds, which every browse and pick query would then
 * read as truth.
 *
 * The caller re-derives the target's upgrade flag afterwards: the arriving
 * releases can beat the target's pick, and this function knowing that rule too
 * is exactly the duplication `deriveUpgradeReleaseId` exists to prevent.
 */
export function moveReleasesToGroup(
  db: DatabaseSync,
  fromGroupId: number,
  toGroupId: number,
): void {
  db.prepare('UPDATE releases SET group_id = ? WHERE group_id = ?').run(toGroupId, fromGroupId);
}

/**
 * Only ever called on a group already emptied by `moveReleasesToGroup`, and
 * only when `groupHasHistory` said no. Anything still referencing the row
 * raises a foreign key error rather than vanishing.
 */
export function deleteGroup(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM media_groups WHERE id = ?').run(id);
}

/** The two kinds of history a group can have. */
export type GroupHistory = 'downloads' | 'imported-files';

/**
 * What has already happened to the one group handed in, or null for a group
 * nothing has happened to yet.
 *
 * Which kind, rather than a bare yes, because the caller refusing a merge has
 * to tell the user what is in the way, and a message naming two tables sends
 * them looking in both. The two situations are also genuinely different: a
 * download is something recorded against this group, an imported file is
 * something already on disk under its name.
 *
 * A group with both is reported as `imported-files`. The ordering only decides
 * anything in that case, and in that case the download has already landed —
 * files are in the library under this group's name, which is the heavier fact
 * and the one the user has to go and look at.
 *
 * Only this group is inspected — in a merge that is the *source*, the group
 * about to be emptied and deleted. Why the merge refuses on a source with
 * history is a fact about the target (it may already carry its own pick, its
 * own upgrade flag and its own imported files, and silently reconciling two
 * picks is a guess), but that is spec §7.3's rationale for asking, not
 * something this observes. It answers about one group and nothing else.
 *
 * A trashed `imported_files` row still counts. The file was placed on disk
 * under this group's name, and trashing recorded where it went — history, not
 * an absence of it.
 */
export function groupHistory(db: DatabaseSync, groupId: number): GroupHistory | null {
  const row = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM downloads WHERE group_id = ?)       AS downloads,
              EXISTS (SELECT 1 FROM imported_files WHERE group_id = ?)  AS imported`,
    )
    .get(groupId, groupId);
  if (row === undefined) return null;
  if (num(row as SqlRow, 'imported') !== 0) return 'imported-files';
  return num(row as SqlRow, 'downloads') !== 0 ? 'downloads' : null;
}
