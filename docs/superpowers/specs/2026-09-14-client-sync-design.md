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
  **concurrently**: a tail of the log forwards from a pivot, and a walk of the
  same log backwards from it, both resolving each entry to current state.
- `GET /api/sync/bootstrap` — the pivot, as the cursor pair an empty client
  starts both from.
- Typed read shapes for the three categories: `tv`, `movie`, `xxx`.
- A log that collapses on write: one row per changed row, no compaction job.

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

**2.6 The synced tables need nothing added for either cursor.** `tv_series`,
`tv_season`, `tv_release`, `xxx_site`, `xxx_scene` and `movie_detail` all
carry `created_at` and `updated_at`, and neither cursor reads either column:
both page `sync_log.id`. An earlier draft of this section counted the absence
of a `(created_at, id)` index on each of them as work §4 had to do; §4 added
six such indexes and they were deleted again, because the backwards walk
seeks `sync_log`'s own primary key. Measured:
`SEARCH sync_log USING INTEGER PRIMARY KEY (rowid<?)`.

**2.10 Collapsing on write costs 0.9 µs and removes the compaction job.**
40,000 updates over 5,000 distinct rows, each changed eight times:

| Trigger | Elapsed | Log rows |
|---|---|---|
| none | 21 ms | 0 |
| append one row per change | 115 ms | **40,000** |
| delete the row's entry, then insert | 151 ms | **5,000** |

0.9 µs per write buys a log proportional to *rows changed* rather than
*changes made*, and no compaction job at all. The trigger's `DELETE` seeks:
`SEARCH sync_log USING INDEX sync_log_row (tbl=? AND row_id=?)`.

**An upsert does not work here, and the reason is why this is written as
delete-then-insert.** With `UNIQUE (table_name, row_id)` and
`ON CONFLICT DO UPDATE`, the row keeps its original id — measured, id 1 before
and id 1 after a second change. A client already past id 1 would never see
that change. Delete-then-insert allocates a fresh id (1 → 3), which is the
whole point.

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
*What it buys here:* **delivering an op twice is a no-op.** A backfill
without snapshot isolation, backfill concurrent with the live tail, and a
self-collapsing log with no horizon each need an op that survives being
applied twice. With diffs, none of them are even available.

*And it is necessary rather than sufficient.* An earlier draft of this
paragraph called idempotence "the load-bearing property" and said every
guarantee in §5 follows from that single fact. That sentence is what invited
the interleaving §5.3 now closes: two idempotent ops still disagree when they
carry values read at different instants and land out of order, and
idempotence says nothing about which of them wins. What settles that is the
op-kind split — the backfill's `create` never overwrites, the tail's `upsert`
always does — and **§5.3 is where the rest of the argument lives.** This
decision buys the foundation, not the building.

**3.2 An empty client is populated from current state, with the log as the
index of which rows exist.** A new client is not replayed history. It is
served one create per live row by the backfill (§5.2) while the tail (§5.1)
runs alongside it, and every value in either stream is read from current state
at the moment it is served. What the log supplies is the *list*: it holds
exactly one entry per live row (§3.5, plus the seed in §4), so walking it
backwards enumerates the rows without ever reading what any of them used to
be. "Bootstrap" means only this: populating a client that has nothing. It is
not a phase, and there is no moment at which the client is doing one and not
the other.
*Rejected:* a separate snapshot endpoint, which is a second protocol to
build, test, guard and keep consistent with the first.

*This decision once said "never from the log", and that phrasing was wrong
rather than merely loose.* It was written against replaying history, which
nothing here does; read literally it also ruled out using the log as an index,
which is what §5.2 now does and which was **not considered when this spec was
written**. Only the snapshot endpoint was. Measuring the log walk afterwards
found it strictly smaller: no new index, no per-page watermark query, no
`rowsFor` on the contract, and a response bounded by rows rather than by
groups — at the cost of two ordering properties §5.2 names. It also closed
N11, the unattached `rss_item`, which the group-hydrated walk could only reach
through a `media_item` that did not exist. And it added one requirement the
current-state walk did not have: a log created empty over a database that
already holds rows indexes none of them, so §4 seeds it.

**3.3 Newest-first by log position, one op per entry, backfilled in the
background.** The backfill pages `sync_log` backwards from the client's pivot
and resolves each entry against current state. The client renders after page
one and keeps paging backwards at idle priority while the live tail runs
concurrently.
*Rejected:* oldest-first (the client waits for the least interesting data),
and a fixed newest-N window with a second endpoint for older data (a second
protocol for what is the same cursor paged further).
*What it buys over hydrating by group:* a page is N rows rather than N groups,
so a response is bounded by the parameter that claims to bound it; and a
shared parent — one `tv_series` across many episodes — is sent **once**, not
once per group, because the log holds one entry per row. The deduplication
3.3 used to accept as a cost is now the log's shape.
*Cost:* ordering. Log position is write order, not dependency order, so an op
can name a synced row the client has not received yet. §5.2 states both halves
of that and why it is accepted.

**3.5 The log collapses on write, so there is no compaction job.** Each
trigger deletes the row's existing entry and inserts a fresh one, so
`sync_log` holds exactly one row per changed row, always.
*Rejected:* appending one row per change and collapsing at read time with a
`GROUP BY`, plus a periodic compaction job. §2.10 measured the trade: 0.9 µs
per write against a log eight times larger in that scenario and unboundedly
larger as change counts grow, a `GROUP BY` on every tail query, and a
maintenance job that must itself be proven safe for live cursors.
*Rejected:* an upsert on `(table_name, row_id)`, which leaves the id
unchanged and so hides the change from any client already past it (§2.10).
*Consequence:* **no client ever needs re-bootstrapping.** The surviving entry
for a row always has the highest id that row has ever had, so every client
below it receives it and every client above it already has it. An earlier
draft of this design claimed retention would force lagging clients to
re-snapshot; that was false then and there is now no retention at all.

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
  -- Every change deletes this row's previous entry and inserts a new one, so
  -- a bare INTEGER PRIMARY KEY would hand the freed id straight back --
  -- constantly, not occasionally -- and a client past that id would never see
  -- the change. Measured in the design spec sections 2.1 and 2.10. Do not
  -- "tidy" this to match the other tables.
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     INTEGER NOT NULL,
  -- Which trigger fired, and a different vocabulary from the wire's
  -- `SyncOp.op` (§5.1), which also has 'create'. Never read when serving:
  -- current state is the authority on what an entry resolved to.
  op         TEXT NOT NULL,          -- 'upsert' | 'delete'
  at         INTEGER NOT NULL
);

-- UNIQUE, and on the hot write path: every trigger deletes through it before
-- inserting, so the log holds one row per changed row. Measured to seek:
-- SEARCH sync_log USING INDEX sync_log_row (table_name=? AND row_id=?).
CREATE UNIQUE INDEX sync_log_row ON sync_log (table_name, row_id);
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
  DELETE FROM sync_log WHERE table_name = '<t>' AND row_id = NEW.id;
  INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('<t>', NEW.id, 'upsert', <now>); END;
CREATE TRIGGER <t>_sync_upd AFTER UPDATE ON <t> BEGIN
  DELETE FROM sync_log WHERE table_name = '<t>' AND row_id = NEW.id;
  INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('<t>', NEW.id, 'upsert', <now>); END;
CREATE TRIGGER <t>_sync_del AFTER DELETE ON <t> BEGIN
  DELETE FROM sync_log WHERE table_name = '<t>' AND row_id = OLD.id;
  INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('<t>', OLD.id, 'delete', <now>); END;
```

And, immediately after installing those triggers, one entry per row the table
already holds **that the log does not already index**:

```sql
INSERT INTO sync_log (table_name, row_id, op, at)
  SELECT '<t>', id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM <t>
   WHERE id NOT IN (SELECT row_id FROM sync_log WHERE table_name = '<t>');
```

**Without this the backfill serves nothing on any database that already has
rows.** The triggers only log a row that changes after they exist, so a log
created beside them indexes the changes since its creation — which is exactly
not what §5.2 reads it as. On a fresh install the statement matches nothing.

**There is no `DELETE`, and an earlier draft of this section had one —
`DELETE FROM sync_log WHERE table_name = '<t>'` — which destroyed tombstones.**
A `delete` entry names a row the table no longer has, so the delete removed it
and the `INSERT … SELECT` over live rows could not put it back; every client
below that entry kept the deleted row for good. Reproduced end to end: three
rows logged at 1, 2, 3, the third deleted at 4, the seed leaving
`5:upsert/1 6:upsert/2`, and a client at cursor 3 never told row 3 went away.
Reachable on exactly the databases the `sync.seeded.<table>` guard below was
written for, since those have had triggers running and so may already hold
tombstones. The anti-join is also strictly better than deleting only the
non-tombstones: it leaves every existing entry's id alone, so no client
re-reads a row it already holds.

It rests on one invariant — **no live row holds a `delete` entry** — which
`sync_log_row`'s UNIQUE index plus the insert trigger's own delete-first
guarantee: re-inserting a row at a deleted row's id replaces the tombstone
with an `upsert`. Measured, `2:delete/3` becomes `3:upsert/3`.

What puts a *seeded* entry above every client's cursor is `AUTOINCREMENT`,
which issues `max_ever + 1` and never reuses an id, with or without a delete
in front of it. Measured — with the log holding ids 1, 2 and 4 and rows 1 and
2 live, an insert produces ids **5 and 6**, not the freed 1 and 2, and
`sqlite_sequence.seq` only ever increases. An earlier wording of this
paragraph said a delete "frees the old `AUTOINCREMENT` ids", which contradicts
the schema comment four screens up in this same section.

The host's six tables are seeded inside the migration, whose version record is
the guard. A plugin's declared tables are seeded in `host.register`, where
their triggers are installed, because a plugin's table list has no version
space of its own — guarded instead by a `sync.seeded.<table>` key in
`host_state`, since `register` runs on every boot and the seed is a scan of
the whole table. That key is a **cost** guard now, not a correctness one: with
the anti-join above, a second seed is a no-op.

**A migration that rebuilds a synced table needs the other statement, and it
is not this one.** Announcing that rows a client already holds have *changed*
needs entries at fresh ids, which the anti-join deliberately does not write.
`docs/database-migrations.md` documents that as `relogSyncedTables` —
`DELETE FROM sync_log WHERE table_name = ? AND op != 'delete'` and then an
unconditional re-log — where the `op != 'delete'` scope is what keeps *it*
from repeating the defect above. `DROP TABLE` fires no `AFTER DELETE` trigger
(measured), so a row deleted before a rebuild still has its entry and is still
owed to every client below it.

An earlier draft of this section also created a `(created_at, id)` index on
each synced table, for a keyset the backfill no longer has. All six were
deleted: they had no other consumer in the repo, and the backwards walk seeks
`sync_log`'s own primary key.

`deleted_media_item`, slice E's tombstone table, is **not** removed by this
slice: `/api/deletions` still serves it and slice 2 decides whether the log
supersedes it.

## 5. The endpoints

All three are guarded like every route but health. **The first two are cursors
run concurrently, not two phases of one.** An earlier draft encoded a phase in
a single cursor, which reads as "backfill, then tail" -- and under that
reading a client with a large history waits for the whole backfill before
seeing anything new. That is the opposite of the intent and the reason this
section is shaped the way it is. §5.4 exists so nothing about *starting* them
imposes an order either.

**Both cursors read the same log, in opposite directions, from one pivot.**
That is not how this section was first written: the tail read the log and the
backfill walked current state on a keyset of its own, with a watermark
threaded between them to keep the two from overlapping. §3.2 records what
measuring the log walk showed and what it cost.

### 5.1 Tail — `GET /api/sync?since=<logId>`

Ops above `since`, ordered by id, each resolved to current state: a row that
still exists becomes an `upsert` carrying it, a row that does not becomes a
`delete`. No collapse is needed at read time — §3.5 collapsed on write, so
the log already holds one entry per changed row. A client far behind
therefore receives one op per changed row, not one per change, and the query
is a primary-key range scan.

```json
{"op":"upsert","table":"media_item","id":123,"value":{ … }}
{"op":"delete","table":"media_item","id":123}
```

**This cursor never emits the third op kind.** `SyncOp.op` is `create`,
`upsert` or `delete`; `create` belongs to the backfill alone (§5.2), and
§5.3 is why the two cursors use different words for what looks like the same
op. `sync_log.op` (§4) is a separate vocabulary — it records which trigger
fired, and neither cursor turns it into an op kind: this one never reads it at
all, and §5.2 reads it only in a `WHERE` clause. Current state is the
authority on what an entry resolved to.

**`id` is on every op, whatever its kind, and is the row's primary key in
`table`.** It is not read out of `value`: the host's own projections
(`sync/tables.ts`) happen to include `id` in the row they return, and no
plugin read shape includes one — §6 says why they must not — so a protocol
that keyed a row from its payload worked for the host's six tables and
silently failed for all six plugin ones. The client stores a row under the
op's `id`, which is what makes a `create`, the `upsert` that later refreshes
the same row and the `delete` that tombstones it agree on one key.

The client polls this from the moment it has its pivot (§5.4), and keeps
polling for the rest of the session. **Nothing about the log's size delays
it**: it starts just below `W` and only ever moves forward.

### 5.2 Backfill — `GET /api/sync/backfill?before=<logId>`

Entries **below** `before`, ordered by id descending, each resolved to current
state and emitted as a `create`. It is §5.1 with the comparison flipped and
the order reversed, and the two are deliberately the same shape.

```sql
SELECT id, table_name, row_id FROM sync_log
 WHERE id < ? AND op != 'delete' ORDER BY id DESC LIMIT ?
```

Measured: `SEARCH sync_log USING INTEGER PRIMARY KEY (rowid<?)`. A seek, and
no new index — which is what freed the six §4 used to add.

**This is a walk over current state, not over history**, for the reason §3.2
gives: the log holds exactly one entry per live row, so it is the index of
which rows exist and every value still comes from current state. The cursor is
the lowest *entry* the page read, not the lowest op it served, so an entry
skipped — a table the registry does not know, a row deleted between the two
queries — cannot stall the walk. A null cursor means exhausted, and exhaustion
is permanent: every entry the log gains takes a higher id, and a re-logged
row's old entry is deleted, so nothing ever appears below a point the walk has
passed.

**`op != 'delete'` is a page-density filter, and the reason is worth stating
because it is not the obvious one.** A `delete` entry *below* a client's pivot
names a row that client can never have held: had it held the row, the deletion
would have re-logged the entry at a fresh, higher id, putting it above the
pivot and into §5.1's half. So the entry carries nothing this cursor could
say, and the collapse (§3.5) means a deleted row's single entry *is* the
delete. Filtering it in the predicate keeps `limit` meaning rows *served*
rather than rows looked at. It is not what keeps tombstones off this cursor —
an unresolved row is dropped by the emission rule anyway, which is what covers
the entry that said `upsert` and whose row was gone by the time it was read.

**Disjointness against the tail is arithmetic.** §5.1 takes `id > since` and
this takes `id < before`; §5.4 hands a bootstrapping client `since = W - 1`
and `before = W`, which meet at `W` and overlap nowhere. There is no
per-page, per-table `sync_log` query deciding who owns a row, no watermark
threaded through the cursor, and no keyset. `before` is a bare `sync_log.id`,
the same kind of value `since` is, which is what lets §5.4 answer both in one
body. An earlier shape encoded `<createdAt>.<id>.<w>` as one token
specifically so the watermark could not be dropped; there is no watermark to
drop.

**No `before` at all is the first page**, meaning "from the newest entry":
this route's own "start from the beginning" case, and the one absent value in
the sync surface that is not refused. A `before` that *was* supplied and is
not a bare non-negative integer is a `400`, for the reason §5.1's `since`
gives — including the old two- and three-part keyset forms, so a client that
kept one across an upgrade is refused rather than having its first component
read as a log id.

**The body is `ops` and `cursor`, and nothing else.** No watermark — §5.4
answers that before either cursor starts, rather than making the client wait
for a backfill page to learn where its tail begins. No `asOf` either; §5.3 has
why the op kind replaced it. A dead field on the wire is a field slice 2
reads.

**Two references in a page point outside the synced set and always will.**
`rss_item.feed_id` names an `rss_feed` and `torrent_download`/`nzb_download`'s
`download_client_id` names a `download_client`; neither table is synced, and
`download_client` never will be — it holds a service's address. So a page does
contain ids a client cannot resolve, by design. Earlier wordings here and in
`sync/backfill.ts` claimed no op references an unreceived row; that was false
of these two columns from the first commit.

**Two properties the group-hydrated walk had and this one does not.** Both
accepted, and recorded here rather than left for slice 2 to discover.

1. **Emission is in log order, not dependency order.** An op can reference a
   *synced* row the client has not received yet: production inserts an
   `rss_item` before the `media_item` it is later relinked to, so the release
   is emitted first and its `media_item_id` points forward. The row arrives
   elsewhere in the same walk. What is lost is the ordering guarantee inside
   the synced set — never eventual resolution, and never a reference that
   dangles for good. A client already has to tolerate the two permanent
   unresolvables above, so this asks nothing new of it, only more often. It
   also takes the *whole* handle a plugin had on page order: declaration order
   was emission order for a group's plugin tables, and is now just a list
   (§6).
2. **A page is `limit` rows, not `limit` hydrated groups.** Strictly better
   for bounding a response — the old walk emitted every dependent row of each
   of `limit` media items, so a response weighed whatever those groups
   happened to weigh — and it means `limit` means what it says.

**And one the group-hydrated walk did not have: it reaches a row no media item
names.** An unattached `rss_item` has a log entry like every other row. N11,
closed by construction rather than by a special case.

### 5.3 Why concurrency loses nothing

`W` is fixed once, by §5.4, and never advances. The tail advances above it and
the backfill descends below it; neither moves `W` itself.

**Disjointness is arithmetic, and it is complete.** Every entry in the log has
an id, and every id is either above `W - 1` or below `W`. So every row is on
exactly one side, with no row on both and none on neither — which is what
`W - 1` as the tail cursor buys over making the tail `>=`: the entry *at* `W`
is the tail's rather than nobody's. There is nothing to measure here and no
query to get wrong, which is the point. The earlier design decided ownership
per row, per table, per page, against a watermark carried in the cursor; the
table below had a row for each way that could go wrong and one of them was a
read-time skip that could not see a write that had not happened yet.

**Idempotence is not the whole argument, and §3.1 once said it was.** Two
idempotent ops still disagree when they carry values read at different
instants and land out of order, and idempotence says nothing about which wins
— which is the last row of the table below, measured, reproduced, and
permanent when it happens. **One thing closes it: the op kind says whether an
op is allowed to overwrite.** Arithmetic disjointness does not close it and
never could: a page's values are read at one instant and applied at another,
and the invalidating write can land after the response was serialised, where
no predicate over the log can see it.

| During the backfill | Backfill | Tail | Result |
|---|---|---|---|
| a row is **created** | never reaches it — its entry is above `W` | op > `W - 1` | delivered |
| a row is **modified** before the page that would carry it is read | never reaches it — the change re-logged it above `W` | op > `W - 1` | delivered once, by the tail |
| a row is **deleted** before the walk reaches it | never reaches it — the deletion re-logged it above `W`, and below `W` a `delete` entry is filtered | delete op > `W - 1` | tombstoned: a delete for a row the client was never sent |
| a row is **deleted** after the walk sent it | sent | delete op > `W - 1` | tombstoned |
| a row is **modified or deleted after a page carrying it was read, and that page is applied after the tail op** | sent, as a `create` with the older value | op > `W - 1` | the `create` is dropped — the client already holds that row |

**Rows 2 and 3 are stronger than they were, and for a reason worth naming.**
They used to depend on the walk *skipping* a row whose entry had risen above
the watermark — a query, run per table per page, that could be wrong. They now
depend on the row's entry having moved, which is the collapse (§3.5) and
happens whether anyone looks. A change to a row below `W` takes the row *out*
of the walk's range and *into* the tail's, in one write, as one effect.

#### The op kinds, and the two obligations they put on a client

**`SyncOp.op` is `create`, `upsert` or `delete`.** The backfill emits only
`create`. The tail emits `upsert` for a row that still exists and `delete` for
one that does not. Slice 2 owes exactly two rules, stated here because slice 2
depends on them and the server cannot enforce either:

1. **A `create` never overwrites.** Applying a `create` for a row the client
   already holds — *including one it holds as a tombstone* — does nothing at
   all.
2. **A `delete` writes a tombstone; it does not remove the row.** The
   tombstone is what makes obligation 1 treat a deleted row as "already
   held".

**What breaks if either is skipped.** Skip 1 and a stale page overwrites the
newer value the tail already delivered — permanently, because that row's log
entry has already been consumed and nothing ever re-sends it. Skip 2 and a
stale page resurrects a row the tail deleted: obligation 1 finds the row
absent, so the `create` applies, and the row is back for as long as that
install exists. Each failure is one row, silent, and terminal.

Measured against a model client driven through the real `tailSince` and
`backfillBefore` (§7.19), with the page read before the write and applied
after the tail op:

```
stale page after a tail UPDATE : replica {"title":"EDITED"}  truth {"title":"EDITED"}
stale page after a tail DELETE : replica TOMBSTONE           truth deleted
ordinary order                 : replica {"title":"EDITED"}  truth {"title":"EDITED"}
```

**Why a stateless server cannot do this itself.** The write that invalidates a
page can land after the page's response was serialised, so the server has
already answered by the time there is anything to notice: measured, with page
2 already built, an `UPDATE` on one of its rows takes a log entry above `W`
and the page in hand still carries the old title. No predicate over the log,
at any threshold, can see a write that has not happened yet. Nor is
obligation 1 sufficient alone — also measured:
make the write a `DELETE`, and without obligation 2 the tail removes the row,
then the stale page finds it absent and puts it straight back. Obligation 2 is
what turns "already holds" into a claim about every row that has ever existed
on this client.

**Why the rule is an op kind and not a number.** An earlier draft dated every
page with `asOf` — the log position its values were read at — and asked the
client to discard and refetch any page its own tail cursor had passed. That
closes the same case, and it is gone. Two mechanisms for one property is worse
than one, and of the two this is the better: the op kind is structural, the
server stating the rule by choosing a word, where `asOf` states it as a
comparison a client can invert, drop, or run against the wrong cursor — with
the failure silent in every one of those cases. No `asOf` is on the wire and
there is no discard-and-refetch rule. Note that neither obligation needs a
per-row version or an `updated_at`, which `role` has not got and no read shape
in §6 carries.

**What the tombstones cost.** A client accumulates one tombstone per row
deleted while it was ever syncing. That is bounded by deletions rather than by
changes, nothing in this slice reclaims them, and §8 records ageing them out
as slice 2's call. The host's own `deleted_media_item` (§4) is a different
thing entirely: these tombstones live only in the client's replica.

A client interrupted mid-backfill and resuming days later keeps both cursors:
its `W` is stale but still valid, because the log keeps only the newest entry
per row and that entry always has the highest id that row has ever had, so it
sits above `W` whenever the row changed after `W` (§3.5).

### 5.4 Bootstrap — `GET /api/sync/bootstrap`

The pivot, as the pair an empty client starts both cursors from. No
parameters.

```json
{"since": 8412, "before": 8413}
```

`before` is `W` and `since` is `W - 1`, named for the query parameters they go
into so a client pastes them back rather than working out which is which.

**Why `W - 1` rather than making the tail `>=` at bootstrap.** `since` means
"I have through here" on every other call a client makes, and one parameter
with two meanings is what a client mis-handles later — silently, since reading
it the wrong way at bootstrap costs exactly one row.

**Why one call rather than the backfill's first page carrying it.** That is
what the earlier shape did, and it made the two cursors ordered: the tail
could not start until a backfill page had come back with the watermark, on a
route whose whole point is that the two run concurrently (§5). They are
independent now.

**How `W` is computed.** Five steps, over one query per category plus three:

1. Per category (`media_item.plugin_id`), the item `X / categories` places
   down from that category's newest:
   `SELECT id FROM media_item WHERE plugin_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1 OFFSET ?`.
   Measured `SEARCH media_item USING COVERING INDEX media_item_sync
   (plugin_id=?)` — a seek, because `media_item_sync` is
   `(plugin_id, updated_at, id)`. A category with too few items answers no row
   and falls back to its oldest, so it contributes a candidate rather than
   dropping out.
2. The oldest of those candidates, by `(updated_at, id)`, is the floor.
3. Its latest release: `SELECT MAX(id) FROM rss_item WHERE media_item_id = ?`.
4. The lower of those two rows' log entries:
   `SELECT MIN(id) FROM sync_log WHERE (table_name = 'media_item' AND row_id = ?) OR (table_name = 'rss_item' AND row_id = ?)`.
5. `W` is that entry.

**Two shapes rejected, both measured rather than reasoned about.** One
`ROW_NUMBER() OVER (PARTITION BY plugin_id ORDER BY updated_at DESC, id DESC)`
query reads better and plans `SCAN media_item USING COVERING INDEX
media_item_sync` plus `USE TEMP B-TREE` — a full scan and a sort where the
per-category form seeks. And `GROUP BY plugin_id` collapses to one row per
category, so an `OFFSET` over it indexes *categories* rather than items, and
`MAX(id)` is the highest rowid rather than the newest by `updated_at`: two
wrong answers wearing the shape of the right one.

**Why steps 3 and 4 rather than the media item's own entry.** The two sit
either way round. Production's order is `rss_item` inserted, then
`createMediaItem`, then `relinkRssItem` *updating* the rss_item — measured,
`3:media_item/1 4:rss_item/1 5:rss_item/2`, so the media item is normally the
group's floor. A later `media_item` update inverts it: measured,
`4:rss_item/1 5:rss_item/2 6:media_item/1`. And step 1 orders by
`updated_at DESC`, so it selects exactly the recently-written rows where that
inversion lives. Taking the `MIN` pins the card's newest release to the tail
side whichever way round they sit. A null `row_id` in the `rss_item` arm makes
that arm never true, so an item with no releases falls through to the
`media_item` clause alone.

**`W` is a pivot, not a horizon**, which is why the floor only has to be
roughly right. The tail walks up from it and the backfill walks down from it,
so rows immediately on either side arrive in the first response from each, and
choosing `W` a few entries out moves rows between the two cursors and loses
none. `X` is a target for how many of the newest items land on the tail's
side, chosen so the client's first tail page covers about that set while its
first backfill page is already below it — both cursors productive from the
first request, which is the reason to pick a floor part-way down rather than
the top of the log.

**No candidate answers above the whole log.** A library with no media items,
or a floor whose rows have no log entry (which §4's seed rules out), gives
`W = max(sync_log.id) + 1`: the tail starts empty and the backfill owns every
entry there is. Complete, just slower to first render, which is the right way
to be wrong here.

## 6. The contract change

```ts
export interface SyncedTable<T> {
  /** The table's name. Must carry the plugin's id as its prefix, as migrations already must. */
  readonly table: string;
  /** Current state for these row ids, in the shape the client receives. */
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, T>;
}

export interface MediaPlugin {
  // … id, mediaType, migrations, jobs as today …
  /** The tables this plugin contributes to a client's replica. Empty means none. */
  readonly synced: readonly SyncedTable<unknown>[];
}
```

`read` takes the raw handle and is synchronous: `node:sqlite` is, and a plugin
reads through the handle the host already holds rather than one of its own.
(An earlier draft of this block declared it `async` and without the handle;
the shipped contract is what is above.)

**One method, where there were two.** `rowsFor(raw, mediaItemIds)` — "which of
your rows belong to these media items" — existed because the backfill paged
`media_item` and had to traverse each group's relations itself, which the host
cannot do for a plugin table, having no schema knowledge of one. §5.2's walk
reads `sync_log`, so the row ids arrive with the entries and nothing is
traversed. Its only consumer in the repo was the backfill, through the
registry, so it left the contract rather than staying as a method nobody
calls. A plugin declares what its rows *are* and no longer how to reach them
from a media item.

**And declaration order is no longer emission order.** It was the only handle
a plugin had on page order — `tv_series` was declared before `tv_season` so
`TvSeasonRead.seriesId` stayed behind the row it names — and §5.2's first lost
property takes it away. A client can hold a season whose `seriesId` names a
series it has not received yet; the series arrives elsewhere in the same walk.

A plugin never sees an HTTP request. The host calls `read`, serialises the
result, and owns the triggers, the cursors, the paging, the seeding and the
guard.

**Six synced plugin tables means six read shapes in the contract**, not
three: `TvRead`, `MovieRead` and `XxxRead` for the detail row of each
category, and `TvSeasonRead`, `TvSeriesRead` and `XxxSiteRead` for the shared
parents a detail row points at. They live beside `MediaItemRead` so slice 2
types against them rather than redeclaring them by hand — the field-name drift
§3.7 calls the worst failure this design can have, moved from triggers to
types — or importing from a plugin package, which is the boundary
`packages/contract` exists to enforce. Enumerating three here was an error in
this spec, not a scope decision: the backfill already emits ops for all six.

**No read shape carries its own row id, deliberately.** The key is on the op
(§5.1), so it is the protocol's and not each plugin author's. The three detail
shapes do carry `mediaItemId`, because grouping is a different question from
keying and `media_item.id` is not the row's own key; the three parent shapes
carry none, because their tables have no `media_item_id` column — many
episodes share one season, many scenes one site — and they are reached through
the detail rows that point at them.

## 7. What the tests must prove

1. `sync_log.id` is never reused, though every change deletes a log row — the
   §2.1 and §2.10 measurements, as a test.
2. A row changed twice gets a *higher* id the second time, and a client whose
   cursor sits between the two receives it. This is the assertion that fails
   if anyone rewrites the trigger as an upsert.
2a. `sync_log` holds exactly one row per changed row after N changes to M
   rows — the collapse-on-write property, asserted by count.
3. Delivering the same op twice leaves the replica identical — idempotence,
   which everything else rests on and which, on its own, settles nothing
   about apply order (§3.1, §5.3).
4. A row changed during the backfill is delivered by the tail and **not** by
   the walk — asserted with both cursors live, since running them in sequence
   would pass while missing the property. The change re-logs the row above
   `W`, which takes it out of the walk's range in the same write.
5. A row created during the backfill, which the backwards walk can never
   reach, arrives on the tail.
6. A row deleted during the backfill is never sent as a `create` by it, and
    its delete on the tail leaves a client that never had the row holding a
    tombstone and nothing else.
7. The two cursors **partition** the log: with `since = W - 1` and
   `before = W`, no row is delivered by both, and the two together deliver
   every live row. Both halves, because either alone passes on a design that
   loses rows. Making the walk `<=` must fail this.
7a. A page is `limit` rows rather than `limit` groups, and a `delete` entry
   in the walk's path does not cost the page one of them — which is what
   `op != 'delete'` in the predicate is worth. Dropping the predicate must
   fail this; it does **not** produce a spurious tombstone, because an
   unresolved row is dropped by the emission rule anyway.
8. Emission order is log order, and the loss that goes with it is asserted
   rather than assumed: a page can carry an op naming a synced row later in
   the same walk — the `rss_item` written before the `media_item` it is
   relinked to — and the walk does deliver that row. References out of the
   synced set stay uncovered on purpose: `rss_item.feed_id` and
   `torrent_download`/`nzb_download`'s `download_client_id` name tables §4
   does not sync, so a page always contains ids a client cannot resolve.
8a. The walk reaches a row no media item names — an unattached `rss_item`.
   N11, which the group-hydrated walk could not serve at all.
9. Every synced table has all three triggers, asserted by enumerating
   `sqlite_master` against the declared set, so a table added without them
   fails the suite rather than diverging a client.
10. A plugin declaring a table without its id as prefix is refused.
11. The tail returns one op per row for a client far behind, not one per
    change — now a property of the log's shape rather than of the query.
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
18. Every op carries its row's key, on a create and an upsert as much as on
    a delete, for a **plugin** table as much as for a host one — asserted with a plugin
    table through both cursors, since the host's own projections include
    `id` in the row and would pass a weaker test.
19. The three interleavings §5.3's op-kind split closes, driven through the
    real `tailSince` and `backfillBefore` rather than a model of them: a page
    read before a tail `UPDATE` and applied after it leaves the replica on
    the tail's value; the same page with a `DELETE` leaves the row tombstoned
    rather than resurrected; and the ordinary order — page applied first,
    tail op second — still ends on the tail's value. The middle case is what
    rules out obligation 1 on its own, without the tombstone.
19a. A backfill op's `op` is `create`, and a tail op's is `upsert` or
    `delete`, asserted on the wire — so neither cursor's vocabulary can widen
    without a test saying so.
19b. The backfill response carries **no** log position of its own: no
    `watermark`, no `asOf`, no dated page. Asserted over the body's whole key
    set rather than field by field, since a dead field on the wire is a field
    slice 2 reads.
20. `GET /api/sync/bootstrap` answers exactly `since` and `before`, they
    differ by one, and each is accepted by the route it is named for — and
    both cursors are productive from their first request, so the floor really
    is part-way down the log rather than at the top of it.
20a. The pivot is the **lower** of the floor group's own log entry and its
    latest release's, asserted in both orderings: with the `media_item`
    written first, and with a later `media_item` update inverting it. Taking
    the max must fail both; dropping the release clause and keeping the
    `media_item`'s entry alone must fail the inverted one, which is the case
    the clause exists for.
20b. A category with too few items for the offset contributes its oldest
    rather than dropping out, asserted with that oldest item being the answer
    — so removing the fallback changes it.
20c. An empty library, and a library whose only synced row is an unattached
    `rss_item`, both answer a pivot the walk can still find everything below.
20d. The per-category candidate query seeks
    (`SEARCH media_item USING COVERING INDEX media_item_sync (plugin_id=?)`),
    and the two rejected forms are pinned by what rejected them: the window
    function's `SCAN` plus `USE TEMP B-TREE`, and `GROUP BY plugin_id`
    collapsing to one row per category with `max(id)` as the highest rowid.
20e. Migration 15 seeds `sync_log` with one entry per row a database already
    holds, and the walk serves those rows. Dropping the seed must make a
    pre-existing row unreachable by either cursor, permanently — which is the
    one correctness requirement the log walk has and the current-state walk
    did not.
20f. A plugin's rows written by its own migration are seeded when it
    registers, and a restart does not reseed them: the same entries at the
    same log ids after two more boots, so no client is told the library
    changed because the host restarted.
21. A boot reinstalls the host tables' triggers, so one dropped by a later
    migration that rebuilt its table is repaired rather than silently absent.
22. `sync_log.id` is `AUTOINCREMENT` in the DDL *and* in the Drizzle mirror,
    asserted against `sqlite_master.sql` on both sides — `PRAGMA table_info`
    cannot report it and `sqlite_sequence`'s existence is not specific to
    one table.

## 8. Consequences

- **A second writer breaks the cursor silently.** §2.4's single-writer property
  is what makes a plain integer safe. A worker thread or a second process
  writing to this database reintroduces the commit-order gap, and the symptom
  is a client quietly missing rows. Re-read this before adding one.
- Every write in the host now costs about 2.3 µs more and rewrites one
  `sync_log` row.
- There is no compaction job. The log is bounded by the number of rows that
  have ever changed, not by how often they changed.
- Every write now performs a delete as well as an insert against `sync_log`.
  Measured at 0.9 µs on top of the trigger's own 1.4 µs.
- A client that has never synced pays a full pass over the log, one op per
  live row. At today's volume — ~20,000 rows, 6.84 MB — that is a hundred
  pages of 200 rows, where the group-hydrated walk was a handful of much
  heavier ones. Same bytes, more requests, each bounded.
- **The log is now load-bearing for completeness, not only for freshness.** A
  synced table whose rows are not indexed in `sync_log` is invisible to the
  backfill, permanently — not stale, invisible. §4 seeds it on migration and
  on plugin registration, and `docs/database-migrations.md` records the same
  obligation for a migration that rebuilds a synced table's rows. This is the
  one thing the current-state walk did not need and the one thing that can
  silently lose a whole table.
- The one case §3.8 does not cover: deep-linking to an item older than the
  backfill has reached shows a placeholder until the backfill arrives there.
- `/api/deletions` and `deleted_media_item` now overlap with the log's delete
  ops. Both remain; slice 2 decides.
- **A client cannot rely on an op's references being resolvable when it
  applies them.** §5.2's first lost property: emission is log order, so a
  reference inside the synced set may point at a row later in the same walk.
  Slice 2 renders from whatever the local store holds and shows a placeholder
  for what it does not (§3.8), which is the same behaviour it already owed for
  `feed_id` and `download_client_id`. Nothing here is unresolvable *forever*
  except those two.
- `PRAGMA recursive_triggers = ON` now applies to every trigger in the
  database, not only these. Nothing else defines one today.
- A fourth plugin gets no client UI for free. §3.6 accepts that.
- **Slice 2 carries two obligations the server cannot enforce**, both in
  §5.3: a `create` never overwrites a row the client already holds, and a
  `delete` tombstones the row rather than removing it. Everything else about
  convergence is the server's. A client that skips the first holds a stale
  value for any row modified while a page was in flight; one that skips the
  second holds a resurrected row for any row deleted while a page was in
  flight. Either lasts as long as that install exists.
- **A client's replica accumulates a tombstone per row ever deleted under
  it**, which is what the second obligation costs. Bounded by deletions
  rather than changes, and nothing here reclaims them; ageing them out is
  slice 2's call, and it cannot be done by forgetting a tombstone whose row a
  walk still in progress may yet `create`.
- The client must run both cursors concurrently. Running them in sequence is
  correct but defeats the design: a client would see nothing new until its
  whole history had replicated. §5 states this structurally so slice 2 cannot
  read it as optional.
