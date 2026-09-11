import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '@pickarr/contract';

/**
 * The shared tables, in dependency order so every `REFERENCES` names a table
 * that already exists. Column names and types mirror `schema.ts` exactly —
 * this is the DDL Drizzle's types describe, not a schema Drizzle generates.
 * Nothing generates one from the other, so `test/db/schema.test.ts` compares
 * them: two sources of truth are only safe while something checks they agree.
 */
const INITIAL_SCHEMA = `
CREATE TABLE download_client (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  api_key      TEXT,
  username     TEXT,
  password     TEXT,
  category     TEXT    NOT NULL,
  import_mode  TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX download_client_name ON download_client (name);

CREATE TABLE filepath_mapping (
  id                  INTEGER PRIMARY KEY,
  download_client_id  INTEGER NOT NULL REFERENCES download_client (id),
  from_path           TEXT    NOT NULL,
  to_path             TEXT    NOT NULL,
  created_at          INTEGER NOT NULL
);
CREATE INDEX filepath_mapping_client ON filepath_mapping (download_client_id);

CREATE TABLE rss_feed (
  id                 INTEGER PRIMARY KEY,
  plugin_id          TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  url                TEXT    NOT NULL,
  download_client_id INTEGER REFERENCES download_client (id),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX rss_feed_url ON rss_feed (url);

CREATE TABLE media_item (
  id           INTEGER PRIMARY KEY,
  plugin_id    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  provider     TEXT,
  provider_ref TEXT,
  title        TEXT    NOT NULL,
  release_date TEXT,
  description  TEXT
);
CREATE UNIQUE INDEX media_item_provider_ref ON media_item (provider, provider_ref);

CREATE TABLE rss_item (
  id                INTEGER PRIMARY KEY,
  feed_id           INTEGER NOT NULL REFERENCES rss_feed (id),
  filename          TEXT    NOT NULL,
  link              TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  download_type     TEXT    NOT NULL,
  media_item_id     INTEGER REFERENCES media_item (id),
  ranking_score     INTEGER,
  resolution        TEXT    NOT NULL,
  resolution_detail TEXT
);
CREATE INDEX rss_item_updated ON rss_item (updated_at, id);

CREATE TABLE person (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  provider_ref TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX person_provider_ref ON person (provider_ref);

CREATE TABLE alias (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES person (id),
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX alias_person_name ON alias (person_id, name);

CREATE TABLE role (
  id            INTEGER PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_item (id),
  person_id     INTEGER NOT NULL REFERENCES person (id),
  role          TEXT    NOT NULL,
  name          TEXT,
  billing_order INTEGER,
  created_at    INTEGER NOT NULL
);
-- Unique, not a plain index: attachRole upserts onto it, which is what makes
-- a re-run job handler idempotent. Its leading column is media_item_id, so it
-- also serves "every role on this item".
CREATE UNIQUE INDEX role_media_item_person_role ON role (media_item_id, person_id, role);

CREATE TABLE external_reference (
  id            INTEGER PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_item (id),
  provider      TEXT    NOT NULL,
  ref           TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX external_reference_media_item_provider ON external_reference (media_item_id, provider);

CREATE TABLE poster (
  id            INTEGER PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_item (id),
  title         TEXT,
  language      TEXT,
  url           TEXT    NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
-- Unique on the url for the same reason as role_media_item_person_role: one
-- image is one row however many times a handler re-runs.
CREATE UNIQUE INDEX poster_media_item_url ON poster (media_item_id, url);

CREATE TABLE background (
  id            INTEGER PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_item (id),
  title         TEXT,
  description   TEXT,
  language      TEXT,
  url           TEXT    NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX background_media_item_url ON background (media_item_id, url);

CREATE TABLE logo (
  id            INTEGER PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_item (id),
  title         TEXT,
  language      TEXT,
  url           TEXT    NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX logo_media_item ON logo (media_item_id);

CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY,
  plugin_id    TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_at       INTEGER NOT NULL,
  state        TEXT    NOT NULL,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX jobs_ready ON jobs (run_at, id) WHERE state = 'ready';
`;

/**
 * `guid`, `download_type`'s new default and `poll_interval_s` back the feed
 * reader; the `path` columns back the artwork writer that follows it. Every
 * `ADD COLUMN ... NOT NULL` carries a `DEFAULT`, since SQLite refuses that
 * combination outright on a table that may already hold rows — the defaults
 * exist to make the statement legal, not because they are values later rows
 * should inherit silently.
 */
const MIGRATION_2 = `
ALTER TABLE rss_item ADD COLUMN guid TEXT;
CREATE UNIQUE INDEX rss_item_feed_guid ON rss_item (feed_id, guid);

ALTER TABLE rss_feed ADD COLUMN download_type   TEXT    NOT NULL DEFAULT 'torrent';
ALTER TABLE rss_feed ADD COLUMN poll_interval_s INTEGER NOT NULL DEFAULT 900;

ALTER TABLE poster     ADD COLUMN path TEXT;
ALTER TABLE background ADD COLUMN path TEXT;
ALTER TABLE logo       ADD COLUMN path TEXT;
CREATE UNIQUE INDEX logo_media_item_url ON logo (media_item_id, url);
`;

/**
 * `started_at` is stamped by the queue worker at the moment a job actually
 * begins, not when it is dispatched -- so a row that has never run has none.
 * It is nullable on purpose: a job dispatched but not yet started stays
 * `ready` with a null `started_at`, so a crash charges it no attempt for a
 * try that never happened. No new `state` value is needed -- `running`
 * already exists alongside `ready`, `done` and `dead`, and it is exactly
 * this state.
 */
const MIGRATION_3 = `
ALTER TABLE jobs ADD COLUMN started_at INTEGER;
`;

/**
 * Stamped once a poll's batch has been handed to `notifyNewRssItems` and
 * came back with no failure for the plugin that owns it -- see
 * `feeds/reader.ts`'s `pollFeed`. Nullable, and left off any `DEFAULT`: a
 * row this predates simply has none, which is exactly what makes a poll
 * re-offer it the moment a plugin exists to receive it, rather than
 * treating "column just appeared" as "already delivered".
 */
const MIGRATION_4 = `
ALTER TABLE rss_item ADD COLUMN delivered_at INTEGER;
`;

/**
 * Renames `rss_feed.download_type`'s `'usenet'` value to `'nzb'`, so a feed's
 * type reads the same word as `download_client.type` for the same transport
 * -- the two columns are compared directly starting next slice, and one
 * concept spelled two ways on two tables is how they drift apart. The
 * column's default stays `'torrent'`; only this value is renamed.
 *
 * **`rss_feed` only, which was not enough.** `feeds/reader.ts` copies a
 * feed's `download_type` onto every `rss_item` it inserts, so this statement
 * left every pre-existing rss item holding `'usenet'`. `MIGRATION_10` is the
 * matching `UPDATE rss_item`; this one is deliberately left as it shipped
 * rather than widened, because a migration already recorded as applied never
 * runs again.
 */
const MIGRATION_5 = `
UPDATE rss_feed SET download_type = 'nzb' WHERE download_type = 'usenet';
`;

/**
 * `implementation` names the product behind an already-existing client
 * ('qbittorrent' | 'sabnzbd'), distinct from `download_client.type` (the
 * transport, 'torrent' | 'nzb', which this migration leaves untouched).
 * `DEFAULT 'qbittorrent'` exists only to make `ADD COLUMN ... NOT NULL`
 * legal on a populated table -- nothing in this tree writes a
 * download_client row yet (the seed script arrives in a later task), so no
 * real row has actually inherited this default silently.
 *
 * `torrent_download` and `nzb_download` are one table per client type,
 * recording what the host submitted and what the client confirmed. A row is
 * written *before* the client is called, so a submission that dies between
 * request and response leaves evidence rather than nothing -- hence
 * `client_ref` is nullable, and `status`/`attempts`/`last_error` describe an
 * attempt rather than only a confirmed result.
 *
 * The unique index on (download_client_id, client_ref) is partial (`WHERE
 * client_ref IS NOT NULL`) so many unconfirmed rows -- every one with a null
 * `client_ref` -- can coexist while no two rows claim the same confirmed
 * job. SQLite already treats NULLs as distinct in a unique index, so the
 * partial form states that intent rather than changing the behavior.
 */
const MIGRATION_6 = `
ALTER TABLE download_client ADD COLUMN implementation TEXT NOT NULL DEFAULT 'qbittorrent';

CREATE TABLE torrent_download (
  id                 INTEGER PRIMARY KEY,
  rss_item_id        INTEGER NOT NULL REFERENCES rss_item (id),
  download_client_id INTEGER NOT NULL REFERENCES download_client (id),
  infohash           TEXT,
  client_ref         TEXT,
  status             TEXT    NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX torrent_download_client_ref
  ON torrent_download (download_client_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX torrent_download_item ON torrent_download (rss_item_id);

CREATE TABLE nzb_download (
  id                 INTEGER PRIMARY KEY,
  rss_item_id        INTEGER NOT NULL REFERENCES rss_item (id),
  download_client_id INTEGER NOT NULL REFERENCES download_client (id),
  client_ref         TEXT,
  status             TEXT    NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX nzb_download_client_ref
  ON nzb_download (download_client_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX nzb_download_item ON nzb_download (rss_item_id);
`;

/**
 * Gives a download row somewhere to record what the client says about it, so
 * a later reconcile pass can compare its own belief against reality instead
 * of only ever recording what the host submitted.
 *
 * Every column is nullable and carries no `DEFAULT` -- unlike `MIGRATION_2`'s
 * or `MIGRATION_6`'s, none of these four columns is ever `NOT NULL`, so none
 * needs one to make `ADD COLUMN` legal on a populated table. A `DEFAULT`
 * here would be a guess written into every existing row, and nothing has
 * measured any of these four facts for a row that predates this column.
 *
 * `storage_path` holds the *client's own* path, exactly as it reports it --
 * never the mapped path a `filepath_mapping` row would produce. That mapping
 * is derived on demand, by `clients/paths.ts`'s `mapClientPath` at the
 * moment a row is delivered, and never stored: a stored mapped path goes
 * stale the moment a `filepath_mapping` row changes, and is then a lie that
 * outlived its cause.
 *
 * `delivered_at` here is not `rss_item.delivered_at`: that column is stamped
 * when slice A's poll hands an undelivered *new item* to its plugin, before
 * any download exists. This one is stamped once a download the client
 * confirmed has actually landed. Two columns, one name, two tables, two
 * unrelated facts.
 *
 * `torrent_download_status` and `nzb_download_status` serve
 * `clients/rows.ts`'s `rowsForClientByStatus`, which is the one read shape
 * every caller in the reconcile tick uses: the absence sweep asks for every
 * non-terminal status, delivery asks for `completed`, reclaim asks for
 * `delivered`, and ref recovery asks for `submitting`. Neither the
 * `client_ref` index (partial, and keyed the wrong way round) nor the
 * `rss_item_id` one can answer any of them, so without these two the whole
 * tick reads every row the client has ever had. `rows.test.ts` asserts the
 * plan actually uses them, because a dropped `status` predicate changes
 * nothing else that a test can see.
 */
const MIGRATION_7 = `
ALTER TABLE torrent_download ADD COLUMN storage_path TEXT;
ALTER TABLE torrent_download ADD COLUMN percentage INTEGER;
ALTER TABLE torrent_download ADD COLUMN absent_since INTEGER;
ALTER TABLE torrent_download ADD COLUMN delivered_at INTEGER;

ALTER TABLE nzb_download ADD COLUMN storage_path TEXT;
ALTER TABLE nzb_download ADD COLUMN percentage INTEGER;
ALTER TABLE nzb_download ADD COLUMN absent_since INTEGER;
ALTER TABLE nzb_download ADD COLUMN delivered_at INTEGER;

CREATE INDEX torrent_download_status ON torrent_download (status);
CREATE INDEX nzb_download_status ON nzb_download (status);
`;

/**
 * Marks a `delivered` row as having had `deps.remove` called for it, so a
 * reconcile pass's reclaim step happens once per download, not once per
 * tick for the rest of that download's existence. Nullable, and carries no
 * `DEFAULT`: no existing row has actually had `remove` called for it under
 * this column's meaning, and guessing either `now` or `null` for one would
 * assert history the column has no way to know.
 *
 * Without this column, `deliverCompleted` re-selects every `delivered` row
 * on every pass and calls `remove` for each all over again, forever: a
 * SABnzbd client with 500 delivered downloads would issue 500 delete
 * requests a minute indefinitely, and the set only grows as more downloads
 * finish. Torrent clients have no `remove` at all (see `clients/deliver.ts`'s
 * module doc), which is the only thing that bounded the damage before this
 * column existed.
 */
const MIGRATION_8 = `
ALTER TABLE torrent_download ADD COLUMN reclaimed_at INTEGER;
ALTER TABLE nzb_download ADD COLUMN reclaimed_at INTEGER;
`;

/**
 * Records that a media item was deleted, since no query over `media_item`'s
 * live rows can say so once the row is gone.
 *
 * `media_item_id` is the primary key, not a surrogate `id` with its own
 * foreign key: one tombstone per id is the whole truth there is to record.
 * An id *can* come back -- SQLite hands the highest rowid out again once its
 * row is deleted, measured against `node:sqlite` -- so the second deletion
 * of a reused id moves this row forward instead of adding a second, which is
 * why `MediaWriter.dropMediaItem` writes it with `ON CONFLICT DO UPDATE`
 * rather than a plain INSERT. It is deliberately not a
 * `REFERENCES media_item (id)` either -- the row it names is gone, which is
 * the entire point, so a reference would be unsatisfiable by construction.
 *
 * **"Forward" is only forward within one plugin.** An id reused by a
 * *different* plugin moves `plugin_id` too, so the first plugin's tombstone
 * becomes the second's and the first plugin's clients never learn their item
 * was deleted -- `test/media/writer.test.ts` pins exactly that, asserting
 * the re-tombstoned row names the second owner. It is a known and accepted
 * consequence of one row per id, recorded in the read API spec's §8, and
 * this paragraph should not be read as denying it.
 *
 * `plugin_id` is copied onto the tombstone rather than looked up: by the
 * time anyone reads it there is nothing left on `media_item` to join to, and
 * a client syncing one media type must not be handed another plugin's
 * deletions.
 *
 * Two indexes, not three, and only one of the two was right.
 *
 * `media_item_sync` is `(plugin_id, updated_at, id)`, which is what
 * `mediaItemsSince` needs: the plugin equality first, then the cursor.
 * `deleted_media_item_at` is `(deleted_at, media_item_id)` and names no
 * `plugin_id`, so it does **not** serve `deletionsSince`, whose `WHERE`
 * leads with `plugin_id = ?` -- it sought the time and then walked every
 * other plugin's tombstones, filtering row by row. Migration 11 replaces it
 * with `deleted_media_item_sync`, `media_item_sync`'s shape one table over,
 * and drops this one; see `MIGRATION_11` for the measurement.
 *
 * An earlier version of this paragraph said "every cursor query in this slice
 * orders by `(updated_at, id)` and filters by plugin: `media_item_sync`
 * serves that on `media_item`, and `deleted_media_item_at` serves the same
 * shape on tombstones", which was wrong three times over. Only
 * `mediaItemsSince` and `deletionsSince` filter by plugin at all --
 * `rssItemsSince` and `downloadsSince` filter by nothing, because feed items
 * and downloads are one stream every client syncs. `deletionsSince` orders by
 * `(deleted_at, media_item_id)`, not `(updated_at, id)`; the tombstone table
 * has neither of those columns. And "the same shape" was the half that
 * mattered and the half that was missing: the plugin column. The knowledge
 * was not absent either -- the plan test's own `why` field said "plugin_id is
 * filtered as rows come off it" -- it simply never reached the index or this
 * comment.
 *
 * **`rss_item` gets nothing new** -- `rss_item_updated` has covered
 * `(updated_at, id)` since migration 1, and a second index on the same
 * columns would be a second B-tree maintained on every `rss_item` write for
 * a query that can only use one of them. A test in
 * `test/db/migrate.test.ts` asserts exactly one index covers those columns,
 * because a first draft of this migration created that duplicate and nothing
 * objected.
 */
const MIGRATION_9 = `
CREATE TABLE deleted_media_item (
  media_item_id INTEGER PRIMARY KEY,
  plugin_id     TEXT    NOT NULL,
  deleted_at    INTEGER NOT NULL
);
CREATE INDEX deleted_media_item_at ON deleted_media_item (deleted_at, media_item_id);
CREATE INDEX media_item_sync       ON media_item (plugin_id, updated_at, id);
`;

/**
 * Two unrelated repairs the read API needs, in one migration because they
 * landed in one fix wave: an index `rss_item` has never had, and the half of
 * migration 5's rename that migration 5 did not do.
 *
 * **The index.** Indexes `rss_item.media_item_id`, which nothing has ever
 * indexed.
 *
 * `reads.ts`'s `rssItemsForMediaItem` -- "every release found for this media
 * item" -- filters on exactly that column, and with no index it planned as a
 * bare `SCAN rss_item`, reading the whole table for one item's handful of
 * rows. The read API's `MediaReader.rssItemsFor` calls it **once per media
 * item**, so a plugin walking its library scanned `rss_item` once for every
 * item in it. With this index the plan is
 * `SEARCH rss_item USING INDEX rss_item_media_item (media_item_id=?)`.
 *
 * One column, not `(media_item_id, id)`, although the query is
 * `ORDER BY id`: an index entry already carries the rowid as its tail, so
 * SQLite hands the matches back in rowid order and needs no sort on top --
 * measured, `EXPLAIN QUERY PLAN` shows no `USE TEMP B-TREE FOR ORDER BY`.
 * Naming `id` explicitly would index the rowid twice for nothing.
 *
 * Not unique: one media item genuinely has many rss items, which is the whole
 * point of the query. Nullable too -- an unmatched rss item has no media item
 * -- and those rows sit in the index under NULL, which costs nothing because
 * nothing ever searches for them.
 *
 * **The two download tables get their own `(updated_at, id)` indexes.**
 * `downloadsSince` pages a union of both, and no index can order across two
 * tables -- that sort stays a temp B-tree whatever is indexed.
 *
 * **What these fixed when they landed is the caught-up poll, and only that.**
 * An earlier version of this paragraph said they fixed the case where "every
 * page scanned both tables from the beginning, and the cost grew with the
 * installation's whole download history rather than with the page". That was
 * false on the day it was written, and it is the kind of false that argues
 * against ever looking again. These indexes do turn each branch's keyset
 * comparison into a seek -- but the query as it then stood carried its only
 * `LIMIT` on the *outer* select, and SQLite cannot push that into either
 * branch, because the union's order is not either branch's order alone. So
 * every page still read every row ahead of the cursor in *both* tables,
 * sought or scanned, and sorted the lot to keep 200 of them.
 *
 * Measured on `node:sqlite`, 100,000 rows per table, per page: with these two
 * indexes 34.9 ms at page 1 and 17.4 ms at a cursor half way in; with both
 * dropped 28.9 ms and 18.5 ms. At page 1 the index was 20% **slower** than
 * the scan it replaced -- an index entry costs a rowid indirection per row
 * where the scan read the table sequentially -- and half way in the two were
 * within a millisecond of each other.
 *
 * The steady state is where they earn their keep, and it is worth having: a
 * caught-up client polling for nothing costs 0.02 ms with them against
 * 8.1 ms without, because the seek lands past the last row and stops while
 * the scan reads both tables to the end on every tick. That is the poll every
 * synced client makes forever, so it is the common case rather than the tail.
 *
 * **And they became load-bearing afterwards.** `reads.ts`'s `DOWNLOADS_SINCE`
 * now wraps each branch in its own ordered, limited subquery, and that is
 * what bounds a page to the page. These indexes are what each branch's inner
 * `ORDER BY updated_at, id` reads, so a branch stops after `PAGE_SIZE` index
 * entries rather than sorting: 0.37 ms per page at any depth with them,
 * 12.2 ms without, because without them each branch sorts its whole
 * ahead-of-cursor set into a temp B-tree before its own `LIMIT` can bite.
 * `test/api/reads.test.ts` asserts exactly one temp B-tree in that plan --
 * the union's own cross-table sort -- and that assertion is what now holds
 * both of these indexes in place.
 *
 * Slice D shipped two status indexes no query used. These two are used, so
 * the mistake worth naming here is a different one: a fix whose measurement
 * was never taken, wearing a justification that outlived being true.
 *
 * **The rename migration 5 left half-done.** `MIGRATION_5` is
 * `UPDATE rss_feed SET download_type = 'nzb' WHERE download_type = 'usenet'`
 * -- `rss_feed` and **only** `rss_feed`. But `feeds/reader.ts` copies a feed's
 * `download_type` onto every `rss_item` it inserts, so every rss item written
 * before migration 5 ran still held `'usenet'`, and nothing had ever touched
 * that column. The read API types the value as `'torrent' | 'nzb'`, which was
 * a lie for exactly those rows: `reads.ts`'s `downloadTypeOf` refuses them,
 * and one such row fails the whole page it lands in. This is the statement
 * migration 5 needed and did not carry.
 *
 * Written the same way round as migration 5's, deliberately: same column
 * name, same old value, same new value, one table over. Idempotent -- a
 * database with no `'usenet'` row updates nothing -- and it does not touch
 * `created_at`/`updated_at`, because the row's transport was always nzb and
 * only its spelling has changed. Bumping `updated_at` would re-serve every
 * such row to every synced client for a change no client can see.
 *
 * It does **not** make the column safe by construction, and `downloadTypeOf`
 * stays. The column is TEXT with no CHECK, and `PluginContext.db` hands a
 * plugin the raw connection, so a row written after this migration can still
 * carry any string at all. What this closes is the one source that history
 * actually produced.
 */
const MIGRATION_10 = `
CREATE INDEX rss_item_media_item ON rss_item (media_item_id);

CREATE INDEX torrent_download_sync ON torrent_download (updated_at, id);
CREATE INDEX nzb_download_sync     ON nzb_download (updated_at, id);

UPDATE rss_item SET download_type = 'nzb' WHERE download_type = 'usenet';
`;

/**
 * The tombstone index migration 9 should have created, in place of the one it
 * did.
 *
 * `reads.ts`'s `deletionsSince` is `WHERE plugin_id = ? AND (deleted_at,
 * media_item_id) > (?, ?)`. `deleted_media_item_at` covers
 * `(deleted_at, media_item_id)` and **names no `plugin_id` at all**, so the
 * plan sought the *time* and then walked every tombstone after it, testing
 * `plugin_id` row by row: `LIMIT 200` bounded the output and nothing bounded
 * the input. Every other plugin's deletions were on the path between a
 * client's cursor and its answer.
 *
 * Measured with one plugin holding a single tombstone, caught up, and polling
 * for nothing while another accumulates -- the poll that returns zero rows
 * forever, which is the steady state of every synced client:
 *
 *     other plugin's tombstones    50,000    100,000    200,000    400,000
 *     caught-up poll, before       3.26 ms    6.57 ms   13.00 ms   26.53 ms
 *     caught-up poll, after       0.004 ms   0.004 ms   0.004 ms   0.004 ms
 *
 * Perfectly linear before, because the walk is the whole cost, and the read
 * API spec's §8 records that tombstones accumulate forever with nothing
 * pruning them -- so that line has no ceiling over an installation's life. It
 * is `media_item_sync`'s shape one table over, and `mediaItemsSince` measured
 * 0.008 ms flat through the same fixture at every one of those sizes, for
 * exactly that reason.
 *
 * `(plugin_id, deleted_at, media_item_id)`, in that order: the equality
 * first, then the cursor's two columns in the order the query sorts them, so
 * one index supplies the narrowing, the seek and the order. The plan is
 * `SEARCH deleted_media_item USING COVERING INDEX deleted_media_item_sync
 * (plugin_id=? AND deleted_at>?)` -- covering, because the three columns are
 * the only three the query reads.
 *
 * **And `deleted_media_item_at` is dropped rather than kept alongside.** With
 * this index in place nothing reads it: `deletionsSince` is the only query
 * over this table, and `MediaWriter.dropMediaItem` writes it as an upsert on
 * the primary key. An index no query uses is still a B-tree maintained on
 * every tombstone write, and this branch has already shipped one of those --
 * migration 9's first draft duplicated `rss_item_updated`, and slice D
 * shipped two status indexes nothing used, which cost a 153 ms reconcile
 * tick before anyone measured it. The lesson is recorded and this is it
 * being applied: the replaced index goes in the same statement as its
 * replacement, so no database ever carries both.
 *
 * Not unique, although `media_item_id` is the table's primary key and so the
 * triple could never repeat: declaring it unique would add a constraint the
 * primary key already enforces, and a second place for a write to fail.
 */
const MIGRATION_11 = `
DROP INDEX deleted_media_item_at;
CREATE INDEX deleted_media_item_sync ON deleted_media_item (plugin_id, deleted_at, media_item_id);
`;

/**
 * `host_state` plus the four tables Better Auth's Drizzle adapter expects.
 *
 * **The column names are the library's, not this repo's choice.** The adapter
 * maps a model's fields onto the *schema object's property keys*, so the
 * Drizzle mirror in `schema.ts` is what has to spell `emailVerified`, and this
 * DDL is what has to spell `email_verified`. Renaming a column here is a
 * runtime failure `test/db/schema.test.ts` cannot see: the mirror would be
 * changed to agree with the DDL, both would agree, and Better Auth would ask
 * for a column neither has.
 *
 * **`auth_`-prefixed.** The library's defaults are `user`, `session`,
 * `account` and `verification` -- four of the most collidable names available,
 * in a schema where plugins are required to prefix their tables and the host
 * owns the unprefixed namespace. A future plugin wanting a `session` table
 * would otherwise be blocked for a reason nobody could see. The prefix costs
 * one `schema` object the adapter already accepts.
 *
 * **`id` is `TEXT` on all four, and these are the only tables in this schema
 * with a text `id`** -- every table above that *has* an `id` declares it
 * `id INTEGER PRIMARY KEY`, i.e. the rowid. The carve-out is why "every table
 * above" on its own read as false here: two of the tables above have no `id`
 * column at all (`host_state` in this same migration, keyed by a text `key`,
 * and `deleted_media_item`, keyed by `media_item_id INTEGER PRIMARY KEY`), and
 * neither does the migration runner's own bookkeeping further down this file
 * (`version INTEGER PRIMARY KEY` for `host_migrations`, composite
 * `PRIMARY KEY (plugin_id, version)` for `plugin_migrations`). None of those is
 * the same asymmetry: a caller-chosen key, the id of a row that no longer
 * exists, and a version number are not generated ids. Better Auth's default id
 * generator is a random
 * base62 string, and adopting it avoids configuring
 * `advanced.database.generateId` to something the library then has to be told
 * about. The asymmetry is the library's, and it is recorded here so it does not
 * read as an accident: an `INTEGER PRIMARY KEY` would *accept* a base62 string
 * -- SQLite's type affinity is permissive -- and then hand something else back,
 * which is why `test/db/migrate.test.ts` asserts the declaration from
 * `PRAGMA table_info` rather than from a successful round trip.
 *
 * **`auth_verification` has no writer in this slice**, the way
 * `external_reference` had none when it was created: nothing here sends mail,
 * so no email verification or password reset runs. It is created anyway
 * because the adapter expects the model to exist, and a table Better Auth may
 * write to is cheaper than discovering at runtime which code path needs it.
 * Nobody should hunt for the writer.
 *
 * **`host_state` is deliberately general** -- one key/value row per fact --
 * because it already holds two unrelated things (the generated signing secret
 * and the first-boot claim token) and a column per fact would mean a migration
 * per fact.
 *
 * **Three of these columns are credentials no other query may name.**
 * `auth_account.password` is a password hash, `auth_session.token` is a live
 * session, and `host_state.value` is the signing secret; only Better Auth's
 * own adapter and the module that persists that secret may select them.
 * Enforced at build time by `scripts/check-test-hygiene.ts`, as an AST walk
 * rather than a grep -- this very comment names all three verbatim, which is
 * exactly the shape that made a text match report twenty-two comments as
 * violations when that script was first written.
 */
const MIGRATION_12 = `
CREATE TABLE host_state (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_user (
  id             TEXT    PRIMARY KEY,
  name           TEXT,
  email          TEXT    NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX auth_user_email ON auth_user (email);

CREATE TABLE auth_session (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES auth_user (id),
  token      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX auth_session_token ON auth_session (token);
CREATE INDEX auth_session_user ON auth_session (user_id);

CREATE TABLE auth_account (
  id                       TEXT    PRIMARY KEY,
  user_id                  TEXT    NOT NULL REFERENCES auth_user (id),
  provider_id              TEXT    NOT NULL,
  account_id               TEXT    NOT NULL,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  INTEGER,
  refresh_token_expires_at INTEGER,
  scope                    TEXT,
  password                 TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX auth_account_user ON auth_account (user_id);

CREATE TABLE auth_verification (
  id         TEXT    PRIMARY KEY,
  identifier TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX auth_verification_identifier ON auth_verification (identifier);
`;

/**
 * Exported for tests: lets a test apply a prefix of the real migrations (e.g.
 * only version 1) rather than a synthetic list, so it can seed a row on the
 * pre-migration-2 schema and then watch the real `MIGRATION_2` DDL act on it.
 */
export const HOST_MIGRATIONS: readonly Migration[] = [
  { version: 1, up: (db) => db.exec(INITIAL_SCHEMA) },
  { version: 2, up: (db) => db.exec(MIGRATION_2) },
  { version: 3, up: (db) => db.exec(MIGRATION_3) },
  { version: 4, up: (db) => db.exec(MIGRATION_4) },
  { version: 5, up: (db) => db.exec(MIGRATION_5) },
  { version: 6, up: (db) => db.exec(MIGRATION_6) },
  { version: 7, up: (db) => db.exec(MIGRATION_7) },
  { version: 8, up: (db) => db.exec(MIGRATION_8) },
  { version: 9, up: (db) => db.exec(MIGRATION_9) },
  { version: 10, up: (db) => db.exec(MIGRATION_10) },
  { version: 11, up: (db) => db.exec(MIGRATION_11) },
  { version: 12, up: (db) => db.exec(MIGRATION_12) },
];

/**
 * Applies the host's own migrations, tracked in `host_migrations` — a
 * separate table and a separate version space from `plugin_migrations`, so a
 * plugin's version 1 and the host's version 1 never collide.
 *
 * Exported for tests: `migrateHost` is this with the real migration list.
 */
export function migrateHostWith(raw: DatabaseSync, list: readonly Migration[]): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS host_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    raw.prepare('SELECT version FROM host_migrations').all()
      .map((row) => Number((row as { version: unknown }).version)),
  );

  const record = raw.prepare('INSERT INTO host_migrations (version, applied_at) VALUES (?, ?)');

  for (const migration of list.toSorted((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    // The migration and the version row are one transaction, so a throw mid-
    // migration leaves no trace. SQLite's DDL autocommits, so without this a
    // crash between `up()` and `record.run()` would leave the schema applied
    // and the version unrecorded — the next boot would then re-run `up()`
    // straight into "table already exists".
    raw.exec('SAVEPOINT host_migration');
    try {
      migration.up(raw);
      record.run(migration.version, Date.now());
    } catch (err) {
      // `ROLLBACK TO` undoes the work but leaves the savepoint on the stack;
      // `RELEASE` is what pops it, so the connection is not left inside a
      // transaction that nothing will ever close.
      raw.exec('ROLLBACK TO host_migration');
      raw.exec('RELEASE host_migration');
      throw err;
    }
    raw.exec('RELEASE host_migration');
  }
}

export function migrateHost(raw: DatabaseSync): void {
  migrateHostWith(raw, HOST_MIGRATIONS);
}

const PLUGIN_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS plugin_migrations (
  plugin_id  TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version)
)`;

function tableNames(raw: DatabaseSync): Set<string> {
  return new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

/**
 * Applies a plugin's outstanding migrations and returns how many ran.
 *
 * Versions are per plugin, so two plugins may both ship a version 1 — the
 * primary key is `(plugin_id, version)` rather than `version` alone.
 *
 * Table names must start with `<pluginId>_`; the check diffs `sqlite_master`'s
 * persistent tables before and after `up()` runs, so it catches a migration
 * that creates a new host-visible table under the wrong name — the
 * two-plugins-sharing-a-table failure this exists to prevent. Everything else
 * passes silently: `CREATE TEMP TABLE` (invisible to `sqlite_master`, and
 * still fully usable), `DROP TABLE`, `ALTER TABLE`, and any view, index or
 * trigger under any name. So this is a tripwire on new-table creation, not a
 * sandbox around `up()` — which receives the raw connection and can do
 * anything that connection can do, the same limitation `PluginContext.db` has.
 */
export function migratePlugin(
  raw: DatabaseSync,
  pluginId: string,
  migrations: readonly Migration[],
): number {
  raw.exec(PLUGIN_MIGRATIONS);
  const done = new Set(
    raw.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?')
      .all(pluginId).map((row) => Number((row as { version: unknown }).version)),
  );
  let ran = 0;
  for (const migration of migrations.toSorted((a, b) => a.version - b.version)) {
    if (done.has(migration.version)) continue;
    const before = tableNames(raw);
    // The migration, the prefix check and the row recording the version are
    // one transaction, so a refused migration leaves no trace. SQLite's DDL
    // autocommits, so without this the throw below lands *after* the offending
    // table exists and *before* the version is recorded: the table survives
    // into the next boot, where it is in `before`, the migration appears to
    // create nothing new, the guard passes and the version is recorded as
    // applied. The enforcement would last exactly one process lifetime.
    raw.exec('SAVEPOINT plugin_migration');
    try {
      migration.up(raw);
      for (const name of tableNames(raw)) {
        if (before.has(name)) continue;
        if (!name.startsWith(`${pluginId}_`)) {
          throw new Error(
            `plugin ${pluginId} migration ${migration.version} created table ${name}, ` +
            `which lacks the required ${pluginId}_ prefix`,
          );
        }
      }
      raw.prepare('INSERT INTO plugin_migrations (plugin_id, version, applied_at) VALUES (?, ?, ?)')
        .run(pluginId, migration.version, Date.now());
    } catch (err) {
      // `ROLLBACK TO` undoes the work but leaves the savepoint on the stack;
      // `RELEASE` is what pops it, so the connection is not left inside a
      // transaction that nothing will ever close.
      raw.exec('ROLLBACK TO plugin_migration');
      raw.exec('RELEASE plugin_migration');
      throw err;
    }
    raw.exec('RELEASE plugin_migration');
    ran += 1;
  }
  return ran;
}
