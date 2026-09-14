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

**2.6 The plugin tables already carry what the backfill needs.**
`tv_series`, `tv_season`, `tv_release`, `xxx_site`, `xxx_scene` and
`movie_detail` all have `created_at` and `updated_at`. None has an index on
`(created_at, id)`, which §4 adds for the backfill's keyset paging.

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
fired and is never read when serving, because current state is the authority.

**`id` is on every op, whatever its kind, and is the row's primary key in
`table`.** It is not read out of `value`: the host's own projections
(`sync/tables.ts`) happen to include `id` in the row they return, and no
plugin read shape includes one — §6 says why they must not — so a protocol
that keyed a row from its payload worked for the host's six tables and
silently failed for all six plugin ones. The client stores a row under the
op's `id`, which is what makes a `create`, the `upsert` that later refreshes
the same row and the `delete` that tombstones it agree on one key, and what
makes a shared parent re-sent once per group (§3.3) deduplicate instead of
accumulating one unlabelled copy per group.

The client polls this from the moment it has a watermark, and keeps polling
for the rest of the session. **Nothing about the log's size delays it**: it
starts at `W`, which is the present, and only ever moves forward.

### 5.2 Backfill — `GET /api/sync/backfill?before=<createdAt>.<id>.<w>`

Current state, newest first, paged backwards, in units of **media item, fully
hydrated**. The emission order within a page is the host's tables first — the
group's row, then its releases, then the downloads submitted for them, then
its people and roles (people before roles, since a role names a person) —
then each plugin's tables in the order that plugin declared them. **Every op
on this route is a `create`** (§5.3).

The ordering rule is that no op precedes a *synced* row it names by id. It is
the plugin's job for its own tables: `tv_series` is declared before
`tv_season`, because `TvSeasonRead.seriesId` is a `tv_series.id`. It is not
the ordering rule an earlier draft stated, which had a detail row coming
before "the shared parents that row points at" — naming a row is a reason to
send it *first*. `TvRead` and `XxxRead` name no parent by id at all (§6
flattens them), so `tv_release` and `xxx_scene` are declared first freely.

**Two references in a page point outside the synced set and always will.**
`rss_item.feed_id` names an `rss_feed` and `torrent_download`/`nzb_download`'s
`download_client_id` names a `download_client`; neither table is synced, and
`download_client` never will be — it holds a service's address. So a page does
contain ids a client cannot resolve, by design, and the self-consistency
property (§7.8) is about rows *within* the synced set. Earlier wordings here
and in `sync/backfill.ts` claimed no op references an unreceived row; that was
false of these two columns from the first commit.

Called with no cursor it returns the first page **and `w`, the log's
high-water mark at that moment**, so the client can start the tail without a
separate round trip. `w` is then carried in the cursor — the wire form is
`<createdAt>.<id>.<w>` — and returned unchanged on every page of the walk, so
a client that adopts a later page's `watermark` adopts the first page's and
skips nothing. A two-part `before` is a 400, not a default: the watermark is
part of one opaque token precisely so it cannot be dropped. It returns a null
cursor when current state is exhausted, and the client retires it — from then
on only the tail runs.

**The page carries no other log position.** An earlier draft added `asOf`, the
mark read when *that* page was read, and an apply rule comparing it against
the client's tail cursor. §5.3 replaced both with the op kind.

**A page omits any row whose `sync_log` entry sits above `w`.** The tail owns
that row and will deliver it, so the two streams are disjoint. Skipping is per
row, not per group: dropping a whole group whose `media_item` changed after
the walk began would lose that group's *unchanged* rows for good, since the
keyset cursor advances past the group either way and the tail carries only
what changed. The cost is that a page may reference a row it did not send —
an `rss_item` whose `media_item` the tail owns. That reference is forward, not
dangling: the row is above `w`, and the client's tail starts at `w`.

Ordering is `(created_at DESC, id DESC)`, both immutable, for the reason in
§3.4.

### 5.3 Why concurrency loses nothing

`W` is captured once and never advances; the tail is what advances past it.

**Idempotence is not the whole argument, and §3.1 once said it was.** Two
idempotent ops still disagree when they carry values read at different
instants and land out of order, and idempotence says nothing about which wins
— which is the last row of the table below, measured, reproduced, and
permanent when it happens. **One thing closes it: the op kind says whether an
op is allowed to overwrite.** The backfill's omission of any row the tail owns
(§5.2) closes nothing here on its own — measured, since the invalidating write
can land after the page was built, where a read-time skip cannot see it — and
is kept for what it does buy: the two streams are disjoint, so a client never
has two sources for one row at once, and `w` is constant across a walk.

| During the backfill | Backfill | Tail | Result |
|---|---|---|---|
| a row is **created** | never reaches it — it is newer than the walk's start | op > `W` | delivered |
| a row is **modified** before the page that would carry it is read | omits it: its entry is above `W` | op > `W` | delivered once, by the tail |
| a row is **deleted** before the walk reaches it | absent | delete op > `W` | tombstoned: a delete for a row the client was never sent |
| a row is **deleted** after the walk sent it | sent | delete op > `W` | tombstoned |
| a row is **modified or deleted after a page carrying it was read, and that page is applied after the tail op** | sent, as a `create` with the older value | op > `W` | the `create` is dropped — the client already holds that row |

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
2 for media item 3 already built, an `UPDATE` on it takes a log entry above
`W` and the page in hand still carries the old title. Omitting rows above `W`
cannot see that write. Nor is obligation 1 sufficient alone — also measured:
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

## 6. The contract change

```ts
export interface SyncedTable<T> {
  /** The table's name. Must carry the plugin's id as its prefix, as migrations already must. */
  readonly table: string;
  /** Current state for these row ids, in the shape the client receives. */
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, T>;
  /** This table's row ids belonging to those media items, so the backfill can hydrate a group. */
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[];
}

export interface MediaPlugin {
  // … id, mediaType, migrations, jobs as today …
  /** The tables this plugin contributes to a client's replica. Empty means none. */
  readonly synced: readonly SyncedTable<unknown>[];
}
```

Both methods take the raw handle and both are synchronous: `node:sqlite` is,
and a plugin reads through the handle the host already holds rather than one
of its own. (An earlier draft of this block declared them `async` and without
the handle; the shipped contract is what is above.)

A plugin never sees an HTTP request. The host calls `read` and `rowsFor`,
serialises the result, and owns the triggers, the cursor, the paging and the
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
4. A row changed during the backfill is delivered by the tail, whether or not
   the backfill also sent it — asserted with both cursors live, since running
   them in sequence would pass while missing the property.
5. A row created during the backfill, which the backwards walk can never
   reach, arrives on the tail.
6. A row deleted during the backfill is never sent as a `create` by it, and
    its delete on the tail leaves a client that never had the row holding a
    tombstone and nothing else.
7. Backfill paging is stable: the same rows in the same order regardless of
   concurrent `updated_at` churn.
8. Each backfill page is self-consistent **within the synced set** — no op
   names a *synced* row the client has not already received in that page or
   an earlier one, with the one exception §5.2 names: a row the page omitted
   because the tail owns it, which the tail delivers at its log position.
   References out of the synced set are deliberately not covered:
   `rss_item.feed_id` and `torrent_download`/`nzb_download`'s
   `download_client_id` name tables §4 does not sync, so a page always
   contains ids a client cannot resolve.
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
19b. The backfill response carries `watermark` and **no** second log
    position: no `asOf`, no dated page. A dead field on the wire is a field
    slice 2 reads.
20. A walk's `watermark` is the same number on every page, so adopting it
    from a later page cannot silently skip ops.
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
- A client that has never synced pays a full pass over current state. At
  today's volume — ~20,000 rows, 6.84 MB — that is a handful of pages.
- The one case §3.8 does not cover: deep-linking to an item older than the
  backfill has reached shows a placeholder until the backfill arrives there.
- `/api/deletions` and `deleted_media_item` now overlap with the log's delete
  ops. Both remain; slice 2 decides.
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
