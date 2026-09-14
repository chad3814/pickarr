import type { DatabaseSync } from 'node:sqlite';

/**
 * The host's own tables that a client replicates, and the reason each of the
 * others is absent.
 *
 * **In:** the group (`media_item`), the releases under it (`rss_item`), what
 * was submitted for them (`torrent_download`, `nzb_download`), and who is in
 * them (`person`, `role`).
 *
 * **Out, and why:** `auth_user`, `auth_session`, `auth_account`,
 * `auth_verification`, `host_state` and `secret` hold credentials, and no
 * credential leaves this process. `download_client` holds a service's address
 * and the names of its secrets. `jobs` is machinery a client has no use for.
 * `poster`, `background` and `logo` describe files already reachable at
 * `/api/artwork/:kind/:mediaItemId`, so a client asks for the image and
 * handles a 404 rather than replicating rows about files it cannot read.
 * `alias`, `external_reference` and `filepath_mapping` have no consumer.
 * `deleted_media_item` is slice E's tombstone table: the log's delete ops
 * supersede it, and it stays because `/api/deletions` still serves it.
 */
export const HOST_SYNCED_TABLES: readonly string[] = [
  'media_item',
  'rss_item',
  'torrent_download',
  'nzb_download',
  'person',
  'role',
];

/**
 * One `SELECT ... FROM <table>` per host synced table, every column named
 * explicitly and the table spelled as a literal rather than assembled from a
 * variable -- never `SELECT *`, and never `FROM ${table}`.
 *
 * Both halves of that are load-bearing, and for different reasons. A star
 * reads whatever the table happens to hold today, including a column added
 * tomorrow for a reason that has nothing to do with a client; naming every
 * column is what keeps that addition from reaching a client until someone
 * decides it belongs here too. Spelling the table literally, once per branch
 * below, is what `scripts/check-test-hygiene.ts` needs to see this as a read
 * of a *named*, non-credential table rather than of an unresolved one --
 * building the `FROM` clause from `table` directly, the way `syncTriggerSql`
 * builds its `ON ${table}` (safe there because it never reads a column),
 * makes this check fail closed and demand `CREDENTIAL_ALLOW_LIST` grow a
 * third entry, which the project's global constraints fix at exactly two.
 * Six short, literal, unremarkable `SELECT`s cost less than that entry would.
 */
function selectSql(table: string, placeholders: string): string | undefined {
  switch (table) {
    case 'media_item':
      return `SELECT id, plugin_id, created_at, updated_at, provider, provider_ref, title, release_date, description
                 FROM media_item WHERE id IN (${placeholders})`;
    case 'rss_item':
      return `SELECT id, feed_id, filename, link, created_at, updated_at, download_type, media_item_id,
                      ranking_score, resolution, resolution_detail, guid, delivered_at
                 FROM rss_item WHERE id IN (${placeholders})`;
    case 'torrent_download':
      return `SELECT id, rss_item_id, download_client_id, infohash, client_ref, status, attempts, last_error,
                      created_at, updated_at, storage_path, percentage, absent_since, delivered_at, reclaimed_at
                 FROM torrent_download WHERE id IN (${placeholders})`;
    case 'nzb_download':
      return `SELECT id, rss_item_id, download_client_id, client_ref, status, attempts, last_error,
                      created_at, updated_at, storage_path, percentage, absent_since, delivered_at, reclaimed_at
                 FROM nzb_download WHERE id IN (${placeholders})`;
    case 'person':
      return `SELECT id, name, provider_ref, created_at, updated_at
                 FROM person WHERE id IN (${placeholders})`;
    case 'role':
      return `SELECT id, media_item_id, person_id, role, name, billing_order, created_at
                 FROM role WHERE id IN (${placeholders})`;
    default:
      return undefined;
  }
}

/**
 * Reads the current state of `ids` from `table`, projected to that table's
 * declared columns (`selectSql` above), keyed by row id.
 *
 * An empty `ids` never reaches SQLite at all: the backfill and the tail both
 * call this with whatever ids one page of `sync_log` names, and an empty page
 * is a normal outcome of that walk rather than a case worth a round trip --
 * so this returns `{}` before ever touching `raw`.
 *
 * `table` decides *which* of `selectSql`'s six literal statements runs; it
 * never reaches SQL text itself. A name outside `HOST_SYNCED_TABLES` throws
 * rather than reading `undefined` columns or silently returning nothing.
 */
export function readHostRows(
  raw: DatabaseSync,
  table: string,
  ids: readonly number[],
): Record<number, unknown> {
  if (ids.length === 0) return {};

  const placeholders = ids.map(() => '?').join(', ');
  const sql = selectSql(table, placeholders);
  if (sql === undefined) {
    throw new Error(`readHostRows: ${table} is not a host synced table`);
  }

  const rows = raw.prepare(sql).all(...ids);

  const result: Record<number, unknown> = {};
  for (const row of rows) {
    const id = Number((row as { id: unknown }).id);
    // Spread rather than pass the row through: `node:sqlite` hands back a
    // null-prototype object, and this is the boundary where that stops being
    // an implementation detail a caller has to know about.
    result[id] = { ...row };
  }
  return result;
}
