import type { DatabaseSync } from 'node:sqlite';
import { redactUrl } from '../clients/redact.ts';

/**
 * The host's own tables that a client replicates, and the reason each of the
 * others is absent.
 *
 * **In:** the group (`media_item`), the releases under it (`rss_item`), what
 * was submitted for them (`torrent_download`, `nzb_download`), who is in them
 * (`person`, `role`), the feeds that produce the releases (`rss_feed`), the
 * clients those releases are submitted to (`download_client`), and the path
 * translations configured under each client (`filepath_mapping`).
 * `rss_feed` and `download_client` are the only two whose projection is not
 * purely a `SELECT` -- see the paragraphs below on why each joined this
 * list, and `readHostRows`'s own doc for the extra step each of their rows
 * takes.
 *
 * **Out, and why:** `auth_user`, `auth_session`, `auth_account`,
 * `auth_verification`, `host_state` and `secret` hold credentials, and no
 * credential leaves this process. `jobs` is machinery a client has no use for,
 * and so are `host_migrations` (schema bookkeeping), `sync_log` (this
 * mechanism's own log) and `sqlite_sequence` (SQLite's, and present only
 * because `sync_log` is `AUTOINCREMENT`). `poster`, `background` and `logo`
 * describe files already reachable at `/api/artwork/:kind/:mediaItemId`,
 * and `person_image` files reachable at `/api/artwork/person/:personId` --
 * the same route and the same handler, a different `:kind`, over a
 * different id space. `api/artwork-route.ts`'s own docblock is where that
 * decision is written down: `person` is "one more entry" in
 * `ArtworkKind`/`ARTWORK_QUERY`, not a parallel handler, and the id in
 * that second segment is a person id for it and a media item id for the
 * other three. Spelled out here because a sentence that named only
 * `:mediaItemId` for all four conflated two id spaces this branch is
 * otherwise careful to keep apart. Either way a client asks for the image
 * and handles a 404 rather than replicating rows about files it cannot
 * read.
 * `alias` and `external_reference` have no
 * consumer. `deleted_media_item` is slice E's
 * tombstone table: the log's delete ops supersede it, and it stays because
 * `/api/deletions` still serves it.
 *
 * **This sentence used to name `filepath_mapping` as a third table with no
 * consumer, and that had been false for two slices before this one struck
 * it.** `clients/deliver.ts` has applied `clients/paths.ts`'s
 * `mapClientPath` on every delivery tick since the reconcile slice landed,
 * so the table had a consumer well before it had a writer; the line stayed
 * because nothing in this file reads it and nothing fails when a reason
 * goes stale. Recorded rather than quietly deleted, because the class of
 * defect -- a justification that was true when written -- is the one this
 * codebase keeps finding.
 *
 * **`rss_feed` used to be out on a rule with no exception, and that rule is
 * amended here, deliberately.** This docblock used to say a feed's url "may
 * not be copied into permanent client storage at all" -- the same reason
 * `selectSql` below still drops `rss_item.link`, because for a private
 * tracker or indexer the url can carry the passkey. That is still true of
 * the raw url. What changed is that the operator needs to tell two feeds
 * apart in a settings screen that a name alone cannot always do, so the url
 * now travels **redacted**: `readHostRows` calls `clients/redact.ts`'s
 * `redactText` on it, after the `SELECT` runs and before the row is handed
 * back. That makes `rss_feed` the first synced table whose projection is not
 * purely SQL -- every other `case` below is the whole of that table's
 * transformation, and this one is not.
 *
 * **The redaction is narrower than a raw url deserves, and what it now
 * reaches is recorded rather than assumed (issue #78, closed).** It ran on
 * one credential *name*, `?apikey=`, and `?passkey=`, `?token=` and a
 * path-embedded passkey all passed through unchanged. `redactSecrets` adds
 * two rules about what a credential *looks like* -- a run of 8+ hex in one
 * case, or 8+ alphanumerics carrying two uppercase, two lowercase and two
 * digits -- and both reach the path case, which no list of names could.
 * Measured on a realistic 32-hex passkey:
 * `?passkey=9f8e…` and `/announce/9f8e…/` both mask to `9f8*****`, while
 * `/category/tv-shows/` is untouched. (The three surviving characters are
 * deliberate and recent -- see `redactSecrets` for why a shape match keeps
 * a prefix where a name match does not. This line read `*****` before
 * that, and a projection test pins the current spelling.)
 *
 * **This paragraph used to argue the path case was undetectable in
 * principle** -- "nothing about a string distinguishes a secret segment
 * from a category slug". That is true of a name rule and false of a shape
 * rule, and the two feeds asserted side by side in
 * `test/sync/tables.test.ts` are what show the difference is real
 * discrimination rather than blanket masking.
 *
 * **What still passes.** A credential under eight characters, and one with
 * neither hex shape nor case mixture -- the userinfo case two paragraphs
 * down is exactly that. A shape rule is a filter, and a filter has a far
 * side.
 *
 * **`download_client` was out on the credential rule until this slice, and
 * that clause is amended rather than struck.** The "out" list above used to
 * read, immediately after the six credential tables, "`download_client`
 * holds a service's address and the names of its secrets." Both halves of
 * that are still true *of the row*. What changed is that neither half has to
 * reach a client for the settings screen to list one (design spec §5), so
 * the projection carries neither:
 *
 * - **The secret names are not projected at all.** `api_key_secret_name`
 *   and `password_secret_name` are simply absent from the `case` below.
 *   Neither is a credential -- the value lives in `secret`, and a secret
 *   name is safe to log by this codebase's own rule -- but a name is the
 *   layout of the secret store, and a browser has no use for it.
 * - **The url is rebuilt rather than filtered.** `readHostRows` projects
 *   `origin + pathname`. Userinfo, query and fragment are gone
 *   *structurally*: nothing recognises and removes them, they are simply
 *   not among the two parts the projected value is assembled from.
 *
 * **That second guarantee is still stronger than `rss_feed`'s, and the
 * difference is the whole reason this table could join the list when that
 * clause said it never would -- but the gap between them narrowed when #78
 * closed, so the old contrast is restated rather than repeated.** This
 * paragraph used to say `redactUrl` "does not touch userinfo at all", and
 * that `http://user:hunter2@qbit:8080` reached the replica credential
 * included. It no longer does: `redactUrl` parses the url and masks
 * `password`, so that address arrives as `http://user:*****@qbit:8080`.
 * `test/clients/redact-url.test.ts` constructs it rather than trusting
 * this sentence.
 *
 * **What keeps the two guarantees different is the kind of thing they
 * are.** `rss_feed.url` is *filtered*: three rules run over it, and a
 * credential that matches none of them survives -- `hunter2` in a query
 * parameter named `q` would. `download_client.url` is *rebuilt* from
 * origin and pathname, so anything that is not host, port and base path is
 * absent structurally, with nothing to recognise and nothing to miss. A
 * closed door still beats a good filter.
 *
 * The reason feeds get the filter and clients get the door is unchanged: a
 * tracker's passkey is genuinely part of the path or query it is sent in,
 * so dropping those would leave a url that no longer reaches the feed; a
 * download client's address is host, port and base path, and nothing else
 * is part of its identity, so nothing is lost by keeping only those.
 *
 * **A url that is not an http(s) address projects as `''`, and the row
 * reaches the replica anyway.** A deliberate choice between three
 * behaviours, not an oversight, so the two rejected ones are named.
 *
 * *Throwing* would fail the whole page `readHostRows` was called for.
 * Nothing between here and the route recovers part of it -- `sync/entries.ts`
 * calls `readRows` bare, once per table -- so the throw travels to
 * `api/server.ts`'s outermost handler, which answers `500 { error: 'read
 * failed' }` for the whole request. One malformed row would therefore take
 * every unrelated table's rows in that page with it, on that request and on
 * every retry, since the row does not change: a client stuck at its cursor
 * with no way to pass the row and nothing telling it which row. And that
 * handler logs `redactText(messageOf(error))` -- so a thrown message quoting
 * the url would put a userinfo credential in a log line, since `redactText`
 * is exactly the function that does not catch that shape. Throwing here
 * would reopen, in the log, the hole this projection closes on the wire.
 *
 * *Omitting the row* would make it vanish from the replica with nothing
 * saying so, and a vanished client is worse than an addressless one:
 * `torrent_download.downloadClientId` names it, so a client would be back to
 * holding downloads that point at a row it will never receive -- the exact
 * state this slice ends.
 *
 * `''` keeps the row, keeps every other field, and says "no address" in the
 * one field that has none. The production writer refuses such a url anyway
 * (`clients/add.ts`'s `isClientAddress`), so this is defence against a row
 * that arrived another way: a migration, or an operator's own SQL.
 *
 * `''` rather than a marker like `(unusable address)` because **the client
 * owns every sentence a human reads** (design spec §3): a marker would put
 * host-authored English into a field the contract types as a url, and every
 * client would then have to know to special-case that one string.
 *
 * **Nothing is logged when it fires.** That is a real cost and it is
 * accepted rather than overlooked: the only diagnostic worth writing is the
 * url, and no log line in this process may carry one (`api/server.ts`'s
 * module doc). The blank address in the settings list is the signal.
 *
 * **"It parses" is not the test, and that was measured.**
 * `URL.parse('qbit.example:8080')` -- what omitting `http://` produces,
 * which is the likeliest way to get this field wrong -- does *not* answer
 * null. It parses as scheme `qbit.example:` with the opaque path `8080`,
 * giving `hostname: ''` and `origin` serialised as the literal string
 * `'null'`, so `origin + pathname` over it is the eight-character
 * address `null8080`. The guard below is therefore on the protocol, which is what
 * makes a host mandatory. `clients/add.ts` refuses the same input at the
 * writer, on the same measurement.
 *
 * **This paragraph used to name the ids a client receives and can never
 * resolve, and there are none left.** `rss_item.feed_id` was the first to
 * stop being one, when `rss_feed` joined the list above.
 * `torrent_download`/`nzb_download`/`rss_feed`'s `download_client_id` was
 * the second, and the harder one to retire: it was argued here not merely as
 * unresolved but as unresolvable, on the reasoning that the row it names
 * "holds a service's address and the names of its secrets" and so would
 * never be synced. The paragraphs above are where that reasoning was
 * answered rather than waived. Both ids are now ordinary references into
 * tables the client holds. The alternative, considered twice and rejected
 * twice, was to drop the column from the projection; it was kept both times
 * because a client grouping downloads by client can do so by id without the
 * row, and an id is not a url -- which is now the lesser of its two reasons
 * rather than the whole of them.
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
 * **`filepath_mapping` is the ninth, and it carries two filesystem paths to
 * the replica on a distinction, not on an exception.** `selectSql`'s doc
 * below refuses `storage_path` and this file does not weaken that: the rule
 * is that this host does not leak filesystem structure a client never asked
 * about. A `storage_path` is **discovered** -- the download client reports
 * where it happened to put a file, disclosing a layout nobody chose to
 * disclose. A mapping is **dictated**: both `from_path` and `to_path` are
 * strings the operator typed into the settings screen, and reading them
 * back is showing someone their own input. A settings UI that cannot
 * display the setting is not a settings UI. Design spec §5 states the
 * distinction so it can be argued with; the `storagePath` rule in
 * `packages/contract/src/sync.ts` stands exactly as written.
 *
 * The projection is six columns and the whole row: `filepath_mapping` has
 * nothing else in it, so there is no seventh thing this table knows that a
 * client is being spared. That is worth saying because the two paragraphs
 * above are each about a column decided over -- one held back, one let
 * through transformed -- and there is no such decision here. It is not the
 * first whole-row projection, though: `media_item`, `person`, `role` and
 * `rss_feed` all project every column of their table too, counted against
 * `PRAGMA table_info` in `packages/contract/src/sync.ts`'s
 * `FilepathMappingSyncRead`.
 *
 * **`plugin_destination` is the tenth, and it carries a third path on the
 * same distinction rather than on a second exception.** A `root` is
 * *dictated* -- the operator types it into the settings screen this
 * projection feeds -- exactly as a mapping's two paths are, so the
 * `storage_path` rule below is untouched again. The other two columns are
 * operator input too and neither is a resolved path: `shape` is a template
 * of `{token}`s and `unmatched_dir` is a literal directory name relative to
 * the root (design spec §3, §6). Seven columns and the whole row, like
 * `filepath_mapping` -- the table holds nothing a client is being spared.
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
  'download_client',
  'filepath_mapping',
  'plugin_destination',
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
 * Ten short, literal, unremarkable `SELECT`s cost less than that entry
 * would.
 *
 * **The aliases are the wire's naming convention, and they exist for one
 * concrete reason.** A column name reaches a client verbatim: `readHostRows`
 * spreads the row `node:sqlite` hands back, and the result is serialised as
 * an op's `value` with no mapping step anywhere between. Unaliased, these
 * ten tables would speak snake_case while all six plugin read shapes
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
 *   next door already follows. **`filepath_mapping` projecting two paths
 *   does not soften this entry**, and the two cases are worth reading
 *   together: this path is one the client *discovered* and reported, and
 *   those are two the operator *dictated* and is owed a sight of. The top
 *   docblock has the distinction in full.
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
 *   text from qBittorrent or SABnzbd, redacted for the `?apikey=` name and
 *   -- since issue #78 -- for anything credential-*shaped* anywhere in it.
 *   It strips a credential's *value* and leaves the url around it --
 *   `clients/downloads.ts` and `clients/reconcile.ts` both write through it
 *   before this column, so what lands here is redacted-of-credential, not
 *   redacted-of-url-or-path. `DownloadRead.lastError` is served through
 *   `/api/downloads` today on that basis, which is a defensible call for a
 *   guarded, per-request response; it is not a defensible call for a value
 *   copied into permanent client storage, which is why this projection
 *   parts ways with that precedent the same way it does for `link`.
 *
 * **`rss_feed.url` and `download_client.url` are named below, not omitted,
 * and they are the odd ones out of this list rather than a fifth and sixth
 * entry on it.** Every column above fails the "no url in permanent storage"
 * bar and stays out entirely; these two fail the same bar and are let
 * through anyway, because each is transformed after this `SELECT` runs --
 * the feed's redacted, the client's rebuilt from its origin and path. See
 * this file's top docblock for why each was judged to clear the bar, for
 * what `redactText` reaches now that #78 has closed and what it still does
 * not, and for why the two are not the same guarantee.
 *
 * **`download_client`'s two secret-name columns are a fifth and sixth
 * omission, and they are omitted for a different reason from the four
 * above.** `api_key_secret_name` and `password_secret_name` do not fail the
 * url-or-credential bar at all -- a secret name is neither, and this
 * codebase logs one freely. They are left out because a browser has no use
 * for the secret store's layout, which is a smaller reason and a sufficient
 * one. Naming them here is what keeps someone adding them back on the
 * correct observation that they are not credentials.
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
                      media_item_id AS mediaItemId, ranking_score AS rankingScore,
                      lookup_state AS lookupState, lookup_state_detail AS lookupStateDetail,
                      delivered_at AS deliveredAt, lookup_json AS lookupJson
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
                      created_at AS createdAt, updated_at AS updatedAt, url,
                      disabled_at AS disabledAt
                 FROM rss_feed WHERE id IN (${placeholders})`;
    case 'filepath_mapping':
      // Two filesystem paths, projected on purpose -- the one place in this
      // function that does what `selectSql`'s doc above otherwise refuses.
      // Both are operator input rather than client-reported layout; see the
      // file's top docblock, and design spec §5 for the argument.
      return `SELECT id, download_client_id AS downloadClientId, from_path AS fromPath,
                      to_path AS toPath, created_at AS createdAt, updated_at AS updatedAt
                 FROM filepath_mapping WHERE id IN (${placeholders})`;
    case 'plugin_destination':
      // A third filesystem path, projected on the same distinction
      // `filepath_mapping` above is: a `root` is dictated by the operator,
      // not discovered from a client. Design spec §3, and the file's top
      // docblock. `shape` and `unmatched_dir` are operator input too, and
      // neither is a path this host has resolved -- a shape is a template
      // and the unmatched directory is a literal name relative to the root.
      return `SELECT id, plugin_id AS pluginId, root, shape,
                      unmatched_dir AS unmatchedDir,
                      created_at AS createdAt, updated_at AS updatedAt
                 FROM plugin_destination WHERE id IN (${placeholders})`;
    case 'download_client':
      // `url` travels raw out of this `SELECT` and is rebuilt by
      // `readHostRows`, the same division of labour `rss_feed` above uses
      // for its redaction. The two secret-name columns are absent on
      // purpose; see this function's doc and the file's top docblock.
      return `SELECT id, name, type, implementation, url, username, category,
                      created_at AS createdAt, updated_at AS updatedAt
                 FROM download_client WHERE id IN (${placeholders})`;
    default:
      return undefined;
  }
}

/**
 * The schemes a download client's address can use, and so the schemes
 * `clientAddress` below will build an address out of.
 *
 * The same set, for the same measured reason, as `clients/add.ts`'s
 * `CLIENT_URL_PROTOCOLS`. Not imported from there: that constant is the
 * *writer's* rule about what it will accept, and this one is the
 * *projection's* rule about what it can render. Sharing them would make a
 * future loosening of the writer silently loosen the wire, which is the
 * direction that matters. Both files record the distinction:
 * `isClientAddress`'s doc names this projection as "a different job with a
 * different reason", and this is that job.
 */
const PROJECTABLE_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * A download client's address as a replica may hold it: `origin + pathname`,
 * or `''` when the column holds something that is not an http(s) address.
 *
 * See this file's top docblock for the whole of the reasoning -- why the
 * rebuild is structural rather than a redaction, why the empty string rather
 * than a throw, a dropped row or a human-readable marker, and why the guard
 * is on the protocol rather than on `URL.parse` answering non-null.
 *
 * `URL.parse` rather than `new URL` in a `try`, for `clients/add.ts`'s
 * reason: it answers `null` instead of throwing, so there is no caught error
 * here whose message -- which would quote the url -- could escape into a log.
 */
function clientAddress(url: string): string {
  const parsed = URL.parse(url);
  if (parsed === null || !PROJECTABLE_URL_PROTOCOLS.has(parsed.protocol)) return '';
  return `${parsed.origin}${parsed.pathname}`;
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
 * `table` decides *which* of `selectSql`'s ten literal statements runs; it
 * never reaches SQL text itself. A name outside `HOST_SYNCED_TABLES` throws
 * rather than reading `undefined` columns or silently returning nothing.
 *
 * **Two tables get one extra step after the row comes back, and the other
 * seven get none.** `rss_feed`'s `url` is redacted by `clients/redact.ts`'s
 * `redactText`; `download_client`'s is rebuilt from its origin and path by
 * `clientAddress`. Both happen on the spread copy this function already
 * makes -- not in `selectSql`, which cannot run JavaScript, and not in
 * storage, which would make the raw url unrecoverable, for a future slice
 * that redacts better in the feed's case and for the adapter that has to
 * dial the thing in the client's. These are the only two places the wire's
 * content is not simply what the `SELECT` returned; see this file's top
 * docblock for why each was judged acceptable, what `redactText` does not yet
 * catch, and why the two are deliberately not the same transformation.
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
    // The two non-SQL steps in this function -- see the docblock above. Each
    // is keyed on its own table and narrowed with `typeof` rather than a
    // cast, which is what lets both stay safe if a projection ever stops
    // naming `url`. The two branches are deliberately not merged behind a
    // shared "has a url" condition: they apply different transformations for
    // different reasons, and a merged branch would invite a later change to
    // one of them to quietly apply to both.
    if (table === 'rss_feed' && typeof projected.url === 'string') {
      projected.url = redactUrl(projected.url);
    }
    if (table === 'download_client' && typeof projected.url === 'string') {
      projected.url = clientAddress(projected.url);
    }
    result[id] = projected;
  }
  return result;
}
