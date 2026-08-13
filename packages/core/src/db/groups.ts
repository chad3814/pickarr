import type { DatabaseSync } from 'node:sqlite';
import { releaseScore } from './releases.ts';
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
 * 1 when the most recent download of the release named by `releaseId` failed,
 * 0 otherwise.
 *
 * A SQL fragment parameterised by the *expression* naming the release rather
 * than by a release id, because its callers name it differently: the upgrade
 * derivation correlates against `releases.id` of the candidate row it is
 * judging, `failedReleasesOf` against `releases.id` of a whole group's worth,
 * and a bare `?` binds one release directly. Whatever is passed has to resolve
 * in the query this is embedded in, which means every such query must select
 * from that table by name. One function rather than several spellings: "this
 * cannot be downloaded" decides which group the user is sent to, which release
 * on that card is marked, and which alternatives are advertised — three
 * answers that must be the same answer, or the user is sent to a group to be
 * offered the very thing that failed.
 *
 * *Most recent* is the whole of it. Re-picking a release whose earlier attempt
 * failed inserts a second `downloads` row rather than reviving the first
 * (`inFlightForRelease` excludes only 'failed', so nothing stops the pick), so
 * a later attempt is how a release recovers — no marker to clear, no write to
 * remember to make. `ORDER BY id DESC LIMIT 1` is that: downloads ids are
 * monotonic, so the highest is the latest attempt. `updated_at` is not used —
 * it moves on every poll, so a stalled retry could be stamped older than the
 * failure it replaced.
 *
 * `COALESCE(..., 0)` is load-bearing, differently for each caller. A release
 * with no downloads makes the subquery NULL and `NULL = 'failed'` is NULL:
 * as a sort key that would separate "never downloaded" from "downloaded fine"
 * and reorder two groups that are equally not-failed; as an eligibility test
 * it is not true, so an untried release — which is every release in a fresh
 * group — would be judged ineligible and nothing would ever be flagged. Both
 * cases want the same answer, and it is 0.
 */
function latestDownloadFailed(releaseId: string): string {
  return `COALESCE(
    (SELECT status FROM downloads
     WHERE release_id = ${releaseId}
     ORDER BY id DESC LIMIT 1) = 'failed',
    0
  )`;
}

/**
 * 1 when the release named by the expression has a download that has not
 * failed, 0 otherwise.
 *
 * Deliberately the same predicate as `inFlightForRelease` — `status !=
 * 'failed'`, not a list of live statuses — spelled as SQL so that "cannot be
 * picked" and "is not advertised" cannot come apart. Those two are one
 * question asked in two places: the API refuses a pick on a release that
 * already has a download, so advertising such a release offers a button whose
 * only outcome is an error message.
 */
function hasUnfailedDownload(releaseId: string): string {
  return `EXISTS (SELECT 1 FROM downloads WHERE release_id = ${releaseId} AND status != 'failed')`;
}

/**
 * The score to beat: the best release this group has *committed to* — its
 * pick, and anything with a download that has not failed.
 *
 * The pick alone was the bar, and it is the wrong bar for the whole window
 * between picking an upgrade and that upgrade importing. An upgrade
 * deliberately leaves `picked_release_id` on the old release until the
 * replacement is on disk (see `pickRelease`), so during that window the
 * downloading release still scores above the pick — still looked like an
 * upgrade on offer, still put the group in the browse list, still drew a Pick
 * button whose only possible outcome was `already has download`. That is the
 * reported bug: picking an upgrade did not remove the card.
 *
 * A release being downloaded is one the user has already said yes to. Folding
 * those into the bar alongside the pick is what makes "is there something
 * better on offer" mean *better than everything already asked for*, and it
 * subsumes the candidate exclusion rather than needing one: an unfailed
 * download's own release is in this set, so its score cannot be strictly
 * greater than the maximum over the set.
 *
 * It also decides the case where the two disagree, and decides it the way the
 * user asked for. With a 2160p downloading as an upgrade over a 480p, a 1080p
 * arriving is better than the pick but worse than what is already coming; the
 * old bar advertised it, which invited a second concurrent upgrade of the same
 * group. Something better than the in-flight upgrade still flags normally —
 * that is the case `completeUpgrade` exists to preserve — so only the strictly
 * worse arrivals are suppressed.
 *
 * `MAX` over an empty set is NULL and `score > NULL` is NULL, which keeps the
 * pre-existing answer for a `picked_release_id` naming a release that no
 * longer exists: nothing flagged, rather than everything.
 */
function committedScore(groupId: string, pickedReleaseId: string): string {
  return `(SELECT MAX(score) FROM releases committed
     WHERE committed.group_id = ${groupId}
           AND (committed.id = ${pickedReleaseId} OR ${hasUnfailedDownload('committed.id')}))`;
}

/**
 * The invariant `upgrade_release_id` is supposed to express: the
 * highest-scoring release in the group that is strictly better than everything
 * the group has already committed to *and* not already known to be
 * undownloadable, or NULL when there is none.
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
 * Ties do not count: the comparison is strict, so an equal-scoring alternative
 * is not an upgrade. What it is strict *against* is `committedScore` above,
 * not the pick alone.
 *
 * A release whose most recent download failed is not a candidate. The flag is
 * what puts a picked group back in the browse list and what its card
 * advertises, so flagging a release that has already proved undownloadable
 * offers the user a button that fails again — and, once the pick has moved off
 * it, offers it forever. That is the reported loop: a 2160p failed with "not
 * enough repair blocks", the 1080p was picked instead, and the group came
 * straight back advertising the 2160p. The judgement is asked about each
 * *candidate*, never about the pick — asking it about the pick would suppress
 * every alternative at once, for exactly the group that most needs one.
 *
 * It does not hide the failed release. A failed *candidate* stays on the card
 * with its Pick button, so retrying it is one click, and an attempt that
 * succeeds makes the release eligible again on its own — no marker to clear
 * (see `latestDownloadFailed`). A failed *pick* has no Pick button, because
 * `ReleaseRow` gives the current release none; it is retried from the
 * Downloads tab instead. Either way the row is marked `Failed` and the release
 * merely stops being advertised as an upgrade.
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
       WHERE group_id = ? AND score > ${committedScore('?', '?')}
             AND ${latestDownloadFailed('releases.id')} = 0
       ORDER BY score DESC, id DESC LIMIT 1`,
    )
    .get(groupId, groupId, pickedReleaseId);
  return row === undefined ? null : num(row as SqlRow, 'id');
}

/**
 * Whether a release scoring `score` beats everything the group already knows
 * about — its pick, and anything already flagged as better than that pick.
 * This is the one condition under which `list_rank_at` moves.
 *
 * Written here once and shared by ingest (`commitRelease`) and the manual
 * merge (`editGroup`) because those are the same event seen twice: a release
 * *arriving* at this group. A merge's releases merely took a slower route, in
 * through a human, exactly as a resolve's do. Two copies of this expression is
 * how the same scene, corrected by hand, ends up ordered differently from the
 * one that arrived on its own.
 *
 * An unpicked group never earns a bump: `state = 'new'` alone already keeps it
 * in the browse list, so there is nothing to lift it back to — and its pick is
 * NULL, so without this every release it holds would qualify.
 *
 * Both comparisons are strict, and the flagged one is the interesting half. A
 * release that merely ties the flagged upgrade offers the user nothing they
 * are not already being offered — the group is in the browse list on that
 * flag's account — so bumping for it would re-sort the list around an arrival
 * that changed nothing. A NULL on either side reads as "no bar to clear", not
 * as "nothing clears it": `releaseScore` answers null for an unset pointer or
 * a release that has since gone, and negative infinity is what that means
 * here.
 */
export function earnsListBump(db: DatabaseSync, group: GroupRow, score: number): boolean {
  if (group.state !== 'picked') return false;
  const pickedScore = releaseScore(db, group.pickedReleaseId) ?? Number.NEGATIVE_INFINITY;
  const flaggedScore = releaseScore(db, group.upgradeReleaseId) ?? Number.NEGATIVE_INFINITY;
  return score > pickedScore && score > flaggedScore;
}

/**
 * Re-derives the flag *and* moves list_rank_at — the only write in the system
 * that does the latter. Its callers — ingest, and the merge half of a group
 * edit — reach it only through `earnsListBump` above, which is the sole event
 * the spec says should lift a group back to the top of the browse list: a
 * release arriving that beats both the pick and anything already flagged. The
 * flag itself is recomputed from the same rule every other write uses, so this
 * is that rule plus a bump, not a second mechanism that could disagree with it.
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
 * — a release edit, a merge that brought in nothing better than the target
 * already had — have already resolved the group, and re-deriving a flag for a
 * row that is gone has nothing to say.
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
 * The ids of the releases in one group whose latest download failed, as a
 * `SELECT` correlated on whatever expression names the group.
 *
 * *Any* release, not just the pick. The narrower reading — only
 * `picked_release_id` — was the first version of this and it missed the case
 * that matters most: own a 1080p, a 2160p arrives and is flagged as an
 * upgrade, the user picks it, and `pickRelease` records that as an upgrade so
 * `picked_release_id` still names the 1080p. When the 2160p then fails, the
 * pick is a release that imported perfectly well, so "did the pick fail" is
 * *false* — and the group sits on Browse advertising the release that just
 * failed, with nothing anywhere saying so. A group is worth surfacing when
 * something in it failed, whichever release that was.
 *
 * The same select answers both questions the callers have, which is why it
 * yields ids rather than a bare flag: `EXISTS` over it is the group-level sort
 * key, and the ids themselves say which row on the card to mark. Two queries
 * could drift; a group hoisted to the top of Picks with no release on it
 * marked would be exactly the drift that matters.
 */
function failedReleasesOf(groupId: string): string {
  return `SELECT id FROM releases
     WHERE group_id = ${groupId} AND ${latestDownloadFailed('releases.id')} = 1`;
}

/** 1 when any release in the group has a failed latest download, 0 otherwise. */
const HAS_FAILED_DOWNLOAD = `EXISTS (${failedReleasesOf('media_groups.id')})`;

/**
 * Which of a group's releases have a failed latest download — empty for a
 * healthy group.
 *
 * A set rather than a boolean because the view needs both facts and this is
 * the one query that carries them: `size > 0` is the group flag, membership is
 * the per-release flag. Asking twice would be two chances to disagree, and the
 * same `failedReleasesOf` that answers here is what `pickedGroups` sorts on, so
 * the ordering and the marking cannot come apart.
 */
export function failedReleaseIds(db: DatabaseSync, groupId: number): Set<number> {
  const rows = db.prepare(failedReleasesOf('?')).all(groupId);
  return new Set(rows.map((row) => num(row as SqlRow, 'id')));
}

/**
 * Groups with a failed download first, because for the group that prompted this
 * nothing else in the app points at it: a picked group holding no *other*
 * flagged upgrade is off browse (see `BROWSABLE`), so this list is where it has
 * to be findable and the top is where the user lands. Not an invariant, only
 * the case worth designing for — a group can hold a failure and still be
 * browsable, if some third release is flagged (pick the 1080p, the 2160p fails,
 * a 4K REMUX arrives and is flagged), and then it is simply on both screens.
 * The eviction from browse and the arrival here are the same instant —
 * `failDownload` re-derives the upgrade flag in the same transaction — so a
 * group is never briefly absent from both.
 *
 * Underneath that, the same tiebreak as `browseGroups`, for the same reason:
 * within one `list_rank_at` tie, ascending `id` is newest-first, because ingest
 * walks an RSS batch newest-first and the newest item gets the lowest id. This
 * has no cursor, so there is no paired comparison to keep in step — but it must
 * still agree with `browseGroups` on order, or the same tied groups render
 * in opposite order on the Picks page versus Browse.
 *
 * Ordered in SQL rather than re-sorted by the caller: this returns rows
 * straight to a view, and a second sort pass would be a second place the order
 * is decided.
 */
export function pickedGroups(db: DatabaseSync): GroupRow[] {
  return db
    .prepare(
      `${SELECT} WHERE state = 'picked'
       ORDER BY ${HAS_FAILED_DOWNLOAD} DESC, list_rank_at DESC, id ASC`,
    )
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
