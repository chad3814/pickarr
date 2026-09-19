import type { DatabaseSync } from 'node:sqlite';
import { redactUrl } from '../clients/redact.ts';

/**
 * The host's own tables that a client replicates, and the reason each of the
 * others is absent.
 *
 * **In:** the group (`media_item`), the releases under it (`rss_item`), what
 * was submitted for them (`torrent_download`, `nzb_download`), who is in them
 * (`person`, `role`), and the feeds that produce the releases (`rss_feed`).
 * `rss_feed` is not a `SELECT` like the other six -- see the paragraph below
 * that explains why it joined this list, and `readHostRows`'s own doc for
 * the extra step its row takes.
 *
 * **Out, and why:** `auth_user`, `auth_session`, `auth_account`,
 * `auth_verification`, `host_state` and `secret` hold credentials, and no
 * credential leaves this process. `download_client` holds a service's address
 * and the names of its secrets. `jobs` is machinery a client has no use for,
 * and so are `host_migrations` (schema bookkeeping), `sync_log` (this
 * mechanism's own log) and `sqlite_sequence` (SQLite's, and present only
 * because `sync_log` is `AUTOINCREMENT`). `poster`, `background` and `logo`
 * describe files already reachable at `/api/artwork/:kind/:mediaItemId`, so a
 * client asks for the image and handles a 404 rather than replicating rows
 * about files it cannot read. `alias`, `external_reference` and
 * `filepath_mapping` have no consumer. `deleted_media_item` is slice E's
 * tombstone table: the log's delete ops supersede it, and it stays because
 * `/api/deletions` still serves it.
 *
 * **`rss_feed` used to be out on a rule with no exception, and that rule is
 * amended here, deliberately.** This docblock used to say a feed's url "may
 * not be copied into permanent client storage at all" -- the same reason
 * `selectSql` below still drops `rss_item.link`, because for a private
 * tracker or indexer the url can carry the passkey. That is still true of
 * the raw url. What changed is that the operator needs to tell two feeds
 * apart in a settings screen that a name alone cannot always do, so the url
 * now travels **redacted**: `readHostRows` calls `clients/redact.ts`'s
 * `redactUrl` on it, after the `SELECT` runs and before the row is handed
 * back. That makes `rss_feed` the first synced table whose projection is not
 * purely SQL -- every other `case` below is the whole of that table's
 * transformation, and this one is not.
 *
 * **The redaction is narrower than the rule it replaces, and the gap is
 * recorded rather than hidden.** `redactUrl` knows exactly one credential
 * shape, a `?apikey=` query parameter -- the only one anything in this
 * codebase has ever had to send. `?passkey=`, `?token=` and a passkey
 * embedded as a path segment (`/announce/SECRET/`) all pass through
 * **unchanged**, and the path-segment case is undetectable in principle:
 * nothing about a string distinguishes a secret segment from a category
 * slug. So a private tracker's passkey can reach the replica today, and a
 * replica is permanent storage on every device that ever syncs, unlike a
 * response body reachable only for the life of a request. Issue #78 tracks
 * broadening `redactUrl`; `test/sync/tables.test.ts` pins the gap itself
 * with a `?passkey=` url asserted, deliberately, to survive unredacted --
 * so #78 closing it is a test failure there, not a silent change.
 *
 * **One consequence of that list, stated because a page does not hide
 * it.** `torrent_download`/`nzb_download`'s `download_client_id` *is*
 * projected below and names a table that is out and will stay out: a
 * `download_client` row holds a service's address and the names of its
 * secrets, so a client receives an id it can never resolve, by design.
 * `rss_item.feed_id` used to be the other half of this paragraph; it no
 * longer is, because the table it names joined the synced set above and a
 * client can now resolve it. Dropping `download_client_id` instead of
 * projecting it would be the alternative; it is kept because a client
 * grouping downloads by client can do so by id without ever needing the row,
 * and an id is not a url.
 *
 * **This used to say `sync/backfill.ts` "claims page self-consistency only
 * for rows *within* the synced set", and that claim is retired.**
 * `backfill.ts` now says the opposite in its own docblock -- "an op may
 * reference a synced row the client has not received yet" -- because the walk
 * emits in log order rather than group order. Design spec §5.2 names the
 * earlier wording as false, and §7.8 pins the loss as a test. A client
 * already had to tolerate the `download_client_id` above, which resolves to
 * nothing *ever*; what the log walk additionally costs is the ordering
 * guarantee *inside* the synced set, where a reference does resolve, just
 * not yet.
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
  'rss_feed',
];

/**
 * One `SELECT ... FROM <table>` per host synced table, every column named
 * explicitly, **every multi-word column aliased to camelCase**, and the table
 * spelled as a literal rather than assembled from a variable -- never
 * `SELECT *`, and never `FROM ${table}`.
 *
 * **Those last two are load-bearing, and for different reasons.** A star
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
 * Seven short, literal, unremarkable `SELECT`s cost less than that entry
 * would.
 *
 * **The aliases are the wire's naming convention, and they exist for one
 * concrete reason.** A column name reaches a client verbatim: `readHostRows`
 * spreads the row `node:sqlite` hands back, and the result is serialised as
 * an op's `value` with no mapping step anywhere between. Unaliased, these
 * seven tables spoke snake_case while all six plugin read shapes
 * (`packages/contract/src/sync.ts`) speak camelCase, so the same logical
 * field was `media_item_id` on three host tables and `mediaItemId` on three
 * plugin ones. The client's storage provider is designed (and not yet
 * written) as one IndexedDB object store keyed `['table', 'id']`, with sparse
 * indexes on `value.mediaItemId` and `value.rssItemId`; an index key path is
 * a single string for every row in the store, so under two spellings "the
 * media item this row belongs to" could not be one index at all. Aliasing here rather than mapping in JavaScript keeps this
 * module the one statement of what a host row looks like on the wire; the
 * plugins map by hand because each of theirs joins and renames anyway.
 *
 * `id` needs no alias and gets none: it is already camelCase, and it is the
 * key `readHostRows` reads the row back out under -- see its doc.
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
 *
 * **`rss_feed.url` is named below, not omitted, and it is the odd one out
 * of this list rather than a fifth entry on it.** Every column above fails
 * the "no url in permanent storage" bar and stays out entirely; this one
 * fails the same bar and is let through anyway, because it is transformed
 * first -- `readHostRows` redacts it after this `SELECT` runs. See this
 * file's top docblock for why that call was judged to clear the bar, and
 * for the gap between what it actually redacts and what a passkey can look
 * like.
 */
function selectSql(table: string, placeholders: string): string | undefined {
  switch (table) {
    case 'media_item':
      return `SELECT id, plugin_id AS pluginId, created_at AS createdAt, updated_at AS updatedAt,
                      provider, provider_ref AS providerRef, title,
                      release_date AS releaseDate, description
                 FROM media_item WHERE id IN (${placeholders})`;
    case 'rss_item':
      return `SELECT id, feed_id AS feedId, filename, created_at AS createdAt,
                      updated_at AS updatedAt, download_type AS downloadType,
                      media_item_id AS mediaItemId, ranking_score AS rankingScore, resolution,
                      resolution_detail AS resolutionDetail, delivered_at AS deliveredAt
                 FROM rss_item WHERE id IN (${placeholders})`;
    case 'torrent_download':
      return `SELECT id, rss_item_id AS rssItemId, download_client_id AS downloadClientId,
                      infohash, client_ref AS clientRef, status, attempts,
                      created_at AS createdAt, updated_at AS updatedAt, percentage,
                      absent_since AS absentSince, delivered_at AS deliveredAt,
                      reclaimed_at AS reclaimedAt
                 FROM torrent_download WHERE id IN (${placeholders})`;
    case 'nzb_download':
      return `SELECT id, rss_item_id AS rssItemId, download_client_id AS downloadClientId,
                      client_ref AS clientRef, status, attempts,
                      created_at AS createdAt, updated_at AS updatedAt, percentage,
                      absent_since AS absentSince, delivered_at AS deliveredAt,
                      reclaimed_at AS reclaimedAt
                 FROM nzb_download WHERE id IN (${placeholders})`;
    case 'person':
      return `SELECT id, name, provider_ref AS providerRef,
                      created_at AS createdAt, updated_at AS updatedAt
                 FROM person WHERE id IN (${placeholders})`;
    case 'role':
      return `SELECT id, media_item_id AS mediaItemId, person_id AS personId, role, name,
                      billing_order AS billingOrder, created_at AS createdAt
                 FROM role WHERE id IN (${placeholders})`;
    case 'rss_feed':
      // `url` travels unaliased and unredacted out of this `SELECT` -- the
      // redaction is `readHostRows`'s job, after this statement runs. See
      // this file's top docblock and the "odd one out" note above.
      return `SELECT id, plugin_id AS pluginId, name, download_type AS downloadType,
                      poll_interval_s AS pollIntervalS, download_client_id AS downloadClientId,
                      created_at AS createdAt, updated_at AS updatedAt, url
                 FROM rss_feed WHERE id IN (${placeholders})`;
    default:
      return undefined;
  }
}

/**
 * Reads the current state of `ids` from `table`, projected to that table's
 * declared columns (`selectSql` above), keyed by row id.
 *
 * **The key survives the aliasing because `id` is the one column not
 * aliased.** This reads `row.id`, which is the result-column name, not the
 * table's -- so an `id AS something` in `selectSql` would read `undefined`,
 * and `Number(undefined)` is `NaN`: measured, a page of two rows collapses
 * to `{"NaN": <the last row>}`, values intact and every key gone. `id` is
 * already camelCase, so there is nothing to rename and nothing to keep in
 * step.
 *
 * An empty `ids` never reaches SQLite at all: the backfill and the tail both
 * call this with whatever ids one page of `sync_log` names, and an empty page
 * is a normal outcome of that walk rather than a case worth a round trip --
 * so this returns `{}` before ever touching `raw`.
 *
 * `table` decides *which* of `selectSql`'s seven literal statements runs; it
 * never reaches SQL text itself. A name outside `HOST_SYNCED_TABLES` throws
 * rather than reading `undefined` columns or silently returning nothing.
 *
 * **`rss_feed` gets one extra step after the row comes back, and every other
 * table gets none.** Its `url` column is redacted here, by
 * `clients/redact.ts`'s `redactUrl`, on the spread copy this function
 * already makes -- not in `selectSql`, which cannot run JavaScript, and not
 * in storage, which would make the raw url unrecoverable for a future slice
 * that redacts better. This is the one place the wire's content is not
 * simply what the `SELECT` returned; see this file's top docblock for why
 * that is judged acceptable and what `redactUrl` does not yet catch.
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
    const projected: Record<string, unknown> = { ...row };
    // The one non-SQL step in this function -- see the docblock above. Only
    // `rss_feed` has a `url` column projected at all, and `typeof` (rather
    // than a cast) is what lets this stay safe if that ever stops being true.
    if (table === 'rss_feed' && typeof projected.url === 'string') {
      projected.url = redactUrl(projected.url);
    }
    result[id] = projected;
  }
  return result;
}
