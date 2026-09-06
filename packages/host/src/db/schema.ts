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
  // 'torrent' | 'usenet'. Defaulted so the column was legal to add to a table
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
