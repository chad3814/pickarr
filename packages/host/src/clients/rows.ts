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
 * `setProgress`, `setStoragePath` and `setAbsent` are observations, not
 * transitions: what a client reports about a download's progress, path or
 * presence is true regardless of which status the row happens to be in, so
 * these are keyed on `id` alone and never touch `status`. An observation
 * that quietly moved a row's state would be indistinguishable from a real
 * transition, and would defeat every guard above.
 */
import type { DatabaseSync } from 'node:sqlite';

export type DownloadStatus =
  'submitting' | 'submitted' | 'downloading' | 'completed' | 'delivered' | 'failed';

const DOWNLOAD_STATUSES: readonly DownloadStatus[] =
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
}

/**
 * The columns every read below needs, in one place: never `infohash`
 * (torrent-only, and no function here needs it), never `attempts` (dead in
 * this slice), and never `api_key`/`username`/`password` -- this module
 * touches only the two download tables, which do not have those columns.
 */
const SELECT_COLUMNS =
  'id, rss_item_id, download_client_id, client_ref, status, storage_path, absent_since, delivered_at';

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
  };
}

/** Every row on `clientId`, tagged with which table it came from. */
export function rowsForClient(raw: DatabaseSync, clientId: number): DownloadRow[] {
  const torrentRows = raw.prepare(
    `SELECT ${SELECT_COLUMNS} FROM torrent_download WHERE download_client_id = ?`,
  ).all(clientId).map((row) => toRow(row, 'torrent_download'));
  const nzbRows = raw.prepare(
    `SELECT ${SELECT_COLUMNS} FROM nzb_download WHERE download_client_id = ?`,
  ).all(clientId).map((row) => toRow(row, 'nzb_download'));
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

/** Records `row`'s current completion percentage. An observation: never touches `status`. */
export function setProgress(raw: DatabaseSync, row: DownloadRow, percentage: number, at: number): void {
  if (row.table === 'torrent_download') {
    raw.prepare('UPDATE torrent_download SET percentage = ?, updated_at = ? WHERE id = ?').run(percentage, at, row.id);
  } else {
    raw.prepare('UPDATE nzb_download SET percentage = ?, updated_at = ? WHERE id = ?').run(percentage, at, row.id);
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
