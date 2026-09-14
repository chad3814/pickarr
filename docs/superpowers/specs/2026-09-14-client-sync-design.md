# Client sync: an invalidation log, and typed read data per category

A replication surface for a browser client: one append-only log recording
*that* a row changed, one endpoint that serves current state for those rows,
and a contract change letting a plugin declare which of its tables take part
and what shape they read as.

This is the first of two slices. The second builds `packages/web` against it.
Nothing here has a user interface, and everything here is testable without one.

## 1. What this builds

- `sync_log` — one row per change, captured by triggers, with a monotonic id.
- Triggers on every synced table, host-owned and plugin-owned alike.
- `SyncedTable` on the plugin contract: a plugin declares its synced tables
  and the read shape each produces.
- `GET /api/sync` and `GET /api/sync/backfill` — two cursors the client runs
  **concurrently**: a tail of log ops from the present, and a backwards walk
  through current state, newest group first.
- Typed read shapes for the three categories: `tv`, `movie`, `xxx`.
- Log compaction: one op per `(table, row_id)`, safe for every live cursor.

## 2. Facts, measured rather than assumed

Measured on 2026-09-14 against this worktree and a `/tmp` copy of a real
1.x database. No value from that database appears here — only counts and byte
totals.

**2.1 A plain `INTEGER PRIMARY KEY` reuses ids, and that breaks the cursor.**
The repo's convention on all 22 mirrored tables is a bare `INTEGER PRIMARY
KEY`. Measured on SQLite 3.53.4:

| Table | After inserting 1-5 and deleting 3,4,5, the next insert gets |
|---|---|
| `INTEGER PRIMARY KEY` | **3** — reused |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | **6** — monotonic |

Compaction deletes log rows by design, so reuse is not a risk here but a
certainty. A client whose cursor is 5 asks for ops greater than 5 and never
sees the op that took id 3. Silent, total, per-row data loss with nothing
failing. **`sync_log.id` must be `AUTOINCREMENT`**, and that is a deliberate
departure from the convention every other table follows — §4 says so beside
the DDL, because tidying it to match would break every client.

**2.2 Trigger capture costs 1.4 µs per write.** Measured over 40,000 writes
(20,000 inserts and 20,000 updates) inside one transaction, with and without
AFTER INSERT and AFTER UPDATE triggers writing to `sync_log`:

| | Elapsed | Log rows |
|---|---|---|
| No triggers | 29 ms | — |
| With triggers | 86 ms | 40,000 |

2.93× relative, 1.4 µs absolute. A feed poll writing a few hundred rows pays
under a millisecond. The relative figure is the alarming one and the absolute
figure is the one that matters.

**2.3 The user-facing data is small; the cache that would have swamped it is
larger than all of it.** Row counts and raw text bytes from a real 28.5 MB
database:

| Table (1.x name) | Rows | Raw text |
|---|---|---|
| `media_groups` → `media_item` | 4,313 | 1.65 MB |
| `feed_items` → `rss_item` | 7,123 | 1.91 MB |
| `group_metadata` | 3,959 | 1.44 MB |
| `performers` → `person` | 2,089 | 0.78 MB |
| `releases` | 6,515 | 0.63 MB |
| `downloads` | 1,186 | 0.35 MB |
| `group_performers` → `role` | 4,606 | 0.04 MB |
| `discovered_sites` → `xxx_site` | 1,062 | 0.04 MB |
| **user-facing total** | **~20,000** | **6.84 MB** |
| `metadata_candidates` (a lookup cache) | 127,237 | **15.89 MB** |

The cache is more than twice the user-facing data. It is excluded because
§6 makes participation an explicit declaration rather than a default, which is
the whole reason this is not whole-database replication.

**2.4 The host is a single synchronous writer, which is why a plain integer
cursor is safe.** One `DatabaseSync`, opened once (`main.ts:649`); no
`worker_threads`, no `cluster`, no `child_process` anywhere under
`packages/host/src`; `node:sqlite` is synchronous. Writes are therefore
serialised by the event loop and log ids are assigned in commit order.

The hazard this avoids is the standard change-data-capture gap: a reader
takes ops up to id 100 while a transaction holding id 98 has not committed,
and never sees 98. **It cannot happen here, and it becomes possible the day
anything writes from a second thread or process.** §8 records this as the
assumption to re-check before adding one.

**2.5 `role` and `alias` carry `created_at` and no `updated_at`.** `person`
carries both. Under a state-based cursor design those two tables would need a
migration before they could sync at all; an invalidation log does not read
either column, so they need none. This is the clearest single reason the log
beat extending the existing keyset-cursor pattern to more tables.

**2.6 The plugin tables already carry what the backfill needs.**
`tv_series`, `tv_season`, `tv_release`, `xxx_site`, `xxx_scene` and
`movie_detail` all have `created_at` and `updated_at`. None has an index on
`(created_at, id)`, which §4 adds for the backfill's keyset paging.

**2.8 The truncate optimisation does not skip delete triggers.** Measured:
`DELETE FROM t` with no `WHERE` fired 3 of 3 delete triggers, as did
`DELETE FROM t WHERE 1=1`. SQLite disables the optimisation when a delete
trigger exists, so a bulk clear cannot silently strand rows on a client.

**2.9 `INSERT OR REPLACE` silently loses a deletion, and one pragma fixes
it.** A `REPLACE` that displaces a *different* row through a unique-index
conflict deletes that row. Measured, with insert/update/delete triggers
present:

| `recursive_triggers` | row 1 displaced? | ops logged |
|---|---|---|
| `OFF` (SQLite's default) | yes, gone | `upsert:2` only — **the deletion is never logged** |
| `ON` | yes, gone | `delete:1`, `upsert:2` |

With the default, a client keeps a row the server no longer has, forever,
with nothing failing. Turning the pragma on costs nothing on the common path:
an `INSERT` followed by `ON CONFLICT (id) DO UPDATE` logs `upsert:1 upsert:1`
under both settings. The repo uses `ON CONFLICT DO UPDATE` at 13 sites and
`INSERT OR REPLACE` at none, so the hazard is latent rather than live — which
is exactly when it is cheap to close.

**2.7 What the host serves today**, for contrast: `/api/health`, `/api/media`,
`/api/rss-items`, `/api/downloads`, `/api/deletions`, `/api/artwork/:kind/:id`
and `/api/auth/*`. Every one is `GET`; anything else is refused at
`api/server.ts:614`. The per-item reads in `reads.ts` — `mediaItemById`,
`rssItemsForMediaItem`, `downloadsForRssItem`, `mediaItemByProviderRef` —
exist and are referenced **zero** times by the server. Nothing serves a
plugin-owned table.

## 3. Decisions

**3.1 An invalidation log, not a diff log.** An op records that a row changed
and the server reads current state when serving it. Ops carry no before/after
values.
*Rejected:* a transaction log with column diffs, which was the original
proposal. It buys exact history and smaller payloads, and costs
`OLD.x`/`NEW.x` SQL generated per column per table, storage of every value
twice, and a retention policy.
*What it buys here, and this is the load-bearing property:* **delivering an
op twice is a no-op.** Every guarantee in §5 — a backfill without snapshot
isolation, backfill concurrent with the live tail, compaction without a
horizon — follows from that single fact. With diffs, none of them hold.

**3.2 An empty client is populated from current state, never from the log.**
A new client is not replayed history; it is served one create per live row by
the backfill (§5.2) while the tail (§5.1) runs alongside it. "Bootstrap" below
means only this: populating a client that has nothing. It is not a phase, and
there is no moment at which the client is doing one and not the other.
*Rejected:* a separate snapshot endpoint, which is a second protocol to
build, test, guard and keep consistent with the first.

**3.3 Newest-first, hydrated by group, backfilled in the background.** The
backfill pages media items newest-first and emits each group's dependent rows
with it, in dependency order. The client renders after page one and keeps
paging backwards at idle priority while the live tail runs concurrently.
*Rejected:* oldest-first (the client waits for the least interesting data),
and a fixed newest-N window with a second endpoint for older data (a second
protocol for what is the same cursor paged further).
*Cost:* a shared parent — one `tv_series` across many episodes — is re-sent
once per group. Harmless by 3.1, and not worth machinery to dedupe.

**3.4 Order the backfill by `(created_at DESC, id DESC)`.** Both immutable.
*Rejected:* `updated_at`, under which a row touched mid-backfill moves in the
ordering and can be skipped entirely; and `id DESC` alone, because slice E
measured that SQLite reuses the rowids of deleted rows, so id order is not
chronological.
Anything touched during the backfill arrives on the live tail regardless.

**3.5 Compaction keeps the newest op per `(table, row_id)`, and needs no
horizon.** The surviving op has the highest id for that row, so every client
whose cursor sits below it still receives it, and every client above it
already has it. Compaction is therefore safe for all live cursors at once.
*Consequence:* **no client ever needs re-bootstrapping.** Only a genuinely
empty client bootstraps. An earlier draft of this design claimed retention
would force lagging clients to re-snapshot; that is false for this scheme and
the claim is recorded here so it is not reintroduced.

**3.6 Typed read shapes per category, not declarative field descriptors.**
Each plugin exposes a concrete read type; the client gets hand-written views
per category.
*Rejected:* a descriptor language (`{ key, label, kind }`) that a generic
client renders. With three plugins and `book` reserved, it is speculative
generality — and a flat field list cannot express the structure that makes
these categories worth browsing: episodes under seasons under a series,
scenes under a site.
*Rejected:* deriving the client's model from the migration DDL. DDL carries
storage, not meaning: it says `episode_number INTEGER` and cannot say that the
number is an episode, that `series_id` is a grouping parent, or that
`details_json` holds nothing renderable.
*Cost:* a fourth plugin needs client work in slice 2.

**3.7 A plugin declares tables; the host owns the triggers.** A plugin names
its synced tables and their read shape. The host creates and owns every
trigger, host-owned and plugin-owned alike.
*Rejected:* plugins writing their own triggers in their migrations. A missed
trigger produces a client that silently diverges with nothing failing, which
is the worst failure this design can have, so it is not left to a caller.

**3.8 No per-item fetch fallback.** A component asks the local store and shows
a placeholder until sync delivers the row.
*Rejected:* querying the server for a row not yet synced. It is a second read
surface to build, test and guard — the unrouted per-item reads in §2.7 — and
newest-first backfill means the realistic case, recent items, is already
present. §8 names the case this does not cover.

**3.9 `details_json` is not synced.** It is the one unbounded field in the
plugin tables, arriving verbatim from the metadata provider. A read shape
projects the fields a view needs.

**3.11 `recursive_triggers = ON`, rather than a rule against `INSERT OR
REPLACE`.** §2.9 measured that the default loses a deletion when a `REPLACE`
displaces another row.
*Rejected:* a build-time hygiene rule banning `INSERT OR REPLACE` under
`packages/host/src`. It would work, and this repo has precedent for exactly
that kind of check -- but it guards by convention where a pragma guards by
construction, it cannot see a plugin's SQL, and the failure it prevents is
invisible rather than loud.
*Cost:* triggers may fire triggers. Ours write only to `sync_log`, which has
none, so there is no recursion to bound.

**3.10 Not built.** Retention or windowing of the backfill; the client half of
any of this; per-item routes; a people read beyond `person` and `role` as
synced tables; any UI.

## 4. Schema

```sql
CREATE TABLE sync_log (
  -- AUTOINCREMENT, unlike every other table in this schema, and deliberately.
  -- Compaction deletes rows from this table; a bare INTEGER PRIMARY KEY would
  -- then hand the freed id to the next op, and a client past that id would
  -- never see it. Measured in the design spec section 2.1. Do not "tidy" this
  -- to match the other tables.
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     INTEGER NOT NULL,
  op         TEXT NOT NULL,          -- 'upsert' | 'delete'
  at         INTEGER NOT NULL
);

-- Serves compaction, which finds the older ops for a row it can drop. The
-- tail's own query is a primary-key range scan (`id > ?`) with a GROUP BY,
-- which this index does not serve -- an earlier draft of this comment claimed
-- it did.
CREATE INDEX sync_log_row ON sync_log (table_name, row_id);
```

`db/open.ts` gains one pragma beside the existing `journal_mode = WAL`:

```sql
PRAGMA recursive_triggers = ON;   -- see 2.9: without it, a displacing REPLACE loses a deletion
```

**A synced table must have an integer primary key named `id`.** All ten
candidates do. The triggers below read `NEW.id`/`OLD.id`, so a table keyed
otherwise -- `deleted_media_item`, keyed on `media_item_id` -- cannot be
synced without a shape change, and §6's declaration is refused for one.

Per synced table, three triggers the host generates:

```sql
CREATE TRIGGER <t>_sync_ins AFTER INSERT ON <t> BEGIN
  INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('<t>', NEW.id, 'upsert', <now>); END;
CREATE TRIGGER <t>_sync_upd AFTER UPDATE ON <t> BEGIN
  INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('<t>', NEW.id, 'upsert', <now>); END;
CREATE TRIGGER <t>_sync_del AFTER DELETE ON <t> BEGIN
  INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('<t>', OLD.id, 'delete', <now>); END;
```

And, for the backfill's keyset paging, on each synced table that lacks one:

```sql
CREATE INDEX <t>_created ON <t> (created_at, id);
```

`deleted_media_item`, slice E's tombstone table, is **not** removed by this
slice: `/api/deletions` still serves it and slice 2 decides whether the log
supersedes it.

## 5. The two endpoints

Both are guarded like every route but health. **They are two cursors run
concurrently, not two phases of one.** An earlier draft encoded a phase in a
single cursor, which reads as "backfill, then tail" -- and under that reading
a client with a large history waits for the whole backfill before seeing
anything new. That is the opposite of the intent and the reason this section
is shaped the way it is.

### 5.1 Tail — `GET /api/sync?since=<logId>`

Ops above `since`, collapsed to the newest per `(table_name, row_id)`, each
resolved to current state: a row that still exists becomes an `upsert`
carrying it, a row that does not becomes a `delete`. A client far behind
therefore receives one op per changed row, not one per change.

```json
{"op":"upsert","table":"media_item","value":{ "id":123, … }}
{"op":"delete","table":"media_item","id":123}
```

The client polls this from the moment it has a watermark, and keeps polling
for the rest of the session. **Nothing about the log's size delays it**: it
starts at `W`, which is the present, and only ever moves forward.

### 5.2 Backfill — `GET /api/sync/backfill?before=<createdAt,id>`

Current state, newest first, paged backwards, in units of **media item, fully
hydrated**: the group's row, then its releases, the plugin's detail row, the
shared parents that row points at, and its people and roles. Dependency order
within a page is what stops a client seeing a reference before its target.

Called with no cursor it returns the first page **and `w`, the log's
high-water mark at that moment**, so the client can start the tail without a
separate round trip. It returns a null cursor when current state is
exhausted, and the client retires it — from then on only the tail runs.

Ordering is `(created_at DESC, id DESC)`, both immutable, for the reason in
§3.4.

### 5.3 Why concurrency loses nothing

`W` is captured once and never advances; the tail is what advances past it.
Every case reduces to ops being idempotent (§3.1):

| During the backfill | Backfill | Tail | Result |
|---|---|---|---|
| a row is **created** | never reaches it — it is newer than the walk's start | op > `W` | delivered |
| a row is **modified** | may send an older copy | op > `W` | converges on current state |
| a row is **deleted** before the walk reaches it | absent | delete op > `W` | a delete for a row the client never had: a no-op |
| a row is **deleted** after the walk sent it | sent | delete op > `W` | removed |

A client interrupted mid-backfill and resuming days later keeps both cursors:
its `W` is stale but still valid, because compaction keeps the newest op per
row and every op above `W` for a changed row survives (§3.5).

## 6. The contract change

```ts
export interface SyncedTable<T> {
  /** The table's name. Must carry the plugin's id as its prefix, as migrations already must. */
  readonly table: string;
  /** Current state for these row ids, in the shape the client receives. */
  read(ids: readonly number[]): Promise<Record<number, T>>;
  /** The media items these rows belong to, so the backfill can hydrate a group. */
  rowsFor(mediaItemIds: readonly number[]): Promise<readonly number[]>;
}

export interface MediaPlugin {
  // … id, mediaType, migrations, jobs as today …
  /** The tables this plugin contributes to a client's replica. Empty means none. */
  readonly synced: readonly SyncedTable<unknown>[];
}
```

A plugin never sees an HTTP request. The host calls `read` and `rowsFor`,
serialises the result, and owns the triggers, the cursor, the paging and the
guard.

The three categories' read shapes — `TvRead`, `MovieRead`, `XxxRead` — live in
the contract beside `MediaItemRead`, so slice 2 types against them.

## 7. What the tests must prove

1. `sync_log.id` is never reused after compaction deletes rows — the §2.1
   measurement, as a test.
2. A client at cursor `N` receives every op with id greater than `N`, across a
   compaction that removes older ops for the same rows.
3. Delivering the same op twice leaves the replica identical — idempotence,
   which everything else rests on.
4. A row changed during the backfill is delivered by the tail, whether or not
   the backfill also sent it — asserted with both cursors live, since running
   them in sequence would pass while missing the property.
5. A row created during the backfill, which the backwards walk can never
   reach, arrives on the tail.
6. A row deleted during the backfill is never sent as a create by it, and its
    delete on the tail is a no-op for a client that never had it.
7. Backfill paging is stable: the same rows in the same order regardless of
   concurrent `updated_at` churn.
8. Each backfill page is self-consistent — no op references a row the client
   has not already received in that page or an earlier one.
9. Every synced table has all three triggers, asserted by enumerating
   `sqlite_master` against the declared set, so a table added without them
   fails the suite rather than diverging a client.
10. A plugin declaring a table without its id as prefix is refused.
11. The tail collapses: one op per row for a client far behind, not one per
    change.
12. A trigger fires for a write made through the Drizzle handle as well as raw
    SQL — the host writes both ways.
13. `details_json` does not appear in any served read shape.
14. The lookup cache tables are absent from every response.
15. An `INSERT OR REPLACE` that displaces a row by unique-index conflict logs
    the displaced row's deletion — §2.9's measurement, as a test, so the
    pragma cannot be removed silently.
16. A synced table whose primary key is not an integer `id` is refused at
    declaration.
17. No credential and no url reaches a log row or an op — the log stores a
    table name and a row id, and nothing else.

## 8. Consequences

- **A second writer breaks the cursor silently.** §2.4's single-writer property
  is what makes a plain integer safe. A worker thread or a second process
  writing to this database reintroduces the commit-order gap, and the symptom
  is a client quietly missing rows. Re-read this before adding one.
- Every write in the host now costs 1.4 µs more, and every write produces a
  log row. The log is the fastest-growing table in the database until
  compaction runs.
- Compaction is required for size, not for correctness. Nothing breaks if it
  never runs; the log simply grows.
- A client that has never synced pays a full pass over current state. At
  today's volume — ~20,000 rows, 6.84 MB — that is a handful of pages.
- The one case §3.8 does not cover: deep-linking to an item older than the
  backfill has reached shows a placeholder until the backfill arrives there.
- `/api/deletions` and `deleted_media_item` now overlap with the log's delete
  ops. Both remain; slice 2 decides.
- `PRAGMA recursive_triggers = ON` now applies to every trigger in the
  database, not only these. Nothing else defines one today.
- A fourth plugin gets no client UI for free. §3.6 accepts that.
- The client must run both cursors concurrently. Running them in sequence is
  correct but defeats the design: a client would see nothing new until its
  whole history had replicated. §5 states this structurally so slice 2 cannot
  read it as optional.
