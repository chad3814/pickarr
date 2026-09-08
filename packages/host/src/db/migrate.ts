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
 * foreign key: an item is deleted once, and a second tombstone for one id
 * would mean a reused rowid, which `INTEGER PRIMARY KEY` does not produce.
 * It is deliberately not a `REFERENCES media_item (id)` either -- the row it
 * names is gone, which is the entire point, so a reference would be
 * unsatisfiable by construction.
 *
 * `plugin_id` is copied onto the tombstone rather than looked up: by the
 * time anyone reads it there is nothing left on `media_item` to join to, and
 * a client syncing one media type must not be handed another plugin's
 * deletions.
 *
 * The three indexes exist because every cursor query in this slice orders by
 * `(updated_at, id)` and filters by plugin -- `media_item_sync` and
 * `rss_item_sync` serve that on their own tables, and
 * `deleted_media_item_at` serves the same shape on tombstones.
 */
const MIGRATION_9 = `
CREATE TABLE deleted_media_item (
  media_item_id INTEGER PRIMARY KEY,
  plugin_id     TEXT    NOT NULL,
  deleted_at    INTEGER NOT NULL
);
CREATE INDEX deleted_media_item_at ON deleted_media_item (deleted_at, media_item_id);
CREATE INDEX media_item_sync       ON media_item (plugin_id, updated_at, id);
CREATE INDEX rss_item_sync         ON rss_item (updated_at, id);
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
