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
 * and the names of its secrets. `rss_feed` holds a feed's url, which for a
 * private tracker carries the passkey -- the same reason `selectSql` below
 * drops `rss_item.link`, and a url may not be copied into permanent client
 * storage at all. `jobs` is machinery a client has no use for, and so are
 * `host_migrations` (schema bookkeeping), `sync_log` (this mechanism's own
 * log) and `sqlite_sequence` (SQLite's, and present only because `sync_log`
 * is `AUTOINCREMENT`). `poster`, `background` and `logo` describe
 * files already reachable at `/api/artwork/:kind/:mediaItemId`, so a client
 * asks for the image and handles a 404 rather than replicating rows about
 * files it cannot read. `alias`, `external_reference` and `filepath_mapping`
 * have no consumer. `deleted_media_item` is slice E's tombstone table: the
 * log's delete ops supersede it, and it stays because `/api/deletions` still
 * serves it.
 *
 * **One consequence of that list, stated because a page does not hide
 * it.** `rss_item.feed_id` and `torrent_download`/`nzb_download`'s
 * `download_client_id` *are* projected below, and both name tables that are
 * out and will stay out. A client therefore receives ids it can never
 * resolve, by design. Dropping the two columns instead would be the
 * alternative; they are kept because a client grouping releases by feed or
 * downloads by client can do so by id without ever needing the row, and an
 * id is not a url.
 *
 * **This used to say `sync/backfill.ts` "claims page self-consistency only
 * for rows *within* the synced set", and that claim is retired.**
 * `backfill.ts` now says the opposite in its own docblock -- "an op may
 * reference a synced row the client has not received yet" -- because the walk
 * emits in log order rather than group order. Design spec §5.2 names the
 * earlier wording as false, and §7.8 pins the loss as a test. A client
 * already had to tolerate the two ids
 * above, which resolve to nothing *ever*; what the log walk additionally
 * costs is the ordering guarantee *inside* the synced set, where the
 * reference does resolve, just not yet.
 *
 * **A table being in this list is not a promise that every one of its
 * columns is projected.** `selectSql` below names the subset of each
 * included table that is safe to hand to a client at all -- see its own doc
 * for the columns left out and why.
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
 *
 * **Four columns that exist on these tables are deliberately not named
 * below, and each is named here so the next person to add a column sees the
 * rule rather than rediscovering it.** The binding constraint is that no
 * response body or log line carries a url, a path, a query string or a
 * credential (`packages/host/src/api/server.ts`'s module doc,
 * `CREDENTIAL_COLUMNS` in `scripts/check-test-hygiene.ts`) -- and a replica
 * is a stronger case than either. A response body exists for one request; a
 * row read here is written into IndexedDB and persists on every device that
 * ever syncs, for as long as that install exists, outliving a session, a
 * guard check or a decision to rotate a credential. Four columns fail that
 * bar even though two of them are already served, guarded, through an
 * existing endpoint:
 *
 * - **`torrent_download.storage_path` / `nzb_download.storage_path`** --
 *   the download client's own filesystem path for the file
 *   (`schema.ts`'s own comment: "the client's own path ... exactly as it
 *   reports it"). `api/reads.ts`'s `DOWNLOAD_COLUMNS`, the equivalent
 *   projection behind `/api/downloads`, already excludes it -- this module
 *   is what would have been the one place that regressed the rule the file
 *   next door already follows.
 * - **`rss_item.link`** -- for a private tracker or indexer this *is* a
 *   credential: `server.ts`'s module doc says plainly that it "carries the
 *   passkey". `/api/rss-items` serves `RssItemRead.link` unredacted today,
 *   behind the session guard, and that precedent is real -- but a guard
 *   bounds who can ask, once, for the duration of a request, and says
 *   nothing about a copy sitting in a browser's storage indefinitely.
 *   Nothing in slice 2 reads this projection yet, and the browse view it
 *   backs needs a title, artwork and a release list, not a download url --
 *   so excluding it now is free and reversible. A future slice that
 *   actually needs to submit a pick from the client is the place to decide
 *   this again, with that need in front of it.
 * - **`rss_item.guid`** -- not served anywhere today (`RssItemRead` in
 *   `@pickarr/contract` has no `guid` field at all, so there is no existing
 *   precedent to weigh here), and riskier than it looks: `feeds/parse-rss.ts`
 *   sets `guid = textOf(item['guid']) ?? link` -- so a feed that omits its
 *   own `<guid>` element gives this column *the same passkey-bearing url as
 *   `link`*, under a different name. Excluding `link` and keeping `guid`
 *   would have reopened exactly the hole this module doc otherwise closes.
 * - **`torrent_download.last_error` / `nzb_download.last_error`** -- free
 *   text from qBittorrent or SABnzbd, redacted only for the one shape
 *   `clients/redact.ts`'s `redactUrl` knows: a `?apikey=` query parameter.
 *   It strips a credential's *value* and leaves the url around it --
 *   `clients/downloads.ts` and `clients/reconcile.ts` both write through it
 *   before this column, so what lands here is redacted-of-credential, not
 *   redacted-of-url-or-path. `DownloadRead.lastError` is served through
 *   `/api/downloads` today on that basis, which is a defensible call for a
 *   guarded, per-request response; it is not a defensible call for a value
 *   copied into permanent client storage, which is why this projection
 *   parts ways with that precedent the same way it does for `link`.
 */
function selectSql(table: string, placeholders: string): string | undefined {
  switch (table) {
    case 'media_item':
      return `SELECT id, plugin_id, created_at, updated_at, provider, provider_ref, title, release_date, description
                 FROM media_item WHERE id IN (${placeholders})`;
    case 'rss_item':
      return `SELECT id, feed_id, filename, created_at, updated_at, download_type, media_item_id,
                      ranking_score, resolution, resolution_detail, delivered_at
                 FROM rss_item WHERE id IN (${placeholders})`;
    case 'torrent_download':
      return `SELECT id, rss_item_id, download_client_id, infohash, client_ref, status, attempts,
                      created_at, updated_at, percentage, absent_since, delivered_at, reclaimed_at
                 FROM torrent_download WHERE id IN (${placeholders})`;
    case 'nzb_download':
      return `SELECT id, rss_item_id, download_client_id, client_ref, status, attempts,
                      created_at, updated_at, percentage, absent_since, delivered_at, reclaimed_at
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
