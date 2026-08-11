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
 *
 * `source_uuid` is the answering service's identifier for the site, kept so a
 * later feature — pulling artwork, or a site's scene list — can address it
 * directly instead of searching by name again. ThePornDB also publishes a
 * numeric id, but `GET /sites/<id>` and `GET /sites/<uuid>` return the same
 * record, so storing both would be two columns for one fact. Nullable: a
 * negative answer identifies nothing, and a service without such an
 * identifier is still allowed to answer.
 */
const DISCOVERED_SITES = `
CREATE TABLE discovered_sites (
  prefix      TEXT PRIMARY KEY,
  site        TEXT,
  source      TEXT    NOT NULL,
  source_uuid TEXT,
  found_at    INTEGER NOT NULL
);
`;

/**
 * What a human, rather than the parser, decided about a row.
 *
 * `feed_items.dismissed_at` is "I have looked at this failure and it is not
 * worth fixing" — a third state alongside failed and resolved, and the default
 * filter of the Failed list. It is nullable rather than a boolean flag because
 * *when* it was waved off is the only thing that distinguishes an old
 * dismissal from a fresh one, and clearing it back to NULL is how a resolve
 * says the decision was reversed.
 *
 * The two `edited_at` columns record that the current values were typed rather
 * than parsed. Nothing reads them yet; they exist so that a future re-parse
 * pass can tell which rows it must not overwrite, which is a fact only
 * recordable at the moment of the edit.
 *
 * The partial index carries the Failed list's exact ORDER BY. `WHERE
 * parse_error IS NOT NULL` keeps it proportional to the failures rather than
 * to the whole feed history, which is the far larger table and never queried
 * this way. `id` is left ascending inside the index because the list tiebreaks
 * ascending on it — see `failedFeedItems`.
 */
const MANUAL_METADATA = `
ALTER TABLE feed_items   ADD COLUMN dismissed_at INTEGER;
ALTER TABLE media_groups ADD COLUMN edited_at    INTEGER;
ALTER TABLE releases     ADD COLUMN edited_at    INTEGER;

CREATE INDEX feed_items_failed
  ON feed_items (first_seen_at DESC, id) WHERE parse_error IS NOT NULL;
`;

/**
 * The index `latestDownloadFailed` needs.
 *
 * That predicate is `SELECT status FROM downloads WHERE release_id = ?
 * ORDER BY id DESC LIMIT 1`, and it is evaluated once per candidate release in
 * `deriveUpgradeReleaseId` and once per group on `/api/browse` and `/api/picks`
 * — so a table scan per release, over a table that only grows. `downloads` was
 * indexed on `group_id` but not `release_id`.
 *
 * `release_id` alone is enough for the `ORDER BY` too: SQLite appends the
 * rowid to every non-unique index entry, `downloads.id` *is* the rowid
 * (INTEGER PRIMARY KEY), so entries for one release are already ordered by id
 * and the descending limit is a backwards seek rather than a sort.
 */
const DOWNLOADS_BY_RELEASE = `
CREATE INDEX downloads_release ON downloads (release_id);
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
  {
    version: 3,
    up(db) {
      db.exec(MANUAL_METADATA);
    },
  },
  // 5, not 4. `main` (f4d3e3a, merging site-identity-key) already ships a
  // `version: 4` that re-keys site segments, and it landed first. The gap this
  // leaves in *this* branch is deliberate and closes on merge; `migrate` skips
  // nothing on account of it, and `assertUniqueVersions` is what makes a repeat
  // of the collision loud instead of silent.
  {
    version: 5,
    up(db) {
      db.exec(DOWNLOADS_BY_RELEASE);
    },
  },
];
