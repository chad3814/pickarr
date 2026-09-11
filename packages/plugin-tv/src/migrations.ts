/**
 * One migration, three tables: a series, its seasons, and one row per
 * downloadable thing.
 *
 * Version 2, not 1: version 1 is the engine's own state table, prepended by
 * `createLookupPlugin`. Every name starts with `tv_` because `migratePlugin`
 * enforces the plugin's id as the prefix and rejects a migration that creates
 * anything else.
 */
import type { Migration } from '@pickarr/contract';

export const TV_MIGRATIONS: readonly Migration[] = [{
  version: 2,
  up: (db) => db.exec(`
CREATE TABLE tv_series (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL,
  provider_ref   TEXT NOT NULL,
  title          TEXT NOT NULL,
  first_air_date TEXT,
  overview       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_series_provider_ref ON tv_series (provider, provider_ref);

CREATE TABLE tv_season (
  id            INTEGER PRIMARY KEY,
  series_id     INTEGER NOT NULL REFERENCES tv_series (id),
  provider      TEXT NOT NULL,
  provider_ref  TEXT NOT NULL,
  season_number INTEGER,
  title         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_season_provider_ref ON tv_season (provider, provider_ref);

CREATE TABLE tv_release (
  id             INTEGER PRIMARY KEY,
  media_item_id  INTEGER NOT NULL REFERENCES media_item (id),
  kind           TEXT NOT NULL,
  series_id      INTEGER NOT NULL REFERENCES tv_series (id),
  season_id      INTEGER REFERENCES tv_season (id),
  episode_number INTEGER,
  details_json   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_release_media_item ON tv_release (media_item_id);
`),
}];
