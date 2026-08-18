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

/**
 * The identity key's site segment, with its separators dropped.
 *
 * This is a frozen copy of `siteComparisonKey` (plugin-scenes/src/parse.ts),
 * deliberately not an import. A migration has to keep producing the keys it
 * produced the day it shipped; the plugin's helper belongs to code that is free
 * to change, and importing a plugin into core's schema history would also point
 * the dependency the wrong way round.
 *
 * Only the first segment is touched. A key is `site:anchor:scene-slug`, and the
 * scene slug's hyphens are word boundaries in a title that is *not* mutable —
 * stripping those too would collide scenes that are genuinely different. A key
 * with no colon at all is treated as a bare site segment, which is what the
 * shape says it would be.
 */
function rekeyedIdentity(identityKey: string): string {
  const colon = identityKey.indexOf(':');
  const site = colon === -1 ? identityKey : identityKey.slice(0, colon);
  const rest = colon === -1 ? '' : identityKey.slice(colon);
  return site.toLowerCase().replace(/[^a-z0-9]+/g, '') + rest;
}

interface ClusterMember {
  id: number;
  identityKey: string;
  pickedReleaseId: number | null;
}

/**
 * What makes two groups the same group.
 *
 * `UNIQUE (plugin, identity_key)` is a *pair*, so a cluster keyed on the new
 * identity alone is not the set of rows that would collide — it is a superset,
 * and merging over it deletes one plugin's group into another's.
 *
 * A newline is the separator because no plugin id and no identity key can hold
 * one — both are built from a parsed release name — so no pair of rows can
 * forge a cluster boundary between them.
 */
function clusterKey(plugin: string, identityKey: string): string {
  return `${plugin}\n${identityKey}`;
}

/**
 * `deriveUpgradeReleaseId` (db/groups.ts) written as one statement.
 *
 * Spelled out here rather than imported for the same reason as
 * `rekeyedIdentity`: what this migration does must not change when the
 * application's rule does. It has to be re-derived rather than carried across a
 * merge because the flag names a release id, and which release is the best one
 * available depends on the whole merged set — the survivor's old flag was
 * derived against half of it.
 *
 * Both NULL cases fall out of SQL's own semantics, and match the function:
 * with no pick, the inner subquery yields no row, `score > NULL` is NULL, no
 * release qualifies, and the flag becomes NULL. The `>` is strict, so a release
 * that merely ties the pick is not an upgrade.
 */
const DERIVE_UPGRADE_FLAG = `
  UPDATE media_groups
     SET upgrade_release_id = (
           SELECT r.id FROM releases r
            WHERE r.group_id = media_groups.id
              AND r.score > (SELECT p.score FROM releases p
                              WHERE p.id = media_groups.picked_release_id)
            ORDER BY r.score DESC, r.id DESC
            LIMIT 1)
   WHERE id = ?
`;

/**
 * Re-keys every group the old rule split, merging the ones that now collide.
 *
 * The bug: site *matching* compares alphanumerics only, so `TouchMyWife` and
 * `Touch My Wife` are one site, but the key's site segment was a slug that kept
 * separators as `-`, so they keyed as two. Any site confirmed after its first
 * release had been ingested therefore has its scenes in two groups. The key now
 * holds the separator-free form; this brings existing databases with it.
 *
 * Two separate things keep other plugins out, and they are not the same thing:
 *
 * - `clusterKey` puts the plugin in the cluster identity. This is *correctness*.
 *   `UNIQUE (plugin, identity_key)` is a pair, so two rows with the same new key
 *   under different plugins do not collide and must not merge; clustering on the
 *   key alone would delete one plugin's group into another's, silently.
 * - `WHERE plugin = 'scenes'` is *scope*. The scenes plugin is the one whose key
 *   rule changed; another plugin's first segment means whatever that plugin says
 *   it means, and a historical migration has no business rewriting an identity
 *   nothing asked it to rewrite.
 *
 * Removing the filter is therefore safe *only while `clusterKey` really does
 * carry the plugin* — the two are stated separately above because they are
 * separate reasons, not because either is redundant. Take the filter out with
 * the plugin missing from the cluster identity and one plugin's group is
 * deleted into another's. `a key collision across plugins is not a collision,
 * and does not merge` fails whichever of the two is removed, which is what
 * makes this comment checkable rather than a promise.
 *
 * The order inside a merge is not free. Every referencing row moves first —
 * `releases`, `downloads` and `imported_files`, all three, or `PRAGMA
 * foreign_keys = ON` turns the delete into an error and, worse, a delete that
 * did succeed would have taken a user's import history with it. The losers are
 * then deleted, and only then does the survivor take the new key: until the
 * losers are gone one of them may still be sitting on it, and
 * `UNIQUE (plugin, identity_key)` would reject the update.
 *
 * Three columns deliberately stand, on the survivor and on a lone re-key alike:
 *
 * - `list_rank_at`. What lifts a group to the top of a list is something
 *   *happening* to it — a release arriving, a download failing. These releases
 *   were already in the user's database; bumping would re-sort the whole list on
 *   upgrade.
 * - `created_at`. The survivor was created when it was created. Taking a
 *   loser's would date the row from a group that no longer exists.
 * - `edited_at`. It records that the current values were *typed* rather than
 *   parsed, so a future re-parse pass knows which rows not to overwrite. A
 *   migration is not a human, and stamping it would immunise every re-keyed
 *   group against that pass.
 */
function rekeySiteSegments(db: DatabaseSync): void {
  const clusters = new Map<string, { newKey: string; members: ClusterMember[] }>();
  // Ascending id, so "the lowest id" is simply the first member of a cluster.
  for (const row of db
    .prepare(
      `SELECT id, plugin, identity_key, picked_release_id
         FROM media_groups WHERE plugin = 'scenes' ORDER BY id`,
    )
    .all()) {
    const identityKey = String(row['identity_key']);
    const picked = row['picked_release_id'];
    const member: ClusterMember = {
      id: Number(row['id']),
      identityKey,
      pickedReleaseId: picked === null || picked === undefined ? null : Number(picked),
    };
    const newKey = rekeyedIdentity(identityKey);
    const key = clusterKey(String(row['plugin']), newKey);
    const cluster = clusters.get(key);
    if (cluster === undefined) clusters.set(key, { newKey, members: [member] });
    else cluster.members.push(member);
  }

  // A *live* imported file, unlike `groupHistory`'s question. The two ask
  // different things of the same table: `groupHistory` asks "has anything ever
  // happened to this group", for which a trashed file counts, while the rule
  // below asks "whose name is on a file that is on disk right now", for which
  // it does not. Every read path in `db/imported-files.ts` and the
  // `imported_files_live` index draw the same line.
  const history = db.prepare(
    `SELECT EXISTS (SELECT 1 FROM imported_files
                     WHERE group_id = ? AND trashed_at IS NULL) AS imported,
            EXISTS (SELECT 1 FROM downloads WHERE group_id = ?) AS downloaded`,
  );
  const hasHistory = (groupId: number, column: 'imported' | 'downloaded'): boolean =>
    Number(history.get(groupId, groupId)?.[column]) !== 0;

  // A pick is only a pick if it names a release the group actually holds. Run
  // after the move, so "holds" means the merged set.
  const heldRelease = db.prepare('SELECT 1 AS held FROM releases WHERE id = ? AND group_id = ?');
  const holds = (releaseId: number | null, groupId: number): boolean =>
    releaseId !== null && heldRelease.get(releaseId, groupId) !== undefined;

  const moveReleases = db.prepare('UPDATE releases SET group_id = ? WHERE group_id = ?');
  const moveDownloads = db.prepare('UPDATE downloads SET group_id = ? WHERE group_id = ?');
  const moveImportedFiles = db.prepare('UPDATE imported_files SET group_id = ? WHERE group_id = ?');
  const adoptPick = db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = ? WHERE id = ?",
  );
  const deleteGroup = db.prepare('DELETE FROM media_groups WHERE id = ?');
  const setKey = db.prepare('UPDATE media_groups SET identity_key = ? WHERE id = ?');
  const deriveUpgradeFlag = db.prepare(DERIVE_UPGRADE_FLAG);

  for (const { newKey, members } of clusters.values()) {
    const first = members[0];
    if (first === undefined) continue;

    if (members.length === 1) {
      // A key whose site segment never held separators is left exactly as it
      // was — no write at all, so nothing about the row can drift.
      if (first.identityKey !== newKey) setKey.run(newKey, first.id);
      continue;
    }

    // The group with a live imported file first: its name is on a file on disk,
    // under a path rendered from it. Then the group with a download recorded
    // against it. Then the oldest, which is the one the rest of the system has
    // had longest.
    //
    // `display` is deliberately not consulted, though it is what
    // `path-template.ts` now renders `{site}`, `{Site}` and `{SiteName}` from.
    // `buildRelease` always sets `display.subtitle`, so a group without one
    // needs a hand-edited database, and even then the template falls back to
    // the key's site segment — which this migration has just corrected. The
    // cost of the case is a run-together word in a path that is otherwise
    // right; adding a clause to the survivor rule for it would be choosing a
    // survivor by cosmetics over one that has files on disk.
    const survivor =
      members.find((m) => hasHistory(m.id, 'imported')) ??
      members.find((m) => hasHistory(m.id, 'downloaded')) ??
      first;
    const losers = members.filter((m) => m.id !== survivor.id);

    for (const loser of losers) {
      moveReleases.run(survivor.id, loser.id);
      moveDownloads.run(survivor.id, loser.id);
      moveImportedFiles.run(survivor.id, loser.id);
    }

    // A pick names a release the user owns a file for. That release has just
    // changed groups, not disappeared, so a survivor with nothing picked adopts
    // it — dropping it would tell the user they no longer have a file they do.
    // `state` travels with it: a row holding a pick while still reading 'new'
    // is off the Picks page and back in Browse, which is the same loss wearing
    // a different hat.
    //
    // Only a pick that resolves counts, on either side. A `picked_release_id`
    // naming a release that no longer exists is already broken, and this is the
    // one moment it could be made worse: adopted onto an unpicked survivor it
    // would take a working group *out* of Browse and point it at nothing, and
    // held by the survivor it would outrank a loser's real pick. This does not
    // repair a dangling pick the survivor already had — the migration did not
    // create it, and clearing a pick is a change nothing asked for — but it
    // will not spread one.
    const donors = losers.filter((m) => holds(m.pickedReleaseId, survivor.id));
    let pickedReleaseId = holds(survivor.pickedReleaseId, survivor.id)
      ? survivor.pickedReleaseId
      : null;
    if (pickedReleaseId === null) {
      const donor = donors[0];
      if (donor !== undefined) {
        pickedReleaseId = donor.pickedReleaseId;
        adoptPick.run(pickedReleaseId, survivor.id);
      }
    }
    for (const donor of donors) {
      if (donor.pickedReleaseId === pickedReleaseId) continue;
      // The only place this migration discards anything. Two groups that were
      // always one scene both had a release picked; there can be one pick, so
      // the survivor's stands and the other release stays an ordinary member of
      // the group. Said out loud because no other record of it survives.
      console.warn(
        `pickarr: migration 4 merged group ${donor.id} into group ${survivor.id} under ` +
          `identity '${newKey}'; both had a pick, so release ${donor.pickedReleaseId} is no ` +
          `longer picked and release ${pickedReleaseId} stands.`,
      );
    }

    for (const loser of losers) deleteGroup.run(loser.id);
    if (survivor.identityKey !== newKey) setKey.run(newKey, survivor.id);
    deriveUpgradeFlag.run(survivor.id);
  }
}

/**
 * Metadata a group has been given by a remote service, and the queue of
 * groups still waiting to be asked about.
 *
 * A `group_metadata` row means *answered*. `state = 'none'` is a real answer —
 * "the service was asked and knows no such scene" — and is what stops a lazy,
 * browse-driven trigger from re-asking the same question on every page view.
 * The reasoning is `discovered_sites`', one table up, applied to scenes.
 *
 * `state` is a column rather than something inferred from `source_uuid IS
 * NULL`, because `discovered_sites` had to make its uuid nullable for a
 * provider that publishes no identifier: nullability there already means
 * "no identifier", so it cannot also mean "no match".
 *
 * A queue row is deleted the moment an answer is written, so the table stays
 * proportional to outstanding work rather than to history, and *pending* is
 * exactly *has a queue row*.
 *
 * `metadata_candidates` holds what was rejected and why. Nothing displays it.
 * It exists so a later merge-suggestion feature has evidence, and so the
 * confirmation rule can be measured rather than argued about.
 *
 * `discovered_sites.source_id` is the site's *integer* id. Migration 2 stored
 * only the uuid, reasoning that `GET /sites/<id>` and `GET /sites/<uuid>`
 * return the same record so a second column would be two columns for one
 * fact. True of fetching a site; not true of filtering scenes, where
 * `GET /scenes?site_id=` accepts only the integer. Nullable, and backfilled
 * for free from the `site` object embedded in any scene response.
 */
const SCENE_METADATA = `
CREATE TABLE group_metadata (
  group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
  state        TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  source_uuid  TEXT,
  title        TEXT,
  performers   TEXT,
  release_date TEXT,
  duration_s   INTEGER,
  synopsis     TEXT,
  poster_url   TEXT,
  poster_path  TEXT,
  fetched_at   INTEGER NOT NULL
);

CREATE TABLE metadata_queue (
  group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
  requested_at INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER NOT NULL,
  last_error   TEXT
);
CREATE INDEX metadata_queue_due ON metadata_queue (next_at);

CREATE TABLE metadata_candidates (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES media_groups (id),
  source      TEXT    NOT NULL,
  source_uuid TEXT,
  title       TEXT    NOT NULL,
  scene_date  TEXT,
  reason      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX metadata_candidates_group ON metadata_candidates (group_id);

ALTER TABLE discovered_sites ADD COLUMN source_id INTEGER;
`;

/**
 * One small operational fact about this installation per row.
 *
 * A generic key-value table earns its keep only while it stays small, so the
 * rule is written here rather than left to taste: a row is a pass marker, a
 * cursor, a "when did this last run" — something singular, operational, and
 * never read in bulk. Not user data. Not anything joined against. Not anything
 * with enough structure to want columns; that earns a real table. Keys are
 * namespaced `subsystem:name` so a reader can tell at a glance who owns one.
 *
 * It exists because the re-key pass is deliberately not a migration — it runs
 * the live parser, so it has no place in `schema_migrations` — and it still
 * needs somewhere to record that it has run. See
 * docs/superpowers/specs/2026-08-14-rekey-scene-slugs-design.md.
 */
const APP_STATE = `
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Where each feed's walk back through its own pagination has reached.
 *
 * A table rather than an `app_state` row, on `app_state`'s own terms: what is
 * stored here has a position, a terminal state and a reason, which is "enough
 * structure to want columns". Packing it into one JSON `value` is exactly what
 * that comment rules out.
 *
 * `next_page` is a **zero-based page index for both pagination styles**, not an
 * offset. The offset arithmetic and the one-based `?page=` conversion both live in
 * URL composition, so a position keeps meaning the same thing if a feed's `style`
 * is corrected after the walk has started.
 *
 * `state` distinguishes three ways of stopping that a boolean would collapse:
 * `done` (a page held nothing new — the history is read), `exhausted`
 * (`maxPages` reached, so there is more and we stopped anyway) and `broken` (the
 * indexer is not paginating at all; asking again is pointless). `detail` carries
 * which, in words, so the difference survives without reading logs.
 *
 * `feed_id` is a config id, so there is deliberately no foreign key — nothing in
 * the database owns the feed list. A feed removed from config leaves a row that
 * harmlessly says "if this comes back, here is where it had reached".
 */
const FEED_BACKFILL = `
  CREATE TABLE IF NOT EXISTS feed_backfill (
    feed_id    TEXT    PRIMARY KEY,
    next_page  INTEGER NOT NULL,
    pages_read INTEGER NOT NULL,
    state      TEXT    NOT NULL,
    detail     TEXT,
    updated_at INTEGER NOT NULL
  )
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
  {
    version: 4,
    up(db) {
      rekeySiteSegments(db);
    },
  },
  // 5, not 4. This index was written while `main` was independently taking a
  // `version: 4` that re-keys site segments, and that one landed first. Two
  // migrations claiming one number is worse than it sounds: on a fresh database
  // the second is a UNIQUE violation that stops the process, and on a database
  // already carrying the other it is skipped in silence, leaving the index
  // absent and the query it exists for scanning the table. `migrate` now
  // refuses duplicate versions by name rather than leaving SQLite to report it.
  {
    version: 5,
    up(db) {
      db.exec(DOWNLOADS_BY_RELEASE);
    },
  },
  // 6, and the same story a second time: this was written as `version: 5` while
  // the index above was taking that number on `main`. It is the second instance
  // of the collision the comment above describes, which is the argument for the
  // duplicate-version guard being a check in code rather than a convention.
  {
    version: 6,
    up(db) {
      db.exec(SCENE_METADATA);
    },
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE performers (
          id          INTEGER PRIMARY KEY,
          source      TEXT    NOT NULL,
          source_uuid TEXT    NOT NULL,
          slug        TEXT    NOT NULL,
          name        TEXT    NOT NULL,
          kind        TEXT    NOT NULL,
          face_url    TEXT,
          face_path   TEXT,
          image_url   TEXT,
          image_path  TEXT,
          fetched_at  INTEGER NOT NULL,
          UNIQUE (source, source_uuid)
        );

        CREATE TABLE group_performers (
          group_id     INTEGER NOT NULL REFERENCES media_groups (id),
          performer_id INTEGER NOT NULL REFERENCES performers (id),
          position     INTEGER NOT NULL,
          PRIMARY KEY (group_id, performer_id)
        );
        CREATE INDEX group_performers_performer ON group_performers (performer_id);

        ALTER TABLE group_metadata ADD COLUMN scene_slug TEXT;
      `);

      // Every group already answered holds names and nothing else — no slug,
      // no avatar, no link. Queue them so the existing worker refetches at
      // its own rate. This bypasses `enqueueMetadata`'s "already answered"
      // guard deliberately: that guard stops a *lazy browse trigger* from
      // re-asking forever, and a one-time backfill is not that. Routing this
      // through the guard would mean weakening the guard.
      //
      // `state = 'confirmed'` only. A 'none' answer has no performers to
      // enrich, and re-asking it is exactly the loop the guard prevents.
      //
      // `requested_at` is stamped far in the future, and the two columns are
      // doing different jobs: `dueMetadataQueue` filters on `next_at` and
      // *orders* by `requested_at`. Stamping `next_at` at 0 keeps every
      // backfill row immediately due, so the worker starts draining them on
      // its first tick; stamping `requested_at` at 4102444800000 —
      // 2100-01-01T00:00:00Z — sorts all of them behind any request a user's
      // browse makes after the upgrade, whose `requested_at` is a real clock
      // reading. A round future date rather than a bit pattern: the first
      // attempt at this used 2^40, which reads like a large number and is in
      // fact November 2004, and the test below caught it.
      //
      // The obvious alternative — `requested_at = fetched_at`, the group's
      // own answer time — does the exact opposite, and that is the bug this
      // is written against: every backfill row would be a historical
      // timestamp, sorting ahead of every post-upgrade request. A freshly
      // ingested group the user is looking at right now would sit at
      // `pending` behind the entire backlog.
      //
      // Expected drain shape: the whole backfill is due at once and drains at
      // the worker's own rate — roughly one group per tick, slower per group
      // once each pulls a poster and up to two images per performer — so a
      // few thousand groups is hours of background work. Throughout it, any
      // group browsed after the upgrade jumps the queue and resolves in the
      // next tick or two, which is the property that makes those hours
      // invisible rather than infuriating.
      db.exec(`
        INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
        SELECT group_id, 4102444800000, 0, 0
        FROM group_metadata WHERE state = 'confirmed'
        ON CONFLICT (group_id) DO NOTHING
      `);
    },
  },
  // 8: replaces the poll counter with a timestamp for the same reason a poll
  // count was never a safe clock — reconcile runs under `tryRun`, so ticks are
  // dropped for the entire duration of a long import, and "three missed polls"
  // is not thirty seconds when the tick that would have counted them never
  // ran. `absent_since` records when a download was first not seen at the
  // client instead of how many times it was not seen, which is a fact
  // reconcile can act on regardless of how the ticks in between were spaced.
  //
  // `missing_polls` is left in place rather than dropped: `DROP COLUMN` is
  // available in this SQLite version, but rewriting a live table buys nothing
  // for one small integer column, and leaving it makes this migration
  // trivially reversible. Nothing reads or writes it any more — its helpers
  // and their last call sites in `pipeline/reconcile.ts` are gone, and
  // `downloads.ts` no longer even selects it — so this comment is the column's
  // only remaining mention.
  {
    version: 8,
    up(db) {
      db.exec('ALTER TABLE downloads ADD COLUMN absent_since INTEGER;');
    },
  },
  // 9, not 8, and the third instance of the story the comments above tell. This
  // table was written as `version: 8` while `main` was independently taking that
  // number for the `absent_since` column directly above, and that one landed
  // first. The guard those earlier collisions bought did its job: a merged list
  // carrying two 8s is refused by `assertUniqueVersions` before a statement
  // runs, naming the version — rather than a fresh database reporting a UNIQUE
  // violation on `schema_migrations`, or a database already holding the other 8
  // skipping this table in silence and leaving the queue absent with no error
  // anywhere. Renumbered per that function's own instruction: versions are a
  // total order, not labels, so the later arrival moves.
  {
    version: 9,
    up(db) {
      db.exec(`
        CREATE TABLE performer_queue (
          group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
          requested_at INTEGER NOT NULL,
          attempts     INTEGER NOT NULL DEFAULT 0,
          next_at      INTEGER NOT NULL,
          last_error   TEXT
        );

        CREATE INDEX performer_queue_due ON performer_queue (next_at);
      `);
    },
  },
  // 10, and the fourth instance of the story above — which is now less a
  // recurring accident than a property of how this project works. This table
  // was written as `7`, renumbered to `8` when `main` took 7 for the performer
  // tables, and renumbered again when `main` took both 8 and 9 while the
  // re-key branch was in flight. Three parallel branches, each picking the
  // next free number correctly at the moment it looked, is enough to collide;
  // checking before picking is necessary but not sufficient, because the
  // answer expires. `assertUniqueVersions` is what actually holds the line,
  // and it has now caught this four times.
  {
    version: 10,
    up(db) {
      db.exec(APP_STATE);
    },
  },
  // 11 was free when this was written, and the comment above is the reason that
  // sentence is worth nothing on its own. Checked again immediately before
  // committing; `assertUniqueVersions` is what will actually catch it if another
  // branch took it first.
  {
    version: 11,
    up(db) {
      db.exec(FEED_BACKFILL);
    },
  },
];
