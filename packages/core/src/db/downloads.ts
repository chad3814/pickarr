import type { DatabaseSync } from 'node:sqlite';
import { flagUpgrade } from './groups.ts';
import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'importing'
  | 'imported'
  | 'failed';

export type DownloadKind = 'initial' | 'upgrade';

export const TERMINAL_STATUSES: DownloadStatus[] = ['imported', 'failed'];

export interface DownloadRow {
  id: number;
  releaseId: number;
  groupId: number;
  clientId: string;
  clientRef: string | null;
  kind: DownloadKind;
  status: DownloadStatus;
  storagePath: string | null;
  /**
   * The plan the first attempt at importing this download resolved, as the
   * JSON array of `{ source, destination }` the plugin answered — or null if
   * no attempt has got that far. Read back by `importDownload` on every later
   * attempt instead of asking the plugin again: in `move` mode a retry's
   * listing has lost whatever the previous attempt already moved, so a plugin
   * asked a second time answers a plan that no longer names the destinations
   * already written. See `parseStoredPlan` in `pipeline/import.ts` and #23.
   */
  importPlan: string | null;
  error: string | null;
  attempts: number;
  absentSince: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * `missing_polls` is deliberately not selected. The column still exists —
 * dropping a live column buys nothing (see migration 8) — but nothing reads
 * or writes it any more: counting polls was the wrong clock, and
 * `absent_since` replaced it.
 */
const SELECT = `
  SELECT id, release_id, group_id, client_id, client_ref, kind, status,
         storage_path, import_plan, error, attempts, absent_since,
         created_at, updated_at
  FROM downloads
`;

const STATUSES = new Set<string>([
  'queued',
  'downloading',
  'completed',
  'importing',
  'imported',
  'failed',
]);

function toDownloadRow(row: SqlRow): DownloadRow {
  const status = str(row, 'status');
  if (!STATUSES.has(status)) throw new Error(`Unknown download status in database: ${status}`);
  return {
    id: num(row, 'id'),
    releaseId: num(row, 'release_id'),
    groupId: num(row, 'group_id'),
    clientId: str(row, 'client_id'),
    clientRef: maybeStr(row, 'client_ref'),
    kind: str(row, 'kind') === 'upgrade' ? 'upgrade' : 'initial',
    status: status as DownloadStatus,
    storagePath: maybeStr(row, 'storage_path'),
    importPlan: maybeStr(row, 'import_plan'),
    error: maybeStr(row, 'error'),
    attempts: num(row, 'attempts'),
    absentSince: maybeNum(row, 'absent_since'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
  };
}

/**
 * The identifier a download's client-side job is submitted under, independent
 * of the release's own name. `addUrl` callers (pick.ts on the first attempt,
 * reconcile.ts on every retry) pass this as the client's job label so that a
 * job the client already accepted can be recognized again from the client's
 * own queue/history — never by matching against the release title, which is
 * exactly the kind of free-text matching that has cost this project multiple
 * fix rounds elsewhere (the scenes parser). Stable and derived from the
 * download's own id, so the same label is produced on every attempt without
 * needing to be stored anywhere new.
 *
 * This id is unique only within one Pickarr installation's own database — it
 * carries no per-installation salt. Two Pickarr instances sharing one
 * SABnzbd server *and* one category will eventually mint the same label for
 * two different downloads, and reconcile's label-based recovery would then
 * attach the wrong ref to a row rather than merely double-submitting.
 * Avoiding this is a deployment constraint, not something this function
 * enforces: each Pickarr instance must be configured with its own SABnzbd
 * category (see the `category` field in config/schema.ts).
 */
export function downloadLabel(id: number): string {
  return `pickarr-${id}`;
}

/**
 * The structural delimiter `extractLabel` anchors on: a `downloadLabel`
 * wrapped in brackets at the very end of a client-reported name. Anchoring on
 * this rather than scanning for the label as a substring, or matching against
 * the release title, is deliberate — free-text matching against a release
 * title is exactly what has cost this project multiple fix rounds elsewhere
 * (the scenes parser).
 */
const LABEL_MARKER_PATTERN = /\[(pickarr-\d+)\]\s*$/;

/**
 * What `clientJobName` strips out of a release title before appending its
 * own marker: anything bracketed carrying this application's namespace,
 * anywhere in the string.
 *
 * Deliberately wider than `LABEL_MARKER_PATTERN` — spaces inside the
 * brackets, a non-numeric tail, any case — because the two are not symmetric
 * in what they cost when wrong. A shape this misses that the pattern can
 * still read is a misattributed ref; a shape this removes that the pattern
 * would never have read is a few characters missing from a display name, and
 * the only strings it can remove are ones already carrying our namespace,
 * which has no business in an indexer title. Widening the read pattern later
 * (the per-installation salt in #28, say) therefore needs no change here.
 */
const MARKER_SHAPE = /\[\s*pickarr-[^\]]*\]/gi;

/**
 * The name pickarr sends the client as a job's display name: the release
 * title, for legibility in the client's own UI (SABnzbd's queue/history
 * otherwise shows every job as an unreadable `pickarr-<id>`), with
 * `downloadLabel(id)` appended as a bracketed marker `extractLabel` can pull
 * back out deterministically. The marker goes at the end rather than
 * anywhere else in the string so it survives a client that reflows or
 * re-punctuates the title ahead of it — as long as the client does not
 * truncate the name outright, which is exactly the failure `extractLabel`
 * returning null is meant to surface (see `warnIfLabelMismatch` in
 * `pipeline/reconcile.ts`).
 *
 * The invariant this maintains, and the reason for the sanitising step: no
 * name Pickarr sends a client carries the marker shape anywhere except as
 * its own trailing marker. `extractLabel` is anchored at the end of whatever
 * it is handed and cannot tell one occurrence from another, so a name
 * carrying the shape twice is a name whose truncation reads as a *different*
 * download's label — the anchor is sound, and what was unsound was minting a
 * name with a second thing the anchor would accept. Once the invariant
 * holds, truncation can only ever remove the marker, never expose one. It is
 * enforced over every prefix of every name built from a hostile title by the
 * property test in `test/db/downloads.test.ts`, and #30 is the report.
 *
 * The whitespace collapse is not cosmetic: a shape removed from the middle
 * of a title would otherwise leave a double space. The empty-title guard
 * covers a title that was nothing but the shape, whose name becomes the bare
 * marker and stays recoverable.
 */
export function clientJobName(title: string, id: number): string {
  const clean = title.replace(MARKER_SHAPE, ' ').replace(/\s+/g, ' ').trim();
  const marker = `[${downloadLabel(id)}]`;
  return clean === '' ? marker : `${clean} ${marker}`;
}

/**
 * The inverse of `clientJobName`: pulls the label back out of a
 * client-reported name, or `null` if there is no well-formed trailing marker
 * — the client sanitised, reflowed past, or truncated it away. A `null`
 * result is exactly what should make label-based recovery treat the entry as
 * unrecognized and `warnIfLabelMismatch` fire.
 */
export function extractLabel(name: string): string | null {
  return LABEL_MARKER_PATTERN.exec(name)?.[1] ?? null;
}

export interface NewDownload {
  releaseId: number;
  groupId: number;
  clientId: string;
  kind: DownloadKind;
  createdAt: number;
}

export function insertDownload(db: DatabaseSync, download: NewDownload): number {
  const result = db
    .prepare(
      `INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      download.releaseId,
      download.groupId,
      download.clientId,
      download.kind,
      download.createdAt,
      download.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function getDownload(db: DatabaseSync, id: number): DownloadRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toDownloadRow(row as SqlRow);
}

export function allDownloads(db: DatabaseSync): DownloadRow[] {
  return db
    .prepare(`${SELECT} ORDER BY created_at DESC, id DESC`)
    .all()
    .map((row) => toDownloadRow(row as SqlRow));
}

export function activeDownloads(db: DatabaseSync, clientId: string): DownloadRow[] {
  return db
    .prepare(`${SELECT} WHERE client_id = ? AND status NOT IN ('imported', 'failed')`)
    .all(clientId)
    .map((row) => toDownloadRow(row as SqlRow));
}

export interface DownloadIndex {
  byRef: Map<string, DownloadRow>;
  byLabel: Map<string, DownloadRow>;
}

/**
 * The two lookup indexes the client-first reconcile loop matches SABnzbd
 * entries against: a client ref once a job is known to the client, and the
 * label a job was submitted under (`downloadLabel`) while it is still being
 * recognized by name (a fresh submission, or one recovering from
 * `disappeared-from-client`). Reconcile needs both every tick, so this runs
 * one query and keys the same rows two ways rather than making the caller
 * (or this module) scan the row set twice for two maps that would otherwise
 * be byte-identical queries apart from the key.
 *
 * The row set is every download of this client that has a client ref,
 * excluding `imported`. `imported` is excluded on purpose, not by oversight
 * — the cleanup pass at the end of the tick owns imported rows and runs its
 * own query against them, and a second map here that also found them would
 * invite a double import of the same job. `failed` rows are included on
 * purpose too: reconcile decides which of those are eligible for
 * re-attachment (only ones whose error is exactly `disappeared-from-client`),
 * and that decision belongs to the caller, not to this query.
 */
export function indexDownloadsForClient(db: DatabaseSync, clientId: string): DownloadIndex {
  const rows = db
    .prepare(`${SELECT} WHERE client_id = ? AND client_ref IS NOT NULL AND status != 'imported'`)
    .all(clientId)
    .map((row) => toDownloadRow(row as SqlRow));
  return {
    byRef: new Map(rows.map((row) => [row.clientRef as string, row])),
    byLabel: new Map(rows.map((row) => [downloadLabel(row.id), row])),
  };
}

/**
 * Whether releaseId already has a download that a fresh pick would collide
 * with. Excludes only 'failed' — not just the actively-running statuses —
 * because a release that has already reached 'imported' must not be
 * downloaded a second time either; the exclusion set here is "safe to start
 * over", not "currently in progress".
 */
export function inFlightForRelease(db: DatabaseSync, releaseId: number): DownloadRow | null {
  const row = db
    .prepare(`${SELECT} WHERE release_id = ? AND status != 'failed' LIMIT 1`)
    .get(releaseId);
  return row === undefined ? null : toDownloadRow(row as SqlRow);
}

/**
 * Every setter below issues a single-row `WHERE id = ?` update. A stale or
 * mistyped id must not silently no-op forever — the caller finds out
 * immediately, by name, rather than downstream when nothing happened. This
 * is safe against SQLite's own semantics: a row that matches `WHERE id = ?`
 * always reports `changes = 1` from an UPDATE, even when every assigned
 * column already held the value being written, so `changes === 0` here can
 * only mean "no row with this id" (verified empirically, not assumed).
 */
function requireAffected(helper: string, id: number, changes: number | bigint): void {
  if (Number(changes) === 0) throw new Error(`${helper}: no download with id ${id}`);
}

export function setClientRef(
  db: DatabaseSync,
  id: number,
  clientRef: string,
  now: number,
): void {
  const result = db
    .prepare(
      "UPDATE downloads SET client_ref = ?, status = 'downloading', error = NULL, updated_at = ? WHERE id = ?",
    )
    .run(clientRef, now, id);
  requireAffected('setClientRef', id, result.changes);
}

/**
 * The other half of `setClientRef`, for a row whose next status is not
 * `downloading`.
 *
 * Both corrections a re-attachment needs — point the row at the client job it
 * actually belongs to, and retract the error that stranded it — with no status
 * write at all. `setClientRef` forces `'downloading'`, which is right for a row
 * being handed to the client or recovered as still-running, and wrong for one
 * whose job the client has already finished or failed: that row's next status
 * is `'completed'` or `'failed'`, and passing it through `'downloading'` first
 * writes a status no reader ever observes and makes one logical recovery look
 * like two events to whoever is counting them.
 */
export function reattachClientRef(
  db: DatabaseSync,
  id: number,
  clientRef: string,
  now: number,
): void {
  const result = db
    .prepare('UPDATE downloads SET client_ref = ?, error = NULL, updated_at = ? WHERE id = ?')
    .run(clientRef, now, id);
  requireAffected('reattachClientRef', id, result.changes);
}

export function setStatus(
  db: DatabaseSync,
  id: number,
  status: DownloadStatus,
  now: number,
): void {
  const result = db
    .prepare('UPDATE downloads SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now, id);
  requireAffected('setStatus', id, result.changes);
}

/**
 * Also drops any committed `import_plan`, in the same statement.
 *
 * Every source in a stored plan is an absolute path into the directory the
 * plan was resolved against, so a plan that outlives a change of that
 * directory describes somewhere else. Reconcile calls this whenever the
 * client's reported path disagrees with the row's — a remote-path mapping
 * corrected in configuration is enough to move every job at once — and a row
 * left in `importing` by a crash, or put back to `completed` by boot
 * recovery, is exactly the kind that has both a committed plan and a path
 * still liable to be rewritten. Without this, that row's every later attempt
 * would refuse with `Planned source is missing` naming the old directory,
 * forever, where before the plan was stored it would simply have re-planned
 * against the new one.
 *
 * `resetForRetry`'s `'queued'` branch is the same guard reached the other
 * way, and neither subsumes the other: that one clears a plan whose files are
 * about to be fetched again, this one clears a plan whose files turn out to
 * have been somewhere else all along. Clearing unconditionally rather than
 * only when the path really moved costs nothing — the first call for any
 * download happens before an import has committed anything.
 */
export function setStoragePath(
  db: DatabaseSync,
  id: number,
  storagePath: string,
  now: number,
): void {
  const result = db
    .prepare(
      'UPDATE downloads SET storage_path = ?, import_plan = NULL, updated_at = ? WHERE id = ?',
    )
    .run(storagePath, now, id);
  requireAffected('setStoragePath', id, result.changes);
}

/**
 * Commits the plan an import resolved, so every later attempt at the same
 * download acts on it rather than asking the plugin again.
 *
 * Written once, by the attempt that first got a plan past
 * `assertSourcesWereListed`, and never overwritten — `importDownload` only
 * calls this on the branch where the column was null. Overwriting it on each
 * attempt would defeat the point: the value a retry would write is precisely
 * the re-derived plan the stored one exists to displace.
 */
export function setImportPlan(db: DatabaseSync, id: number, plan: string): void {
  const result = db
    .prepare('UPDATE downloads SET import_plan = ? WHERE id = ?')
    .run(plan, id);
  requireAffected('setImportPlan', id, result.changes);
}

/**
 * Re-derives the group's upgrade flag and stamps its list rank as well as
 * writing the status.
 *
 * The flag, because failing is one of the writes that changes a side of that
 * comparison: `deriveUpgradeReleaseId` will not flag a release whose latest
 * download failed, and `upgrade_release_id` is a stored column that only says so
 * once something recomputes it.
 *
 * The rank, because that is how the group becomes findable. `pickedGroups`
 * orders on `list_rank_at` alone, so a group picked weeks ago and failed just now
 * would otherwise sit exactly where it always sat — deep in a long list, on the
 * one screen it still appears on. Stamping the failure's own timestamp puts it at
 * the top and lets it drift down again as later events stamp other groups, which
 * is what the alternative — sorting failures ahead of everything in
 * `pickedGroups` — could not do: that predicate clears only if the failed release
 * itself is downloaded again, so a group the user had already dealt with by
 * taking a different version stayed pinned to the top forever.
 *
 * `flagUpgrade` is those two writes, and is reused rather than re-spelled here
 * for the reason `deriveUpgradeReleaseId` exists at all: one rule, one place. Its
 * other caller reaches it on a release arriving, which is the same kind of fact —
 * something happened to this group.
 *
 * Without this the exclusion took effect at an arbitrary later moment — the
 * next unrelated write that happened to call `refreshUpgradeFlag`, perhaps a
 * quality edit days afterwards — at which point the group dropped off Browse
 * for a reason having nothing to do with the edit that triggered it. Doing it
 * here makes the two halves one instant: the group stops being advertised on
 * Browse with the release that just failed, and appears at the top of Picks
 * with that release marked, on the same write. Evicted from one screen and
 * surfaced on another, rather than quietly absent from both.
 *
 * That is a claim about the *eviction* direction only. The inverse needs no
 * such write: `resetForRetry` makes a failed release eligible again without
 * re-deriving, but the release is now being downloaded, and
 * `deriveUpgradeReleaseId` does not advertise a release the group has already
 * committed to. So the stale flag and the freshly derived one agree — both say
 * "not on offer" — and the release becomes advertisable again only if that
 * retry fails too, which comes back through here.
 *
 * This used to be a lag argued to be harmless: the flag was left stale until
 * some unrelated write recomputed it, on the grounds that picking a
 * mid-download release is refused anyway (`inFlightForRelease`, which excludes
 * only 'failed'). The reasoning was right and the derivation did not implement
 * it — it compared candidates against the pick alone, so a release being
 * downloaded *was* advertised, with a Pick button that could only return
 * `already has download`. `committedScore` makes the two agree by
 * construction.
 *
 * It lives in this function rather than at the five `failDownload` call sites
 * in reconcile.ts for the reason `deriveUpgradeReleaseId` exists at all: an
 * invariant re-derived by whichever caller remembers is an invariant that holds
 * on some paths. This is the only writer of `status = 'failed'` in the package,
 * so every failure path inherits the re-derivation by construction.
 *
 * Both statements go in one transaction so the "one instant" above is true of a
 * crash too, not merely of a reader — nothing here awaits, so no query can
 * observe the gap, but a process that died between them would leave exactly the
 * stale flag this exists to prevent. No caller holds a transaction open
 * (reconcile, the only one, opens none), so this is never nested.
 *
 * The re-derivation reads the row back for its `group_id` instead of taking one
 * from the caller — the id it must use is the one the download itself records,
 * and a second parameter would be a second thing that could be wrong.
 */
export function failDownload(db: DatabaseSync, id: number, error: string, now: number): void {
  db.exec('BEGIN');
  try {
    const result = db
      .prepare("UPDATE downloads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, now, id);
    requireAffected('failDownload', id, result.changes);
    const download = getDownload(db, id);
    // `requireAffected` has already thrown if no row matched, so this cannot be
    // null. It is the type system's branch, not a real one — same shape, and
    // the same wording, as `bumpAttempts` uses for the same impossibility.
    if (download === null) {
      throw new Error(`failDownload: download ${id} vanished after its own update`);
    }
    flagUpgrade(db, download.groupId, now);
    db.exec('COMMIT');
  } catch (error_) {
    db.exec('ROLLBACK');
    throw error_;
  }
}

export function recordError(db: DatabaseSync, id: number, error: string, now: number): void {
  const result = db
    .prepare('UPDATE downloads SET error = ?, updated_at = ? WHERE id = ?')
    .run(error, now, id);
  requireAffected('recordError', id, result.changes);
}

export function bumpAttempts(db: DatabaseSync, id: number, now: number): number {
  const result = db
    .prepare('UPDATE downloads SET attempts = attempts + 1, updated_at = ? WHERE id = ?')
    .run(now, id);
  requireAffected('bumpAttempts', id, result.changes);
  const row = getDownload(db, id);
  if (row === null) throw new Error(`bumpAttempts: download ${id} vanished after its own update`);
  return row.attempts;
}

/**
 * Records when a download was first not seen in a client snapshot — not when
 * it was *last* not seen, which a plain assignment would produce. The
 * `absent_since IS NULL` guard is the whole point: without it, every tick a
 * job stays missing would push the timestamp forward, and "how long has this
 * been gone" (surfaced through `/api/downloads`, and the signal the retry
 * escape hatch relies on) would always read as "just now". A stale id is not
 * treated as an error the way the setters above do — reconcile calls this for
 * every row absent from a snapshot in a loop, and a row already gone by the
 * time this runs is not a coding mistake worth throwing over.
 *
 * Deliberately does not touch `updated_at`: that column means "when this
 * download's own state last changed," and absence is an observation about
 * the client, not a state change in the download. Do not add it here.
 */
export function markAbsent(db: DatabaseSync, id: number, now: number): void {
  db.prepare('UPDATE downloads SET absent_since = ? WHERE id = ? AND absent_since IS NULL').run(
    now,
    id,
  );
}

/**
 * The inverse of `markAbsent`: a no-op when already clear is legitimate (the
 * row was never absent, or reconcile already cleared it this tick) rather than
 * an error, so there is no existence check to distinguish "already clear" from
 * "no such id" — nothing here needs to tell them apart.
 *
 * Every other setter in this file turns a bad id into a thrown error, and the
 * deleted `resetMissingPolls` did it with a `getDownload` probe on its
 * `changes === 0` path, which was cheap there because that path was rare.
 * Here the no-op path is the *common* one — most downloads are not absent on
 * most ticks — so the same probe would mean a query per row per tick to guard
 * against a condition that cannot arise on this call path: every id reaching
 * `clearAbsent` was just read out of this table by the caller (reconcile,
 * matching a snapshot entry against a row it already has), not typed in by a
 * human. Paying for the bad-id assertion here would be buying safety against
 * a mistake the call site cannot make.
 *
 * Also does not touch `updated_at`, for the same reason `markAbsent` does
 * not: clearing an observation about the client is not a state change in the
 * download.
 */
export function clearAbsent(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE downloads SET absent_since = NULL WHERE id = ? AND absent_since IS NOT NULL').run(
    id,
  );
}

/**
 * Resumes from the furthest point already reached: a row that has a storage
 * path only needs its import redone, everything else restarts from queued.
 *
 * `absent_since` is cleared so a retried download does not inherit a stale
 * mark from a previous attempt. `missing_polls` is not touched: nothing reads
 * it any more, and writing a column no reader consults would be the only
 * remaining pretence that it still means something.
 *
 * `import_plan` is cleared on the `'queued'` branch and only there, and that
 * asymmetry is the guard on the whole stored-plan mechanism. Going back to
 * `'queued'` means the client fetches the files again, so the plan describes
 * a download directory that no longer exists — and every source in it is an
 * absolute path into that directory, which a later attempt would either fail
 * to find or, worse, find occupied by an unrelated job the client has since
 * put at the same path. Going to `'completed'` is the import-only retry this
 * column exists for, and keeping the plan there is the entire point. Both are
 * one statement so a reader can never see a row whose status and plan
 * disagree.
 */
export function resetForRetry(db: DatabaseSync, id: number, now: number): DownloadRow | null {
  const download = getDownload(db, id);
  if (download === null) return null;

  const status: DownloadStatus = download.storagePath === null ? 'queued' : 'completed';
  db.prepare(
    `UPDATE downloads
     SET status = ?, error = NULL, attempts = 0, absent_since = NULL,
         client_ref = CASE WHEN ? = 'queued' THEN NULL ELSE client_ref END,
         import_plan = CASE WHEN ? = 'queued' THEN NULL ELSE import_plan END,
         updated_at = ?
     WHERE id = ?`,
  ).run(status, status, status, now, id);

  return getDownload(db, id);
}
