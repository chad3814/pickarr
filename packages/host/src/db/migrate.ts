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

const HOST_MIGRATIONS: readonly Migration[] = [{ version: 1, up: (db) => db.exec(INITIAL_SCHEMA) }];

/**
 * Applies the host's own migrations, tracked in `host_migrations` — a
 * separate table and a separate version space from `plugin_migrations`, so a
 * plugin's version 1 and the host's version 1 never collide.
 */
export function migrateHost(raw: DatabaseSync): void {
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

  for (const migration of HOST_MIGRATIONS.toSorted((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    migration.up(raw);
    record.run(migration.version, Date.now());
  }
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
