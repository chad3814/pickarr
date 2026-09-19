# Database migrations

How the 2.0 host changes its schema, and the one hazard that fails silently.

Everything here is about `packages/host` and the plugins it loads. 1.x
(`packages/core`) has its own migration runner and is frozen.

## Two version spaces

| | Table | Key | List |
|---|---|---|---|
| Host | `host_migrations` | `version` | `HOST_MIGRATIONS` in `db/migrate.ts` |
| Plugin | `plugin_migrations` | `(plugin_id, version)` | each plugin's `migrations` export |

The key is why a plugin's version 1 and the host's version 1 never collide, and why two
plugins may both ship a version 1. `migrateHost` runs at boot before anything else
touches the database; `migratePlugin` runs per plugin from `host.register`.

Both runners are the same shape: read the versions already applied, sort the list, skip
what is recorded, and run the rest in order.

## Rules that do not bend

**A migration that has been applied anywhere is frozen.** Not its SQL, not its version
number, not its position in the list. The runner records a version and never looks at
that migration again, so editing one changes the schema of every install that has not
yet applied it and no install that has — and the two then disagree forever, with nothing
failing. Add a new version instead.

**Versions are append-only integers.** Never renumber, never reuse, never insert between
two applied versions.

**A row's `id` is immutable.** No migration may change one, and neither may anything
else. Every client keyed its copy of a row by that id, and `sync_log` records a change as
`(table_name, row_id)` — so an `UPDATE` that moves a row from id 4 to id 9 logs id 9 and
nothing else, and every client keeps its row 4 forever beside a new row 9 with the same
content. There is no call site that does this today, and this is the reason there must
not be one. If a row has to move, delete it and insert the replacement: the delete logs a
tombstone and the insert logs a create, which is a change a client can actually apply.

**Each migration is one transaction, and the runner opens it for you.** The migration
and the row recording its version are wrapped in a `SAVEPOINT`, so a throw part-way
through leaves no trace. This is not belt-and-braces: SQLite's DDL autocommits, so
without it a crash between `up()` and the version insert would leave the schema applied
and the version unrecorded, and the next boot would re-run `up()` straight into "table
already exists". Do not open your own transaction inside `up()`.

**A migration may read and write rows, not just DDL.** `migration14` moves every
download-client credential into the `secret` table and drops the old columns; it is safe
to read, insert, update and drop in sequence precisely because of the savepoint above.

**A migration that calls into today's code inherits today's code's contract.**
`migration14` writes through `secrets/store.ts`, which calls `assertSecretName` — so
tightening the secret-name regex would retroactively break that migration for every
install still upgrading. If you call a helper from a migration, say so in the helper's
docblock.

## Plugin tables

Every table a plugin creates must be named `<pluginId>_something`. `migratePlugin`
enforces it by diffing `sqlite_master`'s persistent tables before and after `up()` and
throwing if a new one lacks the prefix.

That is a tripwire on new-table creation, not a sandbox. `CREATE TEMP TABLE` is
invisible to `sqlite_master`; `DROP TABLE`, `ALTER TABLE`, and any view, index or trigger
under any name all pass silently. `up()` receives the raw connection and can do anything
that connection can do.

## Changing a column

On the SQLite behind `node:sqlite` (3.53.4), `ALTER TABLE … ADD COLUMN` and
`ALTER TABLE … DROP COLUMN` work in place, including on a table carrying an index on a
different column. No table rebuild is needed for either. Adding a `NOT NULL` column to a
table that already holds rows requires a `DEFAULT`.

Anything those two cannot express — changing a type, adding a constraint, reordering
columns — needs SQLite's create-copy-drop-rename rebuild, and that is where the next
section applies.

## The sync triggers, and how a migration silently breaks replication

Every synced table carries three triggers (`<table>_sync_ins`, `_sync_upd`, `_sync_del`)
that write one row per changed row into `sync_log`. That log is how every client learns
anything changed. **A table with no triggers replicates nothing, and nothing fails.**

The synced tables are `HOST_SYNCED_TABLES` in `sync/tables.ts` — `media_item`,
`rss_item`, `torrent_download`, `nzb_download`, `person`, `role` and `rss_feed` — plus
every table a plugin declares in its `synced` array. That list already went stale once
here, missing `rss_feed` for a time after it joined the export: treat
`sync/tables.ts`'s `HOST_SYNCED_TABLES` as the authoritative list and this sentence as
illustrative only, current as of the commit that last touched it.

### What migration operations do to a trigger

Measured on SQLite 3.53.4 through `node:sqlite`, not assumed:

| Operation | Triggers afterwards | Does a later write log? |
|---|---|---|
| `ADD COLUMN` | survive | yes |
| `DROP COLUMN` (one no trigger names) | survive | yes |
| `RENAME COLUMN` | survive, bodies rewritten | yes |
| `RENAME TABLE` | survive, `ON <new name>` rewritten | **logs under the old name, and twice once you reinstall** |
| create-copy-drop-rename rebuild | **gone** | **no** |

Two of those rows need spelling out.

**`RENAME TABLE` is the subtle one, and it goes wrong twice.** SQLite rewrites the
trigger's `ON <table>` clause to the new name, so the trigger still fires — but the
table name inside the body is a *string literal*, and SQLite does not rewrite string
literals. So after `ALTER TABLE media_item RENAME TO media_row`, the triggers happily
write `table_name = 'media_item'` for every change. The tail skips entries naming a
table it does not know and advances its cursor past them, so those changes are not
merely delayed — they are consumed and discarded.

Reinstalling does not repair that; it *doubles* it. `installSyncTriggers` drops each
trigger by name before creating it, and the surviving triggers are still called
`media_item_sync_ins`/`_upd`/`_del` — the rename does not rename them either. So
`installSyncTriggers(db, ['media_row'])` drops `media_row_sync_*`, which do not exist,
creates them, and leaves the old three firing alongside. Measured:

```
after ALTER TABLE plug RENAME TO plug2:
  sqlite_master triggers plug_sync_ins/upd/del, tbl_name = plug2
after installSyncTriggers(db, ['plug2']) and one INSERT:
  [1: plug2/7 upsert, 2: plug/7 upsert]
```

Every write to the renamed table produces two log entries for the rest of that
database's life. The `plug/*` half names a table no registry knows, so both cursors
skip it and advance — correct, and it permanently consumes page budget and doubles the
log. `syncTriggerSql`'s "`DROP TRIGGER IF EXISTS` first, so installation is idempotent"
is true only for the same *name*.

**So the rule for a direct rename is: drop the old triggers by name first, then rename,
then install the new ones.**

```ts
import { installSyncTriggers, syncedTriggerNames } from '../sync/log.ts';

function migration16(db: DatabaseSync): void {
  for (const name of syncedTriggerNames('media_item')) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec('ALTER TABLE media_item RENAME TO media_row');
  installSyncTriggers(db, ['media_row']);
}
```

The create-copy-drop-rename rebuild below does not need this: `DROP TABLE old` takes the
old triggers with it, so by the time the rename runs there is nothing left to inherit.
It is the *direct* rename, with no drop in it, that leaves them behind.

And note the wider consequence: renaming a synced table changes the `table_name` every
client has keyed its replica under, which is not something a trigger reinstall can fix
at either end. Treat a rename of a synced table as a client-visible schema change, not
as housekeeping.

**The rebuild is the dangerous one, and it is dangerous in three ways.** `DROP TABLE`
takes the triggers with it. It does *not* fire the `AFTER DELETE` trigger for the rows it
destroys, which is the one mercy here — a rebuild leaves no spurious tombstones. And the
`INSERT INTO new SELECT … FROM old` writes into a table whose triggers do not exist yet,
so if the rebuild *changes* row content, no client ever learns.

### What your migration must do

**If your migration drops, rebuilds or renames a synced table, reinstall that table's
triggers as the last statement of the same migration.**

```ts
import { installSyncTriggers } from '../sync/log.ts';

function migration16(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE media_item_new (...);
    INSERT INTO media_item_new SELECT ... FROM media_item;
    DROP TABLE media_item;
    ALTER TABLE media_item_new RENAME TO media_item;
    CREATE INDEX media_item_sync ON media_item (plugin_id, updated_at, id);
  `);
  installSyncTriggers(db, ['media_item']);
}
```

`installSyncTriggers` drops each trigger before creating it, so calling it is always
safe.

**Do not rely on the boot-time reinstall.** `main.ts` calls
`installSyncTriggers(raw, HOST_SYNCED_TABLES)` on every boot, and `host.register` does
the same for each plugin's declared tables — but both run *after* every migration has
finished. A migration 17 that updates rows in the table migration 16 rebuilt runs in the
gap, with no triggers installed, and those updates reach no client. The boot-time call is
a backstop for the case where nobody read this document; it is not the mechanism.

**A partial reinstall is worse than none**, because of how it presents. Reinstall only
the update trigger and ordinary edits log perfectly while every delete vanishes — a
client that keeps rows the server deleted, with the update path visibly working. Always
install all three, which is what passing the table name to `installSyncTriggers` does.

**If the rebuild changed row content, relog the rows.** The copy itself is invisible to
the log, so a rebuild that rewrites a column needs the change announced explicitly.
Because `sync_log` holds one row per changed row, relogging the whole table is its
steady state rather than an abuse of it:

```ts
import { relogSyncedTables } from '../sync/log.ts';

relogSyncedTables(db, ['media_item']);
```

which is exactly:

```sql
DELETE FROM sync_log WHERE table_name = 'media_item' AND op != 'delete';
INSERT INTO sync_log (table_name, row_id, op, at)
  SELECT 'media_item', id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM media_item;
```

`AND op != 'delete'` is not a refinement, it is the whole correctness of the statement.
A `delete` entry names a row the table no longer has, so an unscoped `DELETE` removes it
and the `INSERT … SELECT` over live rows **cannot put it back**. Every client whose
cursor sits below that entry then keeps the deleted row for good, with nothing failing.
And those tombstones are exactly what a rebuild leaves behind: `DROP TABLE` fires no
`AFTER DELETE` trigger, so a row deleted before the rebuild still has its entry, and is
still owed to every client below it. This is the defect `seedSyncLog` shipped with on
this branch; `test/sync/log.test.ts` pins both halves.

The `DELETE` is otherwise required only by `sync_log_row`, the `UNIQUE` index on
`(table_name, row_id)`. What makes the relog *work* is `AUTOINCREMENT`: `sync_log.id` is
issued as `max_ever + 1` and no id is ever reused, so the new rows land at higher ids
than any client's cursor whether or not anything was deleted first. Measured — with the
log holding ids 1, 2 and 4 and rows 1 and 2 live, the relog produces ids **5 and 6**,
not the freed 1 and 2. An earlier wording of this paragraph said deleting "frees the old
`AUTOINCREMENT` ids"; it frees nothing, which is the whole reason the column carries
`AUTOINCREMENT` in the first place.

**`seedSyncLog` is a different function and will not do this.** It indexes rows the log
does not know about and leaves every entry it already holds at the id it already has —
right for "this table has rows nothing ever logged", useless for "these rows are not
what you were told they were". Reach for it when a migration *creates and populates* a
synced table, and for `relogSyncedTables` when one rewrites rows that already existed.

**This is the mechanism, not just a repair.** `migration15` runs `seedSyncLog` over
`HOST_SYNCED_TABLES` after installing the triggers, and `host.register` runs
`seedSyncLogOnce` over each plugin's declared tables — because the client's backfill
walks `sync_log` backwards and reads it as an index of *which rows exist*. A table with
rows and no log entries is not merely stale to that cursor; it is invisible to it, and
stays invisible. So a rebuild that leaves a table's rows unindexed is the same defect as
one that leaves it untriggered, and it has the same symptom: a client that never sees
those rows, with nothing failing.

Skip the relog when the rebuild left every row's visible content identical. Nothing
deletes a `sync_log` row except a trigger and `relogSyncedTables`, so a rebuild that
preserves row ids leaves the log a correct index of which rows exist whatever else it
changed — and relogging 20,000 unchanged rows costs every client a full re-read for
nothing.

**A rebuild that drops rows is fine; one that renumbers them is already forbidden.**
Entries naming a row id the new table does not have resolve to nothing: the backfill
skips them, which costs a little page density, and the tail sends a `delete` — right for
a client that holds the row and harmless for one that does not. An entry naming a
*reused* id is the shape that would actually break, because the log would then index the
wrong row — which is the replication half of "a row's `id` is immutable" above, and the
reason that rule is stated as a rule rather than as advice.

### Why the triggers are not simply reinstalled from scratch each boot

They persist. Measured: a trigger created on one connection is in `sqlite_master` on the
next connection to the same file and fires there with nothing reinstalled, the same as
any other schema object. `migration15` installing the host's six tables once is
therefore correct, and the per-boot call in `main.ts` is defensive rather than
corrective. `sync/log.ts` carries the measurement.

## Pragmas

`db/open.ts` sets three on every connection, so a migration runs with all three in
force:

- `foreign_keys = ON` — no foreign key in this schema declares an `ON DELETE`, so every
  one is SQLite's `NO ACTION` and a delete that would orphan a reference is refused
  rather than cascading. Verified: a direct `DELETE FROM auth_user` with one session and
  one account present fails with errcode 787, even though better-auth's own model
  declares `cascade` for both.
- `journal_mode = WAL`
- `recursive_triggers = ON` — required, not tuning. With SQLite's default of `OFF`, an
  `INSERT OR REPLACE` that displaces a *different* row through a unique-index conflict
  fires the insert trigger and not the delete one, so the displaced row's deletion never
  reaches `sync_log` and every client keeps it forever with nothing failing.

## Testing a migration

`migrateHostWith` is exported so a test can apply a *prefix* of the real list — seed a
row on the pre-migration schema, then watch the real DDL act on it. That is the only way
to observe a data-moving migration doing its job; a test that seeds through the migrated
schema cannot see the shape the migration exists to convert.

For a migration touching a synced table, assert on `sync_log` and on `sqlite_master`
rather than on the table alone. `test/sync/tables.test.ts` enumerates `sqlite_master`
against `HOST_SYNCED_TABLES` and fails if any table is missing a trigger, which catches
a forgotten reinstall in CI — after the boot-time call has already papered over it, so
treat a failure there as a migration bug and not a boot bug.
