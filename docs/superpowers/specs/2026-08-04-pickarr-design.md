# Pickarr — Design

Date: 2026-08-04
Status: approved for planning

## 1. What Pickarr is

Sonarr, Radarr, and Whisparr are automation tools. You tell them what you want, and
they acquire it. Pickarr inverts that: it reads RSS feeds, works out what each release
actually *is*, collates the different versions of the same thing together, and presents
the result for a human to browse and pick from. Nothing is downloaded without a click.

Pickarr remembers what you picked. When a better version of something you own shows up
in a feed later, that item jumps back to the top of the list with an upgrade flag, and
you can take it or leave it.

Media types differ in the parts that are specific — how release names decode, where
files belong on disk, what counts as better. Those live in plugins. Feed reading,
collation, download-client communication, file movement, and the picking experience
are the same everywhere, and live in core.

The MVP follows one RSS feed, sends picks to SABnzbd, and moves completed files into a
fixed library layout. It runs in a Docker container.

## 2. Scope

In scope for the MVP:

- One or more RSS feeds, polled on an interval.
- One media-type plugin: adult scenes.
- One download client: SABnzbd.
- Browse, pick, and upgrade flows.
- Import to disk, including replacing a superseded file.

Explicitly out of scope:

- **Authentication.** Pickarr listens with no login. Deploy it on a LAN or behind a
  reverse proxy. There is no users table and no session handling.
- **Library scanning.** Pickarr knows only about media it picked itself. It does not
  walk existing files on disk to seed state.
- **Retention.** Un-picked groups never expire. Volume is handled with pagination and
  search, not deletion.
- **Torrent clients.** The download-client interface is written to accommodate one, but
  none is implemented.
- **Remote metadata lookup.** Identity comes from the release name alone. The plugin
  contract is shaped so a provider can be added later without a schema change.

## 3. Stack

- Node 24
- TypeScript 7 (`tsgo`, from `@typescript/native-preview`), typecheck only — `--noEmit`
- Fastify (HTTP), React + Vite (SPA), `node:sqlite` (storage)
- esbuild for bundling, oxlint for linting, `node:test` for tests
- zod for config and request validation

### Two deliberate deviations from house rules

**`node:sqlite` is synchronous.** The standing preference is async APIs over their
synchronous twins, because a blocked event loop stalls everything sharing it. Every
usable SQLite binding for Node is synchronous — `node:sqlite` and `better-sqlite3` both
are; only `@libsql/client` offers an async surface, and it drags in a Rust core to talk
to a local file. Decision: use `node:sqlite`, keep every query indexed and
point-shaped, and accept blocking measured in microseconds at single-user scale. The one
operation where blocking would genuinely hurt is copying media files during import, and
that uses `fs.promises` regardless.

**TypeScript 7 is a preview.** `tsgo` is the native Go compiler and is not yet at
parity with `tsc` on flags and emit. It is used here only for typechecking, which is the
part it does best; esbuild handles all transpilation. If `tsgo` proves unworkable, the
fallback is `tsc --noEmit` with no other change to the repo.

## 4. Repo layout

npm workspaces:

```
packages/
  plugin-api/       @pickarr/plugin-api      types + shared ranking helpers
  core/             @pickarr/core            fastify, sqlite, pipeline
  web/              @pickarr/web             vite + react SPA
  plugin-scenes/    @pickarr/plugin-scenes   adult scene plugin
```

`plugin-api` depends on nothing. `core` and every plugin depend on `plugin-api`, and
never on each other. That acyclic shape is what prevents "plugin" from decaying into
"part of core." The shared quality ranker lives in `plugin-api` rather than `core` so a
plugin can call it without pulling in the server.

`core` loads plugins by dynamic `import()` of the package names listed in config. The
deployment consequence is real and accepted: the container can only import plugins
installed in it, so the shipped image bundles the first-party plugins and config selects
which are active. A genuine third-party plugin requires a derived image.

Node's type stripping deliberately skips files under `node_modules`, and workspace
packages are symlinked there — so the server cannot run directly off `.ts` once it
imports `@pickarr/plugin-api`. Every package is bundled to ESM with esbuild. Dev runs
esbuild in watch mode.

## 5. Plugin contract

```ts
export interface DisplayFields {
  title: string;
  subtitle?: string;
  date?: string;                                   // ISO 8601
  fields: { label: string; value: string }[];
}

export interface QualityTokens {
  resolution?: number;                             // 1080, 2160
  source?: string;                                 // WEB-DL, BluRay, SiteRip
  videoCodec?: string;
  audioCodec?: string;
  bitrateKbps?: number;
  sizeBytes?: number;
  releaseGroup?: string;
  extras?: Record<string, string | number | boolean>;
}

export interface ParsedRelease {
  identityKey: string;
  display: DisplayFields;
  quality: QualityTokens;
}

export interface DownloadedFile {
  absolutePath: string;                            // as Pickarr sees it, post path-mapping
  relativePath: string;                            // relative to the completed dir
  sizeBytes: number;
}

export interface ImportPlan {
  files: {
    source: string;                                // an absolutePath from the input listing
    destination: string;                           // relative to the plugin's libraryRoot
  }[];
}

export interface MediaTypePlugin {
  readonly id: string;
  readonly displayName: string;
  parse(releaseName: string): ParsedRelease | null;
  score(quality: QualityTokens): number;
  planImport(media: ParsedRelease, files: DownloadedFile[]): ImportPlan | null;
}
```

A plugin package default-exports a factory that receives its own config slice and
returns a `MediaTypePlugin`.

Two identifiers are in play and they are not interchangeable. Config keys and
`feeds[].plugin` use the **package name** (`@pickarr/plugin-scenes`), because that is
what `import()` needs. `media_groups.plugin` stores the plugin's **`id`** (`scenes`),
because that is stable across a package rename and identity must not break if the
package is ever republished under a different name. Core resolves package name to `id`
at boot and rejects a config in which two packages claim the same `id`.

**`parse`** returns `null` for an unrecognized name. That is an expected outcome, not an
error — it produces a `parse_error` row and ingest continues. Thrown exceptions are
caught and recorded the same way.

`identityKey` is both the collation key and the forward-compatibility seam. The scenes
plugin builds it from studio, performers, and date. A later version can make it a
StashDB identifier and core is unaffected.

**`score`** returns a number. `plugin-api` exports `scoreStandardQuality(tokens)`
implementing the shared resolution/source/codec ladder; a plugin with no special opinion
delegates to it in one line, and one with an opinion adjusts the result. Scores are only
ever compared between releases in the same group, so they carry no cross-plugin meaning.

**`planImport`** receives the parsed media and the completed download's file listing,
and returns source/destination pairs. Destinations are relative to the plugin's
configured `libraryRoot`. Core resolves and normalizes each one and rejects any that
escapes that root, so a parser bug cannot cause a write outside the library. Returning
`null` fails the import with `no-importable-files`.

Plugins have no access to the database, the HTTP server, or the download clients.

## 6. Data model

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

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
  display            TEXT    NOT NULL,   -- JSON DisplayFields
  search_text        TEXT    NOT NULL,
  state              TEXT    NOT NULL DEFAULT 'new',   -- new | picked
  picked_release_id  INTEGER REFERENCES releases (id),
  upgrade_release_id INTEGER REFERENCES releases (id),
  created_at         INTEGER NOT NULL,
  list_rank_at       INTEGER NOT NULL,
  UNIQUE (plugin, identity_key)
);
CREATE INDEX media_groups_browse ON media_groups (list_rank_at DESC);

CREATE TABLE releases (
  id           INTEGER PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES media_groups (id),
  feed_item_id INTEGER NOT NULL UNIQUE REFERENCES feed_items (id),
  quality      TEXT    NOT NULL,        -- JSON QualityTokens
  score        REAL    NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX releases_group ON releases (group_id, score DESC);

CREATE TABLE downloads (
  id            INTEGER PRIMARY KEY,
  release_id    INTEGER NOT NULL REFERENCES releases (id),
  group_id      INTEGER NOT NULL REFERENCES media_groups (id),
  client_id     TEXT    NOT NULL,
  client_ref    TEXT,                   -- sabnzbd nzo_id
  kind          TEXT    NOT NULL,       -- initial | upgrade
  status        TEXT    NOT NULL,       -- queued | downloading | completed
                                        -- | importing | imported | failed
  storage_path  TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  missing_polls INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX downloads_client_ref
  ON downloads (client_id, client_ref) WHERE client_ref IS NOT NULL;

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
```

`media_groups.picked_release_id` and `upgrade_release_id` reference a table declared
after it. Insert order is group (with nulls) → release → update group, so this is never
a problem in practice.

### Why `created_at` and `list_rank_at` are separate

`created_at` records when a group first appeared and never changes. `list_rank_at` is
the browse sort key. It starts equal to `created_at` and is set to the current time in
exactly one situation: an upgrade being flagged. That single write is the entire "bump
to the top" behavior, and its narrowness is what makes a new release joining an unpicked
group inert.

### Ingest rule

Parse the release name. Upsert the group by `(plugin, identity_key)`. Insert the
release. Then:

- Group is `new` → stop. `list_rank_at` is not touched.
- Group is `picked` → if the new release outscores both the picked release and any
  currently flagged upgrade, set `upgrade_release_id` and stamp `list_rank_at` to now.
  Otherwise stop.

### Browse rule

```sql
SELECT ... FROM media_groups
WHERE state = 'new' OR upgrade_release_id IS NOT NULL
ORDER BY list_rank_at DESC
```

One query covers both cases. A picked group with nothing better than what you own drops
out of the browse list, and returns to the top the moment something better arrives.
Picked groups are always visible in their own view regardless of upgrade state.

A group's display fields come from the release that created it. Identity-bearing fields
are equal across the group by construction, so later releases differ only in quality
tokens, which belong to the release row.

`search_text` is written at group creation as the lowercased concatenation of the
display title, subtitle, and every field value. The browse endpoint's `q` parameter
matches against it with `LIKE '%…%'`. That is adequate for a single-user list and avoids
an FTS5 table; if it stops being adequate, FTS5 is an additive migration.

## 7. Pipeline

Two timers, each guarded by an async mutex so a tick cannot overlap itself.

**Ingest** — per feed, default 900s. Fetch, parse XML, bulk-insert `feed_items` with
`ON CONFLICT DO NOTHING`, and process only the rows that actually inserted. This is what
makes "only unseen items are processed" true even when a feed re-serves its whole
history. A feed that fails to fetch logs and waits for the next tick; the interval is
the backoff. An item that fails to parse gets a `parse_error` and the batch continues.

**Pick** — synchronous with the HTTP request. In one transaction: set the group's
`state` to `picked` and `picked_release_id` to the chosen release, and insert a
`downloads` row as `queued`. Then call SABnzbd `addurl` with the client's category,
store the returned `nzo_id`, and move to `downloading`. If `addurl` fails, the row stays
`queued` with a null `client_ref` and the pick still succeeds — the user is never
blocked by an unreachable download client.

`picked_release_id` is set at pick time, not at import time, because the ingest rule
compares incoming releases against it and must have something to compare against while a
download is still in flight. For an upgrade it is repointed when the replacement
finishes importing, so it always names the release you chose most recently.

**Reconcile** — per client, default 10s. One queue call and one history call, both
filtered by the client's configured category. That is a fixed two requests per tick
regardless of how many downloads are in flight. From the resulting snapshot:

- Tracked downloads (`client_ref` matches a row) advance through the state machine, and
  have `missing_polls` reset to 0 on every tick in which they are seen.
- `queued` rows with a null `client_ref` get an `addurl` retry, incrementing `attempts`.
  After 5 attempts the row is failed with `addurl-failed`.
- Untracked entries — an `nzo_id` in the category with no matching row — are kept in the
  reconciler's in-memory snapshot for display and nothing else. They are never imported
  and never written to the database. Persisting them would leave orphan rows every time
  SABnzbd prunes history, and Pickarr holds no state about them worth keeping.
- A tracked download missing from both queue and history increments `missing_polls`.
  At three consecutive misses it is failed with `disappeared-from-client`. Three rather
  than one, because a download moving from queue to history can briefly appear in
  neither.

**Import** — triggered when reconcile observes a download reach `completed`. The row
moves to `importing` for the duration and to `imported` on success, which is what makes
the boot-time recovery in §8 work. Steps: map the SABnzbd-reported path through the
client's `pathMappings`, list the directory recursively, call `planImport`, validate
every destination resolves under the plugin's `libraryRoot` after normalization, then
transfer each file per the client's `importMode`, inserting the `imported_files` row
after each one. Imports run serially; a slow copy to a NAS must not fan out.

`importMode: "move"` attempts `fs.promises.rename` and falls back to copy-then-unlink on
`EXDEV`, since the downloads volume and the library volume are frequently different
filesystems even when both are mounted in the same container.

**Upgrade replacement** runs in a fixed order: move the previous live `imported_files`
paths (those with `trashed_at IS NULL`) into `trashDir` and stamp `trashed_at` and
`trash_path`, move the new files into place, then repoint `picked_release_id` and clear
`upgrade_release_id`. Trash first, because the new file usually wants the same
destination path. If the second step fails, the download is marked `failed` with the
trash location in the error message, so the old file is both recoverable and locatable.

Trashed files land at `<trashDir>/<groupId>/<importedAtEpochMs>/<originalBasename>` so
that repeated upgrades of the same group cannot collide.

## 8. Failure handling

Nothing retries forever. Failed downloads sit in the download center with their error
and a manual retry. Retry resumes from the furthest point already reached: a row that
has a `storage_path` goes back to `completed` so only the import is redone, and anything
else goes back to `queued` with `attempts` and `missing_polls` reset to 0.

Pickarr never empties `trashDir`. Reclaiming that space is the operator's job, which
keeps the only destructive operation in the system a manual one.

Crash recovery is two statements at boot, which is the payoff for keeping the state
machine in the database rather than in a queue:

- Anything in `importing` resets to `completed`, so the next tick redoes the import.
- Anything `queued` with a null `client_ref` is retried.

Per-file import is idempotent on retry: a planned file whose destination exists and
whose source does not is treated as already done and simply recorded. That covers a
crash partway through a multi-file import.

A malformed config, an unreadable secret file, or a plugin package that fails to import
are all fatal at boot with a non-zero exit and a message naming the offending field or
path.

## 9. HTTP API

```
GET  /api/browse?cursor=&limit=&q=     groups + releases, list_rank_at DESC
POST /api/groups/:id/pick              { releaseId } → creates a download
GET  /api/picks
GET  /api/downloads                    DB rows merged with the untracked snapshot
POST /api/downloads/:id/retry
GET  /api/health
```

Request and response bodies are validated with zod. No secret value is ever returned by
any route.

There is no SSE or WebSocket. The downloads view polls `/api/downloads` every 3s while
it is open. That is a `useEffect` instead of a subscription protocol, a reconnect story,
and a broadcast bus. Revisit only if live progress is wanted elsewhere.

## 10. Web UI

Three routes, React, served as static assets by `@fastify/static`.

**Browse** — infinite-scroll list of generic cards. Each card renders the group's
`DisplayFields` (title, subtitle, labelled fields), an upgrade badge when
`upgrade_release_id` is set, and a version list: one row per release showing its quality
tokens and score, each with its own Pick button. You pick a *version*, not just a group.

**Picks** — what you own, the version you own, and an upgrade indicator where one exists.

**Downloads** — tracked downloads with status, error, and retry; untracked entries
rendered greyed out and inert, clearly marked as not managed by Pickarr.

Core renders every media type with the same card. Plugins do not supply UI.

## 11. Configuration

One JSON file, `/config/config.json` by default, validated with zod at boot.

```json
{
  "server": { "port": 8080 },
  "database": { "path": "/config/pickarr.db" },
  "trashDir": "/data/trash",
  "plugins": {
    "@pickarr/plugin-scenes": { "libraryRoot": "/media/scenes" }
  },
  "downloadClients": [
    {
      "id": "sab",
      "type": "sabnzbd",
      "url": "http://sabnzbd:8080",
      "apiKey": "file:/run/secrets/sabnzbd_api_key",
      "category": "pickarr",
      "importMode": "move",
      "pathMappings": [{ "from": "/downloads", "to": "/data/downloads" }]
    }
  ],
  "feeds": [
    {
      "id": "feed1",
      "url": "https://example.invalid/rss",
      "plugin": "@pickarr/plugin-scenes",
      "intervalSeconds": 900
    }
  ]
}
```

`importMode` is a property of the download client, not of a library root or a feed.
Usenet downloads are finished when they finish, so SABnzbd uses `move`. A torrent client
would need `copy` or `hardlink` to keep seeding, which is exactly why the setting lives
here.

Secrets use a `file:` indirection so they can be supplied as Docker Compose secrets.
The referenced file is read once at boot with `fs.promises.readFile`, its trailing
newline trimmed, and the value held in memory only. Secret values are never logged and
never returned by an API route. A missing or unreadable secret file is a fatal boot
error naming the path but never the contents.

Environment variables are used only for non-secrets: `PICKARR_CONFIG` and
`PICKARR_PORT`. A generic path-mangling scheme like
`PICKARR_DOWNLOADCLIENTS_0_APIKEY` is deliberately rejected — it is unreadable and
breaks the moment an array is reordered.

## 12. Packaging

Single Docker image, multi-stage. Build stage installs workspaces, runs `tsgo --noEmit`,
bundles each package with esbuild, and builds the SPA with Vite. Runtime stage is
`node:24-alpine`; `node:sqlite` is built in, so nothing native compiles.

Volumes: `/config`, `/data/downloads`, `/media/scenes`, `/data/trash`.
Healthcheck hits `/api/health`.

## 13. Testing

In rough order of value:

1. **Parser fixtures** (`plugin-scenes`) — a table of real release names mapped to
   expected identity keys and quality tokens. This is where the bugs will be, and the
   cheapest place to catch them.
2. **Ingest rules** against `:memory:` SQLite — identical identity collates; a new
   release on a `new` group leaves `list_rank_at` alone; a better release on a `picked`
   group bumps it; a worse one does not; re-ingesting a seen GUID is a no-op.
3. **Reconcile** against a fake SABnzbd client — every state transition, the untracked
   entry path, the `addurl` retry path, and failure after three consecutive misses.
4. **Import** against temp directories with real files — destination escape rejected,
   trash-before-write ordering on upgrade, retry after a partial import.
5. **Routes** via `fastify.inject()`.
6. **Components** with `@testing-library/react` on happy-dom, registered through
   `node:test`.

Every feature ships with unit tests. Lint, typecheck, test, and build must all pass
before any change is considered done.

## 14. Known risks

- **`tsgo` is a preview compiler.** Mitigated by using it only for typechecking; the
  fallback is `tsc --noEmit`.
- **Release-name parsing is the whole product.** If the scenes parser collates poorly,
  the browse list is noise. The fixture suite is the mitigation, and `parse_error` rows
  give a worklist of names the parser missed.
- **Synchronous SQLite blocks the event loop.** Accepted at single-user scale; revisit
  if queries ever stop being point-shaped.
- **`node:sqlite` is itself relatively new.** If it proves unstable, `better-sqlite3` is
  a near drop-in at the cost of a native build.
