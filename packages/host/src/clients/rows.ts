/**
 * One store for `torrent_download` and `nzb_download`: the two tables are
 * identical bar `infohash` (torrent-only -- an nzb has no equivalent
 * identifier to record before submission), so every function here takes a
 * `DownloadRow`, which names its own table, rather than one module per
 * table.
 *
 * Every statement is built from a switch on `row.table` against the two
 * literal table names, never from a template that interpolates a
 * caller-supplied string -- even one typed as the two-member
 * `'torrent_download' | 'nzb_download'` union, because that type is gone at
 * runtime and the next caller of a table-name-taking helper might not be
 * typed at all.
 *
 * `attempts` is deliberately unread and unwritten here: resubmission is out
 * of scope for this slice, so nothing in this module increments it, and
 * `DownloadRow` does not carry it.
 *
 * `advanceStatus`, `setRef`, `markDelivered` and `failRow` all move a row
 * and all guard `WHERE id = ? AND status = ?` before doing it, then report
 * whether the write actually applied. That guard exists because of a bug
 * the job-dispatcher slice shipped: an outcome update there checked a row's
 * identity but not which attempt still owned it, so a late settle decided a
 * row a newer attempt had already moved on from. The fix was a narrower
 * `WHERE`, and the same discipline applies here to every transition -- a
 * caller that reads a row, decides an action, and writes it back can never
 * be sure nothing else moved that row in between, so the write has to name
 * the state it still expects and say whether that expectation held.
 *
 * `markReclaimed` is the same shape with a second condition added: it
 * guards `WHERE id = ? AND status = 'delivered' AND reclaimed_at IS NULL`,
 * because reclaiming has two preconditions rather than one -- still
 * `delivered`, and not already reclaimed by some earlier pass or a
 * concurrent caller.
 *
 * `setProgress`, `setStoragePath` and `setAbsent` are observations, not
 * transitions: what a client reports about a download's progress, path or
 * presence is true regardless of which status the row happens to be in, so
 * these are keyed on `id` alone and never touch `status`. An observation
 * that quietly moved a row's state would be indistinguishable from a real
 * transition, and would defeat every guard above.
 */
import type { DatabaseSync } from 'node:sqlite';
import { doublingDelayMs } from '../jobs/backoff.ts';

export type DownloadStatus =
  'submitting' | 'submitted' | 'downloading' | 'completed' | 'delivered' | 'failed';

/**
 * Every status a download row may hold. Exported so a caller that wants
 * "everything except X" can derive it from this list rather than restate it
 * -- `reconcile.ts`'s absence sweep does exactly that, and a restated list
 * is a list that drifts the day a seventh status is added.
 */
export const DOWNLOAD_STATUSES: readonly DownloadStatus[] =
  ['submitting', 'submitted', 'downloading', 'completed', 'delivered', 'failed'];

function isDownloadStatus(value: string): value is DownloadStatus {
  return (DOWNLOAD_STATUSES as readonly string[]).includes(value);
}

export interface DownloadRow {
  id: number;
  table: 'torrent_download' | 'nzb_download';
  rssItemId: number;
  downloadClientId: number;
  clientRef: string | null;
  status: DownloadStatus;
  storagePath: string | null;
  absentSince: number | null;
  deliveredAt: number | null;
  reclaimedAt: number | null;
  /**
   * The reason the row carries for its current state -- `failRow`'s own
   * message when `status` is `failed`, and whatever an earlier failure left
   * behind otherwise, since nothing clears it on the way back out.
   *
   * Read, not merely written, since `reconcile.ts`'s history walk decides on
   * it: a `failed` history entry that names the reason this row already
   * holds is a repeat of a verdict already recorded, and re-issuing the
   * `UPDATE` would churn `updated_at` on every tick forever. That decision
   * needs the current value, so it is part of the row.
   */
  lastError: string | null;
  /** How many imports this row has had refused in a row (#101). Kept across a cleared wait, so a row refused again resumes its ladder rather than starting over. */
  importFailures: number;
  /** When this row's next import attempt is due, or `null` when it is not waiting on one (#101). See `importRetryDelayMs`. */
  importRetryAt: number | null;
}

/**
 * The columns every read below needs, in one place: never `infohash`
 * (torrent-only, and no function here needs it), never `attempts` (dead in
 * this slice), and never a `download_client` credential column -- this
 * module touches only the two download tables, which have none. Since
 * migration 14 those are `api_key_secret_name`, `username` and
 * `password_secret_name`, and the rule reaches the new names too: a secret
 * name is safe to log, but a module that selects one is a module that could
 * resolve it, and only `readClientConfig` may.
 *
 * `last_error` is here because it is read, not only written: see
 * `DownloadRow.lastError`.
 */
const SELECT_COLUMNS =
  'id, rss_item_id, download_client_id, client_ref, status, storage_path, absent_since, delivered_at, '
  + 'reclaimed_at, last_error, import_failures, import_retry_at';

/**
 * Narrows one raw row into a `DownloadRow`, the same idiom `clients/config.ts`'s
 * `readRow` uses: each field pulled through its own `unknown`-typed
 * accessor, never a wholesale cast. `status` is checked against
 * `DownloadStatus`'s members rather than asserted, mirroring `config.ts`'s
 * `isImplementation` -- a row holding a status this slice does not know
 * about is a fact worth throwing on, not papering over with a cast.
 */
function toRow(raw: unknown, table: DownloadRow['table']): DownloadRow {
  const id = Number((raw as { id: unknown }).id);
  const clientRef = (raw as { client_ref: unknown }).client_ref;
  const storagePath = (raw as { storage_path: unknown }).storage_path;
  const absentSince = (raw as { absent_since: unknown }).absent_since;
  const deliveredAt = (raw as { delivered_at: unknown }).delivered_at;
  const reclaimedAt = (raw as { reclaimed_at: unknown }).reclaimed_at;
  const lastError = (raw as { last_error: unknown }).last_error;
  const importRetryAt = (raw as { import_retry_at: unknown }).import_retry_at;
  const statusValue = String((raw as { status: unknown }).status);
  if (!isDownloadStatus(statusValue)) {
    throw new Error(`${table} row ${id} has unknown status ${JSON.stringify(statusValue)}`);
  }
  return {
    id,
    table,
    rssItemId: Number((raw as { rss_item_id: unknown }).rss_item_id),
    downloadClientId: Number((raw as { download_client_id: unknown }).download_client_id),
    clientRef: clientRef === null || clientRef === undefined ? null : String(clientRef),
    status: statusValue,
    storagePath: storagePath === null || storagePath === undefined ? null : String(storagePath),
    absentSince: absentSince === null || absentSince === undefined ? null : Number(absentSince),
    deliveredAt: deliveredAt === null || deliveredAt === undefined ? null : Number(deliveredAt),
    reclaimedAt: reclaimedAt === null || reclaimedAt === undefined ? null : Number(reclaimedAt),
    lastError: lastError === null || lastError === undefined ? null : String(lastError),
    importFailures: Number((raw as { import_failures: unknown }).import_failures ?? 0),
    importRetryAt: importRetryAt === null || importRetryAt === undefined ? null : Number(importRetryAt),
  };
}

/**
 * The statement `rowsForClientByStatus` runs against one table, for
 * `statusCount` placeholders.
 *
 * Exported so a test can put the *actual* query through
 * `EXPLAIN QUERY PLAN`. A plan assertion against a string restated in the
 * test proves what SQLite does with that string, not what this module asks
 * it -- and the whole reason the assertion exists is that a dropped `status`
 * predicate changes nothing an ordinary test can observe while turning every
 * read back into a full scan.
 *
 * `table` picks between two literals through a comparison rather than being
 * interpolated, even though its type is the two-member union: see this
 * module's own doc for why that type is not what makes the interpolation
 * safe. `statusCount` is a length, never a value, so nothing a caller holds
 * reaches the text. A `statusCount` of 0 would build `IN ()`, which is not
 * valid SQLite; `rowsForClientByStatus` answers that case before calling
 * here.
 */
export function rowsForClientByStatusSql(table: DownloadRow['table'], statusCount: number): string {
  const placeholders = Array.from({ length: statusCount }, () => '?').join(', ');
  const tail = ` WHERE download_client_id = ? AND status IN (${placeholders}) ORDER BY id`;
  return table === 'torrent_download'
    ? `SELECT ${SELECT_COLUMNS} FROM torrent_download${tail}`
    : `SELECT ${SELECT_COLUMNS} FROM nzb_download${tail}`;
}

/**
 * Every row on `clientId` whose `status` is one of `statuses`, tagged with
 * which table it came from, torrent rows first and each table in id order.
 *
 * **The status predicate is in SQL, and that is the point.** The function
 * this replaced selected on `download_client_id` alone and left every
 * caller to filter in JavaScript, so each of them read every row the client
 * had ever had -- every `delivered`, every `failed` -- and narrowed it
 * afterwards. A reconcile tick makes four such reads across two tables, so
 * eight full scans, all materialised through `toRow`. Measured on that
 * shape: 20,000 finished rows with nothing at all to do, one tick took
 * 153 ms. `node:sqlite` is synchronous, so that is 153 ms in which nothing
 * else in the process runs, once per client every `RECONCILE_INTERVAL_S`
 * (10s), growing with lifetime history and never shrinking. This is also
 * the query
 * `torrent_download_status`/`nzb_download_status` were added for in
 * migration 7 -- until it existed those indexes served nothing.
 *
 * `ORDER BY id` is stated rather than inherited from the index. Reading
 * through `..._status` returns rows grouped by status *value*, and delivery
 * order is documented as row order (`clients/deliver.ts`, and §9 of this
 * slice's design). A single-status read gets that ordering from the index
 * for nothing; a multi-status read pays a sort over the narrowed set, which
 * is the only set anyone was going to look at.
 *
 * The placeholder list is built from `statuses.length` and never from its
 * contents -- the same rule this module's own doc states for table names,
 * for the same reason. An empty `statuses` is answered without a query at
 * all: no row's status is a member of the empty set, so `[]` is the correct
 * answer rather than a degenerate one, and `IN ()` is not valid SQLite
 * anyway.
 */
export function rowsForClientByStatus(
  raw: DatabaseSync,
  clientId: number,
  statuses: readonly DownloadStatus[],
): DownloadRow[] {
  if (statuses.length === 0) return [];
  const torrentRows = raw.prepare(rowsForClientByStatusSql('torrent_download', statuses.length))
    .all(clientId, ...statuses).map((row) => toRow(row, 'torrent_download'));
  const nzbRows = raw.prepare(rowsForClientByStatusSql('nzb_download', statuses.length))
    .all(clientId, ...statuses).map((row) => toRow(row, 'nzb_download'));
  return [...torrentRows, ...nzbRows];
}

/**
 * Adds every non-null `client_ref` in `rows` to `refs`. At module scope
 * rather than nested inside `heldRefs`: it closes over nothing from that
 * call, and a nested helper that could be hoisted is a lint warning this
 * package keeps at zero.
 */
function collectRefs(rows: readonly unknown[], refs: Set<string>): void {
  for (const row of rows) {
    const ref = (row as { client_ref: unknown }).client_ref;
    if (ref !== null && ref !== undefined) refs.add(String(ref));
  }
}

/**
 * Every `client_ref` a row on `clientId` already holds -- both tables, and
 * every status, because a `delivered` row's ref is exactly as taken as a
 * `downloading` one's.
 *
 * Both tables even though each has its own unique index, and the index is
 * per-table: `rowByRef` looks a ref up in `torrent_download` first and
 * `nzb_download` second, so a ref taken in either one is a ref nothing may
 * attach to a row in the other -- doing it anyway would not violate a
 * constraint, it would just make `rowByRef` answer with whichever table was
 * asked first. This function answers "is this ref taken", not "would this
 * write be rejected".
 *
 * Selects `client_ref` alone and states `client_ref IS NOT NULL`, which is
 * what lets the *partial* unique index `(download_client_id, client_ref)`
 * cover the read -- no table row is visited at all. Filtering the nulls out
 * in JavaScript instead would leave the predicate unstated, the index
 * unusable, and the read a full scan of every row this client has ever had.
 */
export function heldRefs(raw: DatabaseSync, clientId: number): Set<string> {
  const refs = new Set<string>();
  collectRefs(
    raw.prepare(
      'SELECT client_ref FROM torrent_download WHERE download_client_id = ? AND client_ref IS NOT NULL',
    ).all(clientId),
    refs,
  );
  collectRefs(
    raw.prepare(
      'SELECT client_ref FROM nzb_download WHERE download_client_id = ? AND client_ref IS NOT NULL',
    ).all(clientId),
    refs,
  );
  return refs;
}

/**
 * The statement `unreclaimedRowsForClient` runs against one table.
 * Exported for the same `EXPLAIN QUERY PLAN` reason as
 * `rowsForClientByStatusSql`, and `table` picks between two literals the
 * same way.
 */
export function unreclaimedRowsForClientSql(table: DownloadRow['table']): string {
  const tail = " WHERE download_client_id = ? AND status = 'delivered' AND reclaimed_at IS NULL ORDER BY id";
  return table === 'torrent_download'
    ? `SELECT ${SELECT_COLUMNS} FROM torrent_download${tail}`
    : `SELECT ${SELECT_COLUMNS} FROM nzb_download${tail}`;
}

/**
 * Every `delivered` row on `clientId` that has not been reclaimed yet --
 * the reclaim pass's read, and the one place `rowsForClientByStatus` is not
 * enough.
 *
 * `delivered` is where a row stops moving, so every download a client ever
 * finished is `delivered` forever, and `reclaimed_at` is set on essentially
 * all of them. Narrowing on `status` alone therefore leaves exactly the
 * defect that narrowing was for: measured on this schema, 20,000
 * already-reclaimed rows cost 18-32 ms per read as a status-only select and
 * 1.8 ms with `reclaimed_at IS NULL` stated in SQL, because the former
 * materialises 20,000 `DownloadRow`s to throw all of them away. Both use
 * the `..._status` index; the difference is what comes back through it.
 *
 * The predicate matches `markReclaimed`'s own second guard, which is not a
 * coincidence: this selects the rows that write can still apply to.
 */
export function unreclaimedRowsForClient(raw: DatabaseSync, clientId: number): DownloadRow[] {
  const torrentRows = raw.prepare(unreclaimedRowsForClientSql('torrent_download'))
    .all(clientId).map((row) => toRow(row, 'torrent_download'));
  const nzbRows = raw.prepare(unreclaimedRowsForClientSql('nzb_download'))
    .all(clientId).map((row) => toRow(row, 'nzb_download'));
  return [...torrentRows, ...nzbRows];
}

/**
 * The row on `clientId` holding `ref`, from whichever table has it.
 *
 * Keyed on `(download_client_id, client_ref)` together, never on `ref`
 * alone: a ref is unique only *within* a client, exactly matching the
 * partial unique index `migrate.ts` puts on each table. 1.x learned this
 * the hard way once a second client of the same type became configurable --
 * two clients can each hold a ref with the same text, and a lookup that
 * ignored `clientId` would return whichever row happened to match first,
 * regardless of which client actually owns it.
 */
export function rowByRef(raw: DatabaseSync, clientId: number, ref: string): DownloadRow | undefined {
  const torrentRow = raw.prepare(
    `SELECT ${SELECT_COLUMNS} FROM torrent_download WHERE download_client_id = ? AND client_ref = ?`,
  ).get(clientId, ref);
  if (torrentRow !== undefined) return toRow(torrentRow, 'torrent_download');

  const nzbRow = raw.prepare(
    `SELECT ${SELECT_COLUMNS} FROM nzb_download WHERE download_client_id = ? AND client_ref = ?`,
  ).get(clientId, ref);
  if (nzbRow !== undefined) return toRow(nzbRow, 'nzb_download');

  return undefined;
}

/**
 * Moves `row` from `from` to `to`, applying only if the row is still in
 * `from` -- not merely wherever `row.status` said it was when read. Naming
 * `from` explicitly (rather than trusting `row.status`) lets a caller state
 * the transition it means to make even when its copy of `row` might already
 * be stale, and the database, not the caller's copy, is what decides
 * whether that transition is still legal.
 */
export function advanceStatus(
  raw: DatabaseSync,
  row: DownloadRow,
  from: DownloadStatus,
  to: DownloadStatus,
  at: number,
): boolean {
  const result = row.table === 'torrent_download'
    ? raw.prepare(
      'UPDATE torrent_download SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
    ).run(to, at, row.id, from)
    : raw.prepare(
      'UPDATE nzb_download SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
    ).run(to, at, row.id, from);
  return result.changes > 0;
}

/**
 * Records the client's reference for `row`, applying only if `row`'s status
 * is still what it was when read. `status` itself is left untouched --
 * setting a ref is not, by itself, a transition -- but the write is still
 * conditional: a ref set onto a row something else already moved on from
 * would attach the client's answer to the wrong moment in that row's life.
 */
export function setRef(raw: DatabaseSync, row: DownloadRow, ref: string, at: number): boolean {
  const result = row.table === 'torrent_download'
    ? raw.prepare(
      'UPDATE torrent_download SET client_ref = ?, updated_at = ? WHERE id = ? AND status = ?',
    ).run(ref, at, row.id, row.status)
    : raw.prepare(
      'UPDATE nzb_download SET client_ref = ?, updated_at = ? WHERE id = ? AND status = ?',
    ).run(ref, at, row.id, row.status);
  return result.changes > 0;
}

/**
 * Records `row`'s current completion percentage. An observation: never
 * touches `status`.
 *
 * **Skips the write when the stored percentage already equals `percentage`.**
 * Stated in the `WHERE` clause (`IS NOT`, not `!=`, so a row that has never
 * been observed and still holds `NULL` compares correctly) rather than read
 * and compared in this function: that needs no `percentage` field on
 * `DownloadRow` at all. Without this, a stalled or paused download -- whose
 * reported percentage never changes -- wrote, fired this table's own sync
 * trigger and grew `sync_log`, on every tick forever: at a 10-second
 * `RECONCILE_INTERVAL_S` that is six churns a minute for a download doing
 * nothing differently than it was a tick ago.
 */
export function setProgress(raw: DatabaseSync, row: DownloadRow, percentage: number, at: number): void {
  if (row.table === 'torrent_download') {
    raw.prepare('UPDATE torrent_download SET percentage = ?, updated_at = ? WHERE id = ? AND percentage IS NOT ?')
      .run(percentage, at, row.id, percentage);
  } else {
    raw.prepare('UPDATE nzb_download SET percentage = ?, updated_at = ? WHERE id = ? AND percentage IS NOT ?')
      .run(percentage, at, row.id, percentage);
  }
}

/** Records the client's own path for `row`, exactly as reported. An observation: never touches `status`. */
export function setStoragePath(raw: DatabaseSync, row: DownloadRow, storagePath: string, at: number): void {
  if (row.table === 'torrent_download') {
    raw.prepare('UPDATE torrent_download SET storage_path = ?, updated_at = ? WHERE id = ?').run(storagePath, at, row.id);
  } else {
    raw.prepare('UPDATE nzb_download SET storage_path = ?, updated_at = ? WHERE id = ?').run(storagePath, at, row.id);
  }
}

/**
 * Sets `row`'s `absent_since` to `absentSince`, or clears it when that is
 * `null`. An observation: never touches `status`.
 *
 * The value and the clock are separate parameters so that **both** stamping
 * and clearing move `updated_at`. Folding them into one argument would make
 * `updated_at` advance or not depending on the *value* being written, which
 * is a surprise in a function whose job is to record one -- and it would
 * leave a row that went absent and came back reporting the stamp's time as
 * the last thing that happened to it. A clear is a change; a column called
 * `updated_at` that skips some changes is answering a different question
 * than its name asks.
 */
export function setAbsent(
  raw: DatabaseSync,
  row: DownloadRow,
  absentSince: number | null,
  at: number,
): void {
  if (row.table === 'torrent_download') {
    raw.prepare('UPDATE torrent_download SET absent_since = ?, updated_at = ? WHERE id = ?')
      .run(absentSince, at, row.id);
  } else {
    raw.prepare('UPDATE nzb_download SET absent_since = ?, updated_at = ? WHERE id = ?')
      .run(absentSince, at, row.id);
  }
}

/**
 * Marks `row` delivered, applying only if its status is still what it was
 * when read -- the same guard shape as `setRef`, guarding the transition a
 * reconcile pass makes once a completed download has actually landed.
 */
export function markDelivered(raw: DatabaseSync, row: DownloadRow, at: number): boolean {
  const result = row.table === 'torrent_download'
    ? raw.prepare(
      "UPDATE torrent_download SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ? AND status = ?",
    ).run(at, at, row.id, row.status)
    : raw.prepare(
      "UPDATE nzb_download SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ? AND status = ?",
    ).run(at, at, row.id, row.status);
  return result.changes > 0;
}

/**
 * Marks `row` reclaimed at `at`, applying only if it is still `delivered`
 * and has not already been reclaimed -- the same guard shape as
 * `markDelivered`, with a second condition added because this transition has
 * two preconditions rather than one: a row that is not `delivered` has
 * nothing to reclaim, and a row `reclaimed_at` already names must not be
 * reclaimed a second time. That second guard is the whole fix for the
 * defect this column exists to close -- see `clients/deliver.ts`'s module
 * doc and `db/migrate.ts`'s migration 8 comment for what happens without it.
 */
export function markReclaimed(raw: DatabaseSync, row: DownloadRow, at: number): boolean {
  const result = row.table === 'torrent_download'
    ? raw.prepare(
      "UPDATE torrent_download SET reclaimed_at = ?, updated_at = ? WHERE id = ? AND status = 'delivered' AND reclaimed_at IS NULL",
    ).run(at, at, row.id)
    : raw.prepare(
      "UPDATE nzb_download SET reclaimed_at = ?, updated_at = ? WHERE id = ? AND status = 'delivered' AND reclaimed_at IS NULL",
    ).run(at, at, row.id);
  return result.changes > 0;
}

/**
 * Marks `row` failed with `message`, applying only if its status is still
 * what it was when read -- the same guard shape as `setRef` and
 * `markDelivered`.
 */
export function failRow(raw: DatabaseSync, row: DownloadRow, message: string, at: number): boolean {
  const result = row.table === 'torrent_download'
    ? raw.prepare(
      "UPDATE torrent_download SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = ?",
    ).run(message, at, row.id, row.status)
    : raw.prepare(
      "UPDATE nzb_download SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = ?",
    ).run(message, at, row.id, row.status);
  return result.changes > 0;
}

/** How long a pick may stay `submitting` before a successful snapshot settles it (#95). Long past the 30-second fetch timeout any submission is bounded by. */
export const UNCONFIRMED_AFTER_MS = 600_000;
export const UNCONFIRMED_MESSAGE = 'the client never confirmed this submission';

/**
 * Fails every `submitting` row on `clientId` created before `createdBefore`,
 * in both download tables, and answers how many. One statement per table,
 * guarded on `status = 'submitting'` in the statement itself, so a row that
 * something else settled first is left alone. Keyed on `created_at`, the
 * moment the pick was written; `updated_at` moves when `setRef` attaches a
 * ref to a row that is still `submitting`.
 *
 * Two literal statements, not one templated on `table`, matching every
 * other function in this module: see the module doc for why a table name is
 * never interpolated, even from the two-member union.
 *
 * Called only by `reconcile.ts`'s `walkSnapshot`, after its ref recovery,
 * and only when the snapshot is both successful and complete -- a partial
 * list cannot show a row never arrived, the same reason `recoverRefs` and
 * `sweepAbsent` guard on `deps.snapshot.complete`. See there.
 */
export function failUnconfirmed(raw: DatabaseSync, clientId: number, createdBefore: number, at: number): number {
  const torrentChanges = raw.prepare(
    "UPDATE torrent_download SET status = 'failed', last_error = ?, updated_at = ? "
    + 'WHERE download_client_id = ? AND status = \'submitting\' AND created_at < ?',
  ).run(UNCONFIRMED_MESSAGE, at, clientId, createdBefore).changes;
  const nzbChanges = raw.prepare(
    "UPDATE nzb_download SET status = 'failed', last_error = ?, updated_at = ? "
    + 'WHERE download_client_id = ? AND status = \'submitting\' AND created_at < ?',
  ).run(UNCONFIRMED_MESSAGE, at, clientId, createdBefore).changes;
  return Number(torrentChanges) + Number(nzbChanges);
}

/** The first wait after a refused import, doubled per further refusal. */
const IMPORT_RETRY_BASE_MS = 10_000;
/** The longest a refused import waits: an operator's fix is still picked up within the hour. */
const IMPORT_RETRY_CAP_MS = 3_600_000;

export function importRetryDelayMs(failures: number): number {
  return doublingDelayMs(failures, IMPORT_RETRY_BASE_MS, IMPORT_RETRY_CAP_MS);
}

/**
 * Records one refused import on `row`: one more failure, and no retry until
 * the backoff has passed (#101). Guarded on `status = 'completed'` like every
 * other writer here. `updated_at` is not moved: this is the host's own
 * bookkeeping, not a change to the download, and a client reading the row
 * would see nothing different.
 *
 * Two literal statements, not one templated on `row.table`, matching every
 * other function in this module -- see the module doc for why a table name
 * is never interpolated, even from the two-member union.
 */
export function recordImportRefusal(raw: DatabaseSync, row: DownloadRow, at: number): void {
  const failures = row.importFailures + 1;
  const retryAt = at + importRetryDelayMs(failures);
  if (row.table === 'torrent_download') {
    raw.prepare(
      "UPDATE torrent_download SET import_failures = ?, import_retry_at = ? WHERE id = ? AND status = 'completed'",
    ).run(failures, retryAt, row.id);
  } else {
    raw.prepare(
      "UPDATE nzb_download SET import_failures = ?, import_retry_at = ? WHERE id = ? AND status = 'completed'",
    ).run(failures, retryAt, row.id);
  }
}

/**
 * Lets every `completed` row owned by `pluginId` be tried on the next tick,
 * by clearing its wait. Called when that plugin's destination is saved,
 * because a new destination or shape is the operator's likely fix for a
 * refused import. `import_failures` is kept, so a row refused again resumes
 * its ladder where it was.
 *
 * Two literal statements, not one templated on `table`, for the same reason
 * `failUnconfirmed` above is: a table name is never interpolated here, even
 * from a caller-chosen literal array.
 */
export function clearImportWait(raw: DatabaseSync, pluginId: string): void {
  raw.prepare(`
    UPDATE torrent_download SET import_retry_at = NULL
     WHERE status = 'completed' AND import_retry_at IS NOT NULL
       AND rss_item_id IN (SELECT rss_item.id FROM rss_item JOIN rss_feed ON rss_feed.id = rss_item.feed_id
                            WHERE rss_feed.plugin_id = ?)
  `).run(pluginId);
  raw.prepare(`
    UPDATE nzb_download SET import_retry_at = NULL
     WHERE status = 'completed' AND import_retry_at IS NOT NULL
       AND rss_item_id IN (SELECT rss_item.id FROM rss_item JOIN rss_feed ON rss_feed.id = rss_item.feed_id
                            WHERE rss_feed.plugin_id = ?)
  `).run(pluginId);
}
