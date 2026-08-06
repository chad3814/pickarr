import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

const INITIAL = `
CREATE TABLE feed_items (
  id            INTEGER PRIMARY KEY,
  feed_id       TEXT    NOT NULL,
  guid          TEXT    NOT NULL,
  raw_title     TEXT    NOT NULL,
  link          TEXT    NOT NULL,
  published_at  INTEGER,
  first_seen_at INTEGER NOT NULL,
  parse_error   TEXT,
  UNIQUE (feed_id, guid)
);

CREATE TABLE media_groups (
  id                 INTEGER PRIMARY KEY,
  plugin             TEXT    NOT NULL,
  identity_key       TEXT    NOT NULL,
  display            TEXT    NOT NULL,
  search_text        TEXT    NOT NULL,
  state              TEXT    NOT NULL DEFAULT 'new',
  picked_release_id  INTEGER,
  upgrade_release_id INTEGER,
  created_at         INTEGER NOT NULL,
  list_rank_at       INTEGER NOT NULL,
  UNIQUE (plugin, identity_key)
);
CREATE INDEX media_groups_browse ON media_groups (list_rank_at DESC);

CREATE TABLE releases (
  id           INTEGER PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES media_groups (id),
  feed_item_id INTEGER NOT NULL UNIQUE REFERENCES feed_items (id),
  quality      TEXT    NOT NULL,
  score        REAL    NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX releases_group ON releases (group_id, score DESC);

CREATE TABLE downloads (
  id            INTEGER PRIMARY KEY,
  release_id    INTEGER NOT NULL REFERENCES releases (id),
  group_id      INTEGER NOT NULL REFERENCES media_groups (id),
  client_id     TEXT    NOT NULL,
  client_ref    TEXT,
  kind          TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  storage_path  TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  missing_polls INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX downloads_client_ref
  ON downloads (client_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX downloads_group ON downloads (group_id);

CREATE TABLE imported_files (
  id          INTEGER PRIMARY KEY,
  download_id INTEGER NOT NULL REFERENCES downloads (id),
  group_id    INTEGER NOT NULL REFERENCES media_groups (id),
  source_path TEXT    NOT NULL,
  dest_path   TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  trashed_at  INTEGER,
  trash_path  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX imported_files_live ON imported_files (group_id) WHERE trashed_at IS NULL;
`;

/**
 * The answers a site lookup has already given, positive and negative alike.
 *
 * `site IS NULL` is a real answer — "this prefix is not a site" — and is the
 * reason the table exists rather than a plain list. Without persisted
 * negatives, every tick would re-ask the metadata service about the same
 * unresolvable prefixes for as long as the feed keeps serving them.
 *
 * `prefix` is the slug of the queried text, so lookups are insensitive to the
 * separators and casing a particular release happened to use.
 */
const DISCOVERED_SITES = `
CREATE TABLE discovered_sites (
  prefix   TEXT PRIMARY KEY,
  site     TEXT,
  source   TEXT    NOT NULL,
  found_at INTEGER NOT NULL
);
`;

export const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(INITIAL);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(DISCOVERED_SITES);
    },
  },
];
