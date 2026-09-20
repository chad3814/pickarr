import { sqliteTable, integer, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * A configured download client (SABnzbd or qBittorrent). Feeds name one of
 * these by `id` to say where their picks go; a feed with no preference falls
 * back to whichever client the host treats as the default.
 */
export const downloadClient = sqliteTable('download_client', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  url: text('url').notNull(),
  // The `secret` name for this client's api key, not the key -- a
  // `randomUUID()` resolved through `Secrets.get`. Nullable: a row
  // authenticating with a username and password has none. Migration 14
  // replaced the credential columns with these, so a credential lives in
  // `secret` and in nothing else.
  apiKeySecretName: text('api_key_secret_name'),
  username: text('username'),
  // The `secret` name for this client's password. `username` beside it is
  // plaintext on purpose: a username is not a credential.
  passwordSecretName: text('password_secret_name'),
  category: text('category').notNull(),
  importMode: text('import_mode').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // The product behind this client ('qbittorrent' | 'sabnzbd'), distinct
  // from `type` above (the transport, 'torrent' | 'nzb'). Defaulted only so
  // the column was legal to add to a table that may already hold rows. The
  // one writer of a download_client row outside tests,
  // `scripts/seed-client.ts`, names this column explicitly and refuses an
  // implementation that disagrees with `type`, so no row an operator
  // creates inherits the default silently. Tests are the exception and are
  // meant to be: 5 of the 22 inserts in this repo omit the column, and
  // those rows do inherit 'qbittorrent' -- which is what the default is
  // for.
  implementation: text('implementation').notNull().default('qbittorrent'),
}, (t) => [
  // A feed names a client by this, so two clients answering to the same name
  // would make that reference ambiguous.
  uniqueIndex('download_client_name').on(t.name),
]);

export const filepathMapping = sqliteTable('filepath_mapping', {
  id: integer('id').primaryKey(),
  downloadClientId: integer('download_client_id').notNull().references(() => downloadClient.id),
  fromPath: text('from_path').notNull(),
  toPath: text('to_path').notNull(),
  createdAt: integer('created_at').notNull(),
  // Migration 19, which is also where the table joined `HOST_SYNCED_TABLES`
  // -- every synced table projects an `updatedAt`. **No default**, and that
  // cost a table rebuild: `ADD COLUMN ... NOT NULL` would have needed a
  // constant one, which SQLite then has no `ALTER COLUMN` to remove, and a
  // row written without the column would have stored epoch 0 silently
  // rather than failing. That migration's docblock has the measurement and
  // the argument.
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  index('filepath_mapping_client').on(t.downloadClientId),
  // One mapping per prefix per client. Migration 19's docblock has why this
  // is a correctness fix rather than duplicate detection: it is what makes
  // `clients/paths.ts`'s unresolved equal-length tie unreachable.
  uniqueIndex('filepath_mapping_from_path').on(t.downloadClientId, t.fromPath),
]);

export const rssFeed = sqliteTable('rss_feed', {
  id: integer('id').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  // Nullable: absent means picks from this feed go to the host's default
  // client rather than a specific one.
  downloadClientId: integer('download_client_id').references(() => downloadClient.id),
  // 'torrent' | 'nzb'. Defaulted so the column was legal to add to a table
  // that may already hold rows; existing feeds inherit 'torrent'.
  downloadType: text('download_type').notNull().default('torrent'),
  pollIntervalS: integer('poll_interval_s').notNull().default(900),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('rss_feed_url').on(t.url),
]);

export const mediaItem = sqliteTable('media_item', {
  id: integer('id').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  provider: text('provider'),
  providerRef: text('provider_ref'),
  title: text('title').notNull(),
  releaseDate: text('release_date'),
  description: text('description'),
}, (t) => [
  // The dedup's whole basis. Nullable while a lookup is outstanding, and
  // SQLite treats NULLs as distinct, so unclaimed rows do not collide.
  uniqueIndex('media_item_provider_ref').on(t.provider, t.providerRef),
  // Every cursor query in the read API's sync slice orders by
  // (updated_at, id) filtered by plugin, so plugin_id leads.
  index('media_item_sync').on(t.pluginId, t.updatedAt, t.id),
]);

export const rssItem = sqliteTable('rss_item', {
  id: integer('id').primaryKey(),
  feedId: integer('feed_id').notNull().references(() => rssFeed.id),
  filename: text('filename').notNull(),
  // What a plugin's download capability fetches. Added beyond the tables the
  // spec listed by name: an rss item nobody can fetch is not actionable, and
  // the contract's download capability takes ids so a plugin never supplies
  // one of its own.
  link: text('link').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  downloadType: text('download_type').notNull(),
  mediaItemId: integer('media_item_id').references(() => mediaItem.id),
  rankingScore: integer('ranking_score'),
  resolution: text('resolution').notNull(),
  resolutionDetail: text('resolution_detail'),
  // Nullable: the reader always writes one, falling back to the link when a
  // feed's item has none — a NULL means a row that predates this column.
  // SQLite treats NULLs as distinct in a unique index, so those rows do not
  // collide with each other under `rss_item_feed_guid`.
  guid: text('guid'),
  // Nullable, and never backfilled: set once `notifyNewRssItems` has handed
  // this row to its owning plugin with no failure. A row with none is
  // offered again on the next poll of its feed -- whether it predates this
  // column or its feed simply had no registered plugin yet -- which is what
  // lets a host with no plugin registered still poll safely instead of
  // destroying every item's identity through the (feed_id, guid) dedup.
  deliveredAt: integer('delivered_at'),
}, (t) => [
  // The client's update flow asks "what changed since", so updated_at leads.
  index('rss_item_updated').on(t.updatedAt, t.id),
  uniqueIndex('rss_item_feed_guid').on(t.feedId, t.guid),
  // "Every release found for this media item", which the read API asks once
  // per media item. Migration 10; without it that query was a bare
  // `SCAN rss_item`. One column, not (media_item_id, id): an index entry
  // already carries the rowid, so the query's `ORDER BY id` needs no sort.
  index('rss_item_media_item').on(t.mediaItemId),
  // No second `(updated_at, id)` index for the read API's sync cursor:
  // `rss_item_updated` above already is one, byte for byte. Migration 9's
  // DDL originally created `rss_item_sync` alongside it, which SQLite would
  // never have chosen -- two identical B-trees, both maintained on every
  // `rss_item` write (a feed poll writes one per item, reconcile writes one
  // per delivery) for a query that can only use one of them. The read API
  // uses `rss_item_updated`.
]);

/**
 * Records that a media item was deleted, since no query over `media_item`'s
 * live rows can say so once the row is gone.
 *
 * `mediaItemId` is the primary key, not a surrogate `id` with its own
 * foreign key: one tombstone per id is the whole truth there is to record.
 * An id *can* come back -- SQLite hands the highest rowid out again once its
 * row is deleted, measured against `node:sqlite`, and the dedup path drops
 * exactly the newest row -- so the second deletion of a reused id must move
 * this row's `pluginId` and `deletedAt` forward rather than sit beside a
 * stale twin. `MediaWriter.dropMediaItem` writes it as an upsert for that
 * reason. It is deliberately not a reference to `media_item` either -- the
 * row it names is gone, which is the entire point, so a reference would be
 * unsatisfiable by construction.
 *
 * That is only "forward" **within one plugin**. When the reused id is taken
 * by a *different* plugin the upsert moves `pluginId` too, so the first
 * plugin's tombstone becomes the second's, and a client of the first that
 * had not polled inside that window never learns its item was deleted --
 * nor can it later, since the live row is gone. Not theoretical:
 * `test/media/writer.test.ts` asserts the re-tombstoned row names the second
 * owner. It is still the least-bad shape available with one row per id; the
 * read API spec's §8 records the trade and what closing it would take.
 *
 * `pluginId` is copied onto the tombstone rather than looked up: by the time
 * anyone reads it there is nothing left on `media_item` to join to, and a
 * client syncing one media type must not be handed another plugin's
 * deletions.
 */
export const deletedMediaItem = sqliteTable('deleted_media_item', {
  mediaItemId: integer('media_item_id').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  deletedAt: integer('deleted_at').notNull(),
}, (t) => [
  // `deletionsSince` is `WHERE plugin_id = ? AND (deleted_at, media_item_id)
  // > (?, ?)`, so the index leads with the equality and then carries the
  // cursor's two columns in the order the query sorts them -- genuinely the
  // shape `media_item_sync` gives `media_item`, which the index this replaced
  // was not. Migration 9's `deleted_media_item_at` covered
  // `(deleted_at, media_item_id)` and named no `plugin_id`, so a caught-up
  // client walked every *other* plugin's tombstones on every poll: 26.53 ms
  // at 400,000 of them against 0.004 ms here. Migration 11 drops it in the
  // same statement that creates this, because nothing else reads that table
  // -- `MediaWriter.dropMediaItem` upserts on the primary key -- and an index
  // no query uses is a B-tree maintained on every tombstone write for
  // nothing.
  //
  // Covering, as it happens: `media_item_id` and `deleted_at` are the only
  // columns `deletionsSince` selects, so the read never touches the table.
  index('deleted_media_item_sync').on(t.pluginId, t.deletedAt, t.mediaItemId),
]);

/**
 * One row per pick submitted to a torrent client, recording what the host
 * submitted and what the client confirmed. A row is written *before* the
 * client is called, so a submission that dies between request and response
 * leaves evidence rather than nothing.
 */
export const torrentDownload = sqliteTable('torrent_download', {
  id: integer('id').primaryKey(),
  rssItemId: integer('rss_item_id').notNull().references(() => rssItem.id),
  downloadClientId: integer('download_client_id').notNull().references(() => downloadClient.id),
  infohash: text('infohash'),
  // Nullable: null from the moment the row is written until the client
  // confirms the submission. See the unique index below for why that null
  // is not treated as "unclaimed and interchangeable with any other".
  clientRef: text('client_ref'),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // The client's own path for this download, exactly as it reports it --
  // never the mapped path a `filepath_mapping` row would produce. That
  // mapping is derived on demand and never stored, because a stored mapped
  // path goes stale the moment a `filepath_mapping` row changes. Nullable,
  // with no default: no row before this column had this fact measured.
  storagePath: text('storage_path'),
  // The client's own completion percentage for this download. Nullable: an
  // unconfirmed or pre-column row has never had one reported.
  percentage: integer('percentage'),
  // Set once the client stops reporting this download at all, so a
  // reconcile pass can tell "gone" from "never checked". Nullable: most
  // rows are never absent.
  absentSince: integer('absent_since'),
  // Stamped once a download the client confirmed has actually landed. Not
  // the same fact as `rssItem.deliveredAt`, which is stamped when slice A's
  // poll hands an undelivered new item to its plugin, before any download
  // exists -- two columns, one name, two tables, two unrelated facts.
  // Nullable: unset until landing is observed.
  deliveredAt: integer('delivered_at'),
  // Stamped once `deps.remove` has been called for this row and succeeded,
  // so a reconcile pass reclaims a download once rather than on every tick
  // for the rest of its existence. Nullable, with no default: no row before
  // this column had this fact measured, and a guessed value would assert
  // history the column has no way to know. See `clients/deliver.ts`'s module
  // doc for what happens without it.
  reclaimedAt: integer('reclaimed_at'),
}, (t) => [
  // Partial, not total: many unconfirmed rows (client_ref IS NULL) must be
  // free to coexist so a crashed submission can be retried rather than
  // colliding with its own earlier, unconfirmed attempt. SQLite already
  // treats NULLs as distinct in a unique index; the WHERE states that
  // intent rather than changing the behavior.
  uniqueIndex('torrent_download_client_ref')
    .on(t.downloadClientId, t.clientRef)
    .where(sql`${t.clientRef} is not null`),
  // One *live* download per release, where live is every status but
  // `failed`. The index above is client-side dedup and cannot stand in for
  // this one: it is keyed on the resolved client, and `clients/select.ts`
  // resolves a feed that names no client by drawing among the clients of
  // its type -- so a second pick that draws differently collides with
  // nothing. Migration 18's docblock has the measurement, the reason
  // `failed` is excluded, and why two per-table indexes cover the whole
  // rule.
  uniqueIndex('torrent_download_live_item')
    .on(t.rssItemId)
    .where(sql`${t.status} <> 'failed'`),
  index('torrent_download_item').on(t.rssItemId),
  // The read API's sync cursor over this table's branch of the union.
  index('torrent_download_sync').on(t.updatedAt, t.id),
  // Serves `clients/rows.ts`'s `rowsForClientByStatus` -- the reconcile
  // tick's only read shape, asked for non-terminal statuses by the absence
  // sweep, `completed` by delivery, `delivered` by reclaim and `submitting`
  // by ref recovery. Neither index above can answer any of those:
  // `..._client_ref` is partial and keyed on the wrong column first, and
  // `..._item` is keyed on the item. `rows.test.ts` asserts the query plan
  // reaches this index, since a `status` predicate dropped from the SQL and
  // done in JavaScript instead looks identical from every other angle.
  index('torrent_download_status').on(t.status),
]);

/** Same shape as `torrent_download`, minus `infohash` -- an nzb has no equivalent identifier to record before submission. */
export const nzbDownload = sqliteTable('nzb_download', {
  id: integer('id').primaryKey(),
  rssItemId: integer('rss_item_id').notNull().references(() => rssItem.id),
  downloadClientId: integer('download_client_id').notNull().references(() => downloadClient.id),
  clientRef: text('client_ref'),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // See `torrentDownload.storagePath`.
  storagePath: text('storage_path'),
  // See `torrentDownload.percentage`.
  percentage: integer('percentage'),
  // See `torrentDownload.absentSince`.
  absentSince: integer('absent_since'),
  // See `torrentDownload.deliveredAt`.
  deliveredAt: integer('delivered_at'),
  // See `torrentDownload.reclaimedAt`.
  reclaimedAt: integer('reclaimed_at'),
}, (t) => [
  uniqueIndex('nzb_download_client_ref')
    .on(t.downloadClientId, t.clientRef)
    .where(sql`${t.clientRef} is not null`),
  // See `torrentDownload.torrent_download_live_item`: the same rule, and
  // both tables need it because which one a release lands in is decided by
  // its feed's `download_type`.
  uniqueIndex('nzb_download_live_item')
    .on(t.rssItemId)
    .where(sql`${t.status} <> 'failed'`),
  index('nzb_download_item').on(t.rssItemId),
  // The read API's sync cursor over this table's branch of the union.
  index('nzb_download_sync').on(t.updatedAt, t.id),
  // See `torrentDownload`'s own `..._status` comment: the same query reads
  // both tables, so both need the index.
  index('nzb_download_status').on(t.status),
]);

export const person = sqliteTable('person', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  // The provider's own person id, for de-duplicating across lookups.
  providerRef: text('provider_ref').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('person_provider_ref').on(t.providerRef),
]);

/** An alternate name a provider records for a person, e.g. a performer's stage names. */
export const alias = sqliteTable('alias', {
  id: integer('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => person.id),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('alias_person_name').on(t.personId, t.name),
]);

export const role = sqliteTable('role', {
  id: integer('id').primaryKey(),
  mediaItemId: integer('media_item_id').notNull().references(() => mediaItem.id),
  personId: integer('person_id').notNull().references(() => person.id),
  role: text('role').notNull(),
  // The character's name where the provider gives one.
  name: text('name'),
  billingOrder: integer('billing_order'),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  // Unique, not a plain index: `attachRole` upserts onto it, which is what
  // makes a re-run job handler idempotent. Its leading column is
  // `mediaItemId`, so it also serves "every role on this item".
  uniqueIndex('role_media_item_person_role').on(t.mediaItemId, t.personId, t.role),
]);

/**
 * A provider id a media item carries beyond the one that claimed it in
 * `media_item.provider_ref`. A single item can be known to several providers
 * at once (tmdb, imdb, tpdb, …); only one of those pairs is the dedup key.
 */
export const externalReference = sqliteTable('external_reference', {
  id: integer('id').primaryKey(),
  mediaItemId: integer('media_item_id').notNull().references(() => mediaItem.id),
  provider: text('provider').notNull(),
  ref: text('ref').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  // One reference per provider, per item.
  uniqueIndex('external_reference_media_item_provider').on(t.mediaItemId, t.provider),
]);

export const poster = sqliteTable('poster', {
  id: integer('id').primaryKey(),
  mediaItemId: integer('media_item_id').notNull().references(() => mediaItem.id),
  title: text('title'),
  language: text('language'),
  url: text('url').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  createdAt: integer('created_at').notNull(),
  // Nullable: set once the artwork writer has fetched the file to disk: rows
  // written before that (or before this column existed) have none yet.
  path: text('path'),
}, (t) => [
  // Unique on the url for the same reason as `role_media_item_person_role`:
  // one image is one row however many times a handler re-runs.
  uniqueIndex('poster_media_item_url').on(t.mediaItemId, t.url),
]);

export const background = sqliteTable('background', {
  id: integer('id').primaryKey(),
  mediaItemId: integer('media_item_id').notNull().references(() => mediaItem.id),
  title: text('title'),
  description: text('description'),
  language: text('language'),
  url: text('url').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  createdAt: integer('created_at').notNull(),
  path: text('path'),
}, (t) => [
  uniqueIndex('background_media_item_url').on(t.mediaItemId, t.url),
]);

/**
 * Same columns as `poster`, and now with the same kind of writer:
 * `MediaWriter.attachLogo`. It was the one artwork table slice A left with
 * neither a writer nor a unique index, which is why both arrived together --
 * the index is what makes the writer's re-run idempotent rather than
 * duplicating rows.
 */
export const logo = sqliteTable('logo', {
  id: integer('id').primaryKey(),
  mediaItemId: integer('media_item_id').notNull().references(() => mediaItem.id),
  title: text('title'),
  language: text('language'),
  url: text('url').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  createdAt: integer('created_at').notNull(),
  path: text('path'),
}, (t) => [
  index('logo_media_item').on(t.mediaItemId),
  // Unique to match `poster`/`background`: this is what makes a re-run of
  // `attachLogo` idempotent instead of duplicating rows. The plain index above stays — same leading column, so
  // it still serves the same lookups, and dropping it is unrelated to this
  // change.
  uniqueIndex('logo_media_item_url').on(t.mediaItemId, t.url),
]);

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  kind: text('kind').notNull(),
  payloadJson: text('payload_json').notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull(),
  runAt: integer('run_at').notNull(),
  // 'ready' | 'running' | 'done' | 'dead'
  state: text('state').notNull(),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // Stamped by the queue worker at the moment a job actually begins, not when
  // it is dispatched -- so a row that has never run has none. Nullable on
  // purpose: a job dispatched but not yet started stays `ready` with a null
  // `started_at`, so a crash charges it no attempt for a try that never
  // happened.
  startedAt: integer('started_at'),
}, (t) => [
  // The claim query's own predicate: `WHERE state = 'ready' AND run_at <= :now
  // ORDER BY run_at, id`. Partial on state so the index stays proportional to
  // the queue rather than to every job ever run.
  index('jobs_ready').on(t.runAt, t.id).where(sql`${t.state} = 'ready'`),
]);

/**
 * A key/value row per host-wide fact, deliberately general: it already holds
 * two unrelated things (the generated Better Auth signing secret and the
 * first-boot claim token), and inventing a column per fact would mean a
 * migration per fact.
 *
 * `value` is a credential column. Only the module that persists the signing
 * secret may select it, enforced at build time by
 * `scripts/check-test-hygiene.ts` over `packages/host/src`.
 */
export const hostState = sqliteTable('host_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * The four tables Better Auth's `drizzleAdapter` expects, `auth_`-prefixed.
 *
 * **The property keys are the library's interface, not just labels.** The
 * adapter maps each model's fields onto the *schema object's property keys*,
 * so `emailVerified` here is what makes the `user` model's `emailVerified`
 * field reach the `email_verified` column. Renaming a property is a runtime
 * failure `test/db/schema.test.ts` cannot see -- it compares this file against
 * the DDL, and a rename that changed both would leave the two agreeing and
 * both wrong. The SQL names stay snake_case, which the spike measured working.
 *
 * **These four declare column modes, which no other table here does.** The
 * adapter hands Better Auth's values straight to Drizzle: `emailVerified`
 * arrives as a JS boolean and every `*_at` as a `Date`, and a mode-less
 * `integer()` would pass both to `node:sqlite` unchanged, which binds
 * neither -- sign-up fails with "Provided value cannot be bound to SQLite
 * parameter". `{ mode: 'boolean' }` and `{ mode: 'timestamp_ms' }` are what
 * turn them into the integers the DDL declares. The SQL type is `INTEGER`
 * either way, so this stays one definition mirrored against migration 12
 * rather than a second one shaped for the library.
 *
 * **`id` is `text`, and these four are the only tables in this file with a
 * text `id`** -- every table above that *has* an `id` declares
 * `integer('id').primaryKey()`, i.e. the rowid. Two have none: `hostState`
 * just above is keyed by a text `key`, and `deletedMediaItem` by
 * `mediaItemId`. Neither is the same asymmetry -- a caller-chosen key, and the
 * id of a row that no longer exists, are not generated ids -- and saying
 * "every table above" without that carve-out is how this comment previously
 * read as false about the two tables it skipped over. Better Auth's default id
 * generator is a random base62 string,
 * and adopting it avoids configuring `advanced.database.generateId` to
 * something the library then has to be told about. The asymmetry is the
 * library's; it is said out loud here so the next reader does not "fix" it and
 * break sign-up.
 */
export const authUser = sqliteTable('auth_user', {
  id: text('id').primaryKey(),
  // Nullable, and the library's model is the **opposite** of what this comment
  // used to say: `name` is `required: true` in `@better-auth/core`'s
  // `db/get-tables.ts` (1.7.3, read from `node_modules`), with no
  // `defaultValue`. The column is safe anyway, and for a reason worth having
  // written down instead: nothing reaches it without a name, because
  // `/sign-up/email`'s body schema declares `name: z.string()` -- not
  // `.optional()` -- so a request omitting it is refused before any row is
  // written. What the nullability buys is the row a *future* creation path
  // with no name would write: the adapter's `transformInput` drops a field
  // that is undefined and has no default, so `NOT NULL` would fail that
  // insert rather than store a blank.
  name: text('name'),
  email: text('email').notNull(),
  // Stored as 0 or 1, read and written as a boolean. Nothing in this slice
  // verifies an email -- there is no outbound mail path -- so every row keeps
  // the default; the column exists because the library's model has the field.
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [
  // Unique, not a plain index: the email is how sign-in identifies an account,
  // so two rows sharing one would make that lookup ambiguous rather than
  // merely slow.
  uniqueIndex('auth_user_email').on(t.email),
]);

/**
 * One live session. `token` is the credential the cookie carries, so only
 * Better Auth's own adapter may select it -- enforced at build time by
 * `scripts/check-test-hygiene.ts`.
 *
 * **This column's value is also served in a response body**, which is worth
 * knowing beside the rule that keeps it out of everybody's SQL.
 * `/sign-up/email` answers `{ token, user }` and `/sign-in/email` answers
 * `{ redirect, token, user }`, where `token` is a 32-character string that is
 * this column and is the unsigned prefix of the `better-auth.session_token`
 * cookie (measured by *shape* -- key names and value lengths -- because
 * formatting one of those bodies is how a probe printed a credential into a
 * transcript during the whole-branch review). The plan's "no HTTP response
 * body may carry a session token" is written against that, and the library's
 * own routes break its letter.
 *
 * Bounded, and measured: the value alone grants nothing, because what the
 * guard checks is the *signed* cookie. `/api/media?type=movie` answers 401
 * both with `Authorization: Bearer <that value>` and with it pasted into
 * `better-auth.session_token`; the cookie itself is
 * `HttpOnly; SameSite=Lax; Max-Age=604800; Path=/`, no `Secure` (correct over
 * `http:`). So this is a documented divergence from a hard constraint rather
 * than a live leak -- and the reason no test, message or log line in this repo
 * may name one of these values even in passing.
 *
 * **`userId` declares no `ON DELETE` where the library's model declares
 * `cascade`**, and `updatedAt` is `NOT NULL` against a model that gives it an
 * `onUpdate` and no `defaultValue`. Both are recorded in full beside
 * migration 12's DDL in `db/migrate.ts`, which is the source this mirrors;
 * `schema.test.ts` compares neither foreign-key targets nor the library's
 * model, so neither divergence can fail a test today.
 */
export const authSession = sqliteTable('auth_session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUser.id),
  token: text('token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  // Nullable: recorded from the request when present, and a request through a
  // proxy that strips them has neither.
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [
  // Unique because the token *is* the lookup key: every guarded request
  // resolves a cookie to one session through this index, and two rows sharing
  // a token would mean one cookie naming two sessions.
  uniqueIndex('auth_session_token').on(t.token),
  // "Every session for this user", which is what revoking them all reads.
  index('auth_session_user').on(t.userId),
]);

/**
 * The credentials behind a user. With no social providers in this slice every
 * row is the `credential` provider, and `password` is that account's password
 * hash -- a credential column only Better Auth's own adapter may select,
 * enforced at build time by `scripts/check-test-hygiene.ts`.
 *
 * The six token columns are nullable and stay null throughout this slice:
 * they belong to OAuth providers, which §1.1 of the auth design spec excludes.
 * They exist because the library's `account` model has the fields.
 *
 * `userId` and `updatedAt` carry exactly the two divergences `authSession`'s
 * docblock names -- no `ON DELETE` against the model's `cascade`, and a
 * `NOT NULL` against a model with an `onUpdate` and no `defaultValue`. Both
 * are written out beside migration 12 in `db/migrate.ts`.
 */
export const authAccount = sqliteTable('auth_account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUser.id),
  providerId: text('provider_id').notNull(),
  accountId: text('account_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [
  // "The accounts belonging to this user", which sign-in reads once it has
  // resolved the email to a user row.
  index('auth_account_user').on(t.userId),
]);

/**
 * **Nothing in this slice writes this table**, the way `externalReference`
 * had no writer when it was created: email verification, password reset and
 * social sign-in are all excluded by §1.1 of the auth design spec, because
 * each needs an outbound mail path or a provider registration this host does
 * not have. It exists because `drizzleAdapter` expects the `verification`
 * model to exist, and a table Better Auth may write to is cheaper than
 * discovering at runtime which code path needs it. Do not hunt for the writer.
 *
 * `value` here is *not* `hostState.value`: two columns, one name, two tables,
 * two unrelated facts. The auth design spec's §4 names three credential
 * columns and this is not one of them, so `check-test-hygiene.ts` does not
 * guard it -- which costs nothing while nothing reads it, and is worth
 * revisiting by whatever slice first does.
 */
export const authVerification = sqliteTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  // Nullable, unlike every other `updated_at` in this file -- and **not**
  // because the library declares it optional, which is what this comment used
  // to say and is the opposite of the truth. `verification.updatedAt` is
  // `required: true` in `@better-auth/core`'s `db/get-tables.ts` (1.7.3, read
  // from `node_modules`), and it carries both a `defaultValue` (`new Date()`)
  // and an `onUpdate`. So the adapter always supplies it: `withApplyDefault`
  // fills the default on a create and the `onUpdate` on an update, and no
  // write that reaches this table can leave the column null. The nullability
  // is slack nothing needs rather than a shape the library asked for, and
  // that -- not a misread of the model -- is why it is safe.
  //
  // **The two columns that actually lack a default are elsewhere**, and this
  // comment reasoning at length about exactly that shape while saying nothing
  // about them is why they are now named: `session.updatedAt` and
  // `account.updatedAt` are `required: true` with an `onUpdate` and **no**
  // `defaultValue`, so their `NOT NULL` holds only because the adapter passes
  // a value on create. See their docblocks above, and `db/migrate.ts` for the
  // measurement.
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
}, (t) => [
  // The library looks a verification up by its identifier, never by id.
  index('auth_verification_identifier').on(t.identifier),
]);

/**
 * One credential per row, addressed by name — a `randomUUID()` for a
 * credential the settings UI stored, or a name a human chose like `tvdb_key`
 * for one they may also supply from the environment.
 *
 * `value` is a credential column. Only `src/secrets/store.ts` may select it,
 * enforced at build time by `scripts/check-test-hygiene.ts` over
 * `packages/host/src`. It is deliberately *not* `host_state`: that table
 * holds this host's own facts, while every row here is a third party's
 * credential, and the two have different readers.
 */
export const secret = sqliteTable('secret', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * The client replication log. One row per changed row: a trigger deletes the
 * previous entry before inserting, so this table is bounded by how many rows
 * have ever changed rather than by how often they changed.
 *
 * `id` is `AUTOINCREMENT` in the DDL. Drizzle's `.primaryKey({ autoIncrement:
 * true })` is what mirrors that; a bare `.primaryKey()` would compare equal
 * on name and type while meaning something the cursor cannot survive.
 */
export const syncLog = sqliteTable('sync_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  rowId: integer('row_id').notNull(),
  op: text('op').notNull(),
  at: integer('at').notNull(),
}, (t) => [
  uniqueIndex('sync_log_row').on(t.tableName, t.rowId),
]);
