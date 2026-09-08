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
  apiKey: text('api_key'),
  username: text('username'),
  password: text('password'),
  category: text('category').notNull(),
  importMode: text('import_mode').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // The product behind this client ('qbittorrent' | 'sabnzbd'), distinct
  // from `type` above (the transport, 'torrent' | 'nzb'). Defaulted only so
  // the column was legal to add to a table that may already hold rows --
  // nothing in this tree writes a download_client row yet, so no row has
  // actually inherited this default silently.
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
}, (t) => [
  index('filepath_mapping_client').on(t.downloadClientId),
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
 * foreign key: an item is deleted once, and a second tombstone for one id
 * would mean a reused rowid, which `INTEGER PRIMARY KEY` does not produce.
 * It is deliberately not a reference to `media_item` either -- the row it
 * names is gone, which is the entire point, so a reference would be
 * unsatisfiable by construction.
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
  // The read API's cursor over tombstones orders by (deleted_at, id) -- the
  // same shape `media_item_sync` gives `media_item`, and the same shape
  // `rss_item_updated` already gave `rss_item`.
  index('deleted_media_item_at').on(t.deletedAt, t.mediaItemId),
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
  index('torrent_download_item').on(t.rssItemId),
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
  index('nzb_download_item').on(t.rssItemId),
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
